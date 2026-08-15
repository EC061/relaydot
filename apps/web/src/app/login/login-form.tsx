"use client";

import { type FormEvent, useState } from "react";

export function LoginForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/admin/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token })
      });
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? "Could not sign in");
      }
      setToken("");
      window.location.assign("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={signIn}>
      <label htmlFor="token">Administrator token</label>
      <div className="inputRow">
        <input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          placeholder="Paste controller admin token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
        />
        <button disabled={busy} type="submit">
          {busy ? "Verifying…" : "Sign in"}
        </button>
      </div>
      {error ? <p className="formError">{error}</p> : null}
    </form>
  );
}
