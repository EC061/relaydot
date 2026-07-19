# Model and price catalog refresh

Status: design specification. The current controller does not yet implement this
page, refresh API, scheduler, or catalog tables. These requirements are retained
here for the corresponding implementation milestone.

## Product behavior

The console has a **Settings -> Models & pricing** page with these actions:

- **Check for updates** fetches the official sources now and stages a candidate;
- **Review changes** shows additions, removals, aliases, price changes, effective
  dates, source evidence, warnings, and locally observed but unpriced models;
- **Apply candidate** creates a new immutable catalog version after confirmation;
- **Export** and **Import** support an offline or air-gapped reviewed catalog.

The page also shows last successful check, source freshness and hash, current and
candidate versions, model/price coverage, parser failures, and the next scheduled
check. A daily check is enabled by default. Automatic application is off by
default: discovering a provider change must not silently change cost estimates.

The same workflow is available to operators as:

```text
relaydot-admin catalog check [--provider openai|anthropic|all]
relaydot-admin catalog status
relaydot-admin catalog diff <candidate-id>
relaydot-admin catalog apply <candidate-id>
relaydot-admin catalog export [--version VERSION]
relaydot-admin catalog import <file>
```

The source allowlist and safety thresholds are ordinary reviewed configuration in
[`config/catalog-sources.yaml`](../config/catalog-sources.yaml). Credentials are
secret-store references, never values in that file.

## Why model discovery and pricing are separate

OpenAI and Anthropic provide authenticated model-list endpoints, but those model
records are inventories, not complete rate cards. Prices remain on their official
pricing documentation. Relaydot therefore combines three kinds of evidence:

1. model IDs observed in synchronized Claude/Codex sessions;
2. public official model documentation plus, when configured, the authenticated
   account's model-list API;
3. rate rows parsed from allowlisted official pricing documentation.

The authenticated result means “available to this configured API account,” not
“every model usable by Claude Code, Codex, or a subscription.” A locally observed
ID is retained even if absent from that result. Each normalized model can
independently have `observed_local`, `documented`, `api_available`, `deprecated`,
and `priced` evidence. Unknown models remain visible as `unpriced` rather than
being guessed.

Official starting points:

- OpenAI model list: `GET https://api.openai.com/v1/models`
- OpenAI model and pricing docs: `https://developers.openai.com/api/docs/models/all`
  and `https://developers.openai.com/api/docs/pricing`
- Anthropic model list: `GET https://api.anthropic.com/v1/models?limit=1000`
- Anthropic model/version and pricing docs:
  `https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions`
  and `https://platform.claude.com/docs/en/about-claude/pricing`

## Refresh pipeline

`POST /api/v1/catalog/refresh` creates a durable Honker job and returns `202`
with its ID. The web page follows progress through SSE and can safely reconnect.

1. Fetch only configured HTTPS URLs on the fixed host allowlist. Use ETag and
   Last-Modified conditional requests, strict time/size limits, and never execute
   page JavaScript or follow a redirect to an unlisted host.
2. Archive the raw response with URL, retrieval time, status, ETag,
   Last-Modified, SHA-256, content type, and parser version.
3. Parse API JSON and documentation tables with deterministic, provider-specific
   code. An LLM is never used to extract or approve monetary rates.
4. Merge evidence into a candidate without changing the active catalog.
5. Validate required columns/categories, exact decimal rates, nonnegative values,
   unique keys, pagination completion, source locators, and effective intervals.
6. Fail closed on an empty source, unknown table layout, duplicates, missing
   required rates, or configured anomaly thresholds. Show the raw-source link and
   diagnostics to the reviewer.
7. Render a semantic diff. Approval writes one new catalog version transactionally
   and emits an audit event; rejection retains the candidate for diagnosis.

A parser should select tables by semantic headers and provider-specific anchors,
not brittle DOM positions. Golden fixtures pin the understood page structure. If
a provider redesigns a page, the check becomes `parser_failed`; the last approved
catalog remains active.

## Versioned representation

SQLite uses these records:

- `catalog_sources`: configured kind, provider, URL, credential reference, state;
- `catalog_fetches`: immutable raw-fetch evidence and parser outcome;
- `catalog_candidates`: validation result and diff from an active version;
- `catalog_versions`: immutable approved snapshots and reviewer/audit metadata;
- `models`: canonical exact IDs and lifecycle evidence;
- `model_aliases`: explicit, provider-documented, effective-dated mappings;
- `price_cards`: decimal rates by exact model, effective interval, tier, context
  band, cache operation, speed, and geography;
- `catalog_apply_events`: approval, rejection, import, and recalculation events.

Model IDs match exactly. Relaydot never invents an alias through fuzzy matching.
One model can have multiple price cards for standard/batch/flex/priority service,
short/long context, cache-write TTL, fast mode, or data residency. Future-dated
official prices may be approved now and become eligible only at `effective_from`.

If a changed official row has no trustworthy effective date, applying the
candidate requires the administrator to set one; the UI proposes retrieval time
and labels it an operator assumption. Rates use fixed-point decimal USD per one
million tokens, never binary floating point.

## Historical cost safety

Applying a catalog only affects the price match for facts whose event time falls
in the new card's effective interval. Existing `usage_fact` estimate revisions
keep their catalog and price-card IDs. Relaydot never silently rewrites historical
numbers when a source changes.

An explicit **Recalculate estimates** operation can produce a new, audited
estimate revision for a chosen time range. Reports can select “as originally
estimated” or that newer revision. Actual provider billing reconciliation, if
added later through provider cost-report APIs, is a separate dataset and is not a
replacement for this API-equivalent rate catalog.

## Failure and test requirements

- Missing API credentials skip only the optional account-inventory source.
- A source outage or `304 Not Modified` never creates an empty catalog.
- Model API pagination, rate-table variants, future effective dates, exact decimal
  arithmetic, duplicate keys, malformed pages, large model-count drops, and large
  rate changes all have unit/golden tests.
- Candidate application is transactional, idempotent, authorization checked, CSRF
  protected, and audited.
- The server, not the browser, performs all provider requests so credentials and
  allowlist enforcement remain centralized.
