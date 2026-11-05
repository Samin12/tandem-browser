#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=tandem/deploy/common.sh
source "$(dirname "$0")/common.sh"
unencrypted=false
case "${1:-}" in --unencrypted) unencrypted=true ;; '') ;; *) echo 'Usage: backup.sh [--unencrypted]' >&2; exit 1 ;; esac
load_data
recipient=$(read_env TANDEM_BACKUP_AGE_RECIPIENT)
backup_dir=$(read_env TANDEM_BACKUP_DIR /var/backups/tandem)
keep=$(read_env TANDEM_BACKUP_KEEP 7)
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo 'TANDEM_BACKUP_KEEP must be positive' >&2; exit 1; }
if ! "$unencrypted"; then
  [[ -n "$recipient" ]] || { echo 'Set TANDEM_BACKUP_AGE_RECIPIENT; refusing unencrypted backup (explicit --unencrypted only).' >&2; exit 1; }
  command -v age >/dev/null || { echo 'Install age first' >&2; exit 1; }
fi
mkdir -p "$backup_dir"; chmod 700 "$backup_dir"
# flock also prevents the timer and a manual restore running concurrently.
exec 9>"$TANDEM_DATA/.backup.lock"
flock -n 9 || { echo 'Another backup/restore is active' >&2; exit 1; }
[[ $(compose ps --status running -q neo) && $(compose ps --status running -q gateway) ]] || { echo 'Neo and gateway must be running before backup' >&2; exit 1; }
file="$backup_dir/tandem-$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
partial="$file.partial"
resume() { compose up -d --wait neo gateway >&2; }
cleanup() { rm -f "$partial"; resume; }
trap cleanup EXIT
compose stop gateway neo >&2
if "$unencrypted"; then
  tar --exclude='*/Cache' --exclude='*/Code Cache' --exclude='*/GPUCache' --exclude='*/tool-output' -C "$TANDEM_DATA" -czf "$partial" neo gateway
else
  file="$file.age"; partial="$file.partial"
  tar --exclude='*/Cache' --exclude='*/Code Cache' --exclude='*/GPUCache' --exclude='*/tool-output' -C "$TANDEM_DATA" -czf - neo gateway | age -r "$recipient" -o "$partial"
fi
mv "$partial" "$file"
resume
trap - EXIT
python3 - "$backup_dir" "$keep" <<'PY'
import pathlib,sys
files=sorted((p for p in pathlib.Path(sys.argv[1]).glob('tandem-*.tar.gz*') if p.name.endswith(('.tar.gz','.tar.gz.age'))), key=lambda p:p.stat().st_mtime, reverse=True)
for p in files[int(sys.argv[2]):]: p.unlink()
PY
printf '%s\n' "$file"
