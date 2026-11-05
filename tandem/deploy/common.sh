#!/usr/bin/env bash
# Shared operations library. .env is parsed as data, never sourced as executable code.
DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export DEPLOY_DIR
compose() {
  docker compose --project-directory "$DEPLOY_DIR" --env-file "$DEPLOY_DIR/neo-image.env" --env-file "$DEPLOY_DIR/.env" -f "$DEPLOY_DIR/compose.yaml" "$@"
}
hash_password() {
  # Run the checkout's hash helper with the gateway image's Bun runtime. These
  # read-only mounts also support minimal runtime images that omit dev scripts.
  compose run --rm --no-deps -T --workdir /app \
    -v "$DEPLOY_DIR/../gateway/scripts:/app/scripts:ro" \
    -v "$DEPLOY_DIR/../gateway/package.json:/app/package.json:ro" \
    gateway bun run hash-password
}
read_env() {
  python3 - "$DEPLOY_DIR/.env" "$1" "${2:-}" <<'PY'
import pathlib,sys
value=sys.argv[3]
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    k,sep,v=line.partition('=')
    if sep and k==sys.argv[2]: value=v.replace('$$','$')
print(value)
PY
}
write_env() {
  # Values arrive on stdin so credentials never appear in process arguments.
  python3 -c 'import os,pathlib,sys,tempfile
p=pathlib.Path(sys.argv[1]); key=sys.argv[2]; value=sys.stdin.read().rstrip("\n")
if "\n" in value or "\r" in value: raise SystemExit("Multiline env values refused")
value=value.replace("$","$$")
lines=p.read_text().splitlines() if p.exists() else []
lines=[x for x in lines if not x.startswith(key+"=")]+[key+"="+value]
fd,name=tempfile.mkstemp(dir=p.parent); os.fchmod(fd,0o600)
with os.fdopen(fd,"w") as f: f.write("\n".join(lines)+"\n")
os.replace(name,p)' "$DEPLOY_DIR/.env" "$1"
}
load_data() {
  TANDEM_DATA=$(read_env TANDEM_DATA /var/lib/tandem)
  [[ "$TANDEM_DATA" = /* && $(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$TANDEM_DATA") != / ]] || { echo 'TANDEM_DATA must be an absolute non-root directory' >&2; exit 1; }
}
