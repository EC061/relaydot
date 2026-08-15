"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SignOutButton } from "./sign-out-button";

/**
 * Counts ride the navigation so an operator can see where the work is without
 * opening each route. `attention` marks a count that is waiting on a person
 * rather than simply describing how much exists.
 */
export interface ShellCounts {
  devices: number;
  events: number;
  needsPrice: number;
}

export interface FleetNode {
  id: string;
  name: string;
  online: boolean;
}

const NAV_ITEMS = [
  { href: "/", label: "Overview", short: "Overview" },
  { href: "/usage", label: "Usage", short: "Usage" },
  { href: "/storage", label: "Storage", short: "Storage" },
  { href: "/prices", label: "Model prices", short: "Prices" },
  { href: "/devices", label: "Devices", short: "Devices" },
  { href: "/activity", label: "Activity", short: "Activity" }
] as const;

function RelaydotMark() {
  return (
    <span className="brandMark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * The fleet, rendered as the thing the product is named for: one dot per
 * enrolled node, lit when it is reporting. It sits in the header rather than on
 * a single route because "is anything down" is the question every screen is
 * ultimately answering. Past a dozen nodes the dots stop being countable, so
 * the readout beside them carries the number and the strip is truncated.
 */
function FleetStrip({ nodes }: { nodes: FleetNode[] }) {
  const online = nodes.filter((node) => node.online).length;
  const shown = nodes.slice(0, 12);

  return (
    <div className="fleetStrip">
      <span className="fleetDots" aria-hidden="true">
        {shown.map((node) => (
          <i
            className={node.online ? "fleetDot live" : "fleetDot"}
            key={node.id}
          />
        ))}
      </span>
      <span className="fleetReadout">
        {nodes.length === 0 ? (
          "No nodes enrolled"
        ) : (
          <>
            <b>{online}</b> of <b>{nodes.length}</b> reporting
          </>
        )}
      </span>
    </div>
  );
}

export function DashboardShell({
  children,
  counts,
  database,
  nodes,
  pendingJobs
}: {
  children: ReactNode;
  counts: ShellCounts;
  database: string;
  nodes: FleetNode[];
  pendingJobs: number;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === href : pathname.startsWith(href);

  const countFor = (
    href: string
  ): { value: number; attention: boolean } | null => {
    if (href === "/devices" && counts.devices > 0) {
      return { value: counts.devices, attention: false };
    }
    if (href === "/activity" && counts.events > 0) {
      return { value: counts.events, attention: false };
    }
    if (href === "/prices" && counts.needsPrice > 0) {
      return { value: counts.needsPrice, attention: true };
    }
    return null;
  };

  return (
    <div className="appShell">
      <header className="appHeader">
        <Link className="brand" href="/" aria-label="Relaydot overview">
          <RelaydotMark />
          <span>relaydot</span>
          <em>control</em>
        </Link>

        <FleetStrip nodes={nodes} />

        <div className="headerStatus">
          <span className="statusDot" aria-hidden="true" />
          <span>Controller online</span>
          <SignOutButton />
        </div>
      </header>

      <div className="appBody">
        <aside className="sidebar">
          <div>
            <p className="navLabel">Control plane</p>
            <nav className="desktopNav" aria-label="Primary navigation">
              {NAV_ITEMS.map((item) => {
                const count = countFor(item.href);
                return (
                  <Link
                    aria-current={isActive(item.href) ? "page" : undefined}
                    className={isActive(item.href) ? "active" : undefined}
                    href={item.href}
                    key={item.href}
                  >
                    {item.label}
                    {count === null ? null : (
                      <span
                        className={count.attention ? "navCount attn" : "navCount"}
                      >
                        {count.value}
                      </span>
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>

          <div className="controllerCard">
            <span className="controllerCardKicker">Controller</span>
            <strong>{database}</strong>
            <p>
              {pendingJobs} queued {pendingJobs === 1 ? "job" : "jobs"}
            </p>
            <small>SQLite · WAL</small>
          </div>
        </aside>

        <main className="pageFrame">{children}</main>
      </div>

      <nav className="mobileNav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <Link
            aria-current={isActive(item.href) ? "page" : undefined}
            className={isActive(item.href) ? "active" : undefined}
            href={item.href}
            key={item.href}
          >
            <i aria-hidden="true" />
            {item.short}
          </Link>
        ))}
      </nav>
    </div>
  );
}
