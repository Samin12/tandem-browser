# Tandem Browser architecture

Tandem Browser is a fork of [BrowserOS](https://github.com/browseros-ai/BrowserOS)
(the BrowserOS neo agent browser). It runs the browser on a server, lets an AI
agent (Hermes) drive it over MCP, and lets you watch or take the wheel from a
desktop app or a web page. There is exactly one browser; every view of it is a
view of the same tabs.

## Research findings (Phase 1, 2026-11-05)

| Question | Finding |
|---|---|
| Official upstream | `browseros-ai/BrowserOS` (14k stars). BrowserOS neo ships from this monorepo: `packages/browseros` (Chromium fork, patches, build) and `packages/browseros-agent` (claw-server in Rust: MCP + API; dashboard; onboarding). |
| License | AGPL-3.0 (plus ungoogled-chromium's BSD notice). Forking, modifying and self-hosting are allowed. Network use (§13) means anyone who uses a modified Tandem over the network must be offered its source; this fork is public, which satisfies that. Keep `LICENSE`, `LICENSE.ungoogled_chromium` and upstream copyright notices. |
| Trademark | No trademark policy in the repo, but "BrowserOS" and its logos are the project's marks. Tandem uses its own name and an original logo, and only says "based on BrowserOS neo" (attribution). Note: an unrelated project, `hydro13/tandem-browser` (628★, "AI-Human symbiotic browser"), already uses the name; fine for private use, worth a rename before any public launch. |
| Build system | Browser: Python build CLI over Chromium (~100 GB checkout, hours per build). Agent platform: Bun + Turborepo (TypeScript) and Cargo (Rust). |
| Platforms | macOS, Windows, Linux x64/arm64 (`.deb`, AppImage). |
| Headless / server | **Yes, officially.** Upstream publishes `ghcr.io/browseros-ai/neo` (amd64 + arm64): Ubuntu 24.04, Xvnc virtual display + openbox, Neo, noVNC on 6080, MCP on 9010, profile on `/data`, healthcheck, clean-quit on stop. No desktop environment needed. |
| Automation interfaces | MCP (streamable HTTP, 22 tools, `readOnlyHint` annotations) on 9010; Chrome DevTools Protocol on 127.0.0.1:9110 inside the container; a hosted read-only `/v1/sessions` API in hosted mode. |
| Hermes | Hermes already speaks MCP over HTTP (`mcp_servers:` in `~/.hermes/config.yaml`; it is wired to desktop Neo today as `browseros-neo`). MCP is the supported route; no Hermes changes needed. |

Tested on 2026-11-05 against `neo:0.52.1.2-ee2c294` (arm64, Colima):
container healthy in ~40 s; CDP reachable from a sidecar sharing its network
namespace; `Page.startScreencast` delivers JPEG frames with viewport metadata;
mouse/keyboard input and navigation work over CDP; a background tab streams
only after `Emulation.setFocusEmulationEnabled`, and `captureScreenshot` works on
it as a fallback.

## Decision: don't rebuild Chromium

Everything Tandem needs already exists in upstream's published engine image.
Rebuilding the browser to change its name would cost a 100 GB toolchain and
hours per upstream update, and would make every upstream patch a merge risk. So:

- **Engine** = upstream's image, unmodified, pinned by digest
  (`tandem/deploy/neo-image.env`). Updating it is a one-line change the sync
  workflow makes and tests.
- **Tandem** = new components that sit next to the engine and never patch it.
- Users never see the engine's own window chrome: the viewer draws its own
  browser UI. The engine's name appears only as attribution and in the raw
  "Desktop view" fallback.

If a feature ever truly needs an engine change, the smallest route is a patch to
`packages/browseros/docker/neo/entrypoint.sh` (a shell file, not Chromium),
proposed upstream first.

## Components

```
 Mac / Windows / Linux                                VPS (Hostinger, Docker)
 ┌───────────────────────────┐                ┌──────────────────────────────────────────────┐
 │ Tandem desktop app        │                │ caddy  :443  (TLS, Let's Encrypt, HSTS)       │
 │  (Electron shell, menus,  │── HTTPS/WSS ──▶│   │                                          │
 │   clipboard, shortcuts)   │                │   ▼                                          │
 │  loads the web viewer     │                │ tandem-gateway :8790 (Bun)                   │
 ├───────────────────────────┤                │   auth · sessions · TOTP · audit log         │
 │ any browser:              │── HTTPS/WSS ──▶│   CDP bridge: tabs, screencast, input        │
 │  https://browser.<domain> │                │   control coordinator (watch/agent/manual)  │
 └───────────────────────────┘                │   /mcp proxy with control gating             │
                                              │   /desktop → noVNC (raw screen fallback)     │
 Hermes (on the VPS or anywhere) ─ /mcp ─────▶│        │ shares the neo network namespace    │
                                              │        ▼                                     │
                                              │ neo (upstream image, unmodified)             │
                                              │   Xvnc :1 · openbox · BrowserOS neo          │
                                              │   CDP 127.0.0.1:9110 · MCP :9010 · VNC :6080 │
                                              │   /data → profile, logins, sessions          │
                                              └──────────────────────────────────────────────┘
```

| Path | What |
|---|---|
| `tandem/gateway` | The only process that can reach the browser. Viewer API + WebSocket, CDP bridge, control coordinator, MCP proxy, auth, audit. |
| `tandem/web` | The browser-like viewer (tab strip, address bar, live page, control indicator). Served by the gateway. |
| `tandem/desktop` | Native app that loads the viewer from your server and adds menus, shortcuts and clipboard. |
| `tandem/deploy` | Docker Compose, Caddy, installer, backups, `tandem` CLI. |
| `tandem/scripts` | Upstream sync, engine image bump, contract checks. |
| `tandem/branding` | Name, colors, logo. Every surface reads from here. |
| `.github/workflows/tandem-*` | CI, daily upstream sync, guard, desktop builds. |
| `.github/README.md` | The repository front page (GitHub shows it instead of the upstream `README.md`, so upstream's file stays untouched). |

## Why a screencast instead of only VNC

The viewer streams each tab with CDP `Page.startScreencast` and sends input as
CDP input events. Compared with streaming the whole X display over VNC:

- Your tab strip and address bar are real native UI, not pixels.
- You can watch any tab, including one the agent is working in behind another tab, without bringing it to the front (so you never disturb the agent).
- Frames only flow when a page changes, at JPEG sizes, so it's light on bandwidth.
- Clipboard works as text both ways.

What a page screencast can't show: Chromium's native popups (the `<select>`
dropdown list, right-click menu, file picker, permission prompts, extension
popups). For those, **Desktop view** opens the engine's own noVNC screen,
proxied through the gateway and allowed only while you hold control.

## Persistence

- Profile (cookies, local storage, logins, preferences, history) lives in the
  engine's `/data` volume on the VPS disk.
- A managed policy (`RestoreOnStartup: 1`) restores open tabs when the engine restarts.
- The engine quits Chromium cleanly on `docker stop` (upstream `neo-quit`), so cookies flush.
- Control mode and viewer sessions persist in the gateway's volume.
- Docker's `restart: unless-stopped` plus the docker service starting on boot
  bring everything back after a reboot.
- Website logins still expire on the sites' own schedules; Tandem can't change that.
