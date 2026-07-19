import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { enroll, temporaryStore } from "./test-helpers";
import type { Store } from "./store";
import { InProcessWorker } from "./worker";

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
    const worker = new InProcessWorker(store);
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
    const worker = new InProcessWorker(store);
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
