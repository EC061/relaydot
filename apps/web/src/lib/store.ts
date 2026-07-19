/** better-sqlite3 WAL persistence and transactional Honker outbox writes. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import honker from "@russellthehippo/honker-node";
import Sqlite from "better-sqlite3";

import { migrations } from "./migrations";
import { createToken, hashToken } from "./security";
import type { Command, CommandStatus, CommandType, Device } from "./types";

const QUEUE = "relaydot";

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

export class AuthenticationError extends Error {}
export class NotFoundError extends Error {}

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
