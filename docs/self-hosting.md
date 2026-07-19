# Self-hosting and production deployment

Relaydot deploys one Next.js controller container with one persistent
`/app/data` volume. The controller owns the interface, agent API,
better-sqlite3 WAL database, migrations, and in-process Honker consumer. It does
not require PostgreSQL, Redis, a broker, or a separate worker container.

## Host requirements

- Linux host with Docker Engine and Docker Compose v2.20 or newer.
- A DNS name and host-level TLS reverse proxy for access outside loopback.
- Outbound HTTPS access to `ghcr.io`.
- Enough disk space for `relaydot-controller-data` and retained backups.
- One running Relaydot agent service on every managed node.

The production Compose file is
[`infra/compose/compose.yaml`](../infra/compose/compose.yaml). It references the
published GHCR image and does not require a source checkout or local image build.
[`compose.build.yaml`](../infra/compose/compose.build.yaml) is an optional overlay
for developers who deliberately want to build from the checkout.

## First host installation

Create a private deployment directory:

```sh
sudo install -d -m 700 -o "$USER" -g "$(id -gn)" /opt/relaydot
cp infra/compose/compose.yaml /opt/relaydot/compose.yaml
cp infra/compose/.env.example /opt/relaydot/.env
install -d -m 700 /opt/relaydot/scripts
install -m 700 infra/scripts/*.sh /opt/relaydot/scripts/
chmod 600 /opt/relaydot/.env
```

Generate the administrator token and edit `/opt/relaydot/.env`:

```sh
openssl rand -base64 32
```

Keep `RELAYDOT_BIND_ADDRESS=127.0.0.1` when a reverse proxy runs directly on the
host. If the port must be reachable from another machine, change the address
deliberately and restrict it with the host firewall.

Start and verify the controller:

```sh
cd /opt/relaydot
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --wait
docker compose --env-file .env -f compose.yaml ps
curl --fail http://127.0.0.1:3000/api/v1/health
```

The named volume is `relaydot-controller-data`, mounted at `/app/data`. The
health response must report `"database":"ok"` and `"journal_mode":"wal"`.

## TLS reverse proxy

Terminate HTTPS before exposing the controller to managed nodes. A minimal Caddy
host configuration is:

```caddyfile
relaydot.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Only enroll nodes using the HTTPS origin. Preserve the original `Host` and
forwarded-protocol headers; mainstream reverse proxies do this by default. The
current controller does not implement browser login, so restrict dashboard
network access to trusted administrators until UI authentication is implemented.
Agent and administrator API credentials remain required for protected API calls.

## Managed nodes

After the Python package is published:

```sh
uv tool install relaydot
relaydot enroll --server https://relaydot.example.com --token <one-time-token>
relaydot service install --start
```

The service runs directly on each managed node. There is no agent container and
no shared Honker worker service.

## Backups

Create a consistent backup:

```sh
RELAYDOT_DEPLOY_DIR=/opt/relaydot \
  /opt/relaydot/scripts/backup-controller.sh
```

The script stops the controller when necessary, archives the named data volume,
writes a SHA-256 sidecar, restarts the controller, and retains the newest 14
archives by default. Set `RELAYDOT_BACKUP_DIR` and `RELAYDOT_BACKUP_KEEP` to use a
different destination or retention count. Copy backups off-host; a backup stored
only beside the Docker volume does not protect against host loss.

Test restoration on a separate host before relying on a backup. To restore:

```sh
RELAYDOT_DEPLOY_DIR=/opt/relaydot \
  /opt/relaydot/scripts/restore-controller.sh \
  /absolute/path/to/relaydot-data-YYYYmmddTHHMMSSZ.tar.gz
```

Restore verifies the checksum when present, takes a safety backup of the current
volume, replaces its contents while the controller is stopped, and waits for the
restored controller to become healthy.

## Upgrades and rollback

Deploy immutable image tags or digests:

```sh
RELAYDOT_DEPLOY_DIR=/opt/relaydot \
  /opt/relaydot/scripts/deploy-controller.sh \
  ghcr.io/ec061/relaydot-controller:sha-eff6482
```

The deployment script backs up the volume, pulls the requested image, updates
`.env` atomically, waits for the Compose health check, and automatically restores
the previous immutable image digest if startup fails.

For manual rollback to a known image:

```sh
RELAYDOT_DEPLOY_DIR=/opt/relaydot \
  /opt/relaydot/scripts/deploy-controller.sh \
  ghcr.io/ec061/relaydot-controller@sha256:<known-good-manifest-digest>
```

Do not delete old backups until the upgraded controller has been exercised and a
post-upgrade backup succeeds.

## Local source build

From a checkout:

```sh
cp infra/compose/.env.example infra/compose/.env
# Replace RELAYDOT_ADMIN_TOKEN.
docker compose \
  --env-file infra/compose/.env \
  -f infra/compose/compose.yaml \
  -f infra/compose/compose.build.yaml \
  up -d --build --wait
```

The published-image production path should omit `compose.build.yaml`.

## Routine operations

```sh
cd /opt/relaydot
docker compose --env-file .env -f compose.yaml ps
docker compose --env-file .env -f compose.yaml logs -f controller
docker compose --env-file .env -f compose.yaml restart controller
docker compose --env-file .env -f compose.yaml down
```

`docker compose down` preserves the named volume. Do not add `--volumes` unless
you intentionally want to delete all controller state and have verified backups.

The implemented slice supports enrollment, heartbeat, durable command
claim/acknowledgement, inventory sync commands, and diagnostics. Encrypted
revision transfer and remote package updates remain under implementation.
