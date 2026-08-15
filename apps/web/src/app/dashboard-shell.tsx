"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { SignOutButton } from "./sign-out-button";

const NAV_ITEMS = [
  { href: "/", label: "Overview", short: "Home", glyph: "01" },
  { href: "/usage", label: "Usage", short: "Usage", glyph: "02" },
  { href: "/storage", label: "Storage", short: "Store", glyph: "03" },
  { href: "/prices", label: "Model prices", short: "Prices", glyph: "04" },
  { href: "/devices", label: "Devices", short: "Nodes", glyph: "05" },
  { href: "/activity", label: "Activity", short: "Events", glyph: "06" }
];

function RelaydotMark() {
  return (
    <span className="brandMark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

export function DashboardShell({
  children,
  database,
  pendingJobs
}: {
  children: ReactNode;
  database: string;
  pendingJobs: number;
}) {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === href : pathname.startsWith(href);

  return (
    <div className="appShell">
      <header className="appHeader">
        <Link className="brand" href="/" aria-label="Relaydot overview">
          <RelaydotMark />
          <span>relaydot</span>
          <em>control</em>
        </Link>
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
              {NAV_ITEMS.map((item) => (
                <Link
                  aria-current={isActive(item.href) ? "page" : undefined}
                  className={isActive(item.href) ? "active" : undefined}
                  href={item.href}
                  key={item.href}
                >
                  <span>{item.glyph}</span>
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="controllerCard">
            <span className="controllerCardKicker">Controller</span>
            <strong>{database}</strong>
            <p>{pendingJobs} queued {pendingJobs === 1 ? "job" : "jobs"}</p>
            <div><span /></div>
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
            <span>{item.glyph}</span>
            {item.short}
          </Link>
        ))}
      </nav>
    </div>
  );
}
