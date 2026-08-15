"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { IngestRunRow } from "@/lib/types";

export interface StorageSummary {
  configured: boolean;
  base_url: string;
  username: string;
  updated_at: number | null;
  verified_at: number | null;
  last_error: string | null;
}

interface ProbeResult {
  ok: boolean;
  error: string | null;
}

function ago(timestamp: number | null): string {
  if (timestamp === null || timestamp === 0) {
    return "never";
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

async function send(
  path: string,
  method: string,
  body?: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("session expired");
  }
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String(payload.error ?? `request failed with ${response.status}`));
  }
  return payload;
}

/**
 * Configures the one WebDAV backend every agent shares.
 *
 * The password is write-only by design: the controller returns the base URL and
 * username but never the secret, so this form starts empty on every load and an
 * operator who only wants to change the URL must re-enter the password. That is
 * a deliberate trade — a dashboard that could display the credential would also
 * leak it to anyone who reached an authenticated screen.
 */
export function StoragePanel({
  initial,
  runs
}: {
  initial: StorageSummary;
  runs: IngestRunRow[];
}) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(initial.base_url);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const latest = runs[0];

  async function act(
    label: string,
    run: () => Promise<string>
  ): Promise<void> {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      setNotice(await run());
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    act("save", async () => {
      const result = (await send("/api/v1/admin/storage", "PUT", {
        base_url: baseUrl,
        username,
        password
      })) as unknown as ProbeResult;
      setPassword("");
      return result.ok
        ? "Saved and verified against the server."
        : `Saved, but the connection test failed: ${result.error ?? "unknown error"}`;
    });

  const test = () =>
    act("test", async () => {
      const result = (await send(
        "/api/v1/admin/storage/test",
        "POST"
      )) as unknown as ProbeResult;
      return result.ok
        ? "Connection verified."
        : `Connection failed: ${result.error ?? "unknown error"}`;
    });

  const remove = () =>
    act("remove", async () => {
      await send("/api/v1/admin/storage", "DELETE");
      setBaseUrl("");
      setUsername("");
      setPassword("");
      return "Removed. Agents will report storage as unconfigured until it is set again.";
    });

  const ingest = () =>
    act("ingest", async () => {
      const result = await send("/api/v1/admin/usage/ingest", "POST");
      return (
        `Read ${Number(result.objectsRead)} of ${Number(result.objectsSeen)} history ` +
        `objects across ${Number(result.manifests)} device manifests and wrote ` +
        `${Number(result.factsWritten)} usage records.`
      );
    });

  return (
    <section className="storagePanel" id="storage" aria-labelledby="storage-heading">
      <div>
        <p className="eyebrow">Shared object store</p>
        <h2 id="storage-heading">WebDAV storage</h2>
        <p>
          Every agent reads and writes this one backend directly, so file content
          never passes through the controller. Objects are stored under their
          SHA-256 digest in <code>objects/</code>, and each device publishes what
          it holds to <code>manifests/</code>. The controller only reads, to
          derive usage analytics.
        </p>
        <dl className="storageFacts">
          <div>
            <dt>Status</dt>
            <dd>
              {!initial.configured
                ? "Not configured"
                : initial.last_error !== null
                  ? "Configured, last check failed"
                  : `Verified ${ago(initial.verified_at)}`}
            </dd>
          </div>
          <div>
            <dt>Last history read</dt>
            <dd>
              {latest === undefined
                ? "never"
                : `${latest.status} · ${ago(latest.started_at)}`}
            </dd>
          </div>
        </dl>
        {initial.last_error !== null ? (
          <p className="formError">{initial.last_error}</p>
        ) : null}
        {latest !== undefined && latest.detail.length > 0 ? (
          <p className="storageDetail">{latest.detail}</p>
        ) : null}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor="storage-url">Base URL</label>
        <div className="inputRow">
          <input
            autoComplete="off"
            id="storage-url"
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://files.example.com/remote.php/dav/files/relaydot/"
            required
            type="url"
            value={baseUrl}
          />
        </div>

        <label htmlFor="storage-user">Username</label>
        <div className="inputRow">
          <input
            autoComplete="username"
            id="storage-user"
            onChange={(event) => setUsername(event.target.value)}
            required
            value={username}
          />
        </div>

        <label htmlFor="storage-password">
          {initial.configured ? "Password (re-enter to change)" : "Password"}
        </label>
        <div className="inputRow">
          <input
            autoComplete="new-password"
            id="storage-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="stored encrypted; never shown again"
            required
            type="password"
            value={password}
          />
        </div>

        <div className="buttonRow">
          <button disabled={busy !== null} type="submit">
            {busy === "save" ? "Saving…" : "Save and verify"}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || !initial.configured}
            onClick={() => void test()}
            type="button"
          >
            {busy === "test" ? "Testing…" : "Test connection"}
          </button>
          <button
            className="ghost"
            disabled={busy !== null || !initial.configured}
            onClick={() => void ingest()}
            type="button"
          >
            {busy === "ingest" ? "Reading…" : "Read history now"}
          </button>
          <button
            className="ghost danger"
            disabled={busy !== null || !initial.configured}
            onClick={() => void remove()}
            type="button"
          >
            {busy === "remove" ? "Removing…" : "Remove"}
          </button>
        </div>

        {error ? <p className="formError">{error}</p> : null}
        {notice ? <p className="formNotice">{notice}</p> : null}
      </form>
    </section>
  );
}
