import { getController } from "@/lib/context";
import { RANGES, summarizeUsage } from "@/lib/analytics";
import { loadCatalogSources } from "@/lib/catalog";
import { catalogSourcesPath } from "@/lib/config";
import { requireAdminSession } from "@/lib/session";
import type { RangeKey } from "@/lib/analytics";

import { CatalogPanel } from "./catalog-panel";
import { EnrollmentPanel } from "./enrollment-panel";
import { SectionNav } from "./section-nav";
import { SignOutButton } from "./sign-out-button";
import { StoragePanel } from "./storage-panel";
import { UsagePanel } from "./usage-panel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export default async function Dashboard({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();
  const requested = (await searchParams).range;
  const range: RangeKey =
    RANGES.find((entry) => entry.key === requested)?.key ?? "24h";
  const { store } = getController();
  const health = store.health();
  const devices = store.listDevices();
  const events = store.listAuditEvents().slice(-6).reverse();
  const usage = summarizeUsage(store, range, Math.floor(Date.now() / 1000));
  const online = devices.filter(
    (device) => Math.floor(Date.now() / 1000) - device.last_seen_at < 120
  ).length;

  // Rendered server-side so the panels paint with real state on first load; the
  // password is never part of this, only the base URL and username.
  const backend = store.storageBackend();
  const storage = {
    configured: backend !== null,
    base_url: backend?.base_url ?? "",
    username: backend?.username ?? "",
    updated_at: backend?.updated_at ?? null,
    verified_at: backend?.verified_at ?? null,
    last_error: backend?.last_error ?? null
  };
  const catalog = loadCatalogSources(catalogSourcesPath());

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
        <div className="topbarActions">
          <div className="systemBadge">
            <span className="pulse" />
            Controller healthy
          </div>
          <SignOutButton />
        </div>
      </header>

      <div className="shell">
        <aside>
          <p className="eyebrow">Workspace</p>
          <SectionNav />
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

          <UsagePanel summary={usage} />

          <StoragePanel initial={storage} runs={store.ingestRuns(5)} />

          <CatalogPanel
            checks={store.catalogChecks(5)}
            models={store.catalogModels()}
            prices={store.modelPrices()}
            sources={
              catalog.sources === null
                ? null
                : {
                    schedule: catalog.sources.schedule,
                    auto_apply: catalog.sources.autoApply,
                    providers: catalog.sources.providers.map((provider) => ({
                      key: provider.key,
                      provider: provider.provider,
                      model_api_enabled: provider.modelApi?.enabled ?? false,
                      model_documents: provider.modelDocuments,
                      pricing_documents: provider.pricingDocuments
                    }))
                  }
            }
            sourcesError={catalog.error}
          />

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
