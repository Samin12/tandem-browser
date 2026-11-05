#!/usr/bin/env bash
# Builds the Tandem gateway image on a Hostinger VPS for the Docker Manager
# project (compose.yaml here). Run as root on the VPS:
#
#   curl -fsSL https://raw.githubusercontent.com/Samin12/tandem-browser/main/tandem/deploy/hostinger/build-gateway.sh | bash
#   # or: build-gateway.sh [git-ref]
#
# Keeps a sparse checkout of tandem/ in /opt/tandem/src (about 15 MB; the rest of
# the BrowserOS monorepo isn't needed) and tags the image tandem-gateway:local
# plus tandem-gateway:<commit>. Then restart the project from hPanel or with
# `docker compose -f /docker/tandem/docker-compose.yml up -d`.
set -euo pipefail

repo=${TANDEM_REPO:-https://github.com/Samin12/tandem-browser.git}
ref=${1:-${TANDEM_BRANCH:-main}}
src=${TANDEM_SRC:-/opt/tandem/src}

if [[ ! -d "$src/.git" ]]; then
  mkdir -p "$(dirname "$src")"
  git clone --quiet --filter=blob:none --no-checkout "$repo" "$src"
  git -C "$src" sparse-checkout set --no-cone /tandem/ /LICENSE /LICENSE.ungoogled_chromium
fi
git -C "$src" fetch --quiet origin "$ref"
git -C "$src" checkout --quiet --detach FETCH_HEAD
commit=$(git -C "$src" rev-parse --short=12 HEAD)
echo "Building tandem-gateway at $commit"
docker build --pull -t "tandem-gateway:$commit" -t tandem-gateway:local -f "$src/tandem/gateway/Dockerfile" "$src/tandem"
echo "Built tandem-gateway:local ($commit)"
