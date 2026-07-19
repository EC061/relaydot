/** In-process Honker consumer owned by the Next.js controller process. */
import { hostname } from "node:os";

import type { JsonValue } from "@russellthehippo/honker-node";

import type { Store } from "./store";

export class InProcessWorker {
  readonly workerId = `${hostname()}-${process.pid}`;
  private abortController: AbortController | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly store: Store) {}

  start(): void {
    if (this.running !== undefined) {
      return;
    }
    this.abortController = new AbortController();
    this.running = this.run(this.abortController.signal);
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.running;
    this.abortController = undefined;
    this.running = undefined;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const waker = this.store.queue.claimWaker({ idlePollS: 1 });
    try {
      while (!signal.aborted) {
        const job = await waker.next(this.workerId, { signal });
        if (job === null) {
          continue;
        }
        this.process(job.payload, job.ack.bind(job), job.retry.bind(job));
      }
    } finally {
      waker.close();
    }
  }

  private process(
    payload: JsonValue,
    ack: () => boolean,
    retry: (delayS?: number, error?: string) => boolean
  ): void {
    try {
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        payload.kind !== "command_created" ||
        typeof payload.command_id !== "string"
      ) {
        throw new Error("unknown job payload");
      }
      this.store.sqlite
        .prepare(
          "INSERT OR IGNORE INTO audit_events" +
            "(id, action, resource_type, resource_id, details_json, created_at) " +
            "VALUES (lower(hex(randomblob(16))), 'command.queued', 'command', ?, '{}', unixepoch())"
        )
        .run(payload.command_id);
      ack();
    } catch (error) {
      retry(1, error instanceof Error ? error.message : String(error));
    }
  }
}
