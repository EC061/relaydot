/** better-sqlite3 WAL persistence and transactional Honker outbox writes. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import honker from "@russellthehippo/honker-node";
import Sqlite from "better-sqlite3";

import type { JsonValue } from "@russellthehippo/honker-node";

import { migrations } from "./migrations";
import { estimateCostMicroUsd, ratesFor } from "./prices";
import { createToken, hashToken } from "./security";
import type {
  AdminSession,
  CatalogCheckRow,
  CatalogModelRow,
  CatalogStatus,
  Command,
  CommandStatus,
  CommandType,
  Device,
  IngestRunRow,
  ModelPriceRow,
  StorageBackendRow,
  UsageFactRow
} from "./types";

const QUEUE = "relaydot";

type JsonObject = Record<string, JsonValue>;

/** Recurring background work, registered with Honker's leader-elected cron. */
export interface ScheduleSpec {
  name: string;
  /** Five- or six-field cron, or Honker's `@every <n><unit>` form. */
  expression: string;
  payload: JsonObject;
}

interface EnrollmentTokenRow {
  id: string;
  expires_at: number;
  consumed_at: number | null;
}

interface CommandRow {
  id: string;
  device_id: string;
  type: CommandType;
  payload_json: string;
  idempotency_key: string;
  status: CommandStatus;
  created_at: number;
  claimed_at: number | null;
  acked_at: number | null;
  result_json: string | null;
  error: string | null;
}

interface CountRow {
  count: number;
}

interface IntegrityRow {
  integrity_check: string;
}

/**
 * Next.js bundles this module once for the server-component graph and once for
 * route handlers, while `getController` shares a single Store across both via
 * `globalThis`. That makes `instanceof` unreliable for errors that cross the
 * boundary, so callers match on a branded code instead and use the guards
 * below rather than `instanceof`.
 */
const ERROR_BRAND = "relaydotErrorCode";

export class AuthenticationError extends Error {
  readonly relaydotErrorCode = "authentication";
}

export class NotFoundError extends Error {
  readonly relaydotErrorCode = "not_found";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = (error as Record<string, unknown>)[ERROR_BRAND];
  return typeof code === "string" ? code : undefined;
}

export function isAuthenticationError(
  error: unknown
): error is AuthenticationError {
  return errorCode(error) === "authentication";
}

export function isNotFoundError(error: unknown): error is NotFoundError {
  return errorCode(error) === "not_found";
}

export class Store {
  readonly sqlite: Sqlite.Database;
  readonly honker: ReturnType<typeof honker.open>;
  readonly queue: ReturnType<ReturnType<typeof honker.open>["queue"]>;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.honker = honker.open(path);
    this.queue = this.honker.queue(QUEUE, {
      visibilityTimeoutS: 60,
      maxAttempts: 5
    });
    this.sqlite = new Sqlite(path);
    const journalMode = this.sqlite.pragma("journal_mode = WAL", { simple: true });
    if (String(journalMode).toLowerCase() !== "wal") {
      throw new Error(`SQLite WAL mode could not be enabled: ${String(journalMode)}`);
    }
    this.sqlite.pragma("synchronous = NORMAL");
    this.sqlite.pragma("foreign_keys = ON");
    this.sqlite.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.sqlite.close();
    this.honker.close();
  }

  health(): { database: string; journal_mode: string; pending_jobs: number } {
    const integrity = this.sqlite
      .prepare("PRAGMA integrity_check")
      .get() as IntegrityRow;
    const pending = this.sqlite
      .prepare("SELECT COUNT(*) AS count FROM _honker_live WHERE queue = ?")
      .get(QUEUE) as CountRow;
    return {
      database: integrity.integrity_check,
      journal_mode: String(this.sqlite.pragma("journal_mode", { simple: true })),
      pending_jobs: pending.count
    };
  }

  createEnrollmentToken(expiresIn: number): {
    id: string;
    token: string;
    expires_at: number;
  } {
    const now = this.now();
    const id = randomUUID();
    const token = createToken();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "INSERT INTO enrollment_tokens(id, token_hash, created_at, expires_at) " +
            "VALUES (?, ?, ?, ?)"
        )
        .run(id, hashToken(token), now, now + expiresIn);
      this.audit("enrollment_token.created", "enrollment_token", id, {});
    })();
    return { id, token, expires_at: now + expiresIn };
  }

  enrollDevice(input: {
    token: string;
    name: string;
    platform: string;
    agent_version: string;
    public_key?: string | null;
  }): { device_id: string; device_token: string } {
    const now = this.now();
    const enrollment = this.sqlite
      .prepare(
        "SELECT id, expires_at, consumed_at FROM enrollment_tokens WHERE token_hash = ?"
      )
      .get(hashToken(input.token)) as EnrollmentTokenRow | undefined;
    if (
      enrollment === undefined ||
      enrollment.consumed_at !== null ||
      enrollment.expires_at < now
    ) {
      throw new AuthenticationError("invalid, expired, or consumed enrollment token");
    }
    const deviceId = randomUUID();
    const deviceToken = createToken();
    this.sqlite.transaction(() => {
      const consumed = this.sqlite
        .prepare(
          "UPDATE enrollment_tokens SET consumed_at = ?, consumed_by = ? " +
            "WHERE id = ? AND consumed_at IS NULL"
        )
        .run(now, deviceId, enrollment.id);
      if (consumed.changes !== 1) {
        throw new AuthenticationError("enrollment token was already consumed");
      }
      this.sqlite
        .prepare(
          "INSERT INTO devices" +
            "(id, name, platform, agent_version, public_key, token_hash, enrolled_at, " +
            "last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          deviceId,
          input.name,
          input.platform,
          input.agent_version,
          input.public_key ?? null,
          hashToken(deviceToken),
          now,
          now
        );
      this.audit("device.enrolled", "device", deviceId, { name: input.name });
    })();
    return { device_id: deviceId, device_token: deviceToken };
  }

  /**
   * Issues a browser session for an operator who already proved knowledge of
   * the controller administrator token. Sessions are stored as hashes so a
   * database copy cannot be replayed against a running controller.
   */
  createAdminSession(ttl: number): { id: string; token: string; expires_at: number } {
    const now = this.now();
    const id = randomUUID();
    const token = createToken();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "INSERT INTO admin_sessions" +
            "(id, token_hash, created_at, expires_at, last_seen_at) " +
            "VALUES (?, ?, ?, ?, ?)"
        )
        .run(id, hashToken(token), now, now + ttl, now);
      this.audit("admin_session.created", "admin_session", id, {});
    })();
    this.purgeExpiredAdminSessions();
    return { id, token, expires_at: now + ttl };
  }

  authenticateAdminSession(token: string): AdminSession {
    const now = this.now();
    const session = this.sqlite
      .prepare("SELECT * FROM admin_sessions WHERE token_hash = ?")
      .get(hashToken(token)) as AdminSession | undefined;
    if (
      session === undefined ||
      session.revoked_at !== null ||
      session.expires_at <= now
    ) {
      throw new AuthenticationError("invalid or expired session");
    }
    this.sqlite
      .prepare("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?")
      .run(now, session.id);
    return { ...session, last_seen_at: now };
  }

  revokeAdminSession(token: string): void {
    const now = this.now();
    const session = this.sqlite
      .prepare("SELECT id FROM admin_sessions WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string } | undefined;
    if (session === undefined) {
      return;
    }
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
        )
        .run(now, session.id);
      this.audit("admin_session.revoked", "admin_session", session.id, {});
    })();
  }

  /** Drops rows that can no longer authenticate anything. */
  purgeExpiredAdminSessions(): number {
    return this.sqlite
      .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
      .run(this.now()).changes;
  }

  authenticateDevice(deviceId: string, token: string): Device {
    const device = this.sqlite
      .prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(deviceId) as Device | undefined;
    if (device === undefined || hashToken(token) !== device.token_hash) {
      throw new AuthenticationError("invalid device credentials");
    }
    return device;
  }

  heartbeat(deviceId: string, agentVersion: string): { server_time: number } {
    const now = this.now();
    const result = this.sqlite
      .prepare("UPDATE devices SET last_seen_at = ?, agent_version = ? WHERE id = ?")
      .run(now, agentVersion, deviceId);
    if (result.changes !== 1) {
      throw new NotFoundError("device not found");
    }
    return { server_time: now };
  }

  listDevices(): Array<Omit<Device, "token_hash" | "public_key">> {
    return this.sqlite
      .prepare(
        "SELECT id, name, platform, agent_version, enrolled_at, last_seen_at, revoked_at " +
          "FROM devices ORDER BY enrolled_at, id"
      )
      .all() as Array<Omit<Device, "token_hash" | "public_key">>;
  }

  createCommand(input: {
    deviceId: string;
    type: CommandType;
    payload: Record<string, unknown>;
    idempotencyKey: string;
  }): Command {
    const device = this.sqlite
      .prepare("SELECT id FROM devices WHERE id = ?")
      .get(input.deviceId);
    if (device === undefined) {
      throw new NotFoundError("device not found");
    }
    const existing = this.sqlite
      .prepare("SELECT * FROM commands WHERE device_id = ? AND idempotency_key = ?")
      .get(input.deviceId, input.idempotencyKey) as CommandRow | undefined;
    if (existing !== undefined) {
      return this.decodeCommand(existing);
    }
    const id = randomUUID();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "INSERT INTO commands" +
            "(id, device_id, type, payload_json, idempotency_key, status, created_at) " +
            "VALUES (?, ?, ?, ?, ?, 'pending', ?)"
        )
        .run(
          id,
          input.deviceId,
          input.type,
          JSON.stringify(input.payload),
          input.idempotencyKey,
          this.now()
        );
      this.sqlite
        .prepare(
          "INSERT INTO _honker_live(queue, payload, max_attempts) VALUES (?, ?, ?)"
        )
        .run(QUEUE, JSON.stringify({ kind: "command_created", command_id: id }), 5);
      this.audit("command.created", "command", id, { type: input.type });
    })();
    return this.getCommand(id);
  }

  claimCommands(deviceId: string, limit: number): Command[] {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          "SELECT * FROM commands WHERE device_id = ? AND status = 'pending' " +
            "ORDER BY created_at, id LIMIT ?"
        )
        .all(deviceId, limit) as CommandRow[];
      const statement = this.sqlite.prepare(
        "UPDATE commands SET status = 'claimed', claimed_at = ? WHERE id = ?"
      );
      const now = this.now();
      for (const row of rows) {
        statement.run(now, row.id);
        row.status = "claimed";
        row.claimed_at = now;
      }
      return rows.map((row) => this.decodeCommand(row));
    })();
  }

  acknowledgeCommand(input: {
    deviceId: string;
    commandId: string;
    status: "succeeded" | "failed";
    result?: Record<string, unknown> | null;
    error?: string | null;
  }): Command {
    const existing = this.sqlite
      .prepare("SELECT * FROM commands WHERE id = ? AND device_id = ?")
      .get(input.commandId, input.deviceId) as CommandRow | undefined;
    if (existing === undefined) {
      throw new NotFoundError("command not found");
    }
    if (existing.status === "succeeded" || existing.status === "failed") {
      return this.decodeCommand(existing);
    }
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "UPDATE commands SET status = ?, acked_at = ?, result_json = ?, error = ? " +
            "WHERE id = ? AND device_id = ?"
        )
        .run(
          input.status,
          this.now(),
          input.result === undefined || input.result === null
            ? null
            : JSON.stringify(input.result),
          input.error ?? null,
          input.commandId,
          input.deviceId
        );
      this.audit(`command.${input.status}`, "command", input.commandId, {});
    })();
    return this.getCommand(input.commandId);
  }

  getCommand(commandId: string): Command {
    const row = this.sqlite
      .prepare("SELECT * FROM commands WHERE id = ?")
      .get(commandId) as CommandRow | undefined;
    if (row === undefined) {
      throw new NotFoundError("command not found");
    }
    return this.decodeCommand(row);
  }

  processOneJob(workerId: string): boolean {
    const job = this.queue.claimOne(workerId);
    if (job === null) {
      return false;
    }
    try {
      const payload = job.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        payload.kind !== "command_created" ||
        typeof payload.command_id !== "string"
      ) {
        throw new Error("unknown job payload");
      }
      this.audit("command.queued", "command", payload.command_id, {});
      job.ack();
      return true;
    } catch (error) {
      job.retry(1, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /**
   * Enqueues background work unless an identical `kind` is already waiting.
   * Recurring jobs are idempotent, so a second copy only adds a redundant run
   * that would contend for the same WebDAV listing.
   */
  enqueueUnique(kind: string, payload: JsonObject = {}): boolean {
    const pending = this.sqlite
      .prepare(
        "SELECT 1 FROM _honker_live WHERE queue = ? AND state IN ('pending', 'claimed') " +
          "AND json_extract(payload, '$.kind') = ?"
      )
      .get(QUEUE, kind);
    if (pending !== undefined) {
      return false;
    }
    this.queue.enqueue({ ...payload, kind });
    return true;
  }

  /**
   * Declares the recurring schedule. Honker elects one leader across every
   * controller replica sharing the database, so registering from each process
   * start is safe and does not double-fire.
   */
  registerSchedules(specs: readonly ScheduleSpec[]): void {
    const scheduler = this.honker.scheduler();
    const existing = new Map(
      scheduler.list().map((entry) => [String(entry.name), entry])
    );
    for (const spec of specs) {
      const current = existing.get(spec.name);
      if (current === undefined) {
        scheduler.add({
          name: spec.name,
          queue: QUEUE,
          schedule: spec.expression,
          payload: spec.payload
        });
        continue;
      }
      // Keep an operator's edited cron in the database from being clobbered on
      // every restart, but do follow a changed expression from configuration.
      if (String(current.cron_expr) !== spec.expression) {
        scheduler.update(spec.name, {
          schedule: spec.expression,
          payload: spec.payload
        });
      }
    }
    for (const [name] of existing) {
      if (name.startsWith("relaydot.") && !specs.some((spec) => spec.name === name)) {
        scheduler.remove(name);
      }
    }
  }

  /** Removes a schedule declared by a configuration that no longer enables it. */
  unregisterSchedule(name: string): void {
    this.honker.scheduler().remove(name);
  }

  /**
   * Saves the single shared WebDAV backend. The password arrives already
   * encrypted so the Store never needs the secret key.
   */
  saveStorageBackend(input: {
    baseUrl: string;
    username: string;
    passwordEncrypted: string;
  }): void {
    const now = this.now();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          "INSERT INTO storage_backends" +
            "(id, kind, base_url, username, password_encrypted, created_at, updated_at) " +
            "VALUES (1, 'webdav', ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, " +
            "username = excluded.username, " +
            "password_encrypted = excluded.password_encrypted, " +
            "updated_at = excluded.updated_at, verified_at = NULL, last_error = NULL"
        )
        .run(input.baseUrl, input.username, input.passwordEncrypted, now, now);
      this.audit("storage.configured", "storage_backend", "1", {
        base_url: input.baseUrl
      });
    })();
  }

  storageBackend(): StorageBackendRow | null {
    return (
      (this.sqlite
        .prepare("SELECT * FROM storage_backends WHERE id = 1")
        .get() as StorageBackendRow | undefined) ?? null
    );
  }

  recordStorageProbe(ok: boolean, error: string | null): void {
    this.sqlite
      .prepare(
        "UPDATE storage_backends SET verified_at = ?, last_error = ? WHERE id = 1"
      )
      .run(ok ? this.now() : null, ok ? null : error);
  }

  deleteStorageBackend(): void {
    this.sqlite.transaction(() => {
      const removed = this.sqlite
        .prepare("DELETE FROM storage_backends WHERE id = 1")
        .run().changes;
      if (removed > 0) {
        this.audit("storage.removed", "storage_backend", "1", {});
      }
    })();
  }

  /** Upserts parsed usage so re-ingesting a grown JSONL file is idempotent. */
  recordUsageFacts(facts: UsageFactRow[]): number {
    if (facts.length === 0) {
      return 0;
    }
    const now = this.now();
    const statement = this.sqlite.prepare(
      "INSERT INTO usage_facts(usage_fact_id, device_id, provider, session_id, model_id, " +
        "occurred_at, input_uncached_tokens, cache_write_5m_tokens, cache_write_1h_tokens, " +
        "cache_write_other_tokens, cache_read_tokens, output_tokens, " +
        "reasoning_output_tokens, estimated_cost_microusd, price_match_status, " +
        "source_path, ingested_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(usage_fact_id) DO UPDATE SET " +
        "estimated_cost_microusd = excluded.estimated_cost_microusd, " +
        "price_match_status = excluded.price_match_status"
    );
    return this.sqlite.transaction(() => {
      let written = 0;
      for (const fact of facts) {
        written += statement.run(
          fact.usage_fact_id,
          fact.device_id,
          fact.provider,
          fact.session_id,
          fact.model_id,
          fact.occurred_at,
          fact.input_uncached_tokens,
          fact.cache_write_5m_tokens,
          fact.cache_write_1h_tokens,
          fact.cache_write_other_tokens,
          fact.cache_read_tokens,
          fact.output_tokens,
          fact.reasoning_output_tokens,
          fact.estimated_cost_microusd,
          fact.price_match_status,
          fact.source_path,
          now
        ).changes;
      }
      return written;
    })();
  }

  markObjectIngested(digest: string, sourcePath: string, records: number): void {
    this.sqlite
      .prepare(
        "INSERT INTO ingested_objects(digest, source_path, records, ingested_at) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT(digest, source_path) DO UPDATE SET " +
          "records = excluded.records, ingested_at = excluded.ingested_at"
      )
      .run(digest, sourcePath, records, this.now());
  }

  isObjectIngested(digest: string, sourcePath: string): boolean {
    return (
      this.sqlite
        .prepare(
          "SELECT 1 FROM ingested_objects WHERE digest = ? AND source_path = ?"
        )
        .get(digest, sourcePath) !== undefined
    );
  }

  upsertModelPrices(prices: ModelPriceRow[]): void {
    const now = this.now();
    const statement = this.sqlite.prepare(
      "INSERT INTO model_prices(model_id, provider, display_name, " +
        "input_uncached_microusd_per_mtok, cache_write_5m_microusd_per_mtok, " +
        "cache_write_1h_microusd_per_mtok, cache_write_other_microusd_per_mtok, " +
        "cache_read_microusd_per_mtok, output_microusd_per_mtok, updated_at, " +
        "source_url, approved_by, effective_date) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(model_id) DO UPDATE SET " +
        "provider = excluded.provider, display_name = excluded.display_name, " +
        "input_uncached_microusd_per_mtok = excluded.input_uncached_microusd_per_mtok, " +
        "cache_write_5m_microusd_per_mtok = excluded.cache_write_5m_microusd_per_mtok, " +
        "cache_write_1h_microusd_per_mtok = excluded.cache_write_1h_microusd_per_mtok, " +
        "cache_write_other_microusd_per_mtok = excluded.cache_write_other_microusd_per_mtok, " +
        "cache_read_microusd_per_mtok = excluded.cache_read_microusd_per_mtok, " +
        "output_microusd_per_mtok = excluded.output_microusd_per_mtok, " +
        "updated_at = excluded.updated_at, source_url = excluded.source_url, " +
        "approved_by = excluded.approved_by, effective_date = excluded.effective_date"
    );
    // A priced model must not keep showing up in the review queue, so the two
    // tables move together inside one transaction.
    const promote = this.sqlite.prepare(
      "UPDATE catalog_models SET status = 'priced', last_seen_at = ? WHERE model_id = ?"
    );
    this.sqlite.transaction(() => {
      for (const price of prices) {
        statement.run(
          price.model_id,
          price.provider,
          price.display_name,
          price.input_uncached_microusd_per_mtok,
          price.cache_write_5m_microusd_per_mtok,
          price.cache_write_1h_microusd_per_mtok,
          price.cache_write_other_microusd_per_mtok,
          price.cache_read_microusd_per_mtok,
          price.output_microusd_per_mtok,
          now,
          price.source_url ?? "",
          price.approved_by ?? "seed",
          price.effective_date ?? ""
        );
        promote.run(now, price.model_id);
        this.repriceModel(price.model_id, price);
      }
    })();
  }

  /**
   * Recomputes the stored cost of facts already ingested for one model.
   *
   * Ingest is content-addressed and skips objects it has parsed, so a rate
   * approved after the fact would otherwise never reach those rows and they
   * would stay `unpriced` forever. Passing null clears the cost, which is what a
   * withdrawn rate means.
   */
  repriceModel(modelId: string, price: ModelPriceRow | null): number {
    const rates = price === null ? null : ratesFor(price);
    const rows = this.sqlite
      .prepare(
        "SELECT usage_fact_id, input_uncached_tokens, cache_write_5m_tokens, " +
          "cache_write_1h_tokens, cache_write_other_tokens, cache_read_tokens, " +
          "output_tokens FROM usage_facts WHERE model_id = ?"
      )
      .all(modelId) as Array<
      { usage_fact_id: string } & Parameters<typeof estimateCostMicroUsd>[0]
    >;
    const statement = this.sqlite.prepare(
      "UPDATE usage_facts SET estimated_cost_microusd = ?, price_match_status = ? " +
        "WHERE usage_fact_id = ?"
    );
    let updated = 0;
    for (const row of rows) {
      updated += statement.run(
        rates === null ? null : estimateCostMicroUsd(row, rates),
        rates === null ? "unpriced" : "exact",
        row.usage_fact_id
      ).changes;
    }
    return updated;
  }

  modelPrices(): ModelPriceRow[] {
    return this.sqlite
      .prepare("SELECT * FROM model_prices ORDER BY model_id")
      .all() as ModelPriceRow[];
  }

  /** Drops an approved rate and returns the model to the review queue. */
  deleteModelPrice(modelId: string): boolean {
    return this.sqlite.transaction(() => {
      const removed = this.sqlite
        .prepare("DELETE FROM model_prices WHERE model_id = ?")
        .run(modelId).changes;
      if (removed === 0) {
        return false;
      }
      this.sqlite
        .prepare(
          "UPDATE catalog_models SET status = 'needs_price' WHERE model_id = ? " +
            "AND status = 'priced'"
        )
        .run(modelId);
      this.repriceModel(modelId, null);
      return true;
    })();
  }

  /* ------------------------------------------------------------- catalog */

  /**
   * Records models the controller has heard of. An existing row keeps its
   * status and origin: a model first seen in usage does not become an
   * officially discovered one just because a later check also listed it.
   */
  observeCatalogModels(
    models: ReadonlyArray<{
      model_id: string;
      provider: string;
      display_name: string;
      origin: CatalogModelRow["origin"];
      source_url?: string;
    }>
  ): number {
    if (models.length === 0) {
      return 0;
    }
    const now = this.now();
    const priced = new Set(
      (
        this.sqlite.prepare("SELECT model_id FROM model_prices").all() as Array<{
          model_id: string;
        }>
      ).map((row) => row.model_id)
    );
    const statement = this.sqlite.prepare(
      "INSERT INTO catalog_models(model_id, provider, display_name, origin, " +
        "source_url, first_seen_at, last_seen_at, status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(model_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, " +
        "display_name = CASE WHEN catalog_models.display_name = catalog_models.model_id " +
        "THEN excluded.display_name ELSE catalog_models.display_name END"
    );
    return this.sqlite.transaction(() => {
      let added = 0;
      for (const model of models) {
        added += statement.run(
          model.model_id,
          model.provider,
          model.display_name,
          model.origin,
          model.source_url ?? "",
          now,
          now,
          priced.has(model.model_id) ? "priced" : "needs_price"
        ).changes;
      }
      return added;
    })();
  }

  catalogModels(): CatalogModelRow[] {
    return this.sqlite
      .prepare("SELECT * FROM catalog_models ORDER BY status, provider, model_id")
      .all() as CatalogModelRow[];
  }

  /**
   * Moves a model in or out of the review queue. Restoring a model that already
   * has an approved rate lands on `priced`, not `needs_price`, so the queue
   * never claims a rate is missing when one exists.
   */
  setCatalogModelStatus(modelId: string, status: CatalogStatus): boolean {
    const resolved =
      status === "needs_price" &&
      this.sqlite.prepare("SELECT 1 FROM model_prices WHERE model_id = ?").get(modelId) !==
        undefined
        ? "priced"
        : status;
    return (
      this.sqlite
        .prepare("UPDATE catalog_models SET status = ? WHERE model_id = ?")
        .run(resolved, modelId).changes === 1
    );
  }

  startCatalogCheck(): string {
    const id = randomUUID();
    this.sqlite
      .prepare(
        "INSERT INTO catalog_checks(id, started_at, status) VALUES (?, ?, 'failed')"
      )
      .run(id, this.now());
    return id;
  }

  finishCatalogCheck(
    id: string,
    outcome: {
      status: CatalogCheckRow["status"];
      discovered: number;
      added: number;
      detail: string;
    }
  ): void {
    this.sqlite
      .prepare(
        "UPDATE catalog_checks SET finished_at = ?, status = ?, discovered = ?, " +
          "added = ?, detail = ? WHERE id = ?"
      )
      .run(
        this.now(),
        outcome.status,
        outcome.discovered,
        outcome.added,
        outcome.detail,
        id
      );
  }

  catalogChecks(limit = 5): CatalogCheckRow[] {
    return this.sqlite
      .prepare("SELECT * FROM catalog_checks ORDER BY started_at DESC, id LIMIT ?")
      .all(limit) as CatalogCheckRow[];
  }

  /* -------------------------------------------------------------- ingest */

  startIngestRun(): string {
    const id = randomUUID();
    this.sqlite
      .prepare("INSERT INTO ingest_runs(id, started_at, status) VALUES (?, ?, 'failed')")
      .run(id, this.now());
    return id;
  }

  finishIngestRun(
    id: string,
    outcome: {
      status: IngestRunRow["status"];
      manifests: number;
      objects_seen: number;
      objects_read: number;
      facts_written: number;
      detail: string;
    }
  ): void {
    this.sqlite
      .prepare(
        "UPDATE ingest_runs SET finished_at = ?, status = ?, manifests = ?, " +
          "objects_seen = ?, objects_read = ?, facts_written = ?, detail = ? WHERE id = ?"
      )
      .run(
        this.now(),
        outcome.status,
        outcome.manifests,
        outcome.objects_seen,
        outcome.objects_read,
        outcome.facts_written,
        outcome.detail,
        id
      );
  }

  ingestRuns(limit = 5): IngestRunRow[] {
    return this.sqlite
      .prepare("SELECT * FROM ingest_runs ORDER BY started_at DESC, id LIMIT ?")
      .all(limit) as IngestRunRow[];
  }

  /** Resolves an agent-published manifest device ID to an enrolled device. */
  deviceExists(deviceId: string): boolean {
    return (
      this.sqlite.prepare("SELECT 1 FROM devices WHERE id = ?").get(deviceId) !==
      undefined
    );
  }

  listAuditEvents(): Array<Record<string, unknown>> {
    const rows = this.sqlite
      .prepare("SELECT * FROM audit_events ORDER BY created_at, id")
      .all() as Array<Record<string, unknown> & { details_json: string }>;
    return rows.map(({ details_json, ...row }) => ({
      ...row,
      details: JSON.parse(details_json) as unknown
    }));
  }

  private migrate(): void {
    this.sqlite.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations " +
        "(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
    );
    const applied = new Set(
      (
        this.sqlite.prepare("SELECT version FROM schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version)
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, this.now());
      })();
    }
  }

  private audit(
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, unknown>
  ): void {
    this.sqlite
      .prepare(
        "INSERT OR IGNORE INTO audit_events" +
          "(id, action, resource_type, resource_id, details_json, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        action,
        resourceType,
        resourceId,
        JSON.stringify(details),
        this.now()
      );
  }

  private decodeCommand(row: CommandRow): Command {
    return {
      id: row.id,
      device_id: row.device_id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      idempotency_key: row.idempotency_key,
      status: row.status,
      created_at: row.created_at,
      claimed_at: row.claimed_at,
      acked_at: row.acked_at,
      result:
        row.result_json === null
          ? null
          : (JSON.parse(row.result_json) as Record<string, unknown>),
      error: row.error
    };
  }

  private now(): number {
    return Math.floor(Date.now() / 1000);
  }
}
