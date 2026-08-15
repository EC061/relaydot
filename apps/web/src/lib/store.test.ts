import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  NotFoundError,
  Store,
  isAuthenticationError,
  isNotFoundError
} from "./store";
import { SEED_PRICES } from "./prices";
import { enroll, temporaryStore } from "./test-helpers";
import type { ModelPriceRow, UsageFactRow } from "./types";

describe("SQLite store", () => {
  it("enables WAL, applies idempotent migrations, and reports health", () => {
    const fixture = temporaryStore();
    const path = fixture.store.path;
    expect(fixture.store.health()).toEqual({
      database: "ok",
      journal_mode: "wal",
      pending_jobs: 0
    });
    fixture.store.close();
    const reopened = new Store(path);
    expect(reopened.listDevices()).toEqual([]);
    reopened.close();
    fixture.cleanup();
  });

  it("enrolls once, authenticates, lists, and heartbeats a device", () => {
    const fixture = temporaryStore();
    try {
      const enrollment = fixture.store.createEnrollmentToken(600);
      const result = fixture.store.enrollDevice({
        token: enrollment.token,
        name: "macbook",
        platform: "darwin",
        agent_version: "0.1.0",
        public_key: "age1-example"
      });
      expect(
        fixture.store.authenticateDevice(result.device_id, result.device_token)
      ).toMatchObject({ name: "macbook", public_key: "age1-example" });
      expect(fixture.store.listDevices()).toHaveLength(1);
      expect(
        fixture.store.heartbeat(result.device_id, "0.1.1").server_time
      ).toBeTypeOf("number");
      expect(() =>
        fixture.store.enrollDevice({
          token: enrollment.token,
          name: "duplicate",
          platform: "linux",
          agent_version: "0.1.0"
        })
      ).toThrow(AuthenticationError);
      expect(() =>
        fixture.store.authenticateDevice(result.device_id, "wrong")
      ).toThrow(AuthenticationError);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects expired tokens and missing heartbeat devices", () => {
    const fixture = temporaryStore();
    try {
      const enrollment = fixture.store.createEnrollmentToken(600);
      fixture.store.sqlite
        .prepare("UPDATE enrollment_tokens SET expires_at = 0 WHERE id = ?")
        .run(enrollment.id);
      expect(() =>
        fixture.store.enrollDevice({
          token: enrollment.token,
          name: "late",
          platform: "linux",
          agent_version: "0.1.0"
        })
      ).toThrow(AuthenticationError);
      expect(() => fixture.store.heartbeat("missing", "0.1.0")).toThrow(
        NotFoundError
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("creates idempotent commands, claims, and acknowledges them", () => {
    const fixture = temporaryStore();
    try {
      const device = enroll(fixture.store);
      const first = fixture.store.createCommand({
        deviceId: device.deviceId,
        type: "collect_diagnostics",
        payload: { detail: "safe" },
        idempotencyKey: "diag-1"
      });
      const duplicate = fixture.store.createCommand({
        deviceId: device.deviceId,
        type: "collect_diagnostics",
        payload: { ignored: true },
        idempotencyKey: "diag-1"
      });
      expect(duplicate.id).toBe(first.id);
      expect(fixture.store.health().pending_jobs).toBe(1);
      const claimed = fixture.store.claimCommands(device.deviceId, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.status).toBe("claimed");
      const completed = fixture.store.acknowledgeCommand({
        deviceId: device.deviceId,
        commandId: first.id,
        status: "succeeded",
        result: { checked: true }
      });
      expect(completed.result).toEqual({ checked: true });
      expect(
        fixture.store.acknowledgeCommand({
          deviceId: device.deviceId,
          commandId: first.id,
          status: "failed",
          error: "ignored"
        }).status
      ).toBe("succeeded");
      expect(fixture.store.listAuditEvents().map((row) => row.action)).toContain(
        "command.succeeded"
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("validates missing command resources", () => {
    const fixture = temporaryStore();
    try {
      expect(() =>
        fixture.store.createCommand({
          deviceId: "missing",
          type: "sync",
          payload: {},
          idempotencyKey: "missing"
        })
      ).toThrow(NotFoundError);
      expect(() => fixture.store.getCommand("missing")).toThrow(NotFoundError);
      expect(() =>
        fixture.store.acknowledgeCommand({
          deviceId: "missing",
          commandId: "missing",
          status: "failed"
        })
      ).toThrow(NotFoundError);
    } finally {
      fixture.cleanup();
    }
  });

  it("stores admin sessions as hashes and rejects revoked or expired ones", () => {
    const fixture = temporaryStore();
    try {
      const session = fixture.store.createAdminSession(600);
      expect(fixture.store.authenticateAdminSession(session.token).id).toBe(
        session.id
      );
      const stored = fixture.store.sqlite
        .prepare("SELECT token_hash FROM admin_sessions WHERE id = ?")
        .get(session.id) as { token_hash: string };
      expect(stored.token_hash).not.toContain(session.token);

      expect(() => fixture.store.authenticateAdminSession("forged")).toThrow(
        AuthenticationError
      );

      fixture.store.revokeAdminSession(session.token);
      expect(() =>
        fixture.store.authenticateAdminSession(session.token)
      ).toThrow(AuthenticationError);
      // Revoking an unknown token is a no-op rather than an error.
      fixture.store.revokeAdminSession("never-issued");

      const aging = fixture.store.createAdminSession(600);
      fixture.store.sqlite
        .prepare("UPDATE admin_sessions SET expires_at = 1 WHERE id = ?")
        .run(aging.id);
      expect(() => fixture.store.authenticateAdminSession(aging.token)).toThrow(
        AuthenticationError
      );
      expect(fixture.store.purgeExpiredAdminSessions()).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("recognizes store errors thrown by a duplicate module copy", () => {
    // Next.js bundles this module separately for server components and route
    // handlers while the Store itself is shared through globalThis, so error
    // matching must not depend on class identity.
    class ForeignAuthenticationError extends Error {
      readonly relaydotErrorCode = "authentication";
    }
    class ForeignNotFoundError extends Error {
      readonly relaydotErrorCode = "not_found";
    }

    expect(new ForeignAuthenticationError() instanceof AuthenticationError).toBe(
      false
    );
    expect(isAuthenticationError(new ForeignAuthenticationError())).toBe(true);
    expect(isAuthenticationError(new AuthenticationError("x"))).toBe(true);
    expect(isNotFoundError(new ForeignNotFoundError())).toBe(true);
    expect(isNotFoundError(new NotFoundError("x"))).toBe(true);

    expect(isAuthenticationError(new NotFoundError("x"))).toBe(false);
    expect(isAuthenticationError(new Error("plain"))).toBe(false);
    expect(isAuthenticationError(null)).toBe(false);
    expect(isNotFoundError("string")).toBe(false);
    expect(isNotFoundError({ relaydotErrorCode: 7 })).toBe(false);
  });

  it("stores, probes, and clears the single WebDAV backend", () => {
    const fixture = temporaryStore();
    try {
      expect(fixture.store.storageBackend()).toBeNull();
      fixture.store.saveStorageBackend({
        baseUrl: "https://dav.test/dav/",
        username: "relaydot",
        passwordEncrypted: "v1:sealed"
      });
      const saved = fixture.store.storageBackend();
      expect(saved?.base_url).toBe("https://dav.test/dav/");
      expect(saved?.kind).toBe("webdav");
      expect(saved?.verified_at).toBeNull();

      fixture.store.recordStorageProbe(false, "credential rejected");
      expect(fixture.store.storageBackend()?.last_error).toBe("credential rejected");
      fixture.store.recordStorageProbe(true, null);
      expect(fixture.store.storageBackend()?.verified_at).not.toBeNull();
      expect(fixture.store.storageBackend()?.last_error).toBeNull();

      // Re-saving replaces the row and clears the stale verification.
      fixture.store.saveStorageBackend({
        baseUrl: "https://other.test/dav/",
        username: "second",
        passwordEncrypted: "v1:again"
      });
      expect(fixture.store.storageBackend()?.username).toBe("second");
      expect(fixture.store.storageBackend()?.verified_at).toBeNull();

      fixture.store.deleteStorageBackend();
      expect(fixture.store.storageBackend()).toBeNull();
      // Deleting again is a no-op.
      fixture.store.deleteStorageBackend();
    } finally {
      fixture.cleanup();
    }
  });

  it("upserts usage facts idempotently and tracks ingested objects", () => {
    const fixture = temporaryStore();
    try {
      const fact = {
        usage_fact_id: "fact-1",
        device_id: null,
        provider: "claude",
        session_id: "s1",
        model_id: "claude-opus-5",
        occurred_at: 1_700_000_000,
        input_uncached_tokens: 10,
        cache_write_5m_tokens: 1,
        cache_write_1h_tokens: 2,
        cache_write_other_tokens: 3,
        cache_read_tokens: 4,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        estimated_cost_microusd: 100,
        price_match_status: "exact",
        source_path: "claude/projects/p/s.jsonl"
      };
      expect(fixture.store.recordUsageFacts([fact])).toBe(1);
      // Re-ingesting the same fact must not create a second row.
      fixture.store.recordUsageFacts([{ ...fact, estimated_cost_microusd: 250 }]);
      const rows = fixture.store.sqlite
        .prepare("SELECT usage_fact_id, estimated_cost_microusd FROM usage_facts")
        .all() as Array<{ usage_fact_id: string; estimated_cost_microusd: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].estimated_cost_microusd).toBe(250);
      expect(fixture.store.recordUsageFacts([])).toBe(0);

      expect(fixture.store.isObjectIngested("deadbeef", "p.jsonl")).toBe(false);
      fixture.store.markObjectIngested("deadbeef", "p.jsonl", 3);
      expect(fixture.store.isObjectIngested("deadbeef", "p.jsonl")).toBe(true);
      // A changed digest for the same path is a fresh object to ingest.
      expect(fixture.store.isObjectIngested("cafe", "p.jsonl")).toBe(false);
      fixture.store.markObjectIngested("deadbeef", "p.jsonl", 9);
      expect(
        (
          fixture.store.sqlite
            .prepare("SELECT records FROM ingested_objects WHERE digest = ?")
            .get("deadbeef") as { records: number }
        ).records
      ).toBe(9);
    } finally {
      fixture.cleanup();
    }
  });

  it("seeds and updates the model price catalog", () => {
    const fixture = temporaryStore();
    try {
      expect(fixture.store.modelPrices()).toHaveLength(0);
      fixture.store.upsertModelPrices(SEED_PRICES);
      const seeded = fixture.store.modelPrices();
      expect(seeded.length).toBe(SEED_PRICES.length);
      const opus = seeded.find((row) => row.model_id === "claude-opus-5");
      expect(opus?.input_uncached_microusd_per_mtok).toBe(5_000_000);
      expect(opus?.updated_at).toBeGreaterThan(0);

      fixture.store.upsertModelPrices([
        { ...opus!, output_microusd_per_mtok: 30_000_000 }
      ]);
      expect(fixture.store.modelPrices()).toHaveLength(SEED_PRICES.length);
      expect(
        fixture.store
          .modelPrices()
          .find((row) => row.model_id === "claude-opus-5")?.output_microusd_per_mtok
      ).toBe(30_000_000);
    } finally {
      fixture.cleanup();
    }
  });

  it("processes Honker jobs and retries invalid payloads", () => {
    const fixture = temporaryStore();
    try {
      const device = enroll(fixture.store);
      const command = fixture.store.createCommand({
        deviceId: device.deviceId,
        type: "sync",
        payload: {},
        idempotencyKey: "sync-1"
      });
      expect(fixture.store.processOneJob("test-worker")).toBe(true);
      expect(fixture.store.processOneJob("test-worker")).toBe(false);
      expect(
        fixture.store
          .listAuditEvents()
          .some(
            (row) =>
              row.action === "command.queued" &&
              row.resource_id === command.id
          )
      ).toBe(true);
      fixture.store.queue.enqueue({ unexpected: true });
      expect(() => fixture.store.processOneJob("test-worker")).toThrow(
        "unknown job payload"
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("price catalog and repricing", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
  });

  afterEach(() => cleanup());

  const price = (overrides: Partial<ModelPriceRow> = {}): ModelPriceRow => ({
    model_id: "test-model",
    provider: "openai",
    display_name: "Test Model",
    input_uncached_microusd_per_mtok: 1_000_000,
    cache_write_5m_microusd_per_mtok: 1_000_000,
    cache_write_1h_microusd_per_mtok: 1_000_000,
    cache_write_other_microusd_per_mtok: 1_000_000,
    cache_read_microusd_per_mtok: 100_000,
    output_microusd_per_mtok: 10_000_000,
    updated_at: 0,
    ...overrides
  });

  const fact = (): UsageFactRow => ({
    usage_fact_id: "fact-1",
    device_id: null,
    provider: "openai",
    session_id: "s",
    model_id: "test-model",
    occurred_at: 1_786_000_000,
    input_uncached_tokens: 1_000_000,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_write_other_tokens: 0,
    cache_read_tokens: 0,
    output_tokens: 1_000_000,
    reasoning_output_tokens: 0,
    estimated_cost_microusd: null,
    price_match_status: "unpriced",
    source_path: "codex/sessions/s.jsonl"
  });

  function stored(): { estimated_cost_microusd: number | null; price_match_status: string } {
    return store.sqlite
      .prepare(
        "SELECT estimated_cost_microusd, price_match_status FROM usage_facts WHERE usage_fact_id = 'fact-1'"
      )
      .get() as { estimated_cost_microusd: number | null; price_match_status: string };
  }

  it("prices facts that were ingested before the rate was approved", () => {
    store.recordUsageFacts([fact()]);
    expect(stored().estimated_cost_microusd).toBeNull();

    // Ingest is content-addressed and never re-reads a parsed object, so a rate
    // approved later has to reach the stored rows directly.
    store.upsertModelPrices([price()]);
    expect(stored()).toEqual({
      estimated_cost_microusd: 11_000_000,
      price_match_status: "exact"
    });
  });

  it("clears the cost again when a rate is withdrawn", () => {
    store.recordUsageFacts([fact()]);
    store.upsertModelPrices([price()]);
    expect(store.deleteModelPrice("test-model")).toBe(true);
    expect(stored()).toEqual({
      estimated_cost_microusd: null,
      price_match_status: "unpriced"
    });
    expect(store.deleteModelPrice("test-model")).toBe(false);
  });

  it("moves a model between the review queue and the approved list", () => {
    store.observeCatalogModels([
      {
        model_id: "test-model",
        provider: "openai",
        display_name: "test-model",
        origin: "usage"
      }
    ]);
    expect(store.catalogModels()[0].status).toBe("needs_price");

    store.upsertModelPrices([price()]);
    expect(store.catalogModels()[0].status).toBe("priced");

    store.deleteModelPrice("test-model");
    expect(store.catalogModels()[0].status).toBe("needs_price");
  });

  it("never returns a priced model to the queue when restoring it from ignored", () => {
    store.upsertModelPrices([price()]);
    store.observeCatalogModels([
      {
        model_id: "test-model",
        provider: "openai",
        display_name: "test-model",
        origin: "usage"
      }
    ]);
    expect(store.setCatalogModelStatus("test-model", "ignored")).toBe(true);
    expect(store.catalogModels()[0].status).toBe("ignored");
    // The rate still exists, so restoring must not claim one is missing.
    expect(store.setCatalogModelStatus("test-model", "needs_price")).toBe(true);
    expect(store.catalogModels()[0].status).toBe("priced");
    expect(store.setCatalogModelStatus("absent", "ignored")).toBe(false);
  });

  it("keeps a model's first-seen origin and fills in a better display name", () => {
    store.observeCatalogModels([
      { model_id: "m", provider: "openai", display_name: "m", origin: "usage" }
    ]);
    store.observeCatalogModels([
      {
        model_id: "m",
        provider: "openai",
        display_name: "Proper Name",
        origin: "official_source",
        source_url: "https://example.com"
      }
    ]);
    const [model] = store.catalogModels();
    expect(model.origin).toBe("usage");
    expect(model.display_name).toBe("Proper Name");
    expect(store.observeCatalogModels([])).toBe(0);
  });

  it("records catalog checks and ingest runs newest first", () => {
    const first = store.startCatalogCheck();
    store.finishCatalogCheck(first, {
      status: "ok",
      discovered: 3,
      added: 1,
      detail: "fine"
    });
    expect(store.catalogChecks(5)[0]).toMatchObject({
      status: "ok",
      discovered: 3,
      added: 1
    });

    const run = store.startIngestRun();
    // A run starts recorded as failed so a crash mid-run is never read as success.
    expect(store.ingestRuns(1)[0].status).toBe("failed");
    store.finishIngestRun(run, {
      status: "ok",
      manifests: 1,
      objects_seen: 2,
      objects_read: 2,
      facts_written: 4,
      detail: ""
    });
    expect(store.ingestRuns(1)[0]).toMatchObject({ status: "ok", facts_written: 4 });
  });

  it("reports whether a manifest's device is enrolled", () => {
    const device = enroll(store);
    expect(store.deviceExists(device.deviceId)).toBe(true);
    expect(store.deviceExists("not-a-device")).toBe(false);
  });

  it("enqueues recurring work at most once at a time", () => {
    expect(store.enqueueUnique("usage_ingest")).toBe(true);
    expect(store.enqueueUnique("usage_ingest")).toBe(false);
    expect(store.enqueueUnique("catalog_refresh", { reason: "manual" })).toBe(true);
  });

  it("registers, updates, and prunes its own schedules", () => {
    store.registerSchedules([
      { name: "relaydot.usage-ingest", expression: "@every 5m", payload: { kind: "a" } },
      { name: "relaydot.catalog-refresh", expression: "0 4 * * *", payload: { kind: "b" } }
    ]);
    const scheduler = store.honker.scheduler();
    expect(scheduler.list().map((entry) => entry.name).sort()).toEqual([
      "relaydot.catalog-refresh",
      "relaydot.usage-ingest"
    ]);

    // A changed expression is followed; an unchanged one is left alone.
    store.registerSchedules([
      { name: "relaydot.usage-ingest", expression: "@every 10m", payload: { kind: "a" } }
    ]);
    const remaining = scheduler.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].cron_expr).toBe("@every 10m");

    store.unregisterSchedule("relaydot.usage-ingest");
    expect(scheduler.list()).toEqual([]);
  });
});
