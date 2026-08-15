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
  },
  {
    version: 2,
    sql: `
      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX admin_sessions_expires_idx ON admin_sessions(expires_at);
    `
  },
  {
    version: 3,
    sql: `
      -- Single-row table: the one WebDAV backend all agents share.
      CREATE TABLE storage_backends (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kind TEXT NOT NULL CHECK (kind IN ('webdav')),
        base_url TEXT NOT NULL,
        username TEXT NOT NULL,
        password_encrypted TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        verified_at INTEGER,
        last_error TEXT
      );

      -- Normalized per-event usage, parsed from conversation history.
      CREATE TABLE usage_facts (
        usage_fact_id TEXT PRIMARY KEY,
        device_id TEXT REFERENCES devices(id),
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        input_uncached_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_other_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_microusd INTEGER,
        price_match_status TEXT NOT NULL DEFAULT 'assumed',
        source_path TEXT NOT NULL DEFAULT '',
        ingested_at INTEGER NOT NULL
      );

      CREATE INDEX usage_facts_time_idx ON usage_facts(occurred_at);
      CREATE INDEX usage_facts_model_idx ON usage_facts(model_id, occurred_at);
      CREATE INDEX usage_facts_provider_idx ON usage_facts(provider, occurred_at);

      -- Approved list prices. Costs are official API-equivalent estimates.
      CREATE TABLE model_prices (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        input_uncached_microusd_per_mtok INTEGER NOT NULL,
        cache_write_5m_microusd_per_mtok INTEGER NOT NULL,
        cache_write_1h_microusd_per_mtok INTEGER NOT NULL,
        cache_write_other_microusd_per_mtok INTEGER NOT NULL,
        cache_read_microusd_per_mtok INTEGER NOT NULL,
        output_microusd_per_mtok INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Tracks which blobs have been parsed so ingestion is incremental.
      CREATE TABLE ingested_objects (
        digest TEXT NOT NULL,
        source_path TEXT NOT NULL,
        records INTEGER NOT NULL,
        ingested_at INTEGER NOT NULL,
        PRIMARY KEY (digest, source_path)
      );
    `
  },
  {
    version: 4,
    sql: `
      -- Provenance for every approved rate. config/catalog-sources.yaml sets
      -- requireSourceLocatorPerRate, so a price without a source URL is only
      -- ever the built-in reviewed seed, which records itself as such.
      ALTER TABLE model_prices ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
      ALTER TABLE model_prices ADD COLUMN approved_by TEXT NOT NULL DEFAULT 'seed';
      ALTER TABLE model_prices ADD COLUMN effective_date TEXT NOT NULL DEFAULT '';

      -- Every model the controller has heard of, whether it was discovered by
      -- an official-source check or simply observed in synced history. Rows sit
      -- at 'needs_price' until an operator approves rates for them.
      CREATE TABLE catalog_models (
        model_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        origin TEXT NOT NULL CHECK (origin IN ('usage', 'official_source', 'operator')),
        source_url TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('needs_price', 'priced', 'ignored'))
      );

      CREATE INDEX catalog_models_status_idx ON catalog_models(status, model_id);

      -- One row per attempt against a declared official source, kept so the
      -- panel can show when the last check ran and why a check was skipped.
      CREATE TABLE catalog_checks (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
        discovered INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX catalog_checks_started_idx ON catalog_checks(started_at DESC);

      -- One row per ingest attempt, so freshness and failures are visible
      -- without reading container logs.
      CREATE TABLE ingest_runs (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('ok', 'partial', 'failed', 'skipped')),
        manifests INTEGER NOT NULL DEFAULT 0,
        objects_seen INTEGER NOT NULL DEFAULT 0,
        objects_read INTEGER NOT NULL DEFAULT 0,
        facts_written INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX ingest_runs_started_idx ON ingest_runs(started_at DESC);
    `
  }
];
