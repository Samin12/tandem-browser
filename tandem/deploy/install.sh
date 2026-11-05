#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=tandem/deploy/common.sh
source "$(dirname "$0")/common.sh"
[[ $EUID == 0 ]] || { echo 'Run as root on the VPS (not on your Mac).' >&2; exit 1; }
[[ $(uname -s) == Linux ]] || { echo 'Linux VPS only' >&2; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
case "$ID:$VERSION_ID" in ubuntu:22.04|ubuntu:24.04|debian:12) ;; *) echo 'Supported: Ubuntu 22.04/24.04, Debian 12' >&2; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg python3 openssl ufw unattended-upgrades age util-linux
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
# Preserve a custom active SSH port as well as 22, to avoid locking out the installer.
if [[ -n ${SSH_CONNECTION:-} ]]; then ufw allow "${SSH_CONNECTION##* }/tcp"; fi
ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
ufw --force enable
echo 'Docker publishing bypasses UFW: Tandem publishes only 80/443 publicly and 8790 on loopback.'
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades
if [[ -f "$DEPLOY_DIR/.env" ]]; then
  echo 'Existing .env preserved. Use ./tandem set-password or edit .env for changes.'
  chmod 600 "$DEPLOY_DIR/.env"
else
  domain=${TANDEM_DOMAIN:-}; email=${TANDEM_ACME_EMAIL:-}; password=${TANDEM_PASSWORD:-}
  [[ -n "$domain" ]] || read -r -p 'Browser domain (browser.example.com): ' domain
  [[ -n "$email" ]] || read -r -p 'ACME email: ' email
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$domain" == *.* ]] || { echo 'Use a DNS hostname, without URL/path' >&2; exit 1; }
  [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] || { echo 'Invalid email' >&2; exit 1; }
  if [[ -z ${TANDEM_PASSWORD_HASH:-} && -z "$password" ]]; then
    read -r -s -p 'Viewer password: ' password; echo
    read -r -s -p 'Repeat password: ' repeat; echo
    [[ -n "$password" && "$password" == "$repeat" ]] || { echo 'Passwords do not match' >&2; exit 1; }
  fi
  # A temporary valid env allows Compose to build the gateway before hashing.
  cp "$DEPLOY_DIR/.env.example" "$DEPLOY_DIR/.env"; chmod 600 "$DEPLOY_DIR/.env"
  printf '%s' "$domain" | write_env TANDEM_DOMAIN
  printf '%s' "$email" | write_env TANDEM_ACME_EMAIL
  printf 'https://%s' "$domain" | write_env TANDEM_PUBLIC_ORIGIN
  for key in TANDEM_DATA TANDEM_BACKUP_DIR TANDEM_BACKUP_KEEP TANDEM_BACKUP_AGE_RECIPIENT; do
    if [[ -n ${!key:-} ]]; then printf '%s' "${!key}" | write_env "$key"; fi
  done
  compose build gateway
  hash=${TANDEM_PASSWORD_HASH:-}
  if [[ -z "$hash" ]]; then hash=$(printf '%s' "$password" | hash_password); fi
  # shellcheck disable=SC2016 # Argon2 prefix is literal.
  [[ "$hash" == '$argon2id$'* ]] || { echo 'Expected Argon2id hash; remove incomplete .env and rerun' >&2; exit 1; }
  printf '%s' "$hash" | write_env TANDEM_PASSWORD_HASH
  openssl rand -hex 32 | write_env TANDEM_AGENT_TOKEN
  python3 -c 'import base64,secrets; print(base64.b32encode(secrets.token_bytes(20)).decode().rstrip("="))' | write_env TANDEM_TOTP_SECRET
  unset password repeat hash TANDEM_PASSWORD TANDEM_PASSWORD_HASH
fi
[[ -n $(read_env TANDEM_PASSWORD_HASH) && -n $(read_env TANDEM_AGENT_TOKEN) ]] || { echo 'Incomplete .env; finish credentials before starting' >&2; exit 1; }
load_data
install -d -m 0700 "$TANDEM_DATA"
# Existing owners/data are left alone: report incorrect ownership for the operator.
for pair in neo:1000 gateway:10001; do
  dir=${pair%:*}; uid=${pair#*:}
  if [[ ! -d "$TANDEM_DATA/$dir" ]]; then install -d -m 0700 -o "$uid" -g "$uid" "$TANDEM_DATA/$dir"; fi
  [[ $(stat -c %u "$TANDEM_DATA/$dir") == "$uid" ]] || { echo "Wrong owner of $TANDEM_DATA/$dir (expected $uid); inspect before changing it" >&2; exit 1; }
  chmod 700 "$TANDEM_DATA/$dir"
done
install -d -m 0700 "$TANDEM_DATA/caddy/data" "$TANDEM_DATA/caddy/config"
# Configure the timer for this checkout's actual installation path.
sed "s|^ExecStart=.*|ExecStart=\"$DEPLOY_DIR/backup.sh\"|" "$DEPLOY_DIR/tandem-backup.service" > /etc/systemd/system/tandem-backup.service
cp "$DEPLOY_DIR/tandem-backup.timer" /etc/systemd/system/
systemctl daemon-reload
if [[ -n $(read_env TANDEM_BACKUP_AGE_RECIPIENT) ]]; then systemctl enable --now tandem-backup.timer; else echo 'Backups disabled until TANDEM_BACKUP_AGE_RECIPIENT is configured; then enable tandem-backup.timer.'; fi
compose up -d --wait --build
printf '\nPoint your DNS A (and only a working AAAA) record at this VPS, then open https://%s\n' "$(read_env TANDEM_DOMAIN)"
echo 'Enroll this TOTP URI in your authenticator before first login (keep it private):'
printf 'otpauth://totp/Tandem:owner?secret=%s&issuer=Tandem&algorithm=SHA1&digits=6&period=30\n' "$(read_env TANDEM_TOTP_SECRET)"
echo 'Read the protected .env for the agent token. Hermes configuration:'
"$DEPLOY_DIR/tandem" hermes-config
