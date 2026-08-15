/**
 * Reviewed model/price catalog seed.
 *
 * Values are official API list prices in microUSD per million tokens. Costs
 * derived from them are labeled API-equivalent estimates in the UI and are not
 * a claim about amounts billed under a Claude or ChatGPT subscription.
 *
 * Anthropic cache multipliers, applied to the base input price: 1.25x for a
 * 5-minute cache write, 2x for a 1-hour write, and 0.1x for a cache read.
 */
import type { ModelPriceRow } from "./types";

const MTOK = 1_000_000;

export const ANTHROPIC_PRICING_DOCUMENT =
  "https://platform.claude.com/docs/en/about-claude/pricing";

/** Builds a row from base input/output dollars using the cache multipliers. */
function anthropic(
  modelId: string,
  displayName: string,
  inputUsd: number,
  outputUsd: number
): ModelPriceRow {
  const input = Math.round(inputUsd * MTOK);
  return {
    model_id: modelId,
    provider: "claude",
    display_name: displayName,
    input_uncached_microusd_per_mtok: input,
    cache_write_5m_microusd_per_mtok: Math.round(input * 1.25),
    cache_write_1h_microusd_per_mtok: input * 2,
    cache_write_other_microusd_per_mtok: Math.round(input * 1.25),
    cache_read_microusd_per_mtok: Math.round(input * 0.1),
    output_microusd_per_mtok: Math.round(outputUsd * MTOK),
    updated_at: 0,
    source_url: ANTHROPIC_PRICING_DOCUMENT,
    approved_by: "seed",
    effective_date: ""
  };
}

/**
 * Claude list prices. Codex/OpenAI models are intentionally absent: this
 * repository has no reviewed source for them, and inventing figures would
 * silently mislabel real spend. Add them through the catalog once the
 * scheduled official-source check in config/catalog-sources.yaml is wired up;
 * until then, unpriced models are reported with price_match_status 'unpriced'
 * and contribute tokens but no cost.
 */
export const SEED_PRICES: ModelPriceRow[] = [
  anthropic("claude-fable-5", "Claude Fable 5", 10, 50),
  anthropic("claude-mythos-5", "Claude Mythos 5", 10, 50),
  anthropic("claude-opus-5", "Claude Opus 5", 5, 25),
  anthropic("claude-opus-4-8", "Claude Opus 4.8", 5, 25),
  anthropic("claude-opus-4-7", "Claude Opus 4.7", 5, 25),
  anthropic("claude-opus-4-6", "Claude Opus 4.6", 5, 25),
  anthropic("claude-sonnet-5", "Claude Sonnet 5", 3, 15),
  anthropic("claude-sonnet-4-6", "Claude Sonnet 4.6", 3, 15),
  anthropic("claude-haiku-4-5", "Claude Haiku 4.5", 1, 5)
];

export interface PriceRates {
  inputUncached: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheWriteOther: number;
  cacheRead: number;
  output: number;
}

export function ratesFor(row: ModelPriceRow): PriceRates {
  return {
    inputUncached: row.input_uncached_microusd_per_mtok,
    cacheWrite5m: row.cache_write_5m_microusd_per_mtok,
    cacheWrite1h: row.cache_write_1h_microusd_per_mtok,
    cacheWriteOther: row.cache_write_other_microusd_per_mtok,
    cacheRead: row.cache_read_microusd_per_mtok,
    output: row.output_microusd_per_mtok
  };
}

export interface TokenCounts {
  input_uncached_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  cache_write_other_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
}

/**
 * Exact integer microUSD cost. Each component rounds half-up independently so
 * repeated aggregation stays deterministic regardless of grouping.
 */
export function estimateCostMicroUsd(
  tokens: TokenCounts,
  rates: PriceRates
): number {
  const parts: Array<[number, number]> = [
    [tokens.input_uncached_tokens, rates.inputUncached],
    [tokens.cache_write_5m_tokens, rates.cacheWrite5m],
    [tokens.cache_write_1h_tokens, rates.cacheWrite1h],
    [tokens.cache_write_other_tokens, rates.cacheWriteOther],
    [tokens.cache_read_tokens, rates.cacheRead],
    [tokens.output_tokens, rates.output]
  ];
  let total = 0;
  for (const [count, rate] of parts) {
    total += Math.round((count * rate) / MTOK);
  }
  return total;
}

/**
 * What the same tokens would have cost with no cache: every cached read and
 * write billed at the uncached input rate. The difference is the cache saving
 * shown on the dashboard.
 */
export function uncachedEquivalentMicroUsd(
  tokens: TokenCounts,
  rates: PriceRates
): number {
  const inputTokens =
    tokens.input_uncached_tokens +
    tokens.cache_write_5m_tokens +
    tokens.cache_write_1h_tokens +
    tokens.cache_write_other_tokens +
    tokens.cache_read_tokens;
  return (
    Math.round((inputTokens * rates.inputUncached) / MTOK) +
    Math.round((tokens.output_tokens * rates.output) / MTOK)
  );
}
