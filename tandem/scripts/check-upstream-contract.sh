#!/usr/bin/env bash
set -euo pipefail
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
image=''
case "${1:-}" in --image) image=${2:?Image reference required}; [[ $# == 2 ]] ;; '') ;; *) echo 'Usage: check-upstream-contract.sh [--image <ref>]' >&2; exit 1 ;; esac
entry="$root/packages/browseros/docker/neo/entrypoint.sh"
dockerfile="$root/packages/browseros/docker/neo/Dockerfile"
check() {
  local text=$1 label=$2 pattern=$3 description=$4
  if ! grep -Eq -- "$pattern" <<<"$text"; then echo "Contract changed ($label): $description" >&2; return 1; fi
}
check_entry() {
  local content=$1 label=$2
  check "$content" "$label" 'CDP_PORT=9110([[:space:]]|$)' 'CDP_PORT must be 9110'
  # shellcheck disable=SC2016 # Match the upstream variable name literally.
  check "$content" "$label" '\-\-browseros-cdp-port="?\$CDP_PORT' 'browseros-cdp-port must use CDP_PORT'
  check "$content" "$label" '\-\-browseros-proxy-port=9010' 'MCP proxy must use 9010'
  check "$content" "$label" 'websockify .*6080 localhost:5900' 'noVNC websockify must listen on 6080'
  check "$content" "$label" 'NEO_DATA_DIR:=/data' 'persistent data default must be /data'
  # shellcheck disable=SC2016 # Match the upstream variable name literally.
  check "$content" "$label" 'PROFILE="\$NEO_DATA_DIR/profile"' 'profile must be under /data/profile'
  check "$content" "$label" 'allow_remote_in_mcp = true' 'remote MCP must be enabled'
}
check_entry "$(cat "$entry")" source
check "$(cat "$dockerfile")" Dockerfile '^EXPOSE 6080 9010$' 'EXPOSE 6080 9010 required'
check "$(cat "$dockerfile")" Dockerfile 'NEO_DATA_DIR=/data' 'image persistent data default must be /data'
if [[ -n "$image" ]]; then
  check_entry "$(docker run --rm --entrypoint cat "$image" /usr/local/bin/neo-entrypoint)" "$image"
  config=$(docker image inspect "$image")
  jq -e '.[0].Config.ExposedPorts | has("6080/tcp") and has("9010/tcp")' <<<"$config" >/dev/null || { echo 'Image contract changed: exposed 6080/9010 missing' >&2; exit 1; }
  jq -e '.[0].Config.Env | index("NEO_DATA_DIR=/data") != null' <<<"$config" >/dev/null || { echo 'Image contract changed: NEO_DATA_DIR=/data missing' >&2; exit 1; }
fi
echo 'Neo engine contract OK'
