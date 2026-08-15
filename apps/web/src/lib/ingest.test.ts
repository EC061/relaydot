import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ingestUsage, isHistoryPath, runIngest } from "./ingest";
import { SEED_PRICES } from "./prices";
import { enroll, temporaryStore } from "./test-helpers";
import { WebdavClient, objectPath } from "./webdav";
import type { DeviceManifest, PublishedEntry } from "./ingest";
import type { Store } from "./store";

/**
 * A WebDAV server backed by a map, driven through the real client so the
 * requests under test are the requests a server would receive.
 */
class FakeDav {
  readonly files = new Map<string, string>();
  readonly collections = new Set<string>();

  fetch: typeof fetch = async (url, init) => {
    const path = decodeURIComponent(new URL(String(url)).pathname).replace(
      /^\/+|\/+$/g,
      ""
    );
    const method = init?.method ?? "GET";
    if (method === "MKCOL") {
      const created = !this.collections.has(path);
      this.collections.add(path);
      return new Response("", { status: created ? 201 : 405 });
    }
    if (method === "PUT") {
      this.files.set(path, String(init?.body));
      return new Response("", { status: 201 });
    }
    if (method === "GET") {
      const body = this.files.get(path);
      return body === undefined
        ? new Response("", { status: 404 })
        : new Response(body, { status: 200 });
    }
    if (method === "PROPFIND") {
      const prefix = path.length === 0 ? "" : `${path}/`;
      const children = [...this.files.keys()].filter((name) =>
        name.startsWith(prefix)
      );
      if (children.length === 0 && !this.collections.has(path)) {
        return new Response("", { status: 404 });
      }
      const blocks = children
        .map(
          (name) =>
            `<d:response><d:href>/${name}</d:href><d:propstat><d:prop>` +
            `<d:resourcetype/><d:getcontentlength>${this.files.get(name)?.length ?? 0}` +
            "</d:getcontentlength>" +
            "<d:getlastmodified>Tue, 11 Aug 2026 09:00:00 GMT</d:getlastmodified>" +
            "</d:prop></d:propstat></d:response>"
        )
        .join("");
      return new Response(
        `<d:multistatus xmlns:d="DAV:">${blocks}</d:multistatus>`,
        { status: 207 }
      );
    }
    return new Response("", { status: 405 });
  };

  client(): WebdavClient {
    return new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      this.fetch
    );
  }

  /** Stores content at its digest and returns the manifest entry for it. */
  put(path: string, content: string, modifiedAt = 1_786_000_000): PublishedEntry {
    const digest = createHash("sha256").update(content).digest("hex");
    this.files.set(objectPath(digest), content);
    return {
      path,
      digest,
      size: content.length,
      logical_type: "file",
      modified_at: modifiedAt
    };
  }

  publish(manifest: DeviceManifest): void {
    this.files.set(
      `manifests/${manifest.device_id}.json`,
      JSON.stringify(manifest)
    );
  }
}

const CLAUDE_TRANSCRIPT = [
  JSON.stringify({
    sessionId: "session-one",
    timestamp: "2026-08-11T09:00:00Z",
    message: {
      id: "msg_a",
      role: "assistant",
      model: "claude-opus-5",
      usage: {
        input_tokens: 1000,
        cache_creation: { ephemeral_5m_input_tokens: 500 },
        cache_read_input_tokens: 90_000,
        output_tokens: 1200
      }
    }
  }),
  JSON.stringify({
    sessionId: "session-one",
    timestamp: "2026-08-11T09:05:00Z",
    message: {
      id: "msg_b",
      role: "assistant",
      model: "model-nobody-priced",
      usage: { input_tokens: 10, output_tokens: 20 }
    }
  })
].join("\n");

function manifestFor(
  deviceId: string,
  entries: PublishedEntry[]
): DeviceManifest {
  return {
    format_version: 1,
    device_id: deviceId,
    device_name: deviceId,
    generated_at: 1_786_000_000,
    entries
  };
}

describe("usage ingest", () => {
  let store: Store;
  let cleanup: () => void;
  let dav: FakeDav;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
    store.upsertModelPrices(SEED_PRICES);
    dav = new FakeDav();
  });

  afterEach(() => cleanup());

  it("recognizes only the two history layouts", () => {
    expect(isHistoryPath("claude/projects/demo/a.jsonl")).toBe(true);
    expect(isHistoryPath("codex/sessions/a.jsonl")).toBe(true);
    expect(isHistoryPath("claude/settings.json")).toBe(false);
    expect(isHistoryPath("claude/commands/deploy.md")).toBe(false);
    expect(isHistoryPath("elsewhere/a.jsonl")).toBe(false);
  });

  it("parses a device's history into priced usage facts", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/session-one.jsonl", CLAUDE_TRANSCRIPT),
        // Configuration is synced but carries no usage, so it is never fetched.
        dav.put("claude/settings.json", "{}")
      ])
    );

    const report = await ingestUsage(store, dav.client());
    expect(report.manifests).toBe(1);
    expect(report.objectsSeen).toBe(1);
    expect(report.objectsRead).toBe(1);
    expect(report.factsWritten).toBe(2);
    expect(report.errors).toEqual([]);

    const facts = store.sqlite
      .prepare(
        "SELECT model_id, device_id, estimated_cost_microusd, price_match_status " +
          "FROM usage_facts ORDER BY model_id"
      )
      .all() as Array<Record<string, unknown>>;
    expect(facts).toHaveLength(2);
    expect(facts[0].model_id).toBe("claude-opus-5");
    expect(facts[0].device_id).toBe(device.deviceId);
    expect(facts[0].price_match_status).toBe("exact");
    expect(Number(facts[0].estimated_cost_microusd)).toBeGreaterThan(0);
    // A model with no approved rate contributes tokens but no invented cost.
    expect(facts[1].model_id).toBe("model-nobody-priced");
    expect(facts[1].estimated_cost_microusd).toBeNull();
    expect(facts[1].price_match_status).toBe("unpriced");
  });

  it("queues every model seen in traffic for review", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );
    await ingestUsage(store, dav.client());
    const queued = store
      .catalogModels()
      .filter((model) => model.status === "needs_price")
      .map((model) => model.model_id);
    expect(queued).toEqual(["model-nobody-priced"]);
  });

  it("skips an object it has already parsed", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );
    await ingestUsage(store, dav.client());
    const second = await ingestUsage(store, dav.client());
    expect(second.objectsSeen).toBe(1);
    expect(second.objectsRead).toBe(0);
    expect(second.factsWritten).toBe(0);
  });

  it("re-reads a grown transcript without double counting the old records", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );
    await ingestUsage(store, dav.client());

    const grown = `${CLAUDE_TRANSCRIPT}\n${JSON.stringify({
      sessionId: "session-one",
      timestamp: "2026-08-11T09:10:00Z",
      message: {
        id: "msg_c",
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 5, output_tokens: 7 }
      }
    })}`;
    dav.publish(
      manifestFor(device.deviceId, [dav.put("claude/projects/demo/s.jsonl", grown)])
    );

    const report = await ingestUsage(store, dav.client());
    expect(report.objectsRead).toBe(1);
    // Fact IDs derive from provider, session, and event, so the two records
    // already stored are upserted rather than duplicated.
    const count = store.sqlite
      .prepare("SELECT COUNT(*) AS count FROM usage_facts")
      .get() as { count: number };
    expect(count.count).toBe(3);
  });

  it("counts a session once when two devices publish the same transcript", async () => {
    const first = enroll(store);
    const second = store.enrollDevice({
      token: store.createEnrollmentToken(600).token,
      name: "lab-two",
      platform: "linux",
      agent_version: "0.1.0"
    });
    const entry = dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT);
    dav.publish(manifestFor(first.deviceId, [entry]));
    dav.publish(manifestFor(second.device_id, [entry]));

    await ingestUsage(store, dav.client());
    const count = store.sqlite
      .prepare("SELECT COUNT(*) AS count FROM usage_facts")
      .get() as { count: number };
    expect(count.count).toBe(2);
  });

  it("keeps facts from a manifest whose device is not enrolled, unattributed", async () => {
    dav.publish(
      manifestFor("device-that-never-enrolled", [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );
    const report = await ingestUsage(store, dav.client());
    expect(report.factsWritten).toBe(2);
    const row = store.sqlite
      .prepare("SELECT device_id FROM usage_facts LIMIT 1")
      .get() as { device_id: string | null };
    expect(row.device_id).toBeNull();
  });

  it("reports a malformed manifest and keeps going", async () => {
    const device = enroll(store);
    dav.files.set("manifests/broken.json", "{not json");
    dav.files.set("manifests/wrong-shape.json", JSON.stringify({ device_id: 7 }));
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );

    const report = await ingestUsage(store, dav.client());
    expect(report.manifests).toBe(1);
    expect(report.malformed).toBe(2);
    expect(report.errors).toHaveLength(2);
    expect(report.factsWritten).toBe(2);
  });

  it("refuses an object whose content does not hash to its digest", async () => {
    const device = enroll(store);
    const entry = dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT);
    dav.publish(manifestFor(device.deviceId, [entry]));
    // Same address, different bytes: a truncated upload or a peer that
    // published one digest and stored another.
    dav.files.set(objectPath(entry.digest), "tampered\n");

    const report = await ingestUsage(store, dav.client());
    expect(report.factsWritten).toBe(0);
    expect(report.objectsRead).toBe(0);
    expect(report.errors[0]).toContain("hashes to");
    // It must stay unread so a later correct upload is still parsed.
    expect(store.isObjectIngested(entry.digest, entry.path)).toBe(false);
  });

  it("records an object a manifest names but never uploaded", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        { path: "claude/projects/demo/s.jsonl", digest: "a".repeat(64), size: 10 }
      ])
    );
    const report = await ingestUsage(store, dav.client());
    expect(report.objectsRead).toBe(0);
    expect(report.errors[0]).toContain("missing");
  });

  it("drops manifest entries whose digest is not a SHA-256", async () => {
    const device = enroll(store);
    dav.publish(
      manifestFor(device.deviceId, [
        { path: "claude/projects/demo/s.jsonl", digest: "../escape", size: 1 }
      ])
    );
    const report = await ingestUsage(store, dav.client());
    expect(report.objectsSeen).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("leaves an object larger than the cap unread", async () => {
    const device = enroll(store);
    const entry = dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT);
    dav.publish(manifestFor(device.deviceId, [{ ...entry, size: 999_999_999 }]));
    const report = await ingestUsage(store, dav.client(), { maxObjectBytes: 1024 });
    expect(report.skippedLarge).toBe(1);
    expect(report.objectsRead).toBe(0);
  });

  it("records a run even when no storage backend is configured", async () => {
    const result = await runIngest(store, null);
    expect(result.status).toBe("skipped");
    const [run] = store.ingestRuns(1);
    expect(run.status).toBe("skipped");
    expect(run.detail).toContain("no WebDAV storage backend");
  });

  it("records a partial run when some objects failed", async () => {
    const device = enroll(store);
    dav.files.set("manifests/broken.json", "{not json");
    dav.publish(
      manifestFor(device.deviceId, [
        dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT)
      ])
    );
    const result = await runIngest(store, dav.client());
    expect(result.status).toBe("partial");
    const [run] = store.ingestRuns(1);
    expect(run.status).toBe("partial");
    expect(run.facts_written).toBe(2);
    expect(run.detail.length).toBeGreaterThan(0);
  });

  it("records a failed run and rethrows when the store is unreachable", async () => {
    const failing = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async () => new Response("", { status: 500 })
    );
    await expect(runIngest(store, failing)).rejects.toThrow();
    const [run] = store.ingestRuns(1);
    expect(run.status).toBe("failed");
    expect(run.detail).toContain("500");
  });
});

describe("ingest manifest tolerance", () => {
  let store: Store;
  let cleanup: () => void;
  let dav: FakeDav;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
    dav = new FakeDav();
  });

  afterEach(() => cleanup());

  it("accepts a manifest carrying only the fields it needs", async () => {
    const entry = dav.put("claude/projects/demo/s.jsonl", CLAUDE_TRANSCRIPT);
    // No format_version, device_name, generated_at, policy, or modified_at.
    dav.files.set(
      "manifests/minimal.json",
      JSON.stringify({
        device_id: "minimal",
        device_name: 7,
        policy: 9,
        entries: [{ path: entry.path, digest: entry.digest, size: entry.size }]
      })
    );
    const report = await ingestUsage(store, dav.client(), { now: 1_786_500_000 });
    expect(report.factsWritten).toBe(2);
    const row = store.sqlite
      .prepare("SELECT occurred_at FROM usage_facts LIMIT 1")
      .get() as { occurred_at: number };
    // The transcript carries its own timestamps, so the fallback is unused here
    // but must not break the parse.
    expect(row.occurred_at).toBeGreaterThan(0);
  });

  it("ignores a directory and a non-manifest file in the manifests collection", async () => {
    dav.collections.add("manifests/nested");
    dav.files.set("manifests/notes.txt", "not a manifest");
    const report = await ingestUsage(store, dav.client());
    expect(report.manifests).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it("skips a history object whose content no parser recognizes", async () => {
    const entry = dav.put("claude/projects/demo/s.jsonl", "not json at all\n");
    dav.publish(manifestFor("device-x", [entry]));
    const report = await ingestUsage(store, dav.client());
    expect(report.objectsRead).toBe(1);
    expect(report.factsWritten).toBe(0);
  });

  it("reports a manifest that cannot be fetched", async () => {
    dav.files.set("manifests/vanishing.json", "{}");
    const client = new WebdavClient(
      { baseUrl: "https://dav.test/", username: "u", password: "p" },
      async (url, init) =>
        init?.method === "GET"
          ? new Response("", { status: 500 })
          : dav.fetch(url, init)
    );
    const report = await ingestUsage(store, client);
    expect(report.errors[0]).toContain("500");
  });
});
