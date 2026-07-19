"use client";

import { type FormEvent, useState } from "react";

interface Enrollment {
  token: string;
}

export function EnrollmentPanel() {
  const [adminToken, setAdminToken] = useState("");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createEnrollment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setCommand("");
    try {
      const response = await fetch("/api/v1/admin/enrollment-tokens", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-relaydot-admin-token": adminToken
        },
        body: JSON.stringify({ expires_in: 600 })
      });
      const payload = (await response.json()) as Enrollment & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Could not create enrollment token");
      }
      setCommand(
        `relaydot enroll --server ${window.location.origin} --token ${payload.token}`
      );
      setAdminToken("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="enrollmentPanel" aria-labelledby="enrollment-heading">
      <div>
        <p className="eyebrow">Node onboarding</p>
        <h2 id="enrollment-heading">Enroll a lab agent</h2>
        <p>
          Generate a single-use token valid for ten minutes. The administrator
          token stays in this browser session only.
        </p>
      </div>
      <form onSubmit={createEnrollment}>
        <label htmlFor="admin-token">Administrator token</label>
        <div className="inputRow">
          <input
            id="admin-token"
            name="admin-token"
            type="password"
            autoComplete="off"
            placeholder="Paste controller admin token"
            value={adminToken}
            onChange={(event) => setAdminToken(event.target.value)}
            required
          />
          <button disabled={busy} type="submit">
            {busy ? "Generating…" : "Generate command"}
          </button>
        </div>
        {error ? <p className="formError">{error}</p> : null}
        {command ? (
          <output>
            <span>Run on the managed node</span>
            <code>{command}</code>
          </output>
        ) : null}
      </form>
    </section>
  );
}
