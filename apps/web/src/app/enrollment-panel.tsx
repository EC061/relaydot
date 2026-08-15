"use client";

import { useState } from "react";

interface Enrollment {
  token: string;
}

export function EnrollmentPanel() {
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createEnrollment() {
    setBusy(true);
    setError("");
    setCommand("");
    try {
      const response = await fetch("/api/v1/admin/enrollment-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expires_in: 600 })
      });
      const payload = (await response.json()) as Enrollment & { error?: string };
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        throw new Error(payload.error ?? "Could not create enrollment token");
      }
      setCommand(
        `relaydot enroll --server ${window.location.origin} --token ${payload.token}`
      );
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
          Generate a single-use token valid for ten minutes. It is authorized by
          your current controller session, so the administrator token never
          enters this page.
        </p>
      </div>
      <div>
        <div className="inputRow">
          <button disabled={busy} onClick={createEnrollment} type="button">
            {busy ? "Generating…" : "Generate enrollment command"}
          </button>
        </div>
        {error ? <p className="formError">{error}</p> : null}
        {command ? (
          <output>
            <span>Run on the managed node</span>
            <code>{command}</code>
          </output>
        ) : null}
      </div>
    </section>
  );
}
