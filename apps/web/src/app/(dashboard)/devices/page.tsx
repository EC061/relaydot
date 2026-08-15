import type { Metadata } from "next";

import { getController } from "@/lib/context";

import { relativeTime } from "../../dashboard-format";
import { EnrollmentPanel } from "../../enrollment-panel";

export const metadata: Metadata = {
  title: "Devices",
  description: "Enroll and monitor the coding agents managed by Relaydot"
};

export default function DevicesPage() {
  const devices = getController().store.listDevices();
  const now = Math.floor(Date.now() / 1000);

  return (
    <div className="routePage">
      <header className="routeHero compactHero">
        <div>
          <p className="eyebrow"><span /> Managed nodes</p>
          <h1>Your lab,<br /><em>alive at a glance.</em></h1>
          <p className="lede">
            Bring a new agent into the fleet, then see its platform, software
            version, and latest check-in in one focused view.
          </p>
        </div>
        <span className="routeCount">{devices.length.toString().padStart(2, "0")} nodes</span>
      </header>

      <EnrollmentPanel />

      <section className="deviceDirectory" aria-labelledby="device-directory-heading">
        <header>
          <div>
            <p className="eyebrow">Directory</p>
            <h2 id="device-directory-heading">Fleet status</h2>
          </div>
          <span>{devices.filter((device) => now - device.last_seen_at < 120).length} online</span>
        </header>
        {devices.length === 0 ? (
          <div className="largeEmpty">
            <span>01</span>
            <div>
              <h3>No agents enrolled yet.</h3>
              <p>Generate a command above and run it on the first machine you want Relaydot to manage.</p>
            </div>
          </div>
        ) : (
          <div className="deviceGrid">
            {devices.map((device) => {
              const online = now - device.last_seen_at < 120;
              return (
                <article key={device.id}>
                  <div className="deviceCardTop">
                    <span className="nodeAvatar">{device.name.slice(0, 2).toUpperCase()}</span>
                    <span className={online ? "onlinePill" : "offlinePill"}>
                      <i /> {online ? "Online" : "Idle"}
                    </span>
                  </div>
                  <h3>{device.name}</h3>
                  <p>{device.platform}</p>
                  <dl>
                    <div><dt>Agent</dt><dd>{device.agent_version}</dd></div>
                    <div><dt>Last seen</dt><dd>{relativeTime(device.last_seen_at)}</dd></div>
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
