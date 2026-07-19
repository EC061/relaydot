# Controller deployment workflow

This document describes the repository-to-host path. For host bootstrap,
backup/restore commands, TLS, and managed-node installation, see
[`self-hosting.md`](self-hosting.md).

## Image delivery

[`controller-image.yml`](../.github/workflows/controller-image.yml) runs for pull
requests, pushes to `main`, and version tags.

1. Pull requests build the Dockerfile without publishing an image.
2. A `main` or tag push logs in to GHCR using the workflow's short-lived
   `GITHUB_TOKEN`.
3. Buildx builds the standalone Next.js image with provenance and GitHub Actions
   cache.
4. The workflow publishes `main`, `latest` on the default branch,
   `sha-<short-sha>`, and semantic-version tags where applicable.
5. It pulls the just-published SHA tag, starts the container, and requires the
   health endpoint to report SQLite WAL mode.

Production deployments should use `sha-*`, a semantic version, or a manifest
digest. `latest` is convenient for first installation but is not an immutable
rollback target.

## One-time GitHub configuration

Create a protected GitHub environment named `production`. Add required reviewers
if deployments should wait for approval.

Add these environment secrets:

- `DEPLOY_HOST`: DNS name or IP address of the Docker host.
- `DEPLOY_USER`: unprivileged SSH user that can run Docker.
- `DEPLOY_SSH_PRIVATE_KEY`: private key dedicated to Relaydot deployment.
- `DEPLOY_KNOWN_HOSTS`: pinned `known_hosts` line for the deployment host.

Generate the `known_hosts` entry with `ssh-keyscan`, but verify its fingerprint
against the host console or another trusted channel before saving it as a secret.
Do not accept an unverified key gathered over the same network path used for
deployment.

Optional environment variables:

- `DEPLOY_PATH`: host directory, default `/opt/relaydot`.
- `DEPLOY_PORT`: SSH port, default `22`.

The host's `/opt/relaydot/.env` is created during bootstrap and is never copied
back to GitHub or replaced by the workflow. Keep `RELAYDOT_ADMIN_TOKEN` only in
that owner-readable host file.

## Manual production deployment

Open **Actions → Deploy controller → Run workflow**. Leave `image` empty to
deploy the `sha-<short-sha>` image for the selected workflow commit, or provide
an explicit Relaydot GHCR tag/digest. Run the workflow from `main`; the deployment
job refuses other refs.

[`deploy-controller.yml`](../.github/workflows/deploy-controller.yml):

1. uses strict host-key checking;
2. copies only the production Compose file and operator scripts;
3. preserves the host `.env`;
4. invokes the host deployment script;
5. takes a pre-upgrade backup;
6. waits for the container health check; and
7. automatically rolls back to the previous image digest on failure.

The workflow is deliberately manual. Publishing an image does not silently
change a production host. Environment protection rules provide the approval
boundary.

## Recovery when GitHub is unavailable

SSH to the host and deploy an existing public image directly:

```sh
RELAYDOT_DEPLOY_DIR=/opt/relaydot \
  /opt/relaydot/scripts/deploy-controller.sh \
  ghcr.io/ec061/relaydot-controller@sha256:<manifest-digest>
```

If the host cannot start any image, restore a verified data backup using
`restore-controller.sh`, then deploy the last known-good digest.

## Deployment file inventory

- [`compose.yaml`](../infra/compose/compose.yaml): production container and
  persistent volume.
- [`compose.build.yaml`](../infra/compose/compose.build.yaml): optional local
  build overlay.
- [`.env.example`](../infra/compose/.env.example): required host settings.
- [`deploy-controller.sh`](../infra/scripts/deploy-controller.sh): transactional
  image update and rollback.
- [`backup-controller.sh`](../infra/scripts/backup-controller.sh): consistent
  stopped-volume backup and retention.
- [`restore-controller.sh`](../infra/scripts/restore-controller.sh): checksum
  verification and guarded restore.
- [`controller-image.yml`](../.github/workflows/controller-image.yml): GHCR
  build, publish, and runtime smoke test.
- [`deploy-controller.yml`](../.github/workflows/deploy-controller.yml): manual
  SSH deployment through the protected production environment.
