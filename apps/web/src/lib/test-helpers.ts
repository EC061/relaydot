import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "./store";
import type { WorkerOptions } from "./worker";

/**
 * Worker settings for tests: no secret key so ingest resolves to "not
 * configured", and a path that does not exist so no catalog schedule registers.
 */
export function testWorkerOptions(
  overrides: Partial<WorkerOptions> = {}
): WorkerOptions {
  return {
    secretKey: null,
    catalogSourcesPath: join(tmpdir(), "relaydot-absent-catalog.yaml"),
    ingestSchedule: "@every 1h",
    ...overrides
  };
}

export function temporaryStore(): {
  store: Store;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), "relaydot-controller-"));
  const store = new Store(join(directory, "relaydot.db"));
  return {
    store,
    cleanup: () => {
      if (store.sqlite.open) {
        store.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function enroll(store: Store): {
  deviceId: string;
  deviceToken: string;
} {
  const enrollment = store.createEnrollmentToken(600);
  const device = store.enrollDevice({
    token: enrollment.token,
    name: "lab-one",
    platform: "linux",
    agent_version: "0.1.0"
  });
  return {
    deviceId: device.device_id,
    deviceToken: device.device_token
  };
}
