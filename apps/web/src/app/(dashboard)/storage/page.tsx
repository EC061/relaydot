import type { Metadata } from "next";

import { getController } from "@/lib/context";

import { StoragePanel } from "../../storage-panel";

export const metadata: Metadata = {
  title: "Storage",
  description: "Configure and monitor the Relaydot shared WebDAV store"
};

export default function StoragePage() {
  const { store } = getController();
  const backend = store.storageBackend();
  const storage = {
    configured: backend !== null,
    base_url: backend?.base_url ?? "",
    username: backend?.username ?? "",
    updated_at: backend?.updated_at ?? null,
    verified_at: backend?.verified_at ?? null,
    last_error: backend?.last_error ?? null
  };

  return (
    <div className="routePage">
      <header className="routeHero compactHero">
        <div>
          <p className="eyebrow"><span /> Shared state</p>
          <h1>One store.<br /><em>Every agent.</em></h1>
          <p className="lede">
            Connect the WebDAV backend that keeps settings, history, and agent
            state synchronized across the fleet.
          </p>
        </div>
      </header>
      <StoragePanel initial={storage} runs={store.ingestRuns(8)} />
    </div>
  );
}
