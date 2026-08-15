"use client";

import { useState } from "react";

export function SignOutButton() {
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/v1/admin/session", { method: "DELETE" });
    } finally {
      window.location.assign("/login");
    }
  }

  return (
    <button className="signOut" disabled={busy} onClick={signOut} type="button">
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
