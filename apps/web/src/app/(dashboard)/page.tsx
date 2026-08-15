import Link from "next/link";

import { getController } from "@/lib/context";

import { relativeTime } from "../dashboard-format";
import { EnrollmentPanel } from "../enrollment-panel";

export default function OverviewPage() {
  const { store } = getController();
  const health = store.health();
  const devices = store.listDevices();
  const events = store.listAuditEvents().slice(-4).reverse();
  const now = Math.floor(Date.now() / 1000);
  const online = devices.filter((device) => now - device.last_seen_at < 120).length;

  return (
    <div className="routePage overviewPage">
      <header className="routeHero overviewHero">
        <div>
          <p className="eyebrow"><span /> Fleet overview</p>
          <h1>Your agents.<br /><em>In one rhythm.</em></h1>
          <p className="lede">
            Monitor every coding node, keep shared state moving, and catch what
            needs your attention without digging through the stack.
          </p>
        </div>
        <span className="version">Relaydot · v0.1.0</span>
      </header>

      <section className="metricStrip" aria-label="Fleet summary">
        <article>
          <span className="metricIndex">01 / Nodes</span>
          <strong>{devices.length.toString().padStart(2, "0")}</strong>
          <p><i className="signal good" /> {online} reporting now</p>
        </article>
        <article>
          <span className="metricIndex">02 / Queue</span>
          <strong>{health.pending_jobs.toString().padStart(2, "0")}</strong>
          <p><i className="signal warm" /> Durable jobs waiting</p>
        </article>
        <article className="metricWide">
          <span className="metricIndex">03 / Database</span>
          <strong className="statusWord">{health.database}</strong>
          <p><i className="signal good" /> Journal mode {health.journal_mode}</p>
        </article>
      </section>

      <EnrollmentPanel />

      <div className="overviewGrid">
        <section className="overviewCard">
          <header>
            <div>
              <p className="eyebrow">Managed infrastructure</p>
              <h2>Lab agents</h2>
            </div>
            <Link className="arrowLink" href="/devices">View all <span>↗</span></Link>
          </header>
          {devices.length === 0 ? (
            <div className="compactEmpty">
              <span>+</span>
              <div>
                <strong>No nodes enrolled</strong>
                <p>Your first agent will appear here as soon as it checks in.</p>
              </div>
            </div>
          ) : (
            <ul className="overviewList">
              {devices.slice(0, 3).map((device) => (
                <li key={device.id}>
                  <span className="nodeAvatar">{device.name.slice(0, 2).toUpperCase()}</span>
                  <div><strong>{device.name}</strong><p>{device.platform}</p></div>
                  <time>{relativeTime(device.last_seen_at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overviewCard darkCard">
          <header>
            <div>
              <p className="eyebrow">Immutable trail</p>
              <h2>Latest activity</h2>
            </div>
            <Link className="arrowLink" href="/activity">View all <span>↗</span></Link>
          </header>
          {events.length === 0 ? (
            <div className="compactEmpty">
              <span>·</span>
              <div>
                <strong>All quiet</strong>
                <p>Events will appear after your first enrollment.</p>
              </div>
            </div>
          ) : (
            <ol className="activityPreview">
              {events.map((event) => (
                <li key={String(event.id)}>
                  <span />
                  <div><strong>{String(event.action)}</strong><p>{String(event.resource_type)}</p></div>
                  <time>{relativeTime(Number(event.created_at))}</time>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
