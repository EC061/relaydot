import { describe, expect, it } from "vitest";

import {
  AuthenticationError,
  NotFoundError,
  Store
} from "./store";
import { enroll, temporaryStore } from "./test-helpers";

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
