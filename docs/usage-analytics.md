# Usage analytics and cost accounting

## Product promise

Relaydot shows usage from synchronized Claude and Codex conversations without
indexing prompt or response text in the controller database. Parsing happens on
the source endpoint. The endpoint submits signed, normalized usage facts while the
complete conversation remains end-to-end encrypted in WebDAV.

The dashboard provides:

- total input, output, and combined tokens;
- uncached input, cache-write input, cache-read input, cache hit rate, and cache
  savings versus processing the same input uncached;
- reasoning-output tokens as a subset where the source records them;
- official API-equivalent estimated cost, split by input/cache/output category;
- per-hour, calendar-day, calendar-week, calendar-month, and rolling-range usage;
- rolling 7-day and 30-day average per calendar day, plus average per active day;
- comparisons with the preceding period and peak hourly usage;
- filters and groupings for machine, provider, model, project, session, service
  tier, and time range;
- CSV/JSON export of aggregates, with raw conversation text excluded.

All timestamps are stored in UTC. Bucketing happens in the selected dashboard
timezone and handles daylight-saving 23/25-hour days. Week start is configurable.

## Normalized usage fact

One authoritative provider response/turn becomes one immutable fact:

```text
usage_fact_id
provider                       claude | openai
provider_session_id
provider_response_or_turn_id
event_time_utc
origin_device_id
project_key
model_id
service_tier / speed / inference_geo / context_band
input_uncached_tokens
cache_write_5m_tokens
cache_write_1h_tokens
cache_write_other_tokens
cache_read_tokens
output_tokens
reasoning_output_tokens        subset of output_tokens
total_input_tokens
total_tokens
parser_name / parser_version / source_schema_version
source_record_fingerprint
price_card_id
price_match_status             exact | assumed | override | unpriced
estimated_cost_microusd
```

Token and cost arithmetic uses integers/decimal fixed point, never binary floating
point. Costs are stored in micro-USD and rendered with enough precision that small
hourly buckets do not disappear.

## Claude normalization

For the authoritative terminal record of each `(sessionId, message.id)`:

```text
input_uncached = usage.input_tokens
cache_write_5m = usage.cache_creation.ephemeral_5m_input_tokens
cache_write_1h = usage.cache_creation.ephemeral_1h_input_tokens
cache_read = usage.cache_read_input_tokens
total_input = input_uncached + cache_write_5m + cache_write_1h + cache_read
output = usage.output_tokens
total = total_input + output
```

If the TTL breakdown is absent, use `cache_creation_input_tokens` as
`cache_write_other_tokens` and mark the price match assumed until its rate can be
identified. Top-level usage is authoritative; `iterations` is diagnostic and must
not be added on top of it.

Anthropic documents total input as the sum of base input, cache creation, and cache
read tokens, and prices 5-minute writes, 1-hour writes, reads, and output at
different rates:

- https://platform.claude.com/docs/en/api/messages
- https://platform.claude.com/docs/en/about-claude/pricing

## Codex/OpenAI normalization

For each new Codex `token_count` event, count `last_token_usage` once and use
`total_token_usage` to verify the monotonic cumulative sequence:

```text
input_total = last_token_usage.input_tokens
cache_read = last_token_usage.cached_input_tokens
input_uncached = max(0, input_total - cache_read - cache_write)
output = last_token_usage.output_tokens
reasoning_output = last_token_usage.reasoning_output_tokens  # subset
total = input_total + output
```

Current Codex session events do not expose every billing modifier. When tier,
context band, cache-write count, or geography is absent, use the configured
standard API-equivalent assumption and display an `assumed` badge. Never add
`reasoning_output_tokens` to output a second time.

OpenAI documents `cached_tokens` in input-token details and separate cache-write
tokens for newer model families:

- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/api/docs/pricing

## Deduplication and machine provenance

Synchronization creates copies of the same transcript on multiple endpoints, so
file presence cannot determine token ownership.

The agent tracks a per-file byte cursor and an apply journal. Bytes written by a
remote Relaydot apply are marked remote and are not re-emitted as locally created
usage. A genuinely new local append is tagged with the endpoint's immutable
`device_id`. The controller also enforces a provider-specific uniqueness key and
canonical record fingerprint, making retries idempotent.

For the initial Syncthing migration, old records may already exist identically on
several machines. Relaydot deduplicates them globally and records provenance as:

- `observed_local`: created after Relaydot began observing that machine;
- `import_assigned`: historical session explicitly assigned during migration;
- `import_first_seen`: first importer used as a best-effort source;
- `ambiguous`: duplicates existed and no trustworthy source can be inferred.

The UI includes Unknown/Ambiguous as a machine filter. It must not invent precise
historical attribution where the transcript contains none.

## Price catalog

`price_cards` are append-only and contain:

- provider and exact model/alias mapping;
- effective-from and effective-to timestamps;
- standard/batch/flex/priority/fast service tier;
- short/long context band where applicable;
- input, cache-write, cache-read, and output USD-per-million-token rates;
- geography/data-residency multiplier;
- official source URL, retrieval timestamp, document hash, reviewer, and status.

A scheduled job checks official pricing pages for changes and stages a candidate.
Because those pages are not guaranteed machine-readable pricing APIs, a changed
catalog requires schema validation and admin approval before it affects new facts.
Historical facts retain their original price-card link. Repricing is an explicit,
audited operation that creates a new estimate revision rather than mutating history.
The same refresh also merges optional authenticated provider model inventories and
model IDs observed in local sessions; neither is treated as pricing evidence.
Operators can run it from the Models & pricing page or CLI. Source configuration,
validation, immutable candidate approval, and failure behavior are specified in
[`model-price-catalog.md`](model-price-catalog.md).

Per-fact calculation uses disjoint token categories:

```text
estimated_cost_usd = (
    input_uncached_tokens * input_rate
  + cache_write_5m_tokens * cache_write_5m_rate
  + cache_write_1h_tokens * cache_write_1h_rate
  + cache_write_other_tokens * cache_write_other_rate
  + cache_read_tokens * cache_read_rate
  + output_tokens * output_rate
) / 1_000_000 * applicable_tier_context_geo_multiplier
```

For OpenAI records, cached reads and reported cache writes are subtracted from
total input before applying the uncached-input rate. For Claude records, the API
already reports base input, cache writes, and cache reads as separate categories.
Reasoning tokens are priced inside output and are never charged a second time.

## Aggregation design

Raw usage facts remain the source of truth. PostgreSQL maintains hourly and daily
rollups by device, project, provider, and model. Weekly/monthly views sum daily
rollups; arbitrary ranges query hourly or raw facts as appropriate. Late-arriving
historical imports invalidate only the affected buckets.

Key formulas:

```text
cache_hit_rate = cache_read / total_input
cache_miss_input = input_uncached + all_cache_writes
rolling_7d_daily_average = last_7_calendar_days_total / 7
rolling_30d_daily_average = last_30_calendar_days_total / 30
active_day_average = range_total / count(days_with_usage)
```

The UI always shows the numerator/denominator definition in a tooltip so “cache
hit rate” and “average per day” are not ambiguous.

## Parser health

Every parser reports scanned records, accepted facts, duplicates, malformed rows,
unknown schema variants, cursor resets, and last successful timestamp. A provider
upgrade that changes the JSONL format may temporarily stop analytics for affected
records, but never blocks byte-for-byte conversation synchronization. Parser fixes
can replay encrypted local history on endpoints and submit the missing facts.
