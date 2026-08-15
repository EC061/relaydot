import type { ReactNode } from "react";

import { getController } from "@/lib/context";
import { requireAdminSession } from "@/lib/session";

import { DashboardShell } from "../dashboard-shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A node counts as reporting if it has checked in within two heartbeats. */
const ONLINE_WINDOW_SECONDS = 120;

export default async function DashboardLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  await requireAdminSession();

  const { store } = getController();
  const health = store.health();
  const devices = store.listDevices();
  const now = Math.floor(Date.now() / 1000);

  return (
    <DashboardShell
      counts={{
        devices: devices.length,
        events: store.listAuditEvents().length,
        needsPrice: store
          .catalogModels()
          .filter((model) => model.status === "needs_price").length
      }}
      database={health.database}
      nodes={devices.map((device) => ({
        id: device.id,
        name: device.name,
        online: now - device.last_seen_at < ONLINE_WINDOW_SECONDS
      }))}
      pendingJobs={health.pending_jobs}
    >
      {children}
    </DashboardShell>
  );
}
