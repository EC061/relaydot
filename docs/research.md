# Research and decisions

Status: decision record and supporting research, not an implementation-status
document. Current shipped behavior is summarized in the root README.

Research date: 2026-07-16.

## What the protocols and tools imply

### WebDAV

WebDAV provides collections, metadata, conditional requests, and optional locks.
Its core specification explicitly supports ETags and `If-Match`, which are useful
for optimistic concurrency. RFC 6578 defines efficient collection synchronization,
but it is an extension and cannot be assumed to exist on every WebDAV provider.

Decision: use the smallest portable WebDAV surface (`OPTIONS`, `MKCOL`, `PUT`,
`GET`, `HEAD`, `DELETE`, and shallow `PROPFIND`) and run a capability probe during
setup when an external object adapter is enabled. The default single-container
deployment stores immutable encrypted objects under `/app/data/objects`; SQLite
serializes publication of logical heads in the same persistent volume.

Sources:

- https://datatracker.ietf.org/doc/rfc4918/
- https://datatracker.ietf.org/doc/html/rfc6578

### Agent installation and upgrades

`uv tool install` installs a Python CLI into an isolated environment and exposes
its executable on `PATH`. `uv tool upgrade` upgrades an installed tool. `uv` has
official standalone installers for macOS/Linux and Windows, so it can support the
requested one-line onboarding without assuming a system Python.

Decision: publish the agent as a normal PyPI package with a console entry point.
Use `uv tool install relaydot` for installation and `uv tool upgrade relaydot` for
the latest release. Remote rollouts should normally pin a version so that a fleet
rollout is reproducible rather than racing the current PyPI `latest` value.

Sources:

- https://docs.astral.sh/uv/getting-started/installation/
- https://docs.astral.sh/uv/concepts/tools/
- https://packaging.python.org/en/latest/guides/creating-command-line-tools/

### Web framework and UI

Next.js App Router supports server/client components and Node route handlers in
one deployable process. `better-sqlite3` provides synchronous transactions and
explicit WAL mode. Honker provides durable queue claims and commit notifications
using tables in the same SQLite file.

Decision: use one Next.js controller for the console and versioned agent API.
Use better-sqlite3 with `journal_mode=WAL`, foreign keys, normal synchronous mode,
and a busy timeout. Insert Honker jobs through the same better-sqlite3 transaction,
then consume them inside the Next.js process. Do not deploy a broker or worker
container.

Sources:

- https://nextjs.org/docs/app
- https://ui.shadcn.com/docs/installation/next
- https://github.com/WiseLibs/better-sqlite3
- https://honker.dev/

## Configuration scope findings

### Claude Code

Current Claude Code documentation distinguishes user configuration in
`~/.claude/`, repository configuration in `.claude/`, and machine-local settings.
It identifies `~/.claude/settings.json`, `~/.claude/CLAUDE.md`,
`~/.claude/agents/`, and `~/.claude/skills/` as user-scoped authoring surfaces.
Legacy `commands/` still works, but skills are the recommended authoring surface.
Plugin enablement and non-sensitive plugin options are stored in `settings.json`;
sensitive plugin options use the OS keychain or a credentials file.

Decision: the current operator-selected policy mirrors the complete `~/.claude`
tree plus `~/.claude.json`, including authored settings, instructions, agents,
skills, commands, plugins, projects, credentials, caches, and application state.
Everything is end-to-end encrypted and synchronized exactly, while analytics
extracts only usage metadata. Secret scanning is report-only and never silently
omits a regular file. This is a trusted-device policy and can be narrowed later.

Sources:

- https://code.claude.com/docs/en/settings
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/memory

### Codex

Current Codex documentation says `CODEX_HOME` defaults to `~/.codex` and contains
configuration plus local state. `auth.json` can contain access tokens and must be
treated like a password; history, logs, sessions, and caches are also local state.
Durable user configuration includes `config.toml`, global `AGENTS.md`, profile
TOML files, personal agents, rules, and hooks. Current personal skills live under
`~/.agents/skills`, while personal marketplace metadata can live under
`~/.agents/plugins`; installed plugin cache data under `~/.codex/plugins/cache`
should not be synchronized.

Decision: mirror the complete `~/.codex` tree, including sessions, archived
sessions, attachments, settings, plugins, credentials, SQLite state, caches, and
temporary regular files. Mirror the complete `.agents` tree when it exists. Treat
absolute paths and machine-specific state as portability/conflict warnings, not
exclusions.

Source:

- https://developers.openai.com/codex/codex-manual.md

## Architecture alternatives considered

| Option | Strength | Problem | Decision |
| --- | --- | --- | --- |
| Web controller + outbound endpoint agent | Central policy, offline command delivery, audit, no inbound device ports | Requires hosting a controller | Selected |
| Agents talk directly to WebDAV | Small server footprint | WebDAV credentials on every device; no durable remote control or fleet inventory | Rejected |
| Syncthing plus a dashboard | Mature file replication | Hard to enforce safe semantic allowlists, update agents, or provide application-aware conflicts | Rejected |
| Git repository as the source of truth | Excellent history and review | Awkward for frequently changing personal state and credentials | Optional export only |
| Peer-to-peer mesh | No central server | NAT, offline peers, revocation, and audit complexity | Rejected |
| Always-on WebSockets for control | Low latency | Sleeping/offline devices miss ephemeral broadcasts | Optional wake hint only |

## Conversation and usage format findings

The Claude and Codex on-disk transcript formats are useful but are not public,
versioned interoperability contracts. A metadata-only inspection of current local
files found two accounting hazards:

- Claude assistant records carry `message.usage` with `input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, and a
  5-minute/1-hour cache-creation breakdown. The same `message.id` can appear in
  multiple JSONL records, so the parser must select one authoritative terminal
  record per session/response instead of summing every row.
- Codex session JSONL emits `token_count` events containing both
  `last_token_usage` and cumulative `total_token_usage`. The parser must count the
  last-turn value once and use the cumulative value only to check/reset its cursor.
  Cached input is a subset of total input, and reasoning output is a subset of
  output; neither subset should be added again to total tokens.

Decision: build versioned Claude and Codex parser adapters with captured,
content-redacted fixtures. Unknown records always remain synchronized byte-for-byte
but are quarantined from analytics and surfaced as a parser-health warning.

Official usage semantics agree with the normalized categories. Anthropic defines
total input as base input plus cache creation plus cache reads. OpenAI reports
cached reads within input-token details and, on newer models, cache writes
separately.

Sources:

- https://platform.claude.com/docs/en/api/messages
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- https://developers.openai.com/api/docs/guides/prompt-caching
- https://developers.openai.com/codex/codex-manual.md

## Price accounting findings

Official model pricing is multi-dimensional: provider, exact model, date, service
tier, context band, cache read/write category, geography, and sometimes speed mode
can change the rate. Anthropic already publishes time-bounded introductory pricing,
which demonstrates why a single mutable price-per-model column would corrupt
historical reports.

Decision: store immutable price-card versions with source URL, retrieval time,
effective range, and content hash. Every usage fact records the matched price-card
ID and whether the match was exact, assumed, overridden, or unavailable. Unknown
models still contribute tokens but show `unpriced` cost instead of silently using a
nearby model. Subscription-backed Claude Code or Codex activity is labeled
API-equivalent estimated cost, not actual billed cost.

Sources:

- https://platform.claude.com/docs/en/about-claude/pricing
- https://developers.openai.com/api/docs/pricing

## Model and pricing refresh findings

Both providers expose authenticated model-list APIs, but their documented model
objects describe identity, ownership/display metadata, dates, and capabilities—not
a complete versioned price rate card. Official rates remain in provider pricing
documentation and include modifiers that cannot be represented by a single
price-per-model field.

Decision: use the provider APIs as optional account-availability evidence, merge
them with public official model documents and locally observed session model IDs,
then parse only allowlisted official pricing documents with deterministic,
versioned adapters. A manual web button and daily schedule stage a source-linked
candidate. Schema/anomaly checks and administrator review precede immutable
catalog approval; failed fetches or page-layout changes keep the last approved
catalog. Details are in `docs/model-price-catalog.md`.

Sources:

- https://developers.openai.com/api/reference/resources/models/methods/list
- https://developers.openai.com/api/docs/models/all
- https://developers.openai.com/api/docs/pricing
- https://platform.claude.com/docs/en/api/models/list
- https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
- https://platform.claude.com/docs/en/about-claude/pricing

## Decisions that should be reviewed before implementation

1. Recovery and new-device approval for end-to-end encryption. The first trusted
   device creates the fleet content key; subsequent devices need approval from an
   existing device or the offline recovery key.
2. Whether an external WebDAV object adapter belongs after v1. The default
   deployment keeps encrypted objects on the controller's `/app/data` volume, so
   WebDAV compatibility is not a release requirement.
3. Initial platform support. macOS and Linux user services are straightforward;
   Windows should use a per-user Scheduled Task first and graduate to a signed
   native service wrapper only if background reliability requires it.
