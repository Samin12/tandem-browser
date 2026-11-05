#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=tandem/deploy/common.sh
source "$(dirname "$0")/common.sh"
[[ $# == 1 && -f "$1" ]] || { echo 'Usage: restore.sh <backup.tar.gz[.age]> (set AGE_IDENTITY for encrypted backups)' >&2; exit 1; }
load_data
exec 9>"$TANDEM_DATA/.backup.lock"; flock -n 9 || { echo 'Another backup/restore is active' >&2; exit 1; }
[[ $EUID == 0 ]] || { echo 'Restore requires root to preserve owners' >&2; exit 1; }
staging=$(mktemp -d "$TANDEM_DATA/.restore.XXXXXX")
trap 'rm -rf "$staging"' EXIT
if [[ "$1" == *.age ]]; then
  age -d -i "${AGE_IDENTITY:?Set AGE_IDENTITY to the private age key file}" -o "$staging/archive.tar.gz" "$1"
else cp "$1" "$staging/archive.tar.gz"; fi
# Validate members, links and types before any extraction or service changes.
python3 - "$staging/archive.tar.gz" <<'PY'
import pathlib,sys,tarfile
with tarfile.open(sys.argv[1]) as t:
    for m in t:
        p=pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in ('neo','gateway'):
            raise SystemExit('Unsafe archive path: '+m.name)
        if not (m.isfile() or m.isdir() or m.issym()): raise SystemExit('Unsafe archive member type: '+m.name)
        if m.issym():
            # Chromium Singleton* links may be absolute or point outside the profile.
            # They are stale after restore: omit all symlinks during extraction.
            continue
    t.extractall(sys.argv[1]+'.contents', members=(m for m in t.getmembers() if not m.issym()))
PY
[[ -d "$staging/archive.tar.gz.contents/neo" && -d "$staging/archive.tar.gz.contents/gateway" ]] || { echo 'Archive must include neo and gateway' >&2; exit 1; }
compose stop gateway neo
# Keep pre-restore data intact for recovery; never overwrite a live profile.
previous="$TANDEM_DATA/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -m 700 "$previous"
for name in neo gateway; do
  [[ ! -e "$TANDEM_DATA/$name" ]] || mv "$TANDEM_DATA/$name" "$previous/$name"
  mv "$staging/archive.tar.gz.contents/$name" "$TANDEM_DATA/$name"
done
chown -R 1000:1000 "$TANDEM_DATA/neo"
chown -R 10001:10001 "$TANDEM_DATA/gateway"
chmod 700 "$TANDEM_DATA/neo" "$TANDEM_DATA/gateway"
compose up -d --wait neo gateway
echo "Restored. Previous data retained at $previous"
