#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$script_dir/lib.sh"

relaydot_initialize

new_image="${1:-}"
if [[ ! "$new_image" =~ ^ghcr\.io/ec061/relaydot-controller(:[A-Za-z0-9._-]+|@sha256:[a-f0-9]{64})$ ]]; then
  printf 'expected an immutable Relaydot GHCR tag or digest\n' >&2
  exit 1
fi

previous_image="$(relaydot_compose config --images | head -n 1)"
container_id="$(relaydot_compose ps --quiet controller)"
if [[ -n "$container_id" ]]; then
  image_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  repo_digest="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image_id" 2>/dev/null || true)"
  if [[ -n "$repo_digest" && "$repo_digest" != "<no value>" ]]; then
    previous_image="$repo_digest"
  fi
fi

if docker volume inspect "$RELAYDOT_VOLUME" >/dev/null 2>&1; then
  "$script_dir/backup-controller.sh"
fi

rollback_armed=0
rollback() {
  local status=$?
  if [[ "$status" -ne 0 && "$rollback_armed" -eq 1 ]]; then
    printf 'deployment failed; rolling back to %s\n' "$previous_image" >&2
    relaydot_set_image "$previous_image"
    relaydot_compose pull controller || true
    relaydot_compose up --detach --wait --wait-timeout 90 controller
  fi
  exit "$status"
}
trap rollback EXIT

relaydot_set_image "$new_image"
rollback_armed=1
relaydot_compose pull controller
relaydot_compose up --detach --remove-orphans --wait --wait-timeout 90 controller
relaydot_compose ps controller
rollback_armed=0

printf 'deployed %s\n' "$new_image"
