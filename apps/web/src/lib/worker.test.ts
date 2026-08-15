import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enroll, temporaryStore, testWorkerOptions } from "./test-helpers";
import type { Store } from "./store";
import {
  CATALOG_SCHEDULE_NAME,
  INGEST_SCHEDULE_NAME,
  InProcessWorker
} from "./worker";

describe("in-process Honker worker", () => {
  let store: Store;
  let cleanup: () => void;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
  });

  afterEach(() => cleanup());

  it("starts once, wakes for better-sqlite3 commits, and stops", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    worker.start();
    worker.start();
    const device = enroll(store);
    const command = store.createCommand({
      deviceId: device.deviceId,
      type: "sync",
      payload: {},
      idempotencyKey: "worker-sync"
    });
    await expect
      .poll(() => store.health().pending_jobs, { timeout: 3000 })
      .toBe(0);
    expect(
      store
        .listAuditEvents()
        .some(
          (event) =>
            event.action === "command.queued" &&
            event.resource_id === command.id
        )
    ).toBe(true);
    await worker.stop();
    await worker.stop();
  });

  it("retries malformed jobs without crashing the controller worker", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    store.queue.enqueue({ bad: true });
    worker.start();
    await expect
      .poll(
        () =>
          (
            store.honker.query(
              "SELECT attempts FROM _honker_live WHERE queue = 'relaydot'"
            )[0] as { attempts: number } | undefined
          )?.attempts,
        { timeout: 3000 }
      )
      .toBe(1);
    await worker.stop();
  });
});

describe("worker background jobs", () => {
  let store: Store;
  let cleanup: () => void;
  const SOURCES = join(import.meta.dirname, "../../../../config/catalog-sources.yaml");

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
  });

  afterEach(() => cleanup());

  it("seeds the reviewed catalog and registers the recurring work", async () => {
    const worker = new InProcessWorker(
      store,
      testWorkerOptions({ catalogSourcesPath: SOURCES })
    );
    worker.start();
    try {
      expect(store.modelPrices().length).toBeGreaterThan(0);
      // Seed rates carry the source they were read from, per
      // validation.requireSourceLocatorPerRate.
      expect(store.modelPrices()[0].source_url).toContain("https://");
      expect(
        store
          .honker
          .scheduler()
          .list()
          .map((entry) => entry.name)
          .sort()
      ).toEqual([CATALOG_SCHEDULE_NAME, INGEST_SCHEDULE_NAME]);
    } finally {
      await worker.stop();
    }
  });

  it("registers no catalog schedule when the declaration is unreadable", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    worker.start();
    try {
      expect(store.honker.scheduler().list().map((entry) => entry.name)).toEqual([
        INGEST_SCHEDULE_NAME
      ]);
    } finally {
      await worker.stop();
    }
  });

  it("runs an ingest job and records that no backend is configured", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    store.queue.enqueue({ kind: "usage_ingest" });
    worker.start();
    try {
      await expect
        .poll(() => store.ingestRuns(1)[0]?.status, { timeout: 3000 })
        .toBe("skipped");
      expect(store.ingestRuns(1)[0].detail).toContain("no WebDAV storage backend");
    } finally {
      await worker.stop();
    }
  });

  it("runs a catalog check job against the declared sources", async () => {
    const worker = new InProcessWorker(
      store,
      testWorkerOptions({
        catalogSourcesPath: SOURCES,
        env: {},
        fetchImpl: async () => Response.json({ data: [] })
      })
    );
    store.queue.enqueue({ kind: "catalog_refresh" });
    worker.start();
    try {
      await expect.poll(() => store.catalogChecks(1).length, { timeout: 3000 }).toBe(1);
      // Both model APIs are optional and have no credential here, so the check
      // succeeds having skipped them rather than reporting a failure.
      expect(store.catalogChecks(1)[0].status).toBe("ok");
    } finally {
      await worker.stop();
    }
  });

  it("records a failed check when the declaration cannot be read", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    store.queue.enqueue({ kind: "catalog_refresh" });
    worker.start();
    try {
      await expect
        .poll(() => store.catalogChecks(1)[0]?.status, { timeout: 3000 })
        .toBe("failed");
      expect(store.catalogChecks(1)[0].detail).toContain("cannot read");
    } finally {
      await worker.stop();
    }
  });

  it("retries an unknown job kind and a command job with no id", async () => {
    const worker = new InProcessWorker(store, testWorkerOptions());
    store.queue.enqueue({ kind: "not_a_job" });
    store.queue.enqueue({ kind: "command_created" });
    worker.start();
    try {
      await expect
        .poll(
          () =>
            (
              store.honker.query(
                "SELECT COUNT(*) AS count FROM _honker_live WHERE queue = 'relaydot' AND attempts > 0"
              )[0] as { count: number }
            ).count,
          { timeout: 3000 }
        )
        .toBe(2);
    } finally {
      await worker.stop();
    }
  });
});
