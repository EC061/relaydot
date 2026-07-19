#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$script_dir/lib.sh"

relaydot_initialize

archive="${1:-}"
[[ -n "$archive" && -f "$archive" ]] || {
  printf 'usage: %s /absolute/path/to/relaydot-data-*.tar.gz\n' "$0" >&2
  exit 1
}
archive="$(cd -- "$(dirname -- "$archive")" && pwd)/$(basename -- "$archive")"

if [[ -f "$archive.sha256" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd -- "$(dirname -- "$archive")" && sha256sum --check "$(basename -- "$archive").sha256")
  else
    expected="$(awk '{print $1}' "$archive.sha256")"
    actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
    [[ "$actual" == "$expected" ]] || {
      printf 'backup checksum mismatch\n' >&2
      exit 1
    }
  fi
fi

if docker volume inspect "$RELAYDOT_VOLUME" >/dev/null 2>&1; then
  "$script_dir/backup-controller.sh" >/dev/null
else
  docker volume create "$RELAYDOT_VOLUME" >/dev/null
fi

relaydot_compose stop controller || true

archive_dir="$(dirname -- "$archive")"
archive_name="$(basename -- "$archive")"
docker run --rm \
  --volume "$RELAYDOT_VOLUME:/target" \
  --volume "$archive_dir:/backup:ro" \
  alpine:3.22.1 \
  sh -eu -c \
  'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /target -xzf "/backup/$1"' \
  sh "$archive_name"

relaydot_compose up --detach --wait --wait-timeout 90 controller
relaydot_compose ps controller
