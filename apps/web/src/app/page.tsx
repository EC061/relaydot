import { getController } from "@/lib/context";

import { EnrollmentPanel } from "./enrollment-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export default function Dashboard() {
  const { store } = getController();
  const health = store.health();
  const devices = store.listDevices();
  const events = store.listAuditEvents().slice(-6).reverse();
  const online = devices.filter(
    (device) => Math.floor(Date.now() / 1000) - device.last_seen_at < 120
  ).length;

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Relaydot home">
          <span className="brandMark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>relaydot</span>
        </a>
        <div className="systemBadge">
          <span className="pulse" />
          Controller healthy
        </div>
      </header>

      <div className="shell">
        <aside>
          <p className="eyebrow">Workspace</p>
          <nav aria-label="Primary navigation">
            <a className="active" href="#overview">
              <span>01</span> Overview
            </a>
            <a href="#devices">
              <span>02</span> Devices
            </a>
            <a href="#activity">
              <span>03</span> Activity
            </a>
          </nav>
          <div className="storageCard">
            <p>Storage engine</p>
            <strong>SQLite · WAL</strong>
            <span>Honker queue embedded</span>
          </div>
        </aside>

        <section className="content" id="overview">
          <div className="hero">
            <div>
              <p className="eyebrow">Fleet control plane</p>
              <h1>Everything in sync.</h1>
              <p className="lede">
                One durable controller for every coding agent, policy, and
                command in your lab.
              </p>
            </div>
            <span className="version">v0.1.0</span>
          </div>

          <div className="metrics" aria-label="Fleet summary">
            <article>
              <p>Managed nodes</p>
              <strong>{devices.length.toString().padStart(2, "0")}</strong>
              <span>{online} reporting now</span>
            </article>
            <article>
              <p>Queue depth</p>
              <strong>{health.pending_jobs.toString().padStart(2, "0")}</strong>
              <span>Durable Honker jobs</span>
            </article>
            <article>
              <p>Database</p>
              <strong className="wordMetric">{health.database}</strong>
              <span>Journal mode: {health.journal_mode}</span>
            </article>
          </div>

          <EnrollmentPanel />

          <section className="panel" id="devices">
            <div className="panelHeading">
              <div>
                <p className="eyebrow">Managed infrastructure</p>
                <h2>Lab agents</h2>
              </div>
              <span className="count">{devices.length} total</span>
            </div>
            {devices.length === 0 ? (
              <div className="empty">
                <span className="emptyIcon">+</span>
                <div>
                  <h3>No nodes enrolled yet</h3>
                  <p>
                    Create a one-time enrollment token through the controller API,
                    then run the agent service on a managed node.
                  </p>
                </div>
              </div>
            ) : (
              <div className="deviceTable">
                {devices.map((device) => (
                  <article key={device.id}>
                    <span className="nodeIcon" aria-hidden="true" />
                    <div>
                      <strong>{device.name}</strong>
                      <p>{device.platform}</p>
                    </div>
                    <code>{device.agent_version}</code>
                    <span className="lastSeen">
                      {relativeTime(device.last_seen_at)}
                    </span>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="panel activity" id="activity">
            <div className="panelHeading">
              <div>
                <p className="eyebrow">Immutable trail</p>
                <h2>Recent activity</h2>
              </div>
            </div>
            {events.length === 0 ? (
              <p className="quiet">Events will appear after the first enrollment.</p>
            ) : (
              <ol>
                {events.map((event) => (
                  <li key={String(event.id)}>
                    <span />
                    <div>
                      <strong>{String(event.action)}</strong>
                      <p>{String(event.resource_type)}</p>
                    </div>
                    <time>{relativeTime(Number(event.created_at))}</time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </section>
      </div>
    </main>
  );
}
