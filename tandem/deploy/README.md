# Deploy and operate Tandem Browser

Tandem runs the official, digest-pinned BrowserOS Neo image and a small Tandem
gateway. It never builds Chromium. The VPS needs no desktop environment: the
upstream image contains Xvnc, openbox, Neo and noVNC. Caddy terminates HTTPS and
streams WebSocket/SSE traffic to the gateway.

## Hostinger installation

Use an Ubuntu 22.04/24.04 or Debian 12 VPS with enough RAM for Chromium (4 GB is a
practical starting point), a domain you control, and SSH/root access. Point
`browser.example.com`'s DNS A record at the VPS's public IPv4 address. Publish an
AAAA record only if IPv6 reaches this VPS. Allow 22/tcp, 80/tcp, 443/tcp and
443/udp in Hostinger's network firewall. Caddy needs publicly reachable 80/443 to
obtain and renew Let's Encrypt certificates.

```sh
# On the VPS, as root:
apt-get update && apt-get install -y git
# Use your normal repository access method if the fork is private.
git clone https://github.com/Samin12/tandem-browser.git /opt/tandem-browser
cd /opt/tandem-browser
# Before first main release only: git switch tandem/foundation
cd tandem/deploy
./install.sh
```

The idempotent installer installs Docker Engine/Compose from Docker's apt
repository when missing, enables Docker and unattended security updates, enables
UFW, and creates private data directories. It preserves existing `.env` and data.
It also preserves a custom current SSH port in addition to allowing 22. Check any
other services' firewall requirements before running on a shared VPS. Docker
published ports bypass UFW: this stack publishes only Caddy 80/443 publicly and
gateway 8790 on **127.0.0.1**. Never publish 6080, 9010 or 9110.

Supply `TANDEM_DOMAIN`, `TANDEM_ACME_EMAIL` and `TANDEM_PASSWORD` (or an existing
`TANDEM_PASSWORD_HASH`) in the install process environment for unattended use.
Optional install inputs include `TANDEM_DATA`, `TANDEM_BACKUP_DIR`,
`TANDEM_BACKUP_KEEP`, and the public `TANDEM_BACKUP_AGE_RECIPIENT`. Use a protected
secret manager/environment, not shell command history. The plaintext install
password is consumed over stdin by `bun run hash-password` and never saved to
production `.env`. Review `.env.example` for every supported variable.

`.env` is mode 0600. The installer escapes each `$` in Argon2id hashes as `$$`
because Docker Compose interpolates env files. Do the same when editing by hand.
Do not shell-source this file: its format is Compose dotenv, not shell syntax.
If an interrupted first install leaves an incomplete `.env`, inspect/fill it or
remove only that incomplete file and rerun; never delete data directories.

The installer prints a private TOTP enrollment URI. Add it to an authenticator
before first login, then open `https://browser.example.com`, enter the password
and current six-digit code. Keep the TOTP recovery secret separately. To enroll
a replacement authenticator run `./tandem totp-setup` (invalidates the old secret;
prints a terminal QR if `qrencode` is installed). Set-password and token rotation
restart the gateway; plan for reconnecting clients.

## Hermes and the desktop app

Run `./tandem hermes-config` to print the YAML template. On the VPS:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  tandem:
    url: http://127.0.0.1:8790/mcp
    headers:
      Authorization: Bearer ${TANDEM_AGENT_TOKEN}
```

For Hermes on your Mac use `https://browser.example.com/mcp` instead. Export the
actual token from the protected VPS `.env` in Hermes's process environment (or
substitute it using your client's secret store). The template does not expose the
token. Configure the client's HTTP/tool timeout above the Neo run budget plus the
120-second human-control hold; 240 seconds is a reasonable initial value. A Mac
can instead use `ssh -N -L 8790:127.0.0.1:8790 root@vps` and the local URL.

Install the separately built Tandem desktop package and set its server URL to
`https://browser.example.com`. Log in with the same password/TOTP. The desktop
client loads the same viewer as the website. **Watch** follows Hermes,
**Agent** stays on your selected tab, and **Manual** gives you control while
mutating agent calls wait. Release manual control to let Hermes resume. The
fallback Desktop view handles native browser dialogs. Never connect clients to
Neo's raw internal ports.

## Operations and updates

Run the wrapper from any directory using its absolute path. It always uses both
`neo-image.env` and `.env` with the production `compose.yaml`:

```sh
./tandem up
./tandem status
./tandem logs gateway             # or neo / caddy; Ctrl-C stops log following
./tandem restart
./tandem down                     # data retained
./tandem update                   # ff-only pull, pull pinned images, build gateway, recreate, wait
./tandem set-password
./tandem rotate-agent-token       # update Hermes's secret afterward
```

`update` requires a clean, fast-forwardable deployment checkout with the intended
branch checked out. It does not merge upstream itself. Review the changelog and
back up before updates. Both namespace partners are recreated for engine changes;
restarting only Neo after replacing its container can strand the gateway in an
old namespace. `restart` therefore restarts the complete stack. New source merges
and new runtime image pins are independent; see [UPSTREAM.md](../../UPSTREAM.md).

Docker starts at boot; all production containers use `unless-stopped`. Containers
explicitly stopped by an operator remain stopped until `./tandem up`. Health is
`curl -fsS http://127.0.0.1:8790/api/health` (all `ok`, `cdp`, `mcp` should be true).
Neo has its own readiness healthcheck, and gateway/Caddy start after dependencies
are healthy. Docker does not automatically restart a merely unhealthy running
container; inspect logs and restart deliberately. Log files rotate at 10 MB × 3
per container. Gateway audit/session state persists in the private gateway data
folder. The managed `RestoreOnStartup: 1` policy restores open tabs on browser
restart; it does not preserve in-flight form input or agent calls.

## Start page and managed policies

`../start/index.html` is the self-contained Tandem start page (inline brand mark,
CSS and JavaScript; no remote assets or background requests). Search/URL input
navigates only when submitted; the quick links navigate when clicked. The page
supports system light/dark mode and narrow windows. Its document title is
`New Tab`.

The engine mounts it read-only at `/opt/tandem/start/index.html`.
`policies/tandem-start.json` manages `NewTabPageLocation` and `HomepageLocation`
as `file:///opt/tandem/start/index.html`, sets `HomepageIsNewTabPage: false`, and
shows the Home button. The existing `tandem-restore.json` remains
`{"RestoreOnStartup": 1}`: startup restores saved tabs, while a fresh profile
opens the managed new-tab page. Existing saved onboarding tabs should be closed
once; this does not replace them or alter profile preferences. The unmodified
engine's native product name remains in engine-owned settings/About and the raw
desktop window frame: X11 reports `New Tab - BrowserOS neo`. Enterprise start
policies control the document/tab title, not that application suffix. Removing
the suffix requires a separate window-manager/viewer treatment or engine change.

The production/local/CI Compose files bind-mount both policy files and the page.
**Hostinger Docker Manager** stores only Compose and `.env`, so
`hostinger/compose.yaml` instead embeds both policies and the HTML as read-only
`configs:` at the same engine paths. After changing the page or start policy:

```sh
python3 tandem/deploy/hostinger/sync-start-config.py
python3 tandem/deploy/hostinger/sync-start-config.py --check
```

Run these from the repository root. The helper escapes Compose dollar
interpolation; do not hand-edit the generated inline configs. No gateway route,
new service, published port or Chromium rebuild is needed.

For an existing deployment, copy/apply the complete updated Compose file (with
all three `neo.configs` entries on Hostinger), and include the page and policy
files for bind-mount deployments. Recreate the stack together during the next
planned deployment so namespace partners reconnect. Building the gateway alone
does not install these configs. Keep the existing `/data` volume and restore
policy. This change does not itself deploy or restart production.

Acceptance on the pinned engine: visit `chrome://policy` and check all four
start policies plus `RestoreOnStartup` report `OK`. Open a new tab and use Home:
both must render Tandem with title `New Tab`. CDP may retain `chrome://newtab/`
as the target's virtual URL while `location.href` is the mounted `file://` URL.
See [VALIDATION.md](VALIDATION.md#tandem-start-page--isolated-vps-acceptance) for
isolated engine evidence and limitations.

## Encrypted backups and restore

**Treat profiles and backups like passwords.** Chromium's Linux basic key offers
no meaningful protection against someone who can read the profile. Cookies and
saved logins may grant account access. `.env` and age private keys are deliberately
not included in the archive; protect and back them up separately.

Generate an age identity on a trusted machine using `age-keygen -o tandem.key`.
Keep the private key offline/off the VPS; copy only its `age1…` public recipient
into `TANDEM_BACKUP_AGE_RECIPIENT`. Set `TANDEM_BACKUP_DIR` (default
`/var/backups/tandem`) and `TANDEM_BACKUP_KEEP` (default 7), then:

```sh
./tandem backup
systemctl enable --now tandem-backup.timer
systemctl list-timers tandem-backup.timer
journalctl -u tandem-backup.service
```

The installer generates the systemd service for the checkout's actual path; the
checked-in template assumes `/opt/tandem-browser`. The timer runs daily around
04:15 in **server local time**, with up to five minutes of jitter and catch-up
after downtime. Archives stop gateway and Neo briefly (clean Chromium quit), tar
both data folders, omit Cache, Code Cache, GPUCache and tool-output, and stream
directly to age encryption. They restart the services even on archive failure.
A lock prevents concurrent backups/restores. Only successful completed backups
count toward retention; the newest N across encrypted/plain archives are kept.
No unencrypted intermediate archive is written by encrypted backup. Copy encrypted
archives off the VPS to survive disk loss; local retention alone is not disaster
recovery. Missing age recipient refuses backup. `./tandem backup --unencrypted`
is an explicit emergency override and produces a credential-bearing plaintext
archive; protect and remove it after use.

Restore on the Linux VPS as root:

```sh
AGE_IDENTITY=/secure/path/tandem.key ./tandem restore /var/backups/tandem/tandem-....tar.gz.age
# For an explicitly unencrypted archive: ./tandem restore /path/backup.tar.gz
```

Restore validates archive members before stopping services, omits symlinks
(including stale Chromium lock links), stops gateway/Neo, retains old data in
`$TANDEM_DATA/pre-restore-<timestamp>-<pid>`, sets the two service owners, and starts
with health waits. It never overwrites the old data. Keep enough free disk for
archive staging, old data and restored data. Private decrypted staging is deleted
on exit. If restart fails, inspect logs; the old data is still in `pre-restore-*`.
To roll back a failed restore, stop the stack and move the two old directories
back into place after preserving the failed restored directories separately.
Review/remove retained recovery copies when no longer needed.

## Local Mac / CI

Use Docker/Colima, without Caddy or a public port:

```sh
cd tandem/deploy
docker compose --env-file neo-image.env -f compose.local.yaml up -d --wait --build
# http://127.0.0.1:8790; password tandem-local-test-password
# MCP token tandem-local-test-token-00000000000000000000
# Keep test credentials on loopback only.
docker compose --env-file neo-image.env -f compose.local.yaml down
```

Local persistent data defaults to `$HOME/.local/share/tandem`; override with
`TANDEM_DATA`. On Linux create `neo` and `gateway` with owners 1000 and 10001,
respectively, before first use. CI uses `compose.ci.yaml` with disposable named
volumes and a two-second agent hold. `down -v` destroys those **test** volumes.
Both development files have fixed, public test credentials and no TOTP. Never
use them for a public deployment or pass production environment files to them.

## Security model and troubleshooting

Only gateway authenticates viewers and agents. Caddy provides HTTPS/HSTS; it
supports WebSocket upgrades automatically and disables stream buffering.
The gateway shares Neo's network namespace and reaches CDP/MCP/noVNC over
loopback. It drops all capabilities, has a read-only root, a private writable data
mount and a limited `/tmp`, and cannot acquire new privileges. Neo follows the
upstream container security model: Chromium's sandbox is disabled by default;
the container boundary is important. Do not mount host secrets or Docker's socket
into either service. Trusted VPS administrators can access browser sessions.
Keep the host patched and restrict SSH. Anyone with the MCP bearer token can act
as your agent; rotate it after exposure. Viewer cookies and tokens are separate.

- **TLS fails:** check A/AAAA records, Hostinger firewall and `./tandem logs caddy`.
- **Unhealthy Neo:** inspect Neo logs, disk space, 1 GB shared memory and profile
  ownership; never run two engines on the same profile.
- **Unhealthy gateway:** check hash/token/origin settings and gateway data owner
  10001. A `$` interpolation warning means the Argon2 hash needs `$$` escaping.
- **403 / WebSocket rejection:** set `TANDEM_PUBLIC_ORIGIN` to the exact HTTPS
  origin, with no trailing slash, and use that URL in the desktop app.
- **TOTP rejected:** synchronize VPS/authenticator clocks, check enrollment.
- **Agent waits:** a human holds Manual control; release it or wait for expiry.
- **Blank/stale screen after an update:** recreate Neo and gateway together.
- **Backup timer fails:** configure age recipient, writable private destination,
  free space, and running healthy services; inspect its journal.
- **Reboot did not recover:** inspect `systemctl status docker`, `./tandem status`
  and prior explicit stops. `./tandem up` starts the saved deployment.
