import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ControllerApi } from "./api";
import { deriveSecretKey, encryptSecret } from "./crypto";
import { SESSION_COOKIE, resetLoginThrottle } from "./security";
import { enroll, temporaryStore } from "./test-helpers";
import type { Store } from "./store";

const ADMIN = "admin-test-token";

function sessionCookieValue(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
  return match === null ? "" : decodeURIComponent(match[1]);
}

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
    resetLoginThrottle();
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

  it("issues a browser session only for the administrator token", async () => {
    expect((await api.signIn(request("/session", {}))).status).toBe(422);
    const rejected = await api.signIn(request("/session", { token: "wrong" }));
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("set-cookie")).toBeNull();

    const accepted = await api.signIn(request("/session", { token: ADMIN }));
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(sessionCookieValue(accepted)).not.toBe("");
  });

  it("authorizes administrator routes with a session cookie", async () => {
    const signedIn = await api.signIn(request("/session", { token: ADMIN }));
    const cookie = { cookie: `${SESSION_COOKIE}=${sessionCookieValue(signedIn)}` };

    expect(api.listDevices(request("/devices", undefined, cookie)).status).toBe(200);
    expect(
      api.listDevices(
        request("/devices", undefined, { cookie: `${SESSION_COOKIE}=forged` })
      ).status
    ).toBe(401);

    const signedOut = api.signOut(request("/session", undefined, cookie));
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(api.listDevices(request("/devices", undefined, cookie)).status).toBe(401);
  });

  it("rejects cross-origin cookie use and throttles sign-in guessing", async () => {
    const signedIn = await api.signIn(request("/session", { token: ADMIN }));
    const cookie = `${SESSION_COOKIE}=${sessionCookieValue(signedIn)}`;

    expect(
      api.listDevices(
        request("/devices", undefined, {
          cookie,
          origin: "https://evil.test",
          host: "controller.test"
        })
      ).status
    ).toBe(403);
    expect(
      (
        await api.signIn(
          request(
            "/session",
            { token: ADMIN },
            { origin: "https://evil.test", host: "controller.test" }
          )
        )
      ).status
    ).toBe(403);
    expect(
      api.signOut(
        request("/session", undefined, {
          cookie,
          origin: "https://evil.test",
          host: "controller.test"
        })
      ).status
    ).toBe(403);

    const client = { "x-forwarded-for": "203.0.113.9" };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await api.signIn(
        request("/session", { token: "guess" }, client)
      );
      expect(response.status).toBe(401);
    }
    const blocked = await api.signIn(request("/session", { token: ADMIN }, client));
    expect(blocked.status).toBe(429);
  });

  it("pins origin checks and cookie flags to the configured public URL", async () => {
    const pinned = new ControllerApi(store, ADMIN, "https://relaydot.example.com");

    // A forged Host header cannot widen the check once a public URL is set.
    const forged = await pinned.signIn(
      request(
        "/session",
        { token: ADMIN },
        { origin: "https://evil.test", host: "evil.test" }
      )
    );
    expect(forged.status).toBe(403);

    const accepted = await pinned.signIn(
      request(
        "/session",
        { token: ADMIN },
        { origin: "https://relaydot.example.com", host: "relaydot.example.com" }
      )
    );
    expect(accepted.status).toBe(200);
    // Plain-HTTP transport inside the container still yields a Secure cookie
    // because the public URL is https.
    expect(accepted.headers.get("set-cookie")).toContain("Secure");
  });

  it("stores the WebDAV backend, hides the password, and probes it", async () => {
    const calls: string[] = [];
    const storageApi = new ControllerApi(
      store,
      ADMIN,
      null,
      deriveSecretKey("secret-key"),
      async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
        return new Response("<d:multistatus xmlns:d='DAV:'/>", { status: 207 });
      }
    );
    const adminHeaders = { "x-relaydot-admin-token": ADMIN };

    expect(await payload(storageApi.storage(request("/storage", undefined, adminHeaders))))
      .toEqual({ configured: false });

    expect(
      (await storageApi.saveStorage(request("/storage", { base_url: "nope" }, adminHeaders)))
        .status
    ).toBe(422);
    expect(
      (
        await storageApi.saveStorage(
          request("/storage", { base_url: "ftp://x/y", username: "u", password: "p" }, adminHeaders)
        )
      ).status
    ).toBe(422);

    const saved = await storageApi.saveStorage(
      request(
        "/storage",
        { base_url: "https://dav.test/dav", username: "relaydot", password: "hunter2" },
        adminHeaders
      )
    );
    expect(saved.status).toBe(200);
    // Collections are created and the root listed as the reachability probe.
    expect(calls).toContain("MKCOL /dav/objects");
    expect(calls).toContain("MKCOL /dav/manifests");
    expect((await payload(saved)).ok).toBe(true);

    const shown = await payload(
      storageApi.storage(request("/storage", undefined, adminHeaders))
    );
    expect(shown.base_url).toBe("https://dav.test/dav/");
    expect(shown.username).toBe("relaydot");
    // The password must never be returned to the browser.
    expect(JSON.stringify(shown)).not.toContain("hunter2");

    expect(storageApi.storage(request("/storage")).status).toBe(401);
    expect(
      (await storageApi.saveStorage(request("/storage", {}))).status
    ).toBe(401);
    expect(storageApi.deleteStorage(request("/storage")).status).toBe(401);
    expect((await storageApi.testStorage(request("/storage", {}))).status).toBe(401);

    expect((await payload(await storageApi.testStorage(request("/t", {}, adminHeaders)))).ok).toBe(
      true
    );
    expect(
      await payload(storageApi.deleteStorage(request("/storage", undefined, adminHeaders)))
    ).toEqual({ configured: false });
  });

  it("records a failed probe instead of throwing", async () => {
    const failing = new ControllerApi(
      store,
      ADMIN,
      null,
      deriveSecretKey("secret-key"),
      async () => new Response("", { status: 401 })
    );
    const adminHeaders = { "x-relaydot-admin-token": ADMIN };
    const saved = await failing.saveStorage(
      request(
        "/storage",
        { base_url: "https://dav.test/dav", username: "u", password: "p" },
        adminHeaders
      )
    );
    const body = await payload(saved);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/rejected the credential/);
    expect(store.storageBackend()?.last_error).toMatch(/rejected the credential/);
  });

  it("hands the credential to an enrolled device and no one else", async () => {
    const withKey = new ControllerApi(store, ADMIN, null, deriveSecretKey("secret-key"));
    const device = enroll(store);
    const bearer = { authorization: `Bearer ${device.deviceToken}` };

    // Nothing configured yet.
    expect(
      withKey.deviceStorage(request("/storage", undefined, bearer), device.deviceId).status
    ).toBe(409);

    store.saveStorageBackend({
      baseUrl: "https://dav.test/dav/",
      username: "relaydot",
      passwordEncrypted: encryptSecret("hunter2", deriveSecretKey("secret-key"))
    });

    const granted = await payload(
      withKey.deviceStorage(request("/storage", undefined, bearer), device.deviceId)
    );
    expect(granted.base_url).toBe("https://dav.test/dav/");
    expect(granted.password).toBe("hunter2");
    expect(granted.objects_prefix).toBe("objects");

    expect(withKey.deviceStorage(request("/storage"), device.deviceId).status).toBe(401);
    expect(
      withKey.deviceStorage(
        request("/storage", undefined, { authorization: "Bearer wrong" }),
        device.deviceId
      ).status
    ).toBe(401);

    // A rotated secret key makes the stored password unreadable rather than
    // returning garbage to the agent.
    const rotated = new ControllerApi(store, ADMIN, null, deriveSecretKey("different"));
    expect(
      rotated.deviceStorage(request("/storage", undefined, bearer), device.deviceId).status
    ).toBe(409);
  });

  it("refuses to store a password with no secret key available", async () => {
    const keyless = new ControllerApi(store, ADMIN);
    const response = await keyless.saveStorage(
      request(
        "/storage",
        { base_url: "https://dav.test/dav", username: "u", password: "p" },
        { "x-relaydot-admin-token": ADMIN }
      )
    );
    expect(response.status).toBe(422);
    expect(String((await payload(response)).error)).toMatch(/secret key/);
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

describe("usage ingest and price catalog endpoints", () => {
  let store: Store;
  let cleanup: () => void;
  const KEY = deriveSecretKey("api-catalog-tests");
  const SOURCES = join(import.meta.dirname, "../../../../config/catalog-sources.yaml");

  const admin = { "x-relaydot-admin-token": ADMIN };

  beforeEach(() => {
    const fixture = temporaryStore();
    store = fixture.store;
    cleanup = fixture.cleanup;
    resetLoginThrottle();
  });

  afterEach(() => cleanup());

  function build(fetchImpl: typeof fetch = fetch, sources: string | null = SOURCES) {
    return new ControllerApi(store, ADMIN, null, KEY, fetchImpl, sources);
  }

  function configureStorage(): void {
    store.saveStorageBackend({
      baseUrl: "https://dav.test/",
      username: "u",
      passwordEncrypted: encryptSecret("p", KEY)
    });
  }

  function approve(
    body: Record<string, unknown>,
    api = build()
  ): Promise<Response> {
    return api.savePrice(
      new Request("http://controller.test/prices", {
        method: "PUT",
        headers: { "content-type": "application/json", ...admin },
        body: JSON.stringify(body)
      })
    );
  }

  const VALID = {
    model_id: "gpt-5.6-sol",
    provider: "openai",
    display_name: "GPT-5.6 Sol",
    input_usd_per_mtok: 1.25,
    output_usd_per_mtok: 10,
    source_url: "https://developers.openai.com/api/docs/pricing"
  };

  it("requires a credential on every new endpoint", async () => {
    const api = build();
    expect(api.usageIngestStatus(request("/usage/ingest")).status).toBe(401);
    expect((await api.ingestNow(request("/usage/ingest", {}))).status).toBe(401);
    expect(api.catalog(request("/catalog")).status).toBe(401);
    expect((await api.checkCatalog(request("/catalog/check", {}))).status).toBe(401);
    expect((await approve(VALID, build())).status).toBe(200);
    expect(api.deletePrice(request("/prices/x"), "x").status).toBe(401);
  });

  it("reports ingest freshness and refuses to run without a backend", async () => {
    const api = build();
    const status = await payload(api.usageIngestStatus(request("/usage/ingest", undefined, admin)));
    expect(status.configured).toBe(false);
    expect(status.runs).toEqual([]);

    const response = await api.ingestNow(request("/usage/ingest", {}, admin));
    expect(response.status).toBe(409);
    expect((await payload(response)).error).toContain("no storage backend");
  });

  it("reads the object store when asked and records the run", async () => {
    configureStorage();
    const api = build(async (_url, init) =>
      init?.method === "PROPFIND"
        ? new Response('<d:multistatus xmlns:d="DAV:"></d:multistatus>', { status: 207 })
        : new Response("", { status: 404 })
    );
    const report = await payload(await api.ingestNow(request("/usage/ingest", {}, admin)));
    expect(report.status).toBe("ok");
    expect(report.manifests).toBe(0);

    const status = await payload(api.usageIngestStatus(request("/usage/ingest", undefined, admin)));
    expect(status.configured).toBe(true);
    expect((status.runs as unknown[]).length).toBe(1);
  });

  it("returns the declared sources, the review queue, and approved rates", async () => {
    const body = await payload(build().catalog(request("/catalog", undefined, admin)));
    expect((body.sources as Record<string, unknown>).auto_apply).toBe(false);
    expect(body.sources_error).toBeNull();
    expect(body.models).toEqual([]);
    expect(body.prices).toEqual([]);
  });

  it("reports a missing source configuration instead of failing the page", async () => {
    const body = await payload(
      build(fetch, null).catalog(request("/catalog", undefined, admin))
    );
    expect(body.sources).toBeNull();
    expect(body.sources_error).toContain("no catalog source configuration path");

    const response = await build(fetch, null).checkCatalog(
      request("/catalog/check", {}, admin)
    );
    expect(response.status).toBe(422);
  });

  it("runs a check against the declared sources", async () => {
    const report = await payload(
      await build(async () => Response.json({ data: [{ id: "discovered-model" }] }), SOURCES)
        .checkCatalog(request("/catalog/check", {}, admin))
    );
    // No provider credential is set in the test environment, so both optional
    // model APIs are skipped rather than treated as failures.
    expect(report.status).toBe("ok");
    expect(report.discovered).toBe(0);
  });

  it("approves a rate only with a source locator and sane numbers", async () => {
    expect((await approve(VALID)).status).toBe(200);
    expect(store.modelPrices()[0].source_url).toBe(VALID.source_url);
    expect(store.modelPrices()[0].approved_by).toBe("operator");

    for (const [override, message] of [
      [{ source_url: "http://insecure.example.com" }, /https/],
      [{ source_url: "not-a-url" }, /absolute URL/],
      [{ source_url: undefined }, /source_url/],
      [{ input_usd_per_mtok: -1 }, /nonnegative/],
      [{ output_usd_per_mtok: "free" }, /nonnegative/],
      [{ provider: "gemini" }, /claude or openai/],
      [{ model_id: "" }, /model_id/]
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const response = await approve({ ...VALID, ...override });
      expect(response.status, JSON.stringify(override)).toBe(422);
      expect(String((await payload(response)).error)).toMatch(message);
    }
  });

  it("defaults cache rates to the input rate rather than guessing a discount", async () => {
    await approve(VALID);
    const [price] = store.modelPrices();
    expect(price.cache_read_microusd_per_mtok).toBe(1_250_000);
    expect(price.cache_write_5m_microusd_per_mtok).toBe(1_250_000);

    await approve({ ...VALID, cache_read_usd_per_mtok: 0.125, confirm: true });
    expect(store.modelPrices()[0].cache_read_microusd_per_mtok).toBe(125_000);
  });

  it("blocks a large rate move until it is confirmed", async () => {
    await approve(VALID);
    const blocked = await approve({ ...VALID, input_usd_per_mtok: 9 });
    expect(blocked.status).toBe(409);
    const body = await payload(blocked);
    expect(body.requires_confirmation).toBe(true);
    expect(String(body.error)).toContain("review threshold");

    expect((await approve({ ...VALID, input_usd_per_mtok: 9, confirm: true })).status).toBe(200);
    expect(store.modelPrices()[0].input_uncached_microusd_per_mtok).toBe(9_000_000);
  });

  it("withdraws a rate and reports an unknown one", async () => {
    await approve(VALID);
    const api = build();
    expect(api.deletePrice(request("/prices", undefined, admin), "gpt-5.6-sol").status).toBe(200);
    expect(store.modelPrices()).toEqual([]);
    expect(api.deletePrice(request("/prices", undefined, admin), "gpt-5.6-sol").status).toBe(404);
  });

  it("moves a model in and out of the review queue", async () => {
    store.observeCatalogModels([
      { model_id: "m", provider: "openai", display_name: "m", origin: "usage" }
    ]);
    const api = build();
    const patch = (status: string, modelId = "m") =>
      api.setCatalogStatus(
        new Request("http://controller.test/catalog/models", {
          method: "PATCH",
          headers: { "content-type": "application/json", ...admin },
          body: JSON.stringify({ status })
        }),
        modelId
      );

    expect((await patch("ignored")).status).toBe(200);
    expect(store.catalogModels()[0].status).toBe("ignored");
    expect((await patch("needs_price")).status).toBe(200);
    expect((await patch("priced")).status).toBe(422);
    expect((await patch("ignored", "unknown-model")).status).toBe(404);
  });
});
