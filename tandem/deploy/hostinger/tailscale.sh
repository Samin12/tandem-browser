#!/usr/bin/env bash
# Run as root on the Hostinger VPS with TANDEM_HOST set to its public hostname.
set -euo pipefail

: "${TANDEM_HOST:?Set TANDEM_HOST to the public Tandem hostname}"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status --json | python3 -c 'import json,sys; sys.exit(json.load(sys.stdin).get("BackendState") != "Running")'; then
  tailscale up --hostname="${TANDEM_TAILSCALE_HOSTNAME:-tandem}"
fi
tailscale serve --bg --https=443 "http://127.0.0.1:${TANDEM_PRIVATE_PORT:-8791}"
origin=$(tailscale status --json | python3 -c 'import json,sys; print("https://" + json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
printf '\nViewer: %s\nSet these in the project .env, then recreate the stack:\n' "$origin"
printf 'TANDEM_VIEWER_AUTH=tailscale\nTANDEM_PRIVATE_LISTEN=0.0.0.0:8791\nTANDEM_PUBLIC_ORIGIN=%s,https://%s\n' "$origin" "$TANDEM_HOST"
