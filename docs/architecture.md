# Architecture

## System boundary

```text
Browser
  |
  | HTTPS
  v
Next.js controller  <---- HTTPS long-poll ----  Relaydot agents
  |
  +---- better-sqlite3 WAL database
  |       +---- device, command, usage, price, and audit tables
  |       +---- Honker durable queue/stream tables
  |
  +---- /app/data encrypted revision objects
```

Agents only make outbound HTTPS connections. They do not accept remote shell
commands, do not expose listening ports, and do not execute arbitrary controller
payloads. The remote command vocabulary is a closed, versioned enum such as
`sync`, `update_agent`, `reload_policy`, and `collect_diagnostics`.

## Repository layout

```text
relaydot/
  apps/
    web/                  # single Next.js controller, UI, and agent API
  packages/
    contracts/            # OpenAPI-generated TypeScript client and schemas
    sync-format/          # manifest schema and test vectors
  agent/                  # Python package installed by uv
  infra/
    compose/              # one controller container and persistent data volume
  policies/               # reviewed default policy presets
  docs/
```

Use a pnpm workspace for TypeScript packages and a separate uv-managed Python
project for the agent. The versioned `/api/v1` HTTP surface is the contract
boundary between the Next.js route handlers and Python agent.

## Control plane

### Services

- `controller`: Next.js App Router UI and Node route handlers with `/api/v1`
  versioning, admin/device authentication, enrollment, and command delivery.
- `db`: better-sqlite3 in WAL mode as the system of record.
- `jobs`: Honker tables in the same SQLite file, consumed in the controller.
- `objects`: encrypted immutable files under `/app/data/objects`.
- `proxy`: Caddy or an existing reverse proxy terminates TLS.

Redis, BullMQ, and a separate worker are deliberately absent. Device commands and
background work live in SQLite/Honker and commit alongside controller state.

### Core data model

- `users`: administrator identity and authorization.
- `fleets`: isolation boundary for policy, encryption, and revisions.
- `devices`: public key, platform, hostname label, agent version, capabilities,
  last seen, status, desired version, revocation state, immutable device ID,
  mutable display name, reported OS hostname, labels, and aliases.
- `enrollment_tokens`: hashed, single-use, short-lived tokens with an audit link.
- `policies` and `policy_versions`: immutable reviewed allowlists and selectors.
- `channels`: named sync streams such as `personal-default` or `work`.
- `revisions`: parent/base IDs, manifest digest, object path, author device,
  timestamps, size, and validation state.
- `conversation_streams` and `conversation_segments`: provider/session identity,
  ordered encrypted append segments, origin device, and source-format version.
- `channel_heads`: current accepted revision per channel.
- `commands`: target selector, typed payload, not-before/expiry, attempt count,
  acknowledgement, result, and idempotency key.
- `conflicts`: base/ours/theirs, affected paths, resolution, and audit actor.
- `usage_facts`: deduplicated per-response/turn token categories, source machine,
  project/model dimensions, parser provenance, and estimated cost.
- `usage_import_cursors`: per-device/file byte position, prefix digest, apply
  provenance, schema version, and last parser result.
- `price_cards`: immutable official price snapshots with effective ranges, model,
  tier/context/geography dimensions, source hash, and approval state.
- `catalog_sources`, `catalog_fetches`, `catalog_candidates`, and
  `catalog_versions`: allowlisted official inputs, immutable fetch evidence,
  validated staged diffs, and approved model/price snapshots.
- `models` and `model_aliases`: exact provider IDs with independent observed,
  documented, account-available, deprecation, and pricing evidence.
- `usage_rollups_hourly` and `usage_rollups_daily`: rebuildable aggregates.
- `events`: append-only audit records with retention controls.

### Web console surfaces

1. Fleet overview: online/offline/stale devices, sync health, current agent
   versions, conflicts, object-storage status, and recent activity.
2. Device inventory: filters, labels, last check-in, platform, policy revision,
   current/desired version, diagnostics, revoke, single-device sync/update, and
   editable display name/tags. Renaming does not change the OS hostname.
3. Revision timeline: parent graph, author, file-level metadata diff, restore, and
   retention status. File contents are hidden unless explicitly enabled.
4. Conflict inbox: structured JSON/TOML conflicts, text diffs, choose/merge,
   publish resolution, and impacted device count.
5. Policy editor: form mode plus YAML editor, live validation, dry-run against
   device inventories, secret warnings, and versioned publish/rollback.
6. Update center: available signed agent releases, canary/ring/all rollout,
   progress, failures, retry, pause, and rollback.
7. Usage analytics: total/cache/output tokens and API-equivalent cost over hourly,
   daily, weekly, monthly, rolling 7/30-day, and arbitrary periods, filterable by
   machine, provider, model, project, session, and service tier.
8. Parser health: per-provider accepted/duplicate/unknown record counts, cursor
   resets, last successful parse, replay action, and price-match coverage.
9. Storage/settings: object integrity, quota/latency health,
   encryption key status, retention, backup, and audit export.
10. Models & pricing: check official sources now, inspect source freshness and
    coverage, review a semantic candidate diff, apply an immutable catalog version,
    and explicitly recalculate selected historical estimate revisions.

## Endpoint agent

### Runtime and libraries

- Python 3.11+ packaged with `pyproject.toml` and a `relaydot` console script.
- Typer for CLI, Pydantic for typed configuration, HTTPX for the controller API,
  watchfiles for native file notifications, platformdirs for local state, keyring
  for device credentials, and cryptography for authenticated encryption.
- launchd user agent on macOS, systemd user service on Linux, and a per-user
  Scheduled Task on Windows for v1.

### Local state

Store Relaydot state outside the synchronized roots. It contains the device ID,
controller URL, device private key reference, last applied revision, local base
manifest, loop-suppression markers, bounded logs, and staged recovery backups.
It also contains conversation byte cursors and a journal that distinguishes bytes
created locally from bytes applied by Relaydot. Secret material belongs in the OS
credential store when available. Local config must use owner-only permissions.

### Configuration commands

`relaydot config init` creates a commented config and validates discovered paths.
`config set` changes one typed key, `config edit` opens the file, and `config
validate` checks policy, path portability, controller reachability, secret
patterns, symlink escapes, and file size limits. The web console can publish a
policy version, but machine-specific path overrides remain local.

### Conversation parser adapters

Provider-specific adapters parse only usage metadata and structural identifiers.
They never send prompt/response content to the analytics API. Claude adapters
deduplicate repeated records by session and response ID. Codex adapters count
`last_token_usage` once and use cumulative totals for consistency checking. Parser
schemas are versioned, and unknown rows remain part of the synchronized byte stream
even when analytics cannot yet interpret them.

## Sync protocol

Relaydot has two synchronization classes: configuration snapshots and append-heavy
conversation streams. Treating multi-gigabyte JSONL history as a fresh archive on
every appended line would be inefficient and would make source-machine accounting
unreliable.

### Configuration snapshot and publish

1. A watcher event is debounced and coalesced; periodic reconciliation catches
   missed watcher events.
2. Enumerate only allowlisted roots. Never follow a symlink outside its root.
3. Reject unsafe paths and sockets/devices. Regular files have no policy size cap
   in full-mirror mode and use chunked transfer; provider quota/limits surface as a
   blocking storage-health error. Secret and credential detection is report-only.
4. Hash files and build a canonical manifest containing relative path, content
   digest, size, mode class, and logical type. Do not put absolute home paths in it.
5. Compare with the local base. If unchanged, stop.
6. Create and end-to-end encrypt a compressed revision bundle, then upload it with
   `base_revision_id` and an idempotency key.
7. The controller validates ciphertext metadata, stores the immutable local
   object, and in a database transaction advances the channel head only if the
   base is current.
8. If the base is stale, start the merge/conflict path instead of overwriting.

### Receive and apply

1. Poll for the current channel head and durable commands with jitter/backoff.
2. Download and authenticate the revision; validate all paths before extraction.
3. Stage under a private temporary directory on the same filesystem.
4. Re-scan the live destination. If it changed since the base, merge or report a
   conflict rather than overwriting it.
5. Make a bounded recovery backup, then apply files with atomic replacement.
6. Delete only files that were previously managed and are now explicitly deleted
   by the policy. Never delete excluded or unknown local files.
7. Record the applied revision and suppress watcher echoes from the same apply.
8. Acknowledge with per-path results and health data.

### Conversation stream publish and apply

1. Maintain a byte cursor and stable prefix digest per conversation file.
2. When a file grows, parse complete new JSONL records, classify the bytes as local
   or remote-applied, and emit usage facts only for genuinely local records.
3. Preserve original bytes in ordered, content-addressed segments. Encrypt each
   segment on the endpoint before upload; prompt text never reaches SQLite.
4. The controller deduplicates segments and usage facts with separate idempotency
   keys and records the origin device for each newly observed local event.
5. A receiving agent reconstructs the exact provider file in a staging area and
   atomically appends or replaces it only after prefix validation.
6. If one copy is a strict-prefix extension of the other, use the longer stream.
7. For Claude, records with stable UUID/parent relationships can be unioned when
   the graph is valid and all original records are preserved.
8. For Codex or an unknown schema, concurrent divergent appends create preserved
   branches and a conflict instead of rewriting undocumented internal identifiers.
9. Truncation, rotation, or mid-file rewrite starts a new stream epoch and retains
   the previous version for recovery.

Secret scanning is report-only because full-fidelity state is an explicit
requirement. Credentials are included, every enrolled device is therefore a
high-trust endpoint, and E2EE is mandatory for every dataset.

### Merge rules

- JSON: parse and perform a three-way object merge. Independent keys merge;
  same-key divergent edits conflict. Preserve a deterministic formatting style.
- TOML: the same semantic three-way rule, with a formatter round trip and schema
  validation where possible.
- Markdown and text: line-based three-way merge. Never silently leave conflict
  markers in active configuration files.
- Directories: merge per relative path.
- Binary or unknown formats: no automatic merge; retain both candidates and open
  a conflict.
- Provider JSONL: use the application-aware stream rules above, never a generic
  formatter or line-sort operation.
- Delete versus modify: always a conflict unless policy explicitly chooses one.

The default conflict policy is `preserve_both_and_pause_path`, not last writer
wins. Other unrelated paths continue synchronizing.

## Encrypted object layout

```text
/app/data/objects/v1/fleets/<fleet-id>/
  revisions/<revision-id>.bundle.enc
  manifests/<revision-id>.manifest.enc
  conversations/<provider>/<stream-id>/<epoch>/<segment-id>.jsonl.enc
  attachments/<content-digest>.blob.enc
  checks/<revision-id>.sha256
```

Objects are immutable and addressed by revision ID. Logical heads and commands are
kept in SQLite, not mutable object files. Under the current preservation mode,
tombstones and old objects are retained forever and garbage collection is disabled.

## Security model

- TLS is mandatory outside loopback development.
- Enrollment tokens are random, hashed at rest, single use, scoped, and short lived.
- Each device creates a keypair. Controller-issued access tokens are bound to the
  device, rotated, and immediately revocable.
- The object directory is writable only by the controller container user and is
  backed up consistently with SQLite.
- The first trusted device generates the fleet content key. The controller stores
  only per-device encrypted key envelopes. A new device needs approval from an
  existing trusted device or the offline recovery key before it can decrypt.
- Revision bundles, conversation segments, and attachments use authenticated
  encryption on the endpoint before object upload. The controller cannot decrypt
  conversation content.
- Auth files, credentials, operational logs, caches, SQLite state, plugins,
  settings, conversation histories, sessions, and attachments are all included
  under the current E2EE full-mirror policy.
- Secret scanning combines known filenames, high-confidence token patterns, and
  entropy checks. A blocked file is never uploaded in diagnostics.
- Update commands accept only signed, allowlisted Relaydot releases and fixed
  command parameters. There is no remote shell endpoint.
- All policy changes, enrollments, revocations, restores, conflict resolutions,
  and update rollouts create append-only audit events.
- Archives are checked against path traversal, absolute paths, special files,
  symlink escapes, decompression bombs, and unexpected ownership/mode changes.
- Signed analytics facts contain counters and identifiers only. They must not carry
  prompt, response, tool output, or attachment content.

### Full-state file handling

All regular files and symlinks inside the selected roots are retained. Sockets,
device nodes, and active OS lock handles cannot be serialized and are represented
as inventory warnings. Symlinks are copied as links without following targets
outside their root.

SQLite databases are captured through an application-consistent snapshot when
possible rather than by independently copying database/WAL/SHM bytes. Unknown or
actively changing databases are preserved as versioned machine branches and never
silently overlaid onto another machine. Machine-specific paths and caches can
conflict, so full-state conflicts preserve both versions.

The current deletion policy is `archive-and-restore`: a disappearance creates a
tombstone/audit event but does not remove the retained object or other device
copies. Relaydot restores the last retained version unless the operator later
changes policy and explicitly approves a permanent deletion.

The fleet policy also enforces Claude `cleanupPeriodDays = 36500`, the largest
practical no-cleanup horizon selected for the current deployment because Claude
does not accept `0`, and Codex `[history].persistence = "save-all"`. The agent
validates these after every apply and reports drift. Relaydot retention remains the
authoritative safety net if either application deletes local state despite those
settings.

## Usage and cost pipeline

The endpoint converts provider-specific records into normalized immutable facts.
The controller validates signatures, uniqueness keys, nonnegative/subset
relationships, model/timestamp plausibility, and device enrollment before insert.
Hourly/daily rollups are derived from raw facts and can be rebuilt.

Every fact is matched to a time-versioned official price card. Exact model, tier,
context band, cache operation, speed, and geography are used where present. Missing
billing modifiers produce an `assumed` badge; an unknown model is `unpriced`. The
displayed value is API-equivalent estimated cost and is not presented as a Claude
or ChatGPT subscription invoice. Detailed normalization and formulas live in
`docs/usage-analytics.md`.

## Model and price catalog refresh

Model inventory and pricing are different inputs. The OpenAI and Anthropic model
APIs show IDs available to a configured API account but do not provide complete
rate cards. The controller combines those optional authenticated inventories with
locally observed model IDs and deterministic parsing of allowlisted official model
and pricing documentation.

A manual UI check or daily schedule creates a durable Honker refresh job. It
archives response metadata and hashes, parses with versioned provider adapters,
validates exact decimal rates and completeness, and stages a candidate. Automatic
application is off by default. An administrator reviews source-linked additions,
removals, aliases, effective dates, and rate changes before a transaction creates
an immutable catalog version. A source-layout failure leaves the prior catalog
active. Existing usage estimates are not silently repriced.

The controller is the only fetcher. It enforces HTTPS, a fixed official-host
allowlist, response size/time limits, same-allowlist redirects, conditional HTTP,
and no page script execution. The declarative source file is
`config/catalog-sources.yaml`; the full contract, tables, failure modes, and CLI
are in `docs/model-price-catalog.md`.

## Remote agent updates

The controller creates a rollout with a pinned version and device selector. Each
matching agent claims an idempotent `update_agent` command, verifies that the
version is allowed, runs `uv tool upgrade relaydot==<version>`, and exits with a
known restart code. The service manager restarts it. The new process reports its
version and runs a health check before the rollout counts it successful.

Rollout modes are canary, percentage/ring, and all. “Update all” is available, but
the UI should default to a small canary followed by automatic progression. Offline
devices retain the command until its expiry and update when they reconnect. A
failed health check can install the previous pinned version and report a rollback.
