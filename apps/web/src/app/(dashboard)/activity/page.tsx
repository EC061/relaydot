import type { Metadata } from "next";

import { getController } from "@/lib/context";

import { relativeTime } from "../../dashboard-format";

export const metadata: Metadata = {
  title: "Activity",
  description: "The immutable activity trail for your Relaydot controller"
};

export default function ActivityPage() {
  const events = getController().store.listAuditEvents().slice().reverse();

  return (
    <div className="routePage">
      <header className="routeHero compactHero">
        <div>
          <p className="eyebrow"><span /> Immutable trail</p>
          <h1>Every change.<br /><em>Nothing hidden.</em></h1>
          <p className="lede">
            A chronological record of enrollments, commands, settings, and
            controller actions across the lab.
          </p>
        </div>
        <span className="routeCount">{events.length} events</span>
      </header>

      <section className="activityLog" aria-labelledby="activity-log-heading">
        <header>
          <p className="eyebrow">Timeline</p>
          <h2 id="activity-log-heading">Controller history</h2>
        </header>
        {events.length === 0 ? (
          <div className="largeEmpty">
            <span>00</span>
            <div>
              <h3>No activity yet.</h3>
              <p>Your immutable event trail begins when the first node is enrolled.</p>
            </div>
          </div>
        ) : (
          <ol>
            {events.map((event, index) => (
              <li key={String(event.id)}>
                <span className="eventNumber">{String(events.length - index).padStart(2, "0")}</span>
                <i />
                <div>
                  <strong>{String(event.action).replaceAll("_", " ")}</strong>
                  <p>{String(event.resource_type).replaceAll("_", " ")}</p>
                </div>
                <time>{relativeTime(Number(event.created_at))}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
