# Relaydot

Relaydot is a self-hosted control plane and endpoint agent for synchronizing a
curated subset of AI coding-tool configuration across macOS, Linux, and Windows.
The controller is a single Next.js container backed by better-sqlite3 in WAL mode.
Honker provides durable in-process jobs in the same SQLite file, without a
separate worker or broker.

The repository contains an executable controller and endpoint-agent slice.
Policy/path safety, deterministic manifests, traversal-safe bundles, atomic apply
with rollback, merging, append streams, WebDAV blob sync, and usage arithmetic
live under `agent/`. The controller implements one-time enrollment, device
authentication, heartbeat, durable command creation/claim/acknowledgement, audit
events, SQLite migrations, an embedded Honker consumer and scheduler, browser
session authentication, WebDAV storage configuration, usage ingestion and
analytics, the reviewed model/price catalog, and the administration dashboard.

**Current readiness:** the controller and agent protocol run end-to-end.
Configuration and conversation history synchronize agent to agent through a
shared WebDAV object store, and the controller derives per-model usage and cost
from it. End-to-end encryption of stored objects, remote package updates, and
staged catalog-diff review are still in progress.

## Synchronization

Agents talk to WebDAV directly, so file bytes never pass through the controller.
Each agent uploads the content of every policy-selected file to
`objects/<first two hex>/<sha256>` and publishes what it holds to
`manifests/<device id>.json`; peers read those manifests and pull only the
digests they are missing. Content is addressed by hash, so an unchanged file
costs one existence check and no upload, and a file two machines already share is
never uploaded twice. Modification time decides which side is authoritative when
the same path differs.

Two policy guarantees are enforced in the sync loop. `deletionPolicy:
archive-and-restore` means a path missing from a peer manifest is never deleted
locally — absence is not a delete instruction. `conflictStrategy:
preserve_both_and_pause_path` means that when two versions genuinely diverged,
the peer copy lands beside the local one under a conflict name and the path is
reported as paused rather than overwritten.

### Conversation transcripts are always partial

A live session appends to its `.jsonl` transcript the whole time a sync is
running, so those files get handled on their own terms:

- **Digests describe the bytes that were read**, never a hash taken during an
  earlier inventory pass. Otherwise an object lands at an address it does not
  hash to, and every peer trusts that address.
- **Only whole records are published.** Content is cut at the last complete JSONL
  record, so a peer never receives a half-written line, and the published digest
  stays stable while a writer is midway through the next record. A file with no
  complete record yet waits for the next cycle.
- **Logs merge by prefix, not by clock.** Records are only appended, so whichever
  side strictly extends the other is the complete log; a peer with fewer records
  but a newer timestamp cannot truncate a longer transcript. Only genuinely
  divergent branches — both sides appended different records — produce a
  conflict copy.
- **Downloads are re-hashed before they are applied**, so a truncated upload is
  refused rather than written into a real home directory. The controller checks
  the same thing before parsing.

A file that fails on its own is reported in the sync result's `problems` and the
rest of the run continues; transient session files appear and vanish constantly,
and one of them going away must not stop the fleet from converging.

Configure the shared backend on the dashboard's **Storage** panel. The password
is stored encrypted at rest, is never returned to a browser, and is handed only
to authenticated enrolled devices.

## Usage analytics and prices

The controller reads the same object store, parses `claude/projects/**.jsonl` and
`codex/sessions/**.jsonl`, and writes normalized usage facts. Parsing is
metadata-only: token counters and model identifiers are read; prompt and
completion text never are. Because blobs are named by digest, an object that has
already been parsed is skipped without fetching it, and a transcript that grew is
re-read in full without double counting — fact identity comes from provider,
session, and event.

Costs are official API-equivalent estimates, not a claim about what a Claude or
ChatGPT subscription billed. Claude list prices ship as a reviewed seed. A
scheduled check against the sources declared in
[`config/catalog-sources.yaml`](config/catalog-sources.yaml) discovers which
model *identifiers* exist; it does not scrape prices, because a dollar figure
lifted out of a documentation page would silently mislabel real spend. Models
seen in traffic with no approved rate appear in a review queue on the **Prices**
panel and contribute tokens but no cost until an operator approves a rate against
the source they read it from.

## Controller authentication

The dashboard requires a session. `RELAYDOT_ADMIN_TOKEN` is the root credential:
signing in at `/login` exchanges it for an HttpOnly, SameSite=Lax session cookie
that is stored server-side as a SHA-256 hash and expires after eight hours.
Administrator API routes accept either that cookie or the
`x-relaydot-admin-token` header, so scripts and CI keep working unchanged.

Set `RELAYDOT_PUBLIC_URL` to the URL browsers use to reach the controller. It
pins the origin check and the `Secure` cookie flag to a trusted value rather
than the client-supplied `Host` header. Cookie-authenticated requests from any
other origin are rejected with 403, and repeated failed sign-ins are throttled.

The controller refuses to start in production without `RELAYDOT_ADMIN_TOKEN`
rather than falling back to a default.

## Development checks

The Python 3.11+ agent is managed with `uv`:

```sh
cd agent
uv sync --all-groups
uv run ruff check .
uv run ruff format --check .
uv run mypy src
uv run pytest --cov=relaydot --cov-report=term-missing
```

The suite uses branch coverage and includes property tests for portable paths,
append classification, and token arithmetic. CI enforces a minimum of 90%; the
current suite exercises more than 95% of statements.

## Target product shape

- One Next.js controller containing the administration UI and agent API.
- better-sqlite3 in WAL mode at `/app/data/relaydot.db`.
- Honker durable jobs consumed inside the controller process.
- A Python endpoint agent distributed as a PyPI CLI and installed with `uv`.
- One persistent `/app/data` volume for the controller database and encrypted
  revision objects.
- Outbound-only agent traffic with durable command polling, so offline machines
  receive sync and update commands when they return.
- Full-fidelity Claude project conversations and Codex session equivalents,
  synchronized with application-aware append-log handling.
- Per-machine usage analytics for tokens, cache activity, and API-equivalent cost.
- A reviewed model/price catalog with a web **Check for updates** action, scheduled
  official-source checks, semantic diffs, and immutable approved versions.

SQLite/Honker is the durable command bus. A WebSocket-only broadcast would lose
commands for sleeping laptops, while durable command rows can be claimed,
acknowledged, retried, audited, and processed when a node returns.

## Operator experience

After the package is published:

```sh
uv tool install relaydot
relaydot enroll --server https://relaydot.example.com --token <one-time-token>
relaydot service install --start
```

The current agent supports foreground operation and installs a launchd user
agent, systemd user service, or Windows Scheduled Task with:

```sh
relaydot service install --start
```

The CLI implements:

```text
relaydot config show|validate
relaydot sync inventory|now|status|diff
relaydot service install|run
relaydot enroll
relaydot doctor
```

`sync now` heartbeats, claims durable commands, exchanges content through the
shared object store, and acknowledges. `sync status` reports the local inventory
and what this node last exchanged with peers; `sync diff` shows which local paths
differ from what it last applied.

`config init|set|edit`, `sync` service subcommands beyond the above, and
`relaydot update` are still target behavior. Remote version selection and
rollout rings are not part of the current `0.1.x` slice; the planned agent
upgrade mechanism uses `uv tool upgrade relaydot` or an explicitly pinned
version.

## Documents

- [Self-hosting status and current Compose path](docs/self-hosting.md)
- [Controller image and production deployment workflow](docs/deployment-workflow.md)
- [Agent release and uv publishing guide](docs/releasing.md)
- [Research and decisions](docs/research.md)
- [Architecture](docs/architecture.md)
- [Implementation plan](docs/implementation-plan.md)
- [Usage analytics and cost accounting](docs/usage-analytics.md)
- [Model and price catalog refresh](docs/model-price-catalog.md)
- [Syncthing replacement and migration](docs/syncthing-migration.md)
- [Official catalog source configuration](config/catalog-sources.yaml)
- [Recommended sync policy](policies/recommended.yaml)

## Important default

The current policy is a **curated subset**, not a full mirror. Only the
directories listed below leave a machine; everything else — credentials, logs,
caches, todos, and other local state — is ignored and never uploaded:

```text
~/.claude    settings.json, commands/, skills/, plugins/, projects/
~/.codex     config.toml, prompts/, sessions/          (optional root)
```

Ignore rules use Syncthing semantics, evaluated in order with the first match
deciding, so the negations above the trailing `*` are the complete allow list.
Deletions are archived and restored rather than propagated, and object garbage
collection is disabled. See
[`policies/recommended.yaml`](policies/recommended.yaml) to widen or narrow it. Conversation
payloads will be encrypted on the endpoint before controller object upload; the
controller receives normalized usage counters without receiving prompt text.

Costs shown in the console are explicitly labeled **official API-equivalent
estimates**. They use versioned official API list prices and are not a claim about
the amount billed under a Claude or ChatGPT subscription.
