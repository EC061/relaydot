import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControllerApi } from "./api";
import { enroll, temporaryStore } from "./test-helpers";
import type { Store } from "./store";

const ADMIN = "admin-test-token";

function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://controller.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("controller API", () => {
  let store: Store;
  let api: ControllerApi;
  let cleanup: () => void;

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
    api = new ControllerApi(store, ADMIN);
  });

  afterEach(() => cleanup());

  it("serves health and protects administrator routes", async () => {
    expect(api.health().status).toBe(200);
    expect((await payload(api.health())).journal_mode).toBe("wal");
    expect(api.listDevices(request("/devices")).status).toBe(401);
    expect(
      api.listDevices(
        request("/devices", undefined, {
          "x-relaydot-admin-token": ADMIN
        })
      ).status
    ).toBe(200);
  });

  it("validates and creates enrollment tokens", async () => {
    const unauthorized = await api.createEnrollmentToken(
      request("/tokens", {})
    );
    expect(unauthorized.status).toBe(401);
    const invalid = await api.createEnrollmentToken(
      request(
        "/tokens",
        { expires_in: 2 },
        { "x-relaydot-admin-token": ADMIN }
      )
    );
    expect(invalid.status).toBe(422);
    const created = await api.createEnrollmentToken(
      request(
        "/tokens",
        {},
        { "x-relaydot-admin-token": ADMIN }
      )
    );
    expect(created.status).toBe(200);
    expect(await payload(created)).toHaveProperty("token");
  });

  it("validates enrollment JSON and credentials", async () => {
    const malformed = new Request("http://controller.test/enroll", {
      method: "POST",
      body: "{"
    });
    expect((await api.enroll(malformed)).status).toBe(422);
    expect((await api.enroll(request("/enroll", []))).status).toBe(422);
    expect((await api.enroll(request("/enroll", {}))).status).toBe(422);
    expect(
      (
        await api.enroll(
          request("/enroll", {
            token: "bad",
            name: "node",
            platform: "linux",
            agent_version: "0.1.0"
          })
        )
      ).status
    ).toBe(401);
  });

  it("runs the enrollment, heartbeat, command, claim, and ack flow", async () => {
    const token = store.createEnrollmentToken(600);
    const enrolledResponse = await api.enroll(
      request("/enroll", {
        token: token.token,
        name: "node",
        platform: "linux",
        agent_version: "0.1.0"
      })
    );
    expect(enrolledResponse.status).toBe(201);
    const enrolled = await payload(enrolledResponse);
    const deviceId = String(enrolled.device_id);
    const bearer = { authorization: `Bearer ${String(enrolled.device_token)}` };

    expect(
      (await api.heartbeat(request("/heartbeat", {}), deviceId)).status
    ).toBe(401);
    expect(
      (
        await api.heartbeat(
          request("/heartbeat", {}, { authorization: "Bearer wrong" }),
          deviceId
        )
      ).status
    ).toBe(401);
    expect(
      (
        await api.heartbeat(
          request("/heartbeat", {}, bearer),
          deviceId
        )
      ).status
    ).toBe(422);
    expect(
      (
        await api.heartbeat(
          request("/heartbeat", { agent_version: "0.1.1" }, bearer),
          deviceId
        )
      ).status
    ).toBe(200);

    const adminHeaders = { "x-relaydot-admin-token": ADMIN };
    expect(
      (
        await api.createCommand(
          request("/commands", { type: "bad", idempotency_key: "x" }, adminHeaders),
          deviceId
        )
      ).status
    ).toBe(422);
    expect(
      (
        await api.createCommand(
          request("/commands", { type: "sync", idempotency_key: "" }, adminHeaders),
          deviceId
        )
      ).status
    ).toBe(422);
    const commandResponse = await api.createCommand(
      request(
        "/commands",
        { type: "sync", idempotency_key: "sync-1", payload: { full: true } },
        adminHeaders
      ),
      deviceId
    );
    expect(commandResponse.status).toBe(200);
    const command = await payload(commandResponse);

    expect(
      api.claimCommands(
        request("/claim?limit=0", undefined, bearer),
        deviceId
      ).status
    ).toBe(422);
    const claimed = api.claimCommands(
      request("/claim?limit=10", undefined, bearer),
      deviceId
    );
    expect((await claimed.json()) as unknown[]).toHaveLength(1);
    expect(
      (
        await api.acknowledgeCommand(
          request("/ack", { status: "unknown" }, bearer),
          deviceId,
          String(command.id)
        )
      ).status
    ).toBe(422);
    const acknowledged = await api.acknowledgeCommand(
      request(
        "/ack",
        { status: "succeeded", result: { files: 3 } },
        bearer
      ),
      deviceId,
      String(command.id)
    );
    expect((await payload(acknowledged)).status).toBe("succeeded");
  });

  it("maps missing resources to 404", async () => {
    const adminHeaders = { "x-relaydot-admin-token": ADMIN };
    expect(
      (
        await api.createCommand(
          request(
            "/commands",
            { type: "sync", idempotency_key: "x" },
            adminHeaders
          ),
          "missing"
        )
      ).status
    ).toBe(404);
    const device = enroll(store);
    expect(
      (
        await api.acknowledgeCommand(
          request(
            "/ack",
            { status: "failed", error: "nope" },
            { authorization: `Bearer ${device.deviceToken}` }
          ),
          device.deviceId,
          "missing"
        )
      ).status
    ).toBe(404);
  });
});
