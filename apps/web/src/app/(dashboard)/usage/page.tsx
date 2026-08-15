import type { Metadata } from "next";

import { RANGES, summarizeUsage } from "@/lib/analytics";
import type { RangeKey } from "@/lib/analytics";
import { getController } from "@/lib/context";

import { UsagePanel } from "../../usage-panel";

export const metadata: Metadata = {
  title: "Usage",
  description: "Token volume and API-equivalent cost across the Relaydot fleet"
};

export default async function UsagePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams).range;
  const range: RangeKey =
    RANGES.find((entry) => entry.key === requested)?.key ?? "24h";
  const summary = summarizeUsage(
    getController().store,
    range,
    Math.floor(Date.now() / 1000)
  );

  return (
    <div className="routePage">
      <header className="routeHero">
        <div>
          <h1>Usage</h1>
          <p className="lede">
            Token volume, cache efficiency, and API-equivalent cost over time,
            broken down by provider and model.
          </p>
        </div>
      </header>
      <UsagePanel summary={summary} />
    </div>
  );
}
