# Web viewer

Vanilla TypeScript/CSS viewer for the Tandem gateway. Runtime branding comes from
`/brand.json`; the gateway's public `/favicon.svg` aliases the bundled
`logo.svg` brand asset. No runtime packages are required.

```sh
bun install --frozen-lockfile
bun run build
bun run dev
```

The mock listens on `http://127.0.0.1:8791` and prints its temporary development
password at startup. `PORT` overrides the port; `TANDEM_DEV_PASSWORD` can provide
a repeatable password without storing it in a file. `TANDEM_DEV_TOTP=1` enables
the development code `123456`. Never deploy the mock as a gateway.

`dist/` contains the two HTML pages, bundled JS, CSS, the brand logo and favicon,
and a mock-only copy of `brand.json`. The real gateway supplies its own brand
file. Build paths are relative to this folder, including inside Docker.

```sh
bun test
bun run typecheck
bun dev/visual-check.ts
bun dev/visual-check.ts --totp
```

The visual check starts and stops its own mock and headless Chrome, uses a fresh
profile under `~/.cache`, logs in through the form, exercises the viewer and
native command bridge, and saves screenshots under `dev/screenshots/`. It never
opens a visible window or connects to an existing browser. Chrome must be
installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

The mock streams the supplied engine capture (`dev/sample-frame.jpg`,
1600×913) with the real binary frame envelope. Every fake tab intentionally
shows that same image; navigation and input do not drive an actual engine.
It implements session cookies, Origin/X-Tandem checks, login errors and rate
limiting, server-confirmed control ownership, tab changes, agent activity,
clipboard replies, dialogs and reconnects. Its sessions, audit and control state
are in memory; TOTP is a fixed development fixture, not RFC 6238 validation.
The mock's `/desktop/` is a placeholder; real native popups require the gateway.

Authenticated development helpers (not part of the gateway contract):

- `POST /api/mock/dialog` with `{ "type": "prompt" }` triggers a remote JS dialog.
- `POST /api/mock/disconnect` forces viewers to reconnect.
- `GET /api/mock/messages` returns recent in-memory client messages for checks;
  text payloads are redacted. Do not type private information into the mock.

POST helpers require the session, `Origin` and `X-Tandem: 1` headers. The visual
check demonstrates their use. The production viewer never calls these routes.

The mock checks use headless Chrome and an injected desktop bridge. Real-engine
acceptance is described below. Native Electron menus, OS IME candidate windows
and clipboard permissions in other browsers still need acceptance with their
respective components.

Neo view is the default at `/`: the gateway serves its engine's noVNC ES module
at runtime, so noVNC is never bundled into this viewer. The 44px Tandem bar
shares the existing control coordinator, mode preference, audit dialog, login
and desktop bridge. Watch enables gateway follow; Agent disables it. Input is
view-only until a `control` acknowledgment confirms this session holds control.
The gateway independently filters VNC input. A narrow noVNC 1.3 compatibility
shim allows its resize method to run in view-only mode; the RFB instance and
input handlers keep their real view-only state. This matches the gateway's
permission for every viewer to resize the desktop. Losing the viewer socket also
makes VNC view-only while it reconnects.

The menu switches between Neo and the original screencast **Lite view**.
`/?view=lite` and `/?view=neo` override and save `tandem.view`; blocked storage
is optional. Switching resets the viewer socket to drop its old screencast
subscription. Neo does not subscribe to screencasts or duplicate native dialogs.
Mac Command shortcuts become Linux Control shortcuts; Command-Q/H/M/backtick
stay local. Clipboard access uses the desktop bridge when available, native
paste events in a browser, then the browser Clipboard API (which may require
permission). Remote clipboard writes also require browser permission outside
the desktop app.

Real Neo acceptance (headless Chrome only, disposable engine and volumes):

```sh
# From tandem/deploy. This project name and port avoid existing containers.
TANDEM_PORT=18790 docker compose -p tandem-neo-web-check \
  --env-file neo-image.env -f compose.ci.yaml \
  -f ../web/dev/neo-compose.override.yaml up -d --wait --build

# From tandem/web. Read the existing test-only password without storing it.
TANDEM_PASSWORD="$(docker compose -p tandem-neo-web-check \
  --env-file ../deploy/neo-image.env -f ../deploy/compose.ci.yaml \
  -f dev/neo-compose.override.yaml config --format json | \
  bun -e 'const c=await Bun.stdin.json();process.stdout.write(c.services.gateway.environment.TANDEM_PASSWORD)')" \
  bun dev/neo-visual-check.ts

# From tandem/deploy. Remove only this acceptance stack and its volumes.
TANDEM_PORT=18790 docker compose -p tandem-neo-web-check \
  --env-file neo-image.env -f compose.ci.yaml \
  -f ../web/dev/neo-compose.override.yaml down -v
```

The override enables Neo extensions and toolbar features. The gateway image
builds and serves the viewer without host bind mounts.
The real check saves 1440×900 Manual, Agent, Watch and Lite captures (plus a
390px capture) and `results.json` under `dev/screenshots/neo/`. It exercises real
VNC shortcuts/clipboard/control and uses a simulated desktop preload; it does
not launch Electron or prove native menu delivery. `dev/visual-check.ts` keeps
using Lite against the mock, which deliberately has no VNC implementation.
