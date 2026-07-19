# Implementation plan

Status: roadmap. Completed items are represented in the repository and summarized
in the root README; an item appearing below is not by itself a claim that the
feature is already implemented.

The plan is milestone-based. Each milestone ends in an executable acceptance test,
not only completed source files.

Architecture baseline: one Next.js controller container, better-sqlite3 in WAL
mode, an in-process Honker consumer using the same database file, one persistent
`/app/data` volume, and one Python agent service on every managed node. There is
no PostgreSQL, Redis, broker, or separate worker container.

## Milestone 0: decisions and threat model

Deliverables:

- Confirm project/CLI/package name.
- Confirm the encrypted local object layout and controller-volume backup target.
- Approve the E2EE recovery and new-device key-approval workflow.
- Confirm only platform-specific handling exceptions; complete `.claude`,
  `.claude.json`, `.codex`, and existing `.agents` regular-file trees are now the
  operator-selected v1 scope.
- Define the pricing-estimate contract: official API list prices, standard-tier
  assumption when a local transcript omits modifiers, and a visible distinction
  between API-equivalent estimate and subscription invoice.
- Write the threat model: stolen controller volume, stolen enrollment token,
  compromised endpoint, compromised controller, archive traversal, secret leak,
  replay, downgrade, and supply-chain compromise.
- Define support targets for macOS, Linux, Windows, Python, and self-hosted Docker.

Acceptance: an architecture decision record exists for each open decision and the
recommended policy passes review using a real sample of both home directories.

## Milestone 1: monorepo and contracts

Deliverables:

- Create pnpm workspace with one Next.js controller and shared packages.
- Create uv Python project under `agent/` with the `relaydot` console entry point.
- Add formatting, linting, type checking, unit tests, secret scan, and CI.
- Define OpenAPI v1 endpoints and JSON Schema for policies, manifests, conversation
  segments, normalized usage facts, price cards, commands, revisions, conflicts,
  device identity/rename, health, rollout state, catalog refresh jobs, candidates,
  semantic diffs, approval, and estimate revisions.
- Generate TypeScript and Python clients/models from the contract.
- Add Docker Compose for one controller and its persistent data volume.

Acceptance: a clean checkout starts locally, both clients are generated without a
diff, and CI verifies schema compatibility.

## Milestone 2: safe local agent engine

Deliverables:

- Implement policy parsing, include/exclude evaluation, protected-path deny rules,
  path normalization, symlink containment, secret detection, and inventory.
- Implement canonical manifests, hashing, compressed bundles, and test vectors.
- Implement atomic stage/apply, managed-file deletion semantics, recovery backups,
  watcher loop suppression, debounce, and periodic reconciliation.
- Implement semantic JSON/TOML merge and text merge with conflict objects.
- Implement append-aware Claude project and Codex session synchronization,
  strict-prefix fast path, stream epochs, preserved divergent branches, encrypted
  attachments, and byte-for-byte round-trip fixtures.
- Implement incremental usage cursors, remote-apply suppression, Claude response
  deduplication, Codex cumulative/incremental reconciliation, and signed facts.
- Implement `config`, `sync`, and `doctor` CLI command groups.
- Add exhaustive unit/property tests for traversal, conflicting edits, duplicate
  usage records, truncated logs, schema changes, and token subset arithmetic.

Acceptance: two temporary home directories can exchange config and conversation
history plus complete plugin/application state, avoid re-attributing remote-applied
usage, survive interruption during apply, restore deleted files, and surface
deterministic conflicts without data loss.

## Milestone 3: controller storage and device protocol

Deliverables:

- Versioned SQLite migrations and typed better-sqlite3 data access.
- Encrypted local object adapter under `/app/data/objects` with immutable
  put/get, checksums, atomic rename, and backup verification.
- Endpoint encryption format, per-device key envelopes, trusted-device approval,
  recovery key flow, key rotation, and post-revocation rekey metadata.
- One-time enrollment, device keys/tokens, revocation, heartbeat, head lookup,
  revision upload/download, command claim/ack, and idempotency.
- Transactional head publication and conflict persistence.
- Conversation stream/segment tables, globally idempotent usage-fact ingestion,
  parser health, immutable official price cards, exact/assumed/unpriced matching,
  micro-USD cost calculation, and hourly/daily rollups.
- Durable model/price refresh jobs; optional paginated provider model inventories;
  allowlisted conditional documentation fetches; raw evidence hashes; deterministic
  provider parsers; candidate validation/diffing; transactional catalog approval;
  and explicit, versioned estimate recalculation.
- Forever retention, deletion tombstones, restoration of missing files, and a
  future policy-controlled garbage collector that remains disabled in v1.

Acceptance: an offline device can miss several changes, reconnect, receive the
latest revision and every unexpired durable command exactly once logically; a
concurrent publish produces a merge/conflict instead of lost data; repeated imports
do not change token totals or machine attribution; a malformed pricing source or
anomalous candidate fails closed and leaves the approved catalog unchanged.

## Milestone 4: service installation and one-line onboarding

Deliverables:

- launchd user service, systemd user service, and Windows Scheduled Task adapters.
- `service install/start/stop/status/uninstall` commands.
- Web-generated one-line commands for Unix and PowerShell with a ten-minute,
  single-use enrollment token.
- Pending-device approval and fleet-key envelope delivery without placing the
  recovery key in the install command or controller logs.
- `relaydot update` using uv, pinned-version support, restart handoff, post-update
  health report, and previous-version rollback.
- Package release to TestPyPI, then PyPI; provenance/signing and release checks.

Acceptance: clean macOS, Ubuntu, and Windows VMs enroll from one line, survive a
reboot, synchronize a change, upgrade remotely, restart, and report healthy.

## Milestone 5: administration console

Deliverables:

- Next.js/shadcn application shell, responsive navigation, dark mode, and auth.
- Fleet dashboard, device table/detail, event timeline, and object-store health.
- Editable machine display name and labels, with immutable device identity and
  rename audit history.
- Policy form/YAML editor with validation and device dry-run.
- Revision metadata diff, restore flow, and conflict resolution UI.
- Update center with canary/ring/all rollout and live SSE progress.
- Usage dashboard with token/category cards, cache hit/miss and savings, official
  API-equivalent cost, hourly/daily/weekly/monthly charts, rolling 7/30-day
  averages, prior-period comparison, machine/model/provider/project filters, and
  parser/price coverage warnings.
- Usage drill-down and CSV/JSON aggregate export without prompt/response text.
- Models & pricing page with **Check for updates**, scheduled-check status, source
  freshness, candidate diff/review/apply, price coverage, locally observed unpriced
  models, catalog export/import, and explicit estimate recalculation.
- Accessible keyboard navigation, loading/error/empty states, and audit screens.

Acceptance: every device-affecting action has confirmation, an idempotency key,
visible progress, a final result, and an audit event; UI end-to-end tests cover the
happy path and partial/offline failure states.

## Milestone 6: Syncthing replacement migration

Deliverables:

- `observe-only` agent mode, per-machine inventory, historical usage preview, and
  immutable machine registration before any writes.
- Import workspace that deduplicates already-synchronized histories, detects
  divergent config/conversation branches, and tracks provenance confidence.
- UI for assigning historical sessions to a machine or explicitly leaving them
  Unknown/Ambiguous.
- Pause/snapshot/import/canary/reconcile/cutover workflow documented in
  `docs/syncthing-migration.md`.
- Digest/file-count comparison, Claude/Codex history readability checks, and a
  tested rollback that resumes the original Syncthing share.

Acceptance: all machines converge under Relaydot, token totals remain stable across
two reconciliation cycles, encrypted credentials and application state reach every
trusted device, and Syncthing can be removed without losing any regular file.

## Milestone 7: hardening and compatibility

Deliverables:

- Compatibility matrix across supported local filesystems and backup targets.
- Chaos tests: timeouts, corrupt downloads, stale ETags, quota exhaustion, API
  restart, database restart, volume exhaustion, and endpoint power loss during apply.
- Security review, dependency/license scan, SBOM, backup/restore drill, key
  rotation, audit retention, and rate-limit tests.
- Performance tests using realistic file counts and 100/1,000 simulated agents.
- Operator documentation, upgrade policy, disaster recovery, and troubleshooting.

Acceptance: no test loses an allowed file or deletes an excluded file; a controller
restore can reconstruct all current heads from a consistent `/app/data` backup.

## Suggested build order within each milestone

Build vertical slices: contract, API, agent behavior, UI state, and tests for one
workflow at a time. The first slice should be enroll -> inventory -> upload one
revision -> apply on a second device. The second should be a concurrent edit and
conflict. The third should parse one Claude response and one Codex turn into
deduplicated usage facts and render an hourly machine-filtered total. The fourth
should be a remote pinned-version update. This exposes the highest-risk protocol
choices before the dashboard grows large.

## v1 definition of done

- Complete `.claude`, `.claude.json`, `.codex`, and existing `.agents` regular-file
  content syncs across the three supported operating systems, including projects,
  sessions, plugins, settings, credentials, databases, caches, and attachments.
- The controller cannot decrypt conversation content.
- No local deletion permanently removes a retained file while full-retention mode
  is active; the controller keeps all encrypted revisions and tombstones forever.
- Concurrent changes never silently overwrite each other.
- A newly enrolled machine reaches the current revision from a one-line install.
- The controller can trigger and audit a pinned update for all agents, including
  agents that were offline at dispatch time.
- Object corruption, volume failure, or rollback cannot cause silent local deletion.
- The console provides device status, revisions, conflicts, policy management,
  storage health, update rollout, machine rename/filters, and audit history.
- Usage totals are idempotent and filterable by machine; hourly, daily, weekly,
  monthly, rolling averages, cache categories, and official API-equivalent costs
  match parser fixtures and independent decimal calculations.
- A manual or scheduled official-source check cannot change active or historical
  prices until a validated candidate is approved; every catalog version and any
  historical recalculation is source-linked, immutable, and audited.
