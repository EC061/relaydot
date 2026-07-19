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
