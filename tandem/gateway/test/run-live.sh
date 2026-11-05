#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TANDEM_REPO_ROOT=$(cd ../.. && pwd)
TANDEM_RUN_ID="$$"
TANDEM_NEO_CONTAINER="${TANDEM_TEST_NEO_CONTAINER:-tandem-gateway-e2e-neo-$TANDEM_RUN_ID}"
TANDEM_GATEWAY_CONTAINER="tandem-gateway-e2e-gateway-$TANDEM_RUN_ID"
TANDEM_E2E_CONTAINER="tandem-gateway-e2e-test-$TANDEM_RUN_ID"
TANDEM_E2E_DATA_DIR="$HOME/.cache/tandem-dev/gateway-e2e-$TANDEM_RUN_ID"
source ../deploy/neo-image.env
export TANDEM_TEST_PASSWORD=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')
export TANDEM_AGENT_TOKEN=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')
export TANDEM_TEST_TOTP_SECRET=$(bun -e 'import {encodeBase32} from "./src/security"; console.log(encodeBase32(crypto.getRandomValues(new Uint8Array(20))))')
cleanup() {
  if [ "$?" != 0 ]; then docker logs "$TANDEM_GATEWAY_CONTAINER" 2>/dev/null || true; fi
  docker rm -f "$TANDEM_E2E_CONTAINER" "$TANDEM_GATEWAY_CONTAINER" "$TANDEM_NEO_CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TANDEM_E2E_DATA_DIR"
}
if docker container inspect "$TANDEM_NEO_CONTAINER" >/dev/null 2>&1; then
  echo "Refusing to replace existing container $TANDEM_NEO_CONTAINER" >&2
  exit 1
fi
trap cleanup EXIT
mkdir -p "$TANDEM_E2E_DATA_DIR"
docker run -d --name "$TANDEM_NEO_CONTAINER" --shm-size=1g --hostname neo \
  -e NEO_DISABLE_BROWSEROS_EXTENSIONS=false -e "NEO_ARGS=--disable-browseros-features=AvatarButton" \
  -v "$TANDEM_E2E_DATA_DIR:/data" "$TANDEM_NEO_IMAGE" >/dev/null
for ((i=0; i<120; i++)); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$TANDEM_NEO_CONTAINER")" = healthy ]; then break; fi
  sleep 1
done
[ "$(docker inspect --format '{{.State.Health.Status}}' "$TANDEM_NEO_CONTAINER")" = healthy ] || { echo 'Neo did not become healthy'; exit 1; }
gateway_args=(--name "$TANDEM_GATEWAY_CONTAINER" --network "container:$TANDEM_NEO_CONTAINER"
  -e TANDEM_ENV=development -e TANDEM_PUBLIC_ORIGIN=http://127.0.0.1:8790
  -e "TANDEM_PASSWORD=$TANDEM_TEST_PASSWORD" -e TANDEM_AGENT_TOKEN -e "TANDEM_TOTP_SECRET=$TANDEM_TEST_TOTP_SECRET"
  -e TANDEM_AGENT_HOLD_SECONDS=0.75)
if [ -n "${TANDEM_TEST_GATEWAY_IMAGE:-}" ]; then
  docker run -d "${gateway_args[@]}" "$TANDEM_TEST_GATEWAY_IMAGE" >/dev/null
else
  docker run -d "${gateway_args[@]}" -v "$TANDEM_REPO_ROOT:/repo" -w /repo/tandem/gateway \
    -e TANDEM_DATA_DIR=/tmp/tandem -e TANDEM_PUBLIC_DIR=./test/fixtures/public -e TANDEM_BRAND_FILE=../branding/brand.json \
    oven/bun:1 bun src/index.ts >/dev/null
fi
docker run --rm --name "$TANDEM_E2E_CONTAINER" --network "container:$TANDEM_NEO_CONTAINER" \
  -v "$TANDEM_REPO_ROOT:/repo" -w /repo/tandem/gateway \
  -e TANDEM_URL=http://127.0.0.1:8790 -e TANDEM_ORIGIN=http://127.0.0.1:8790 \
  -e TANDEM_TEST_PASSWORD -e TANDEM_AGENT_TOKEN -e TANDEM_TEST_TOTP_SECRET oven/bun:1 bun run e2e

if [ -n "${TANDEM_TEST_GATEWAY_IMAGE:-}" ]; then
  docker exec "$TANDEM_GATEWAY_CONTAINER" bun -e '
    import {statSync} from "node:fs";
    if (process.getuid() !== 10001) throw new Error("wrong runtime uid");
    for (const name of ["sessions.sqlite", "audit.log"]) if ((statSync(`/var/lib/tandem/${name}`).mode & 0o777) !== 0o600) throw new Error("wrong file mode");
    const icon = await fetch("http://127.0.0.1:8790/favicon.svg");
    if (!icon.ok || !(await icon.text()).includes("<svg")) throw new Error("missing built favicon");
    const login = await fetch("http://127.0.0.1:8790/login");
    const html = await login.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1]);
    if (!login.ok || !assets.length) throw new Error("missing built viewer assets");
    for (const asset of assets) if (!(await fetch(`http://127.0.0.1:8790${asset}`)).ok) throw new Error("built asset unavailable");
    console.log("PASS image uid 10001, writable data, 0600 files, built web assets and favicon");'
  for ((i=0; i<60; i++)); do
    if [ "$(docker inspect --format '{{.State.Health.Status}}' "$TANDEM_GATEWAY_CONTAINER")" = healthy ]; then break; fi
    sleep 1
  done
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$TANDEM_GATEWAY_CONTAINER")" = healthy ] || { echo 'Gateway HEALTHCHECK failed'; exit 1; }
  echo 'PASS Docker HEALTHCHECK healthy'
fi
