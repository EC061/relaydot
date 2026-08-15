import type { ReactNode } from "react";

import { getController } from "@/lib/context";
import { requireAdminSession } from "@/lib/session";

import { DashboardShell } from "../dashboard-shell";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function DashboardLayout({
  children
}: Readonly<{ children: ReactNode }>) {
  await requireAdminSession();
  const health = getController().store.health();

  return (
    <DashboardShell
      database={health.database}
      pendingJobs={health.pending_jobs}
    >
      {children}
    </DashboardShell>
  );
}
