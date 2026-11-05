# Tandem security model

The browser can be signed in to email, banking and brokerage accounts. Treat
anyone who can control it as someone holding all of those logins.

## What is exposed

| Surface | Exposed to | Protection |
|---|---|---|
| `https://<domain>` (viewer, desktop app) | Internet, port 443 | Caddy TLS (Let's Encrypt) + HSTS; password (argon2id) + TOTP; per-IP login rate limit; HttpOnly/Secure/SameSite=Strict session cookie; Origin checks on every write and WebSocket; idle (12 h) and absolute (72 h) session expiry |
| `https://<domain>/mcp` | Internet, port 443 | Separate 48-char bearer token, constant-time check, only valid on `/mcp` |
| `127.0.0.1:8790` | The VPS itself (Hermes running there) | Same auth as above; not reachable from outside |
| CDP 9110, Neo API 9010, noVNC 6080, VNC 5900 | **Nobody outside the engine's network namespace** | Never published. Only the gateway shares that namespace. |

## What the viewer never gets

- No raw CDP. The browser can only be driven through a fixed list of typed
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
- [ ] TOTP is set (`./tandem totp-setup`).
- [ ] SSH password login disabled.
- [ ] Backups configured with an `age` recipient you hold offline.
- [ ] `TANDEM_AGENT_TOKEN` stored in 1Password and Hermes `.env`, nowhere else.
