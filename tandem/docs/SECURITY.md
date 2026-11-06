# Tandem security model

The browser can be signed in to email, banking and brokerage accounts. Treat
anyone who can control it as someone holding all of those logins.

## What is exposed

| Surface | Exposed to | Protection |
|---|---|---|
| `https://<domain>` (viewer, desktop app, password mode) | Internet, port 443 | Caddy/Traefik TLS (Let's Encrypt) + HSTS; password (argon2id) + TOTP; per-IP login rate limit; HttpOnly/Secure/SameSite=Strict session cookie; Origin checks on every write and WebSocket; idle (12 h) and absolute (72 h) session expiry |
| `https://<name>.<tailnet>.ts.net` (viewer, desktop app, Tailscale mode) | Tailnet only, via Tailscale Serve | Tailscale user identity and optional login allowlist; same session cookie, Origin checks and expiry; public viewer routes return 404 |
| `https://<domain>/mcp` | Internet, port 443 | Separate 48-char bearer token, constant-time check, valid on `/mcp` and `/cdp` |
| `https://<domain>/cdp[/TOKEN]/*` | Internet, port 443 | Same agent token as MCP; constant-time check, explicit discovery/socket routes, human-control gating, eight-connection cap |
| `127.0.0.1:8790` (loopback deployments) | The VPS itself (Hermes running there) | Same auth as above; in Tailscale mode only agent paths and `GET /api/health` are served |
| `127.0.0.1:8791` (Hostinger private listener) | Host loopback, proxied by Tailscale Serve | Viewer requires `Tailscale-User-Login` on every request; agent paths still require bearer auth |
| CDP 9110, Neo API 9010, noVNC 6080, VNC 5900 | **Nobody outside the engine's network namespace** | Never published. Only trusted Tandem sidecars share that namespace; no raw upstream port is published. |

## Tailscale mode

Set `TANDEM_VIEWER_AUTH=tailscale` and `TANDEM_PRIVATE_LISTEN=0.0.0.0:8791`.
The viewer is reachable only over the tailnet; identity comes from Tailscale
Serve's `Tailscale-User-Login` header. The public listener serves only `/mcp`,
`/cdp`, `/cdp/*` and `GET /api/health`, so internet requests cannot reach viewer
pages, assets, APIs or sockets, even with a forged identity header or cookie.
The private listener is published only through host loopback (`127.0.0.1:8791`);
only Tailscale Serve and trusted host processes should reach it. Never publicly
publish that port or proxy public traffic to it: it trusts Serve's header.

`GET /login` creates the usual session and redirects back to the viewer without
a password or TOTP; expired sessions sign in again silently. Password hashes and
TOTP secrets are ignored. Keep the tailnet HTTPS origin first in
`TANDEM_PUBLIC_ORIGIN`, followed by the public agent origin (second, for public
CDP discovery URLs). The Electron app
loads the same tailnet origin and uses the same session checks.

Anyone with a device on the tailnet logged in as an allowed user gets the viewer.
Keep `TANDEM_TAILSCALE_USERS` set to your login names (comma-separated,
case-insensitive; empty allows any Tailscale user), and keep Tailscale device
approval on. Agent bearer authentication remains unchanged on both listeners.
Run [hostinger/tailscale.sh](../deploy/hostinger/tailscale.sh) on the host to
install/connect Tailscale and configure its private HTTPS proxy.

## What the viewer never gets

- Viewer sessions cannot access raw CDP. The browser can only be driven through a fixed list of typed
  actions (click, key, text, navigate, tab ops, dialog answer, copy selection).
- No cookies, storage, passwords or tokens from the browser profile. The viewer
  receives pictures of pages and tab titles/URLs.
- Address-bar navigation refuses `javascript:`, `file:`, `data:` and internal
  `chrome://` pages.

## Shared control

- Your input is accepted only while you hold control (Manual mode). A person can
  always take control instantly; the agent can't take it back.
- While you hold control, the agent's state-changing tools are held, not run.
- The raw "Desktop view" (VNC) works only while you hold control and closes when
  you hand it back.

## Logging

`audit.log` records logins, control changes, tab operations, navigations (origin
only) and agent tool names with timings. It never records typed text, clipboard
contents, tool arguments, full URLs, cookies or secrets.

## Secrets

- `.env` on the VPS (mode 0600) holds the password hash, TOTP secret and agent
  token. It is git-ignored; nothing secret is committed.
- Keep a copy of the TOTP secret and agent token in your password manager
  (1Password vault `Hermes`).
- Rotate the agent token with `./tandem rotate-agent-token` (update Hermes after).

## The profile on disk

A container has no OS keychain, so Chromium encrypts saved logins and cookies
with its built-in key (`--password-store=basic`). Anyone who can read
`/var/lib/tandem/neo` can read them. So:

- Keep SSH key-only, keep the VPS updated (`unattended-upgrades` is enabled).
- Backups are encrypted with `age` and are refused unencrypted unless you insist.
- Upstream's hosted mode turns off Chrome's password and card saving prompts;
  prefer giving the agent logins per task over storing many in the profile.

## Hardening checklist

- [ ] DNS points only the Tandem hostname at the VPS.
- [ ] `ufw status` shows only 22, 80, 443 open.
- [ ] TOTP is set in password mode (`./tandem totp-setup`); in Tailscale mode, the user allowlist and device approval are enabled.
- [ ] SSH password login disabled.
- [ ] Backups configured with an `age` recipient you hold offline.
- [ ] `TANDEM_AGENT_TOKEN` stored in 1Password and Hermes `.env`, nowhere else.

## Agent CDP credentials

CDP grants the same browser power as the MCP agent token, including arbitrary
JavaScript, page navigation, input, cookies and signed-in accounts. The read-only
allowlist is a control-coordination policy, not a sandbox for untrusted agents.
It deliberately permits screenshot/DOM inspection and attachment while a person
has control. Runtime.evaluate, callFunctionOn and every command outside the
allowlist wait for agent control. A command already dispatched can finish after
a person takes over. Browser events and responses are always forwarded.

The complete URL `https://HOST/cdp/TOKEN` is a secret. Do not paste it into issues,
analytics, screenshots or shared configuration. Prefer the bearer-header form
`https://HOST/cdp` when the client can attach Authorization on both discovery and
WebSocket handshakes. The gateway uses its configured public origin when
rewriting debugger URLs, never an incoming Host or forwarded host header. The
agent token cannot authenticate viewer routes, and viewer cookies cannot
authenticate CDP. `TANDEM_CDP=off` disables CDP discovery and sockets with 404.

Gateway logs never include request paths or CDP bodies. Audit records connect
and disconnect metadata, timings, message/held/rejected counts and top method
names. Reverse proxies, load balancers and client debug logs can still record
URL paths: disable access logs for `/cdp/*` or redact the credential segment
before enabling them (including Traefik/Caddy access logs). Do not retain raw
request URLs for these routes. Discovery responses carry `Cache-Control:
no-store` and `Referrer-Policy: no-referrer`.

Rotate `TANDEM_AGENT_TOKEN` with `./tandem rotate-agent-token`, restart/recreate
the gateway to disconnect existing MCP/CDP clients, and update **every** agent
configuration, wrapper and saved CDP URL. Established sockets retain authority
until closed, so replacing the environment variable alone is insufficient.
The NET_ADMIN capability is confined to the `neo-net` route helper; the gateway
drops all capabilities. Neither helper nor gateway modifies the Neo image.
