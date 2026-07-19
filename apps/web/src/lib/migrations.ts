/** Ordered, immutable SQLite schema migrations. */
export interface Migration {
  version: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE enrollment_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by TEXT
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        agent_version TEXT NOT NULL,
        public_key TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        enrolled_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE commands (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES devices(id),
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'succeeded', 'failed')),
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        acked_at INTEGER,
        result_json TEXT,
        error TEXT,
        UNIQUE(device_id, idempotency_key)
      );

      CREATE INDEX commands_claim_idx
        ON commands(device_id, status, created_at, id);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX audit_action_resource_idx
        ON audit_events(action, resource_type, resource_id);
    `
  }
];
