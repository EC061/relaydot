/**
 * Reads conversation history out of the shared WebDAV object store and turns it
 * into priced usage facts.
 *
 * The agents own the writes: each one publishes `manifests/<device>.json`
 * listing the content-addressed blobs it uploaded under `objects/<aa>/<sha256>`.
 * The controller only reads. Because blob names are digests, an object that has
 * already been parsed can be skipped without fetching it, and a file that grew
 * gets a new digest and is re-read in full — the usage fact IDs are derived from
 * provider, session, and event, so re-reading is idempotent rather than
 * double-counting.
 *
 * Nothing here retains prompt or completion text; see usage-parse.ts.
 */
import { createHash } from "node:crypto";

import { estimateCostMicroUsd, ratesFor } from "./prices";
import { parseByPath } from "./usage-parse";
import { objectPath } from "./webdav";
import type { PriceRates } from "./prices";
import type { Store } from "./store";
import type { ModelPriceRow, UsageFactRow } from "./types";
import type { WebdavClient } from "./webdav";

/** Blob listing published by one agent. Mirrors relaydot/sync.py. */
export interface PublishedEntry {
  path: string;
  digest: string;
  size: number;
  logical_type?: string;
  modified_at?: number;
  link_target?: string | null;
}

export interface DeviceManifest {
  format_version: number;
  device_id: string;
  device_name?: string;
  generated_at: number;
  policy?: string;
  entries: PublishedEntry[];
}

export interface IngestReport {
  manifests: number;
  objectsSeen: number;
  objectsRead: number;
  factsWritten: number;
  skippedLarge: number;
  malformed: number;
  errors: string[];
}

/**
 * Objects above this are not conversation transcripts worth parsing, and a
 * runaway file should not be pulled into the controller's heap.
 */
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;

/** Only history transcripts carry usage; everything else synced is config. */
export function isHistoryPath(path: string): boolean {
  if (!path.endsWith(".jsonl")) {
    return false;
  }
  return path.startsWith("claude/projects/") || path.startsWith("codex/sessions/");
}

function emptyReport(): IngestReport {
  return {
    manifests: 0,
    objectsSeen: 0,
    objectsRead: 0,
    factsWritten: 0,
    skippedLarge: 0,
    malformed: 0,
    errors: []
  };
}

function parseManifest(text: string): DeviceManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const manifest = value as Partial<DeviceManifest>;
  if (
    typeof manifest.device_id !== "string" ||
    manifest.device_id.length === 0 ||
    !Array.isArray(manifest.entries)
  ) {
    return null;
  }
  const entries = manifest.entries.filter(
    (entry): entry is PublishedEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as PublishedEntry).path === "string" &&
      /^[0-9a-f]{64}$/.test(String((entry as PublishedEntry).digest))
  );
  return {
    format_version: Number(manifest.format_version ?? 1),
    device_id: manifest.device_id,
    device_name:
      typeof manifest.device_name === "string" ? manifest.device_name : undefined,
    generated_at: Number(manifest.generated_at ?? 0),
    policy: typeof manifest.policy === "string" ? manifest.policy : undefined,
    entries
  };
}

/**
 * Pulls every not-yet-parsed history object referenced by a device manifest and
 * writes the usage facts it yields.
 *
 * A failure against one object is recorded and the run continues: one truncated
 * upload should not stop a fleet's analytics from updating.
 */
export async function ingestUsage(
  store: Store,
  client: WebdavClient,
  options: { now?: number; maxObjectBytes?: number } = {}
): Promise<IngestReport> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const maxObjectBytes = options.maxObjectBytes ?? MAX_OBJECT_BYTES;
  const report = emptyReport();

  const prices = new Map<string, ModelPriceRow>(
    store.modelPrices().map((row) => [row.model_id, row])
  );
  const rates = new Map<string, PriceRates>(
    [...prices].map(([id, row]) => [id, ratesFor(row)])
  );
  const observed = new Map<string, { provider: string }>();

  const listing = await client.list("manifests", "1");
  for (const entry of listing) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) {
      continue;
    }
    let manifest: DeviceManifest | null;
    try {
      const text = await client.getText(entry.href);
      manifest = text === null ? null : parseManifest(text);
    } catch (error) {
      report.errors.push(`${entry.href}: ${message(error)}`);
      continue;
    }
    if (manifest === null) {
      report.errors.push(`${entry.href}: not a readable device manifest`);
      report.malformed += 1;
      continue;
    }
    report.manifests += 1;

    // An unknown device ID still yields usable facts; it just cannot be
    // attributed, so the foreign key is left null rather than failing the row.
    const deviceId = store.deviceExists(manifest.device_id) ? manifest.device_id : null;

    for (const item of manifest.entries) {
      if (!isHistoryPath(item.path)) {
        continue;
      }
      report.objectsSeen += 1;
      if (store.isObjectIngested(item.digest, item.path)) {
        continue;
      }
      if (Number(item.size) > maxObjectBytes) {
        report.skippedLarge += 1;
        continue;
      }
      try {
        const bytes = await client.get(objectPath(item.digest));
        if (bytes === null) {
          report.errors.push(`${item.path}: object ${item.digest.slice(0, 12)} missing`);
          continue;
        }
        // Content addressing is only a guarantee if it is checked. A truncated
        // upload or a peer that published one digest and stored other bytes
        // would otherwise be parsed and then marked ingested under that digest,
        // so the wrong content would never be re-read.
        const actual = createHash("sha256").update(bytes).digest("hex");
        if (actual !== item.digest) {
          report.errors.push(
            `${item.path}: object ${item.digest.slice(0, 12)} hashes to ` +
              `${actual.slice(0, 12)}; skipped`
          );
          continue;
        }
        const text = Buffer.from(bytes).toString("utf8");
        report.objectsRead += 1;
        const parsed = parseByPath(item.path, text, item.modified_at ?? now);
        if (parsed === null) {
          continue;
        }
        report.malformed += parsed.malformed;

        const facts: UsageFactRow[] = parsed.facts.map((fact) => {
          const rate = rates.get(fact.model_id);
          observed.set(fact.model_id, { provider: fact.provider });
          return {
            usage_fact_id: fact.usage_fact_id,
            device_id: deviceId,
            provider: fact.provider,
            session_id: fact.session_id,
            model_id: fact.model_id,
            occurred_at: fact.occurred_at,
            input_uncached_tokens: fact.input_uncached_tokens,
            cache_write_5m_tokens: fact.cache_write_5m_tokens,
            cache_write_1h_tokens: fact.cache_write_1h_tokens,
            cache_write_other_tokens: fact.cache_write_other_tokens,
            cache_read_tokens: fact.cache_read_tokens,
            output_tokens: fact.output_tokens,
            reasoning_output_tokens: fact.reasoning_output_tokens,
            estimated_cost_microusd:
              rate === undefined ? null : estimateCostMicroUsd(fact, rate),
            price_match_status: rate === undefined ? "unpriced" : "exact",
            source_path: item.path
          };
        });
        report.factsWritten += store.recordUsageFacts(facts);
        store.markObjectIngested(item.digest, item.path, parsed.facts.length);
      } catch (error) {
        report.errors.push(`${item.path}: ${message(error)}`);
      }
    }
  }

  // Every model seen in real traffic enters the review queue, so an operator
  // can see exactly which IDs are costing tokens without an approved rate.
  store.observeCatalogModels(
    [...observed].map(([modelId, info]) => ({
      model_id: modelId,
      provider: info.provider,
      display_name: modelId,
      origin: "usage" as const
    }))
  );

  return report;
}

/**
 * Runs one ingest and records the attempt, including the "no backend
 * configured" case, so the dashboard can distinguish unconfigured from broken.
 */
export async function runIngest(
  store: Store,
  client: WebdavClient | null
): Promise<IngestReport & { status: "ok" | "partial" | "failed" | "skipped" }> {
  const id = store.startIngestRun();
  if (client === null) {
    store.finishIngestRun(id, {
      status: "skipped",
      manifests: 0,
      objects_seen: 0,
      objects_read: 0,
      facts_written: 0,
      detail: "no WebDAV storage backend is configured"
    });
    return { ...emptyReport(), status: "skipped" };
  }
  try {
    const report = await ingestUsage(store, client);
    const status = report.errors.length > 0 ? "partial" : "ok";
    store.finishIngestRun(id, {
      status,
      manifests: report.manifests,
      objects_seen: report.objectsSeen,
      objects_read: report.objectsRead,
      facts_written: report.factsWritten,
      detail: report.errors.slice(0, 5).join("; ")
    });
    return { ...report, status };
  } catch (error) {
    store.finishIngestRun(id, {
      status: "failed",
      manifests: 0,
      objects_seen: 0,
      objects_read: 0,
      facts_written: 0,
      detail: message(error)
    });
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
