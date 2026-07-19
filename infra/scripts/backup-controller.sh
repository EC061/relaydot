#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
source "$script_dir/lib.sh"

relaydot_initialize

backup_dir="${RELAYDOT_BACKUP_DIR:-$RELAYDOT_ROOT/backups}"
keep="${RELAYDOT_BACKUP_KEEP:-14}"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || {
  printf 'RELAYDOT_BACKUP_KEEP must be a positive integer\n' >&2
  exit 1
}

docker volume inspect "$RELAYDOT_VOLUME" >/dev/null
mkdir -p -- "$backup_dir"
chmod 700 "$backup_dir"

was_running=0
if [[ -n "$(relaydot_compose ps --status running --quiet controller)" ]]; then
  was_running=1
fi

restart_controller() {
  if [[ "$was_running" -eq 1 ]]; then
    relaydot_compose up --detach --wait --wait-timeout 90 controller
  fi
}
trap restart_controller EXIT

if [[ "$was_running" -eq 1 ]]; then
  relaydot_compose stop controller
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$backup_dir/relaydot-data-$timestamp.tar.gz"
archive_name="$(basename -- "$archive")"

docker run --rm \
  --volume "$RELAYDOT_VOLUME:/source:ro" \
  --volume "$backup_dir:/backup" \
  alpine:3.22.1 \
  tar -C /source -czf "/backup/$archive_name" .

relaydot_checksum "$archive" >"$archive.sha256"
chmod 600 "$archive" "$archive.sha256"

mapfile -t old_archives < <(
  find "$backup_dir" -maxdepth 1 -type f -name 'relaydot-data-*.tar.gz' \
    -print | sort -r | tail -n "+$((keep + 1))"
)
for old_archive in "${old_archives[@]}"; do
  rm -f -- "$old_archive" "$old_archive.sha256"
done

printf '%s\n' "$archive"
