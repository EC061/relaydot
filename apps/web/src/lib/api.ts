import { Store, isAuthenticationError, isNotFoundError } from "./store";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  isSameOrigin,
  loginThrottle,
  readCookie,
  sessionCookie,
  tokensMatch
} from "./security";
import { encryptSecret } from "./crypto";
import { loadCatalogSources, refreshCatalog } from "./catalog";
import { runIngest } from "./ingest";
import { resolveStorage } from "./storage";
import { WebdavClient, normalizeBaseUrl } from "./webdav";
import type { PublicUrl } from "./security";
import type { CatalogStatus, CommandType, ModelPriceRow } from "./types";

const commandTypes = new Set<CommandType>([
  "sync",
  "update_agent",
  "reload_policy",
  "collect_diagnostics"
]);

class ValidationError extends Error {}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

/** Dollars per million tokens. Nonnegative and finite, per the declared rules. */
function requireRate(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} must be a nonnegative number`);
  }
  return value;
}

function optionalRate(
  body: Record<string, unknown>,
  field: string
): number | undefined {
  return body[field] === undefined || body[field] === null
    ? undefined
    : requireRate(body, field);
}

function json(value: unknown, status = 200, setCookie?: string): Response {
  return Response.json(value, {
    status,
    headers: setCookie === undefined ? undefined : { "set-cookie": setCookie }
  });
}

/** Best-effort client identity for throttling behind a reverse proxy. */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export class ControllerApi {
  constructor(
    private readonly store: Store,
    private readonly adminToken: string,
    private readonly publicUrl: PublicUrl = null,
    /** Null disables storage-credential features rather than failing requests. */
    private readonly secretKey: Buffer | null = null,
    /** Injectable so storage probes are testable without a WebDAV server. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Declared official catalog sources; absent disables catalog checks. */
    private readonly catalogSourcesPath: string | null = null
  ) {}

  health(): Response {
    return json({
      status: "ok",
      version: "0.1.0",
      ...this.store.health()
    });
  }

  /**
   * Exchanges the controller administrator token for an HttpOnly browser
   * session, so the operator token is never held in page state or replayed by
   * the dashboard on every request.
   */
  async signIn(request: Request): Promise<Response> {
    if (!isSameOrigin(request, this.publicUrl)) {
      return json({ error: "cross-origin sign-in rejected" }, 403);
    }
    const throttle = loginThrottle(clientKey(request));
    if (throttle.blocked) {
      return json({ error: "too many sign-in attempts" }, 429);
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (typeof body.token !== "string" || body.token.length === 0) {
        throw new ValidationError("token must be a non-empty string");
      }
      if (!tokensMatch(body.token, this.adminToken)) {
        throttle.fail();
        return json({ error: "invalid admin token" }, 401);
      }
      throttle.reset();
      const session = this.store.createAdminSession(SESSION_TTL_SECONDS);
      return json(
        { expires_at: session.expires_at },
        200,
        sessionCookie(request, session.token, SESSION_TTL_SECONDS, this.publicUrl)
      );
    });
  }

  signOut(request: Request): Response {
    if (!isSameOrigin(request, this.publicUrl)) {
      return json({ error: "cross-origin sign-out rejected" }, 403);
    }
    const token = readCookie(request, SESSION_COOKIE);
    if (token !== null) {
      this.store.revokeAdminSession(token);
    }
    return json(
      { status: "signed_out" },
      200,
      clearedSessionCookie(request, this.publicUrl)
    );
  }

  /** Current WebDAV configuration, never including the password. */
  storage(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const backend = this.store.storageBackend();
    if (backend === null) {
      return json({ configured: false });
    }
    return json({
      configured: true,
      kind: backend.kind,
      base_url: backend.base_url,
      username: backend.username,
      updated_at: backend.updated_at,
      verified_at: backend.verified_at,
      last_error: backend.last_error
    });
  }

  async saveStorage(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      for (const field of ["base_url", "username", "password"] as const) {
        if (typeof body[field] !== "string" || body[field].length === 0) {
          throw new ValidationError(`${field} must be a non-empty string`);
        }
      }
      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(body.base_url as string);
      } catch (error) {
        throw new ValidationError(
          error instanceof Error ? error.message : "invalid WebDAV base URL"
        );
      }
      if (this.secretKey === null) {
        throw new ValidationError(
          "controller secret key is unavailable; cannot store the WebDAV password"
        );
      }
      this.store.saveStorageBackend({
        baseUrl,
        username: body.username as string,
        passwordEncrypted: encryptSecret(body.password as string, this.secretKey)
      });
      const probe = await this.probeStorage();
      return json({ configured: true, base_url: baseUrl, ...probe });
    });
  }

  async testStorage(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => json(await this.probeStorage()));
  }

  deleteStorage(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    this.store.deleteStorageBackend();
    return json({ configured: false });
  }

  /**
   * Hands the WebDAV credential to an enrolled device so it can read and write
   * objects directly, keeping file bytes out of the controller's path.
   */
  deviceStorage(request: Request, deviceId: string): Response {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const resolved = this.resolveStorage();
    if (resolved === null) {
      return json({ error: "no storage backend is configured" }, 409);
    }
    return json({
      kind: "webdav",
      base_url: resolved.baseUrl,
      username: resolved.username,
      password: resolved.password,
      objects_prefix: "objects",
      manifests_prefix: "manifests"
    });
  }

  /** Verifies the credential and records the outcome for the panel. */
  private async probeStorage(): Promise<{
    ok: boolean;
    verified_at: number | null;
    error: string | null;
  }> {
    const resolved = this.resolveStorage();
    if (resolved === null) {
      return { ok: false, verified_at: null, error: "no storage backend configured" };
    }
    const client = new WebdavClient(resolved, this.fetchImpl);
    try {
      await client.ensureCollection("objects");
      await client.ensureCollection("manifests");
      await client.list("", "1");
      this.store.recordStorageProbe(true, null);
      const backend = this.store.storageBackend();
      return { ok: true, verified_at: backend?.verified_at ?? null, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.recordStorageProbe(false, message);
      return { ok: false, verified_at: null, error: message };
    }
  }

  private resolveStorage() {
    return resolveStorage(this.store, this.secretKey);
  }

  /* ------------------------------------------------------- usage ingest */

  /** Recent ingest attempts, so an operator can see analytics freshness. */
  usageIngestStatus(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return json({
      configured: this.store.storageBackend() !== null,
      runs: this.store.ingestRuns(5)
    });
  }

  /**
   * Reads the shared object store now rather than waiting for the schedule.
   * Runs inline because the operator pressed a button and wants the outcome;
   * work is bounded by the objects whose digests have not been parsed yet.
   */
  async ingestNow(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const resolved = this.resolveStorage();
      if (resolved === null) {
        return json({ error: "no storage backend is configured" }, 409);
      }
      const report = await runIngest(
        this.store,
        new WebdavClient(resolved, this.fetchImpl)
      );
      return json(report);
    });
  }

  /* ----------------------------------------------------- price catalog */

  catalog(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const loaded =
      this.catalogSourcesPath === null
        ? { sources: null, error: "no catalog source configuration path is set" }
        : loadCatalogSources(this.catalogSourcesPath);
    return json({
      sources:
        loaded.sources === null
          ? null
          : {
              schedule: loaded.sources.schedule,
              auto_apply: loaded.sources.autoApply,
              providers: loaded.sources.providers.map((provider) => ({
                key: provider.key,
                provider: provider.provider,
                model_api_enabled: provider.modelApi?.enabled ?? false,
                model_documents: provider.modelDocuments,
                pricing_documents: provider.pricingDocuments
              }))
            },
      sources_error: loaded.error,
      models: this.store.catalogModels(),
      prices: this.store.modelPrices(),
      checks: this.store.catalogChecks(5)
    });
  }

  async checkCatalog(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      if (this.catalogSourcesPath === null) {
        throw new ValidationError("no catalog source configuration path is set");
      }
      const loaded = loadCatalogSources(this.catalogSourcesPath);
      if (loaded.sources === null) {
        throw new ValidationError(loaded.error);
      }
      return json(
        await refreshCatalog(this.store, loaded.sources, {
          fetchImpl: this.fetchImpl
        })
      );
    });
  }

  /**
   * Approves a rate for one model. `config/catalog-sources.yaml` sets
   * `autoApply: false`, so this is the only path into `model_prices` besides the
   * reviewed built-in seed, and it enforces the declared validation rules: a
   * source locator per rate, nonnegative rates, and an explicit confirmation
   * when an existing rate moves by more than the configured percentage.
   */
  async savePrice(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      const modelId = requireString(body, "model_id");
      const provider = requireString(body, "provider");
      if (provider !== "claude" && provider !== "openai") {
        throw new ValidationError("provider must be claude or openai");
      }
      const sourceUrl = requireString(body, "source_url");
      let parsedSource: URL;
      try {
        parsedSource = new URL(sourceUrl);
      } catch {
        throw new ValidationError("source_url must be an absolute URL");
      }
      if (parsedSource.protocol !== "https:") {
        throw new ValidationError("source_url must use https");
      }

      const input = requireRate(body, "input_usd_per_mtok");
      const output = requireRate(body, "output_usd_per_mtok");
      // Neutral defaults: no cache discount or premium unless stated. Guessing
      // a provider's multipliers would put an invented number on real spend.
      const cacheRead = optionalRate(body, "cache_read_usd_per_mtok") ?? input;
      const write5m = optionalRate(body, "cache_write_5m_usd_per_mtok") ?? input;
      const write1h = optionalRate(body, "cache_write_1h_usd_per_mtok") ?? input;

      const row: ModelPriceRow = {
        model_id: modelId,
        provider,
        display_name:
          typeof body.display_name === "string" && body.display_name.length > 0
            ? body.display_name
            : modelId,
        input_uncached_microusd_per_mtok: Math.round(input * 1_000_000),
        cache_write_5m_microusd_per_mtok: Math.round(write5m * 1_000_000),
        cache_write_1h_microusd_per_mtok: Math.round(write1h * 1_000_000),
        cache_write_other_microusd_per_mtok: Math.round(write5m * 1_000_000),
        cache_read_microusd_per_mtok: Math.round(cacheRead * 1_000_000),
        output_microusd_per_mtok: Math.round(output * 1_000_000),
        updated_at: 0,
        source_url: sourceUrl,
        approved_by: "operator",
        effective_date:
          typeof body.effective_date === "string" ? body.effective_date : ""
      };

      const guard = this.rateChangeGuard(row, body.confirm === true);
      if (guard !== null) {
        return json({ error: guard, requires_confirmation: true }, 409);
      }
      this.store.upsertModelPrices([row]);
      return json({ model_id: modelId, status: "approved" });
    });
  }

  deletePrice(request: Request, modelId: string): Response {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    if (!this.store.deleteModelPrice(modelId)) {
      return json({ error: "no approved price for that model" }, 404);
    }
    return json({ model_id: modelId, status: "withdrawn" });
  }

  async setCatalogStatus(request: Request, modelId: string): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      const status = body.status;
      if (status !== "needs_price" && status !== "ignored") {
        throw new ValidationError("status must be needs_price or ignored");
      }
      if (!this.store.setCatalogModelStatus(modelId, status as CatalogStatus)) {
        return json({ error: "unknown model" }, 404);
      }
      return json({ model_id: modelId, status });
    });
  }

  /**
   * Returns a message when a rate moves further than the configured percentage
   * without confirmation, matching `validation.blockOnRateChangePercent`.
   */
  private rateChangeGuard(row: ModelPriceRow, confirmed: boolean): string | null {
    if (confirmed) {
      return null;
    }
    const loaded =
      this.catalogSourcesPath === null
        ? null
        : loadCatalogSources(this.catalogSourcesPath).sources;
    const threshold = loaded?.validation.blockOnRateChangePercent ?? 50;
    const existing = this.store
      .modelPrices()
      .find((price) => price.model_id === row.model_id);
    if (existing === undefined) {
      return null;
    }
    const fields: Array<keyof ModelPriceRow> = [
      "input_uncached_microusd_per_mtok",
      "cache_write_5m_microusd_per_mtok",
      "cache_write_1h_microusd_per_mtok",
      "cache_read_microusd_per_mtok",
      "output_microusd_per_mtok"
    ];
    for (const field of fields) {
      const before = Number(existing[field]);
      const after = Number(row[field]);
      if (before === 0) {
        continue;
      }
      const change = (Math.abs(after - before) / before) * 100;
      if (change > threshold) {
        return (
          `${field} changes by ${change.toFixed(0)}%, over the ${threshold}% ` +
          "review threshold; resubmit with confirm to approve"
        );
      }
    }
    return null;
  }

  async createEnrollmentToken(request: Request): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      const expiresIn = body.expires_in ?? 600;
      if (
        typeof expiresIn !== "number" ||
        !Number.isInteger(expiresIn) ||
        expiresIn < 60 ||
        expiresIn > 86_400
      ) {
        throw new ValidationError(
          "expires_in must be an integer from 60 to 86400"
        );
      }
      return json(this.store.createEnrollmentToken(expiresIn));
    });
  }

  async enroll(request: Request): Promise<Response> {
    return this.handle(async () => {
      const body = await bodyObject(request);
      for (const field of [
        "token",
        "name",
        "platform",
        "agent_version"
      ] as const) {
        if (typeof body[field] !== "string" || body[field].length === 0) {
          throw new ValidationError(`${field} must be a non-empty string`);
        }
      }
      return json(
        this.store.enrollDevice({
          token: body.token as string,
          name: body.name as string,
          platform: body.platform as string,
          agent_version: body.agent_version as string,
          public_key: typeof body.public_key === "string" ? body.public_key : null
        }),
        201
      );
    });
  }

  listDevices(request: Request): Response {
    const unauthorized = this.requireAdmin(request);
    return unauthorized ?? json(this.store.listDevices());
  }

  async heartbeat(request: Request, deviceId: string): Promise<Response> {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (
        typeof body.agent_version !== "string" ||
        body.agent_version.length === 0
      ) {
        throw new ValidationError("agent_version must be a non-empty string");
      }
      return json(this.store.heartbeat(deviceId, body.agent_version));
    });
  }

  async createCommand(
    request: Request,
    deviceId: string
  ): Promise<Response> {
    const unauthorized = this.requireAdmin(request);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (
        typeof body.type !== "string" ||
        !commandTypes.has(body.type as CommandType)
      ) {
        throw new ValidationError("unsupported command type");
      }
      if (
        typeof body.idempotency_key !== "string" ||
        body.idempotency_key.length === 0 ||
        body.idempotency_key.length > 200
      ) {
        throw new ValidationError(
          "idempotency_key must contain 1 to 200 characters"
        );
      }
      const payload =
        typeof body.payload === "object" &&
        body.payload !== null &&
        !Array.isArray(body.payload)
          ? (body.payload as Record<string, unknown>)
          : {};
      return json(
        this.store.createCommand({
          deviceId,
          type: body.type as CommandType,
          payload,
          idempotencyKey: body.idempotency_key
        })
      );
    });
  }

  claimCommands(request: Request, deviceId: string): Response {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? "10");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return json({ error: "limit must be an integer from 1 to 100" }, 422);
    }
    return json(this.store.claimCommands(deviceId, limit));
  }

  async acknowledgeCommand(
    request: Request,
    deviceId: string,
    commandId: string
  ): Promise<Response> {
    const unauthorized = this.requireDevice(request, deviceId);
    if (unauthorized !== null) {
      return unauthorized;
    }
    return this.handle(async () => {
      const body = await bodyObject(request);
      if (body.status !== "succeeded" && body.status !== "failed") {
        throw new ValidationError("status must be succeeded or failed");
      }
      return json(
        this.store.acknowledgeCommand({
          deviceId,
          commandId,
          status: body.status,
          result:
            typeof body.result === "object" &&
            body.result !== null &&
            !Array.isArray(body.result)
              ? (body.result as Record<string, unknown>)
              : null,
          error: typeof body.error === "string" ? body.error : null
        })
      );
    });
  }

  /**
   * Accepts either the administrator token header, used by scripts and the
   * agent tooling, or a browser session cookie issued by `signIn`. Cookie
   * credentials are ambient, so they additionally require a same-origin
   * request before any state change.
   */
  private requireAdmin(request: Request): Response | null {
    const token = request.headers.get("x-relaydot-admin-token");
    if (token !== null) {
      return tokensMatch(token, this.adminToken)
        ? null
        : json({ error: "invalid admin token" }, 401);
    }
    const session = readCookie(request, SESSION_COOKIE);
    if (session === null) {
      return json({ error: "authentication required" }, 401);
    }
    if (!isSameOrigin(request, this.publicUrl)) {
      return json({ error: "cross-origin request rejected" }, 403);
    }
    try {
      this.store.authenticateAdminSession(session);
      return null;
    } catch (error) {
      if (isAuthenticationError(error)) {
        return json({ error: error.message }, 401);
      }
      throw error;
    }
  }

  private requireDevice(request: Request, deviceId: string): Response | null {
    const authorization = request.headers.get("authorization");
    if (authorization === null || !authorization.startsWith("Bearer ")) {
      return json({ error: "missing device bearer token" }, 401);
    }
    try {
      this.store.authenticateDevice(
        deviceId,
        authorization.slice("Bearer ".length)
      );
      return null;
    } catch (error) {
      if (isAuthenticationError(error)) {
        return json({ error: error.message }, 401);
      }
      throw error;
    }
  }

  private async handle(action: () => Promise<Response>): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ValidationError) {
        return json({ error: error.message }, 422);
      }
      if (isAuthenticationError(error)) {
        return json({ error: error.message }, 401);
      }
      if (isNotFoundError(error)) {
        return json({ error: error.message }, 404);
      }
      throw error;
    }
  }
}
