# Relaydot

Relaydot is a self-hosted control plane and endpoint agent for synchronizing a
curated subset of AI coding-tool configuration across macOS, Linux, and Windows.
The controller is a single Next.js container backed by better-sqlite3 in WAL mode.
Honker provides durable in-process jobs in the same SQLite file, without a
separate worker or broker.

The repository contains an executable controller and endpoint-agent slice.
Policy/path safety, deterministic manifests, traversal-safe bundles, atomic apply
with rollback, merging, append streams, and usage arithmetic live under `agent/`.
The controller implements one-time enrollment, device authentication, heartbeat,
durable command creation/claim/acknowledgement, audit events, SQLite migrations,
an embedded Honker consumer, and the initial administration dashboard.

**Current readiness:** the controller and agent protocol run end-to-end and the
agent package builds cleanly. Encrypted cross-device revision transfer, controller
authentication for the browser UI, remote package updates, and the remaining
fleet-management screens are still in progress.

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

## Product shape

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

## Planned operator experience

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

The stable CLI contract is planned as:

```text
relaydot config init|show|set|edit|validate
relaydot sync now|status|diff
relaydot update [--version VERSION]
relaydot service install|start|stop|status|uninstall
relaydot doctor
```

The controller can set a desired agent version for one device, a rollout ring,
or the entire fleet. Agents upgrade with `uv tool upgrade relaydot` (or install a
pinned version), restart through the local service manager, and report health.

## Documents

- [Self-hosting status and current Compose path](docs/self-hosting.md)
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

The current policy is a full encrypted mirror of `~/.claude`, `~/.claude.json`,
`~/.codex`, and optional `~/.agents`: conversations, settings, plugins,
credentials, caches, databases, attachments, and other regular files are retained
on every trusted machine. Deletions are archived and restored rather than
propagated, and object garbage collection is disabled. This intentionally favors
preservation over storage efficiency and can be narrowed later. Conversation
payloads will be encrypted on the endpoint before controller object upload; the
controller receives normalized usage counters without receiving prompt text.

Costs shown in the console are explicitly labeled **official API-equivalent
estimates**. They use versioned official API list prices and are not a claim about
the amount billed under a Claude or ChatGPT subscription.
