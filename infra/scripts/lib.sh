#!/usr/bin/env bash

set -euo pipefail

relaydot_deploy_root() {
  if [[ -n "${RELAYDOT_DEPLOY_DIR:-}" ]]; then
    printf '%s\n' "$RELAYDOT_DEPLOY_DIR"
    return
  fi

  local script_dir
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$script_dir/../compose/compose.yaml" ]]; then
    (cd -- "$script_dir/../compose" && pwd)
  else
    (cd -- "$script_dir/.." && pwd)
  fi
}

relaydot_require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

relaydot_initialize() {
  RELAYDOT_ROOT="$(relaydot_deploy_root)"
  RELAYDOT_COMPOSE_FILE="$RELAYDOT_ROOT/compose.yaml"
  RELAYDOT_ENV_FILE="$RELAYDOT_ROOT/.env"
  RELAYDOT_VOLUME="${RELAYDOT_VOLUME:-relaydot-controller-data}"

  relaydot_require_command docker
  [[ -f "$RELAYDOT_COMPOSE_FILE" ]] || {
    printf 'Compose file not found: %s\n' "$RELAYDOT_COMPOSE_FILE" >&2
    exit 1
  }
  [[ -f "$RELAYDOT_ENV_FILE" ]] || {
    printf 'Environment file not found: %s\n' "$RELAYDOT_ENV_FILE" >&2
    exit 1
  }
  docker compose version >/dev/null
}

relaydot_compose() {
  docker compose \
    --env-file "$RELAYDOT_ENV_FILE" \
    --file "$RELAYDOT_COMPOSE_FILE" \
    "$@"
}

relaydot_set_image() {
  local image="$1"
  local temporary="$RELAYDOT_ENV_FILE.tmp"
  awk -v image="$image" '
    BEGIN { replaced = 0 }
    /^RELAYDOT_IMAGE=/ {
      print "RELAYDOT_IMAGE=" image
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print "RELAYDOT_IMAGE=" image
      }
    }
  ' "$RELAYDOT_ENV_FILE" >"$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$RELAYDOT_ENV_FILE"
}

relaydot_checksum() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    shasum -a 256 "$path"
  fi
}
