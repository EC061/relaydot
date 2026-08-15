/**
 * Usage aggregation for the analytics view. All money is integer microUSD until
 * the final render, so grouping never changes a total.
 */
import { ratesFor, estimateCostMicroUsd, uncachedEquivalentMicroUsd } from "./prices";
import type { Store } from "./store";
import type { ModelPriceRow } from "./types";

export type RangeKey = "24h" | "7d" | "30d" | "90d";

export const RANGES: Array<{ key: RangeKey; label: string; seconds: number }> = [
  { key: "24h", label: "Past 24h", seconds: 86_400 },
  { key: "7d", label: "7 days", seconds: 604_800 },
  { key: "30d", label: "30 days", seconds: 2_592_000 },
  { key: "90d", label: "90 days", seconds: 7_776_000 }
];

/** Fixed provider order, so a filter never repaints the surviving series. */
export const PROVIDERS = [
  { key: "claude", label: "Claude Code" },
  { key: "openai", label: "Codex" }
] as const;

export type ProviderKey = (typeof PROVIDERS)[number]["key"];

interface Totals {
  costMicroUsd: number;
  uncachedMicroUsd: number;
  inputUncached: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  reasoning: number;
  events: number;
}

function emptyTotals(): Totals {
  return {
    costMicroUsd: 0,
    uncachedMicroUsd: 0,
    inputUncached: 0,
    cacheWrite: 0,
    cacheRead: 0,
    output: 0,
    reasoning: 0,
    events: 0
  };
}

function add(into: Totals, from: Totals): void {
  into.costMicroUsd += from.costMicroUsd;
  into.uncachedMicroUsd += from.uncachedMicroUsd;
  into.inputUncached += from.inputUncached;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
  into.output += from.output;
  into.reasoning += from.reasoning;
  into.events += from.events;
}

export function processedTokens(totals: Totals): number {
  return totals.inputUncached + totals.cacheWrite + totals.cacheRead + totals.output;
}

export interface Bucket {
  start: number;
  perProvider: Record<ProviderKey, { costMicroUsd: number; tokens: number }>;
}

export interface ModelRow {
  modelId: string;
  provider: ProviderKey;
  costMicroUsd: number;
  tokens: number;
  priced: boolean;
}

export interface UsageSummary {
  range: RangeKey;
  from: number;
  to: number;
  bucketSeconds: number;
  totals: Totals;
  perProvider: Record<ProviderKey, Totals>;
  buckets: Bucket[];
  models: ModelRow[];
  activeBuckets: number;
  unpricedModels: string[];
}

interface FactRow {
  provider: string;
  model_id: string;
  occurred_at: number;
  input_uncached_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_other_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

function providerOf(raw: string): ProviderKey {
  return raw === "openai" ? "openai" : "claude";
}

/**
 * Hourly buckets for a day, daily buckets beyond that: 90 days of hourly bars
 * would be 2160 marks in a few hundred pixels.
 */
function bucketSecondsFor(range: RangeKey): number {
  return range === "24h" ? 3600 : 86_400;
}

export function summarizeUsage(
  store: Store,
  range: RangeKey,
  now: number
): UsageSummary {
  const spec = RANGES.find((entry) => entry.key === range) ?? RANGES[0];
  const bucketSeconds = bucketSecondsFor(spec.key);
  // Align the window to bucket edges so labels sit on whole hours or days.
  const to = Math.ceil(now / bucketSeconds) * bucketSeconds;
  const from = to - spec.seconds;

  const prices = new Map<string, ModelPriceRow>(
    store.modelPrices().map((row) => [row.model_id, row])
  );

  const rows = store.sqlite
    .prepare(
      "SELECT provider, model_id, occurred_at, input_uncached_tokens, " +
        "cache_write_5m_tokens, cache_write_1h_tokens, cache_write_other_tokens, " +
        "cache_read_tokens, output_tokens, reasoning_output_tokens " +
        "FROM usage_facts WHERE occurred_at >= ? AND occurred_at < ? " +
        "ORDER BY occurred_at"
    )
    .all(from, to) as FactRow[];

  const totals = emptyTotals();
  const perProvider: Record<ProviderKey, Totals> = {
    claude: emptyTotals(),
    openai: emptyTotals()
  };
  const byModel = new Map<string, ModelRow>();
  const unpriced = new Set<string>();

  const bucketCount = Math.max(1, Math.round(spec.seconds / bucketSeconds));
  const buckets: Bucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    start: from + index * bucketSeconds,
    perProvider: {
      claude: { costMicroUsd: 0, tokens: 0 },
      openai: { costMicroUsd: 0, tokens: 0 }
    }
  }));

  for (const row of rows) {
    const provider = providerOf(row.provider);
    const price = prices.get(row.model_id);
    if (price === undefined) {
      unpriced.add(row.model_id);
    }
    const rates = price === undefined ? null : ratesFor(price);
    const cost = rates === null ? 0 : estimateCostMicroUsd(row, rates);
    const uncached = rates === null ? 0 : uncachedEquivalentMicroUsd(row, rates);
    const cacheWrite =
      row.cache_write_5m_tokens +
      row.cache_write_1h_tokens +
      row.cache_write_other_tokens;
    const tokens =
      row.input_uncached_tokens + cacheWrite + row.cache_read_tokens + row.output_tokens;

    const contribution: Totals = {
      costMicroUsd: cost,
      uncachedMicroUsd: uncached,
      inputUncached: row.input_uncached_tokens,
      cacheWrite,
      cacheRead: row.cache_read_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_output_tokens,
      events: 1
    };
    add(totals, contribution);
    add(perProvider[provider], contribution);

    const index = Math.floor((row.occurred_at - from) / bucketSeconds);
    if (index >= 0 && index < buckets.length) {
      const slot = buckets[index].perProvider[provider];
      slot.costMicroUsd += cost;
      slot.tokens += tokens;
    }

    const existing = byModel.get(row.model_id);
    if (existing === undefined) {
      byModel.set(row.model_id, {
        modelId: row.model_id,
        provider,
        costMicroUsd: cost,
        tokens,
        priced: price !== undefined
      });
    } else {
      existing.costMicroUsd += cost;
      existing.tokens += tokens;
    }
  }

  return {
    range: spec.key,
    from,
    to,
    bucketSeconds,
    totals,
    perProvider,
    buckets,
    models: [...byModel.values()].sort(
      (a, b) => b.costMicroUsd - a.costMicroUsd || b.tokens - a.tokens
    ),
    // "Per active hour" should divide by hours that actually had traffic.
    activeBuckets: buckets.filter((bucket) =>
      PROVIDERS.some((provider) => bucket.perProvider[provider.key].tokens > 0)
    ).length,
    unpricedModels: [...unpriced].sort()
  };
}

/* ---------------------------------------------------------------- formatting */

export function formatUsd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 100 ? Math.round(millions) : Number(millions.toFixed(1))}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}K`;
  }
  return String(count);
}

export function formatShare(part: number, whole: number): string {
  if (whole === 0) {
    return "0.0%";
  }
  return `${((part / whole) * 100).toFixed(1)}%`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
];

/** Renders in UTC so server and browser agree without hydration mismatch. */
function parts(epochSeconds: number) {
  const date = new Date(epochSeconds * 1000);
  return {
    month: MONTHS[date.getUTCMonth()],
    day: date.getUTCDate(),
    hour: date.getUTCHours()
  };
}

function clockLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

export function formatRangeCaption(from: number, to: number): string {
  const start = parts(from);
  const end = parts(to);
  return (
    `${start.month} ${start.day}, ${clockLabel(start.hour)} to ` +
    `${end.month} ${end.day}, ${clockLabel(end.hour)}`
  );
}

export function formatBucketTick(epochSeconds: number, bucketSeconds: number): string {
  const value = parts(epochSeconds);
  return bucketSeconds === 3600
    ? clockLabel(value.hour)
    : `${value.month} ${value.day}`;
}

export function formatBucketTooltip(
  epochSeconds: number,
  bucketSeconds: number
): string {
  const value = parts(epochSeconds);
  return bucketSeconds === 3600
    ? `${value.month} ${value.day}, ${clockLabel(value.hour)}`
    : `${value.month} ${value.day}`;
}
