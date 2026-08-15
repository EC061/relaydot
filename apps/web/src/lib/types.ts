/** Shared controller persistence and protocol types. */
export type CommandType =
  | "sync"
  | "update_agent"
  | "reload_policy"
  | "collect_diagnostics";

export type CommandStatus = "pending" | "claimed" | "succeeded" | "failed";

export interface Command {
  id: string;
  device_id: string;
  type: CommandType;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: CommandStatus;
  created_at: number;
  claimed_at: number | null;
  acked_at: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface StorageBackendRow {
  id: number;
  kind: "webdav";
  base_url: string;
  username: string;
  password_encrypted: string;
  created_at: number;
  updated_at: number;
  verified_at: number | null;
  last_error: string | null;
}

export interface UsageFactRow {
  usage_fact_id: string;
  device_id: string | null;
  provider: string;
  session_id: string;
  model_id: string;
  occurred_at: number;
  input_uncached_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_other_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  estimated_cost_microusd: number | null;
  price_match_status: string;
  source_path: string;
}

export interface ModelPriceRow {
  model_id: string;
  provider: string;
  display_name: string;
  input_uncached_microusd_per_mtok: number;
  cache_write_5m_microusd_per_mtok: number;
  cache_write_1h_microusd_per_mtok: number;
  cache_write_other_microusd_per_mtok: number;
  cache_read_microusd_per_mtok: number;
  output_microusd_per_mtok: number;
  updated_at: number;
  /** Where the rate came from. Empty only for the built-in reviewed seed. */
  source_url?: string;
  approved_by?: string;
  effective_date?: string;
}

export type CatalogStatus = "needs_price" | "priced" | "ignored";

export interface CatalogModelRow {
  model_id: string;
  provider: string;
  display_name: string;
  origin: "usage" | "official_source" | "operator";
  source_url: string;
  first_seen_at: number;
  last_seen_at: number;
  status: CatalogStatus;
}

export interface CatalogCheckRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: "ok" | "partial" | "failed";
  discovered: number;
  added: number;
  detail: string;
}

export interface IngestRunRow {
  id: string;
  started_at: number;
  finished_at: number | null;
  status: "ok" | "partial" | "failed" | "skipped";
  manifests: number;
  objects_seen: number;
  objects_read: number;
  facts_written: number;
  detail: string;
}

export interface AdminSession {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface Device {
  id: string;
  name: string;
  platform: string;
  agent_version: string;
  public_key: string | null;
  token_hash: string;
  enrolled_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}
