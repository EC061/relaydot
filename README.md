# Relaydot

Relaydot is a self-hosted control plane and endpoint agent for synchronizing a
curated subset of AI coding-tool configuration across macOS, Linux, and Windows.
The durable payload store is WebDAV; device inventory, commands, rollouts, and
audit records live in the controller database.

The repository now contains the first executable agent-core slice. Policy and
path safety, deterministic inventories/manifests, traversal-safe bundles, atomic
apply with rollback, semantic/text merging, append-stream handling, usage
normalization, and exact cost arithmetic live under `agent/`. The controller and
web applications remain contract placeholders while the security and protocol
decisions are reviewed.

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
current suite exercises more than 98% of statements and branches combined.

## Recommended product shape

- A Next.js + shadcn/ui administration console.
- A NestJS TypeScript API/control plane backed by PostgreSQL.
- A Python endpoint agent distributed as a PyPI CLI and installed with `uv`.
- Encrypted, immutable revision bundles stored in any compatible WebDAV server.
- Outbound-only agent traffic with durable command polling, so offline machines
  receive sync and update commands when they return.
- Full-fidelity Claude project conversations and Codex session equivalents,
  synchronized with application-aware append-log handling.
- Per-machine usage analytics for tokens, cache activity, and API-equivalent cost.
- A reviewed model/price catalog with a web **Check for updates** action, scheduled
  official-source checks, semantic diffs, and immutable approved versions.

WebDAV is storage, not the command bus. This is the central architectural
decision: a WebSocket-only broadcast would lose commands for sleeping laptops,
while a durable command row can be acknowledged, retried, audited, and expired.

## Planned operator experience

After the package is published:

```sh
uv tool install relaydot
relaydot enroll --server https://relaydot.example.com --token <one-time-token>
relaydot service install --start
```

The web console will generate a single copy/paste enrollment line which installs
`uv` when necessary, installs Relaydot, consumes a short-lived one-time token,
and starts the per-user service.

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
propagated, and WebDAV garbage collection is disabled. This intentionally favors
preservation over storage efficiency and can be narrowed later. Conversation
payloads are encrypted on the endpoint before WebDAV upload; the controller
receives normalized usage counters without receiving prompt text.

Costs shown in the console are explicitly labeled **official API-equivalent
estimates**. They use versioned official API list prices and are not a claim about
the amount billed under a Claude or ChatGPT subscription.
