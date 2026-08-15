/**
 * Populates a controller database with synthetic usage for design review and
 * screenshots. Not used at runtime; never invoked by the app.
 *
 *   RELAYDOT_DATABASE_PATH=/tmp/demo.db npx tsx scripts/seed-demo.ts
 */
import { Store } from "../src/lib/store";
import { SEED_PRICES, ratesFor, estimateCostMicroUsd } from "../src/lib/prices";

const path = process.env.RELAYDOT_DATABASE_PATH ?? "/tmp/relaydot-demo/relaydot.db";
const store = new Store(path);

/**
 * Illustrative placeholder prices for the Codex models, so a demo database
 * exercises the two-series chart. These are invented round numbers for layout
 * review ONLY and are deliberately absent from src/lib/prices.ts, which carries
 * reviewed Claude list prices only. Do not copy them into the shipped catalog.
 */
const DEMO_ONLY_CODEX_PRICES = [
  {
    model_id: "gpt-5.6-sol",
    provider: "openai",
    display_name: "GPT-5.6 Sol (demo price)",
    input_uncached_microusd_per_mtok: 1_250_000,
    cache_write_5m_microusd_per_mtok: 1_250_000,
    cache_write_1h_microusd_per_mtok: 1_250_000,
    cache_write_other_microusd_per_mtok: 1_250_000,
    cache_read_microusd_per_mtok: 125_000,
    output_microusd_per_mtok: 10_000_000,
    updated_at: 0
  },
  {
    model_id: "codex-auto-review",
    provider: "openai",
    display_name: "Codex auto review (demo price)",
    input_uncached_microusd_per_mtok: 250_000,
    cache_write_5m_microusd_per_mtok: 250_000,
    cache_write_1h_microusd_per_mtok: 250_000,
    cache_write_other_microusd_per_mtok: 250_000,
    cache_read_microusd_per_mtok: 25_000,
    output_microusd_per_mtok: 2_000_000,
    updated_at: 0
  }
];

store.upsertModelPrices([...SEED_PRICES, ...DEMO_ONLY_CODEX_PRICES]);

/** Deterministic PRNG so repeated seeds produce the same screenshots. */
let seed = 20260813;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

const MODELS = [
  { id: "claude-opus-5", provider: "claude", weight: 0.62 },
  { id: "claude-sonnet-5", provider: "claude", weight: 0.1 },
  { id: "gpt-5.6-sol", provider: "openai", weight: 0.24 },
  { id: "codex-auto-review", provider: "openai", weight: 0.03 },
  { id: "<synthetic>", provider: "claude", weight: 0.01 }
];

const prices = new Map(
  [...SEED_PRICES, ...DEMO_ONLY_CODEX_PRICES].map((row) => [row.model_id, ratesFor(row)])
);
const now = Math.floor(Date.now() / 1000);
const facts = [];
let id = 0;

// 90 days of history so every range tab has something to show, weighted toward
// recent hours the way real interactive sessions cluster.
for (let hoursAgo = 0; hoursAgo < 24 * 90; hoursAgo += 1) {
  const hourOfDay = (24 - (hoursAgo % 24)) % 24;
  // Working-hours shape plus a recent-activity ramp.
  const workday = hourOfDay >= 9 && hourOfDay <= 23 ? 1 : 0.08;
  const recency = hoursAgo < 24 ? 1 : hoursAgo < 24 * 7 ? 0.42 : 0.12;
  const intensity = workday * recency;
  if (random() > intensity) {
    continue;
  }
  const events = 1 + Math.floor(random() * 6 * intensity);
  for (let event = 0; event < events; event += 1) {
    let pick = random();
    const model =
      MODELS.find((candidate) => (pick -= candidate.weight) <= 0) ?? MODELS[0];
    const scale = 0.4 + random() * 1.8;
    // Real transcripts are overwhelmingly cache reads; keep that ratio.
    const cacheRead = Math.round(120_000 * scale);
    const cacheWrite5m = Math.round(900 * scale);
    const cacheWrite1h = Math.round(700 * scale);
    const inputUncached = Math.round(1_600 * scale);
    const output = Math.round(1_100 * scale);
    const reasoning = Math.round(output * 0.18);
    const tokens = {
      input_uncached_tokens: inputUncached,
      cache_write_5m_tokens: cacheWrite5m,
      cache_write_1h_tokens: cacheWrite1h,
      cache_write_other_tokens: 0,
      cache_read_tokens: cacheRead,
      output_tokens: output
    };
    const rates = prices.get(model.id);
    facts.push({
      usage_fact_id: `demo-${id++}`,
      device_id: null,
      provider: model.provider,
      session_id: `demo-session-${Math.floor(hoursAgo / 6)}`,
      model_id: model.id,
      occurred_at: now - hoursAgo * 3600 - Math.floor(random() * 3600),
      ...tokens,
      reasoning_output_tokens: reasoning,
      estimated_cost_microusd:
        rates === undefined ? null : estimateCostMicroUsd(tokens, rates),
      price_match_status: rates === undefined ? "unpriced" : "exact",
      source_path: `claude/projects/demo/${Math.floor(hoursAgo / 6)}.jsonl`
    });
  }
}

store.recordUsageFacts(facts);
store.close();
console.log(`seeded ${facts.length} usage facts into ${path}`);
