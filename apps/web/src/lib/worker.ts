/** In-process Honker consumer and scheduler owned by the Next.js controller. */
import { hostname } from "node:os";

import { loadCatalogSources, refreshCatalog } from "./catalog";
import { runIngest } from "./ingest";
import { SEED_PRICES } from "./prices";
import { resolveStorage } from "./storage";
import { WebdavClient } from "./webdav";
import type { JsonValue } from "@russellthehippo/honker-node";
import type { ScheduleSpec, Store } from "./store";

export const INGEST_SCHEDULE_NAME = "relaydot.usage-ingest";
export const CATALOG_SCHEDULE_NAME = "relaydot.catalog-refresh";

export interface WorkerOptions {
  /** Decrypts the stored WebDAV password. Null disables ingest. */
  secretKey: Buffer | null;
  catalogSourcesPath: string;
  ingestSchedule: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface JobPayload {
  kind: string;
  [key: string]: JsonValue;
}

function isJobPayload(payload: JsonValue): payload is JobPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof payload.kind === "string"
  );
}

export class InProcessWorker {
  readonly workerId = `${hostname()}-${process.pid}`;
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly store: Store,
    private readonly options: WorkerOptions
  ) {}

  start(): void {
    if (this.running !== undefined) {
      return;
    }
    this.seed();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // The consumer and the leader-elected scheduler are independent loops; a
    // failure in either should not silently stop the other.
    this.running = Promise.all([this.run(signal), this.schedule(signal)]).then(
      () => undefined
    );
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.running;
    this.abortController = undefined;
    this.running = undefined;
  }

  /**
   * Publishes the reviewed price seed and the recurring work. Both are
   * idempotent, so every controller start converges on the same state.
   */
  private seed(): void {
    this.store.upsertModelPrices(SEED_PRICES);
    this.store.observeCatalogModels(
      SEED_PRICES.map((price) => ({
        model_id: price.model_id,
        provider: price.provider,
        display_name: price.display_name,
        origin: "official_source" as const,
        source_url: price.source_url ?? ""
      }))
    );

    const specs: ScheduleSpec[] = [
      {
        name: INGEST_SCHEDULE_NAME,
        expression: this.options.ingestSchedule,
        payload: { kind: "usage_ingest" }
      }
    ];
    const catalog = loadCatalogSources(this.options.catalogSourcesPath);
    if (catalog.sources !== null && catalog.sources.schedule.enabled) {
      specs.push({
        name: CATALOG_SCHEDULE_NAME,
        expression: catalog.sources.schedule.cron,
        payload: { kind: "catalog_refresh" }
      });
    }
    this.store.registerSchedules(specs);
  }

  private async run(signal: AbortSignal): Promise<void> {
    const waker = this.store.queue.claimWaker({ idlePollS: 1 });
    try {
      while (!signal.aborted) {
        const job = await waker.next(this.workerId, { signal });
        if (job === null) {
          continue;
        }
        await this.process(job.payload, job.ack.bind(job), job.retry.bind(job));
      }
    } finally {
      waker.close();
    }
  }

  private async schedule(signal: AbortSignal): Promise<void> {
    try {
      await this.store.honker.scheduler().run(this.workerId, signal);
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    }
  }

  private async process(
    payload: JsonValue,
    ack: () => boolean,
    retry: (delayS?: number, error?: string) => boolean
  ): Promise<void> {
    try {
      if (!isJobPayload(payload)) {
        throw new Error("unknown job payload");
      }
      switch (payload.kind) {
        case "command_created":
          this.handleCommandCreated(payload);
          break;
        case "usage_ingest":
          await this.handleUsageIngest();
          break;
        case "catalog_refresh":
          await this.handleCatalogRefresh();
          break;
        default:
          throw new Error(`unknown job kind: ${payload.kind}`);
      }
      ack();
    } catch (error) {
      retry(60, error instanceof Error ? error.message : String(error));
    }
  }

  private handleCommandCreated(payload: JobPayload): void {
    if (typeof payload.command_id !== "string") {
      throw new Error("command_created requires a command_id");
    }
    this.store.sqlite
      .prepare(
        "INSERT OR IGNORE INTO audit_events" +
          "(id, action, resource_type, resource_id, details_json, created_at) " +
          "VALUES (lower(hex(randomblob(16))), 'command.queued', 'command', ?, '{}', unixepoch())"
      )
      .run(payload.command_id);
  }

  private async handleUsageIngest(): Promise<void> {
    await runIngest(this.store, this.webdav());
  }

  private async handleCatalogRefresh(): Promise<void> {
    const catalog = loadCatalogSources(this.options.catalogSourcesPath);
    if (catalog.sources === null) {
      const id = this.store.startCatalogCheck();
      this.store.finishCatalogCheck(id, {
        status: "failed",
        discovered: 0,
        added: 0,
        detail: catalog.error
      });
      return;
    }
    await refreshCatalog(this.store, catalog.sources, {
      fetchImpl: this.options.fetchImpl,
      env: this.options.env
    });
  }

  private webdav(): WebdavClient | null {
    const resolved = resolveStorage(this.store, this.options.secretKey);
    return resolved === null
      ? null
      : new WebdavClient(resolved, this.options.fetchImpl ?? fetch);
  }
}
