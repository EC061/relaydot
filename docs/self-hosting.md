# Self-hosting status and Compose path

Relaydot uses one Next.js controller container. The controller owns the web
interface, agent API, better-sqlite3 database, schema migrations, and in-process
Honker consumer. There is no PostgreSQL, Redis, broker, or worker container.

The Compose path is:

```text
infra/compose/compose.yaml
```

From the repository root:

```sh
cp infra/compose/.env.example infra/compose/.env
# Replace RELAYDOT_ADMIN_TOKEN before continuing.
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml up -d
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml ps
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml logs -f
docker compose --env-file infra/compose/.env -f infra/compose/compose.yaml down
```

The interface and API use the configured host port:

- Controller: `http://<host>:3000`
- Health: `http://<host>:3000/api/v1/health`

Edit `infra/compose/.env` to change the bind address, port, image, and admin
token. Controller state is stored in the `controller-data` volume mounted at
`/app/data`; back up that volume while the controller is stopped or by using
SQLite's online backup API.

From another directory, use an absolute checkout path:

```sh
docker compose \
  --env-file /path/to/relaydot/infra/compose/.env \
  -f /path/to/relaydot/infra/compose/compose.yaml \
  up -d
```

Each managed node separately runs:

```sh
uv tool install relaydot
relaydot enroll --server https://relaydot.example.com --token <one-time-token>
relaydot service install --start
```

Put the controller behind a TLS reverse proxy before enrolling machines over an
untrusted network. The current agent/controller slice supports enrollment,
heartbeat, durable command claim/acknowledgement, inventory sync commands, and
diagnostics. Encrypted revision transfer and remote package updates remain under
implementation.
