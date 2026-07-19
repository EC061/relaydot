#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT

mkdir -p "$fixture/bin" "$fixture/deploy"
cp "$repository_root/infra/compose/compose.yaml" "$fixture/deploy/compose.yaml"
cat >"$fixture/deploy/.env" <<'EOF'
RELAYDOT_ADMIN_TOKEN=test-token
RELAYDOT_BIND_ADDRESS=127.0.0.1
RELAYDOT_PORT=3000
RELAYDOT_IMAGE=ghcr.io/ec061/relaydot-controller:sha-old000
EOF

cat >"$fixture/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  "compose version")
    printf 'Docker Compose version v2.30.0\n'
    ;;
  "volume inspect relaydot-controller-data")
    exit 1
    ;;
  *"config --images")
    printf 'ghcr.io/ec061/relaydot-controller:sha-old000\n'
    ;;
  *"ps --quiet controller")
    ;;
esac
EOF
chmod 755 "$fixture/bin/docker"

export FAKE_DOCKER_LOG="$fixture/docker.log"
export PATH="$fixture/bin:$PATH"
export RELAYDOT_DEPLOY_DIR="$fixture/deploy"

new_image="ghcr.io/ec061/relaydot-controller:sha-abcdef0"
"$repository_root/infra/scripts/deploy-controller.sh" "$new_image" >/dev/null
grep -qx "RELAYDOT_IMAGE=$new_image" "$fixture/deploy/.env"
grep -q "pull controller" "$fixture/docker.log"
grep -q "up --detach --remove-orphans --wait --wait-timeout 90 controller" "$fixture/docker.log"

if "$repository_root/infra/scripts/deploy-controller.sh" "docker.io/example/unsafe:latest" \
  >/dev/null 2>&1; then
  printf 'invalid deployment image was accepted\n' >&2
  exit 1
fi

printf 'deployment script checks passed\n'
