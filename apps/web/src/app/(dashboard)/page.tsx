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
      <header className="routeHero">
        <div>
          <h1>Fleet overview</h1>
          <p className="lede">
            Every enrolled node, the durable job queue, and the controller&apos;s
            own health, on one screen.
          </p>
        </div>
        <span className="version">v0.1.0</span>
      </header>

      {/* Three readings taken at the same moment, not three steps: labelled by
          what each measures, with no sequence numbers implying an order. */}
      <section className="metricStrip" aria-label="Fleet summary">
        <article>
          <span className="metricIndex">Enrolled nodes</span>
          <strong>{devices.length.toString().padStart(2, "0")}</strong>
          <p>
            {/* The dot states what the number means: nothing enrolled is idle,
                enrolled but silent needs attention, anything checking in is
                healthy. A fixed green dot beside "0 reporting" would lie. */}
            <i
              className={
                devices.length === 0
                  ? "signal idle"
                  : online === 0
                    ? "signal warm"
                    : "signal good"
              }
            />{" "}
            {online} reporting now
          </p>
        </article>
        <article>
          <span className="metricIndex">Queued jobs</span>
          <strong>{health.pending_jobs.toString().padStart(2, "0")}</strong>
          <p>
            <i className={health.pending_jobs > 0 ? "signal warm" : "signal good"} />{" "}
            {health.pending_jobs > 0 ? "Waiting to run" : "Queue is clear"}
          </p>
        </article>
        <article className="metricWide">
          <span className="metricIndex">Database</span>
          <strong className="statusWord">{health.database}</strong>
          <p>
            <i className="signal good" /> Journal mode {health.journal_mode}
          </p>
        </article>
      </section>

      <EnrollmentPanel />

      <div className="overviewGrid">
        <section className="overviewCard">
          <header>
            <div>
              <p className="eyebrow">Managed nodes</p>
              <h2>Recently seen</h2>
            </div>
            <Link className="arrowLink" href="/devices">
              All devices <span aria-hidden="true">→</span>
            </Link>
          </header>
          {devices.length === 0 ? (
            <div className="compactEmpty">
              <span aria-hidden="true">+</span>
              <div>
                <strong>No nodes enrolled</strong>
                <p>
                  Generate an enrollment command above and run it on the first
                  machine you want Relaydot to manage.
                </p>
              </div>
            </div>
          ) : (
            <ul className="overviewList">
              {devices.slice(0, 3).map((device) => (
                <li key={device.id}>
                  <span className="nodeAvatar">
                    {device.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{device.name}</strong>
                    <p>{device.platform}</p>
                  </div>
                  <time>{relativeTime(device.last_seen_at)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="overviewCard">
          <header>
            <div>
              <p className="eyebrow">Immutable trail</p>
              <h2>Latest activity</h2>
            </div>
            <Link className="arrowLink" href="/activity">
              All events <span aria-hidden="true">→</span>
            </Link>
          </header>
          {events.length === 0 ? (
            <div className="compactEmpty">
              <span aria-hidden="true">·</span>
              <div>
                <strong>Nothing recorded yet</strong>
                <p>The trail starts with your first enrollment.</p>
              </div>
            </div>
          ) : (
            <ol className="activityPreview">
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
      </div>
    </div>
  );
}
