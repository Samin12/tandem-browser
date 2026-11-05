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

Known acceptance limits: tests use headless Chrome and an injected desktop
bridge. Real gateway/CDP streaming, native Electron menus, OS IME candidate
windows, clipboard permissions in other browsers, and the proxied noVNC desktop
still need integration acceptance with their respective components.
