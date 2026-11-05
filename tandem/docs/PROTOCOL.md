# Tandem protocol (contract between gateway, web viewer and desktop app)

This file is the single source of truth for how the pieces talk. Change it first,
then the code. Everything here is Tandem-only; nothing in upstream BrowserOS
depends on it.

## Processes and ports

```
             internet (HTTPS only)
                    │
               Caddy :443  ──────────────▶  gateway :8790   (TLS, HSTS)
                                              │  (shares the neo container's network namespace)
   Hermes on the VPS host ─ 127.0.0.1:8790 ──▶│
                                              ├─▶ 127.0.0.1:9110  Neo CDP          (never published)
                                              ├─▶ 127.0.0.1:9010  Neo MCP + API    (never published)
                                              └─▶ 127.0.0.1:6080  Neo noVNC        (never published)
```

The gateway is the only external entry point to the browser. It runs with
`network_mode: service:neo`, so Neo's loopback ports are its loopback ports.
Trusted `neko` and `neo-net` sidecars share this namespace too. Raw engine
ports are never published; gateway 8790 is reachable on host loopback and by
the TLS proxy, and neko's media mux is published separately.

## Gateway environment

| Variable | Default | Meaning |
|---|---|---|
| `TANDEM_LISTEN` | `0.0.0.0:8790` | Address inside the shared namespace |
| `TANDEM_PUBLIC_ORIGIN` | (required) | e.g. `https://browser.example.com`. Exact `Origin` the viewer must send. Comma-separate extra origins (e.g. `http://localhost:8790` for local dev). |
| `TANDEM_PASSWORD_HASH` | (required unless `TANDEM_PASSWORD`) | Argon2id hash from `bun run hash-password` (Bun.password) |
| `TANDEM_PASSWORD` | unset | Plain password, dev only; hashed in memory at startup. Refused when `TANDEM_ENV=production`. |
| `TANDEM_TOTP_SECRET` | unset | Base32 secret. When set, login also needs a 6-digit code (RFC 6238, SHA1, 30 s, ±1 step). |
| `TANDEM_AGENT_TOKEN` | (required) | Agent credential for `/mcp` and `/cdp`. At least 32 chars. Never accepted for viewer routes. |
| `TANDEM_ENV` | `production` | `production` or `development` (development allows `TANDEM_PASSWORD` and non-Secure cookies on http origins) |
| `TANDEM_DATA_DIR` | `/var/lib/tandem` | `sessions.sqlite`, `audit.log` (JSONL), `state.json` (control mode) |
| `TANDEM_SESSION_IDLE_HOURS` | `12` | Viewer session idle timeout |
| `TANDEM_SESSION_MAX_HOURS` | `72` | Absolute session lifetime |
| `TANDEM_AGENT_HOLD_SECONDS` | `120` | How long a mutating MCP call or CDP command waits during human control |
| `TANDEM_CDP` | `on` | `off` disables agent CDP routes (404) |
| `TANDEM_CDP_URL` | `http://127.0.0.1:9110` | Neo's CDP endpoint (internal) |
| `TANDEM_NEO_MCP_URL` | `http://127.0.0.1:9010/mcp` | Neo's MCP endpoint (internal) |
| `TANDEM_NOVNC_URL` | `http://127.0.0.1:6080` | Neo's noVNC (internal) |
| `TANDEM_PUBLIC_DIR` | `./public` | Built web viewer (`tandem/web/dist`) |
| `TANDEM_BRAND_FILE` | `./brand.json` | Copy of `tandem/branding/brand.json` |

## HTTP routes

All viewer routes need the session cookie `tandem_session` (HttpOnly, Secure,
SameSite=Strict, Path=/). State-changing requests (non-GET) and WebSocket
upgrades must carry an `Origin` header listed in `TANDEM_PUBLIC_ORIGIN`;
non-GET JSON requests must also send `X-Tandem: 1`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /` and static files | none for `/login*`, `/assets/*`, `/brand.json`, `/favicon.svg`; session for the app shell | Web viewer |
| `GET /api/auth-config` | none | `{totp:boolean, productName}` so the login page knows whether to show the code field |
| `POST /api/login` `{password, totp?}` | none, rate-limited | 200 `{ok:true}` + cookie; 401 `{error:"invalid_credentials"}` (same answer whether the password or the code was wrong); 429 `{error:"rate_limited", retryAfter}`. 5 failures per IP per 15 min, then 429 with `Retry-After`. Constant-time compare. |
| `POST /api/logout` | session | Clears session |
| `GET /api/me` | session | `{user:"owner", sessionId, expiresAt, totp:boolean}` |
| `GET /api/health` | none | `{ok, cdp:boolean, mcp:boolean, version}`; never leaks URLs or titles |
| `GET /api/audit?limit=200` | session | Last audit entries |
| `GET /ws` (upgrade) | session + Origin | Viewer socket, below |
| `GET /desktop/*` | session | Neo's own noVNC files, proxied. The Neo view imports `/desktop/core/rfb.js` from here, so the client always matches the engine's noVNC. |
| `GET /desktop/websockify` (upgrade) | session + Origin | The engine's VNC stream. Any signed-in viewer may watch; the gateway drops keyboard, mouse and clipboard messages from sessions that don't hold control (see "Neo view"). |
| `GET /cdp[/TOKEN]/{json,devtools}/*` | Agent token in path or bearer header | Agent CDP discovery and sockets (see below) |
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | `Authorization: Bearer $TANDEM_AGENT_TOKEN` | Neo MCP proxy with control gating |

Responses on every route: `Cache-Control: no-store` for `/api/*`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, a CSP of `default-src 'self'; img-src 'self' data: blob:;
connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`.
The `/desktop/*` route relaxes CSP only as noVNC needs.

## Viewer WebSocket `/ws`

Text frames are JSON objects with a `t` field. Binary frames are screencast images.
A failed upgrade answers HTTP 401 (no/expired session) or 403 (bad Origin). An open
socket is closed with code **4401** when its session expires or is logged out,
**4403** on a protocol violation, and **4409** never (reserved). Clients reconnect
with backoff on any other close and go to `/login` on 4401.

### Client → server

| `t` | Fields | Allowed when |
|---|---|---|
| `hello` | `viewport:{w,h,dpr}` | always (first message) |
| `viewport` | `w,h,dpr` | always. Sets max screencast size (`w*dpr` × `h*dpr`, capped at 2560×1600). |
| `view` | `targetId` | always. Subscribe this socket's screencast to a tab. Does **not** bring the tab to the front in the real browser. |
| `tab.new` | `url?` | human control by this session |
| `tab.close` | `targetId` | human control by this session |
| `tab.activate` | `targetId` | human control by this session. Brings the tab to the front in the real browser (`Target.activateTarget`) and also views it. |
| `nav.go` | `targetId, url` | human control. URL rules: `http(s)`, `about:blank`, `chrome://newtab`. Bare words become `https://www.google.com/search?q=…`; `host.tld` gets `https://`. `javascript:`, `file:`, `data:`, `chrome://` other than newtab are refused. |
| `nav.back` / `nav.forward` / `nav.reload` / `nav.stop` | `targetId` | human control |
| `input.mouse` | `targetId, type:"move"\|"down"\|"up"\|"wheel", x, y, button?:"left"\|"middle"\|"right"\|"none", buttons?, clickCount?, modifiers?, deltaX?, deltaY?` | human control. `x,y` are CSS pixels inside the page viewport, already mapped from the frame metadata. |
| `input.key` | `targetId, type:"down"\|"up", key, code, keyCode, text?, modifiers, location?, autoRepeat?` | human control. `modifiers` is the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). The client maps Mac ⌘ to Ctrl, because the remote browser runs on Linux. |
| `input.text` | `targetId, text` | human control. Paste and IME (`Input.insertText`). Max 100 000 chars. |
| `clipboard.copy` | `targetId, reqId` | human control. Server returns the page's current selection (focused input/textarea selection, else `getSelection()`), max 100 000 chars. |
| `dialog.respond` | `targetId, accept, promptText?` | human control |
| `control.take` | | always (a human can always take over) |
| `control.release` | | the human who holds control |
| `ping` | `ts` | always |

A message that needs control and doesn't have it gets
`{t:"error", code:"not_in_control", message}` and is dropped. The server never
forwards raw CDP from the client; every message maps to a fixed, typed CDP call.

### Server → client

| `t` | Fields |
|---|---|
| `welcome` | `sessionId, brand, control, tabs, activeTargetId, serverVersion` |
| `tabs` | `tabs:[{targetId, url, title, loading, canGoBack, canGoForward, opener:"agent"\|"human"\|"unknown", lastAgentActivityAt?}]`, `activeTargetId` (the tab in front in the real browser, best effort) |
| `control` | `controller:"agent"\|"human", holderSessionId?, holderLabel?, since, yours:boolean, agentBusy:boolean, pendingAgentCalls:number, lastAgentTool?:{name, at}` |
| `agent.activity` | `tool, targetId?, at` (a tab the agent just created or navigated; drives Watch mode) |
| `dialog` | `targetId, type:"alert"\|"confirm"\|"prompt"\|"beforeunload", message, defaultPrompt?` |
| `dialog.closed` | `targetId` |
| `clipboard` | `reqId, text` |
| `error` | `code, message, reqId?` |
| `pong` | `ts, serverTs` |

### Binary screencast frame

```
uint32 big-endian  N = byte length of the JSON header
N bytes            UTF-8 JSON {targetId, seq, deviceWidth, deviceHeight, offsetTop, pageScaleFactor, scrollOffsetX, scrollOffsetY, timestamp, format:"jpeg"}
rest               JPEG bytes
```

`deviceWidth`/`deviceHeight` are the page viewport in CSS pixels; the client
draws the JPEG scaled into that box and maps pointer positions back into it.
The server acks each CDP frame at once and drops frames for a socket whose
`bufferedAmount` is above 2 MB, so a slow link sees a lower frame rate rather than
growing lag. A tab behind other tabs in the real browser only paints while
someone views it: the server enables `Emulation.setFocusEmulationEnabled` on its
own session for viewed tabs, and if no frame arrives within 1 s it falls back to
`Page.captureScreenshot` every 250 ms until frames flow.

## Neo view (default)

The viewer's main mode streams BrowserOS neo's real window (vertical tabs, Neo
dashboard, toolbar, extensions, native popups) over VNC instead of redrawing a
browser frame. Upstream UI changes therefore show up in Tandem with no Tandem
work. The screencast UI above stays available as **Lite view** (menu, or
`/?view=lite`), for phones and slow links.

Engine settings that make the real UI visible (compose files):
`NEO_DISABLE_BROWSEROS_EXTENSIONS=false` (Neo's dashboard is an extension) and
`NEO_ARGS=--disable-browseros-features=AvatarButton` (replaces upstream's list
that hides vertical tabs, home, split, tab search, extensions toolbar and the new
tab page). A one-shot `neo-prefs` service turns vertical tabs on in a new
profile (`vertical_tabs.enabled` and `browseros.vertical_tabs_enabled`), once;
after that the user's own choice in Neo wins.

### VNC input filter

`/desktop/websockify` relays RFB 3.8 between the viewer and the engine's Xvnc
(security type None, so authentication is the gateway session). The gateway
parses the client-to-server stream:

| Phase / message | Size | Forwarded |
|---|---|---|
| ProtocolVersion, security type, ClientInit | 12 + 1 + 1 bytes | always |
| 0 SetPixelFormat | 20 | always |
| 2 SetEncodings | 4 + 4·n | always |
| 3 FramebufferUpdateRequest | 10 | always |
| 150 EnableContinuousUpdates | 10 | always |
| 248 ClientFence | 9 + payload length | always |
| 251 SetDesktopSize | 8 + 16·screens | always (the window you look through sets the screen size) |
| 4 KeyEvent | 8 | only from the session holding control |
| 5 PointerEvent | 6 | only from the session holding control |
| 6 ClientCutText | 8 + abs(length) | only from the session holding control |
| 255 QEMU extended key event | 12 | only from the session holding control |
| anything else | | connection closed (4403) |

Messages are reassembled across WebSocket frames before filtering. Server to
client traffic is passed through untouched. Losing control no longer closes the
socket; input is simply dropped from then on.

### Follow (Watch mode)

Viewer message `{t:"follow", enabled:boolean}` (always allowed). While at least
one connected viewer has follow on and `controller=agent`, the gateway brings
the agent's tab to the front (`Target.activateTarget`) on each `agent.activity`,
at most once per 500 ms, so the streamed Neo window shows what the agent is
doing. It never does this while a person holds control.

### Viewer behaviour in Neo view

- Layout: a slim Tandem bar (logo, connection, who is driving, Watch / Agent /
  Manual, menu with Lite view, Audit log, Log out) above the full-size Neo window.
- noVNC `RFB` from `/desktop/core/rfb.js` (dynamic import), `scaleViewport` and
  `resizeSession` on, `viewOnly` unless this session holds control.
- On a Mac client, ⌘+key is sent to the remote as Ctrl+key (the engine is Linux).
- Clipboard: remote copy (`clipboard` event) is written to the local clipboard;
  ⌘V/Ctrl+V pushes local text with `clipboardPasteFrom` then sends Ctrl+V.
- Desktop app commands map to engine shortcuts while in control: new-tab Ctrl+T,
  close-tab Ctrl+W, focus-address Ctrl+L, reload Ctrl+R, stop Escape, back
  Alt+Left, forward Alt+Right, next/prev-tab Ctrl+(Shift+)Tab, select-tab:N
  Ctrl+N, edit-* Ctrl+Z / Ctrl+Shift+Z / Ctrl+X / Ctrl+C / paste / Ctrl+A.
  Without control they show "Take control first".

## WebRTC transport (neko)

Neo view prefers WebRTC and falls back to VNC. The `neko` service
(m1k1o/neko 3.2.0, pinned) runs beside the engine with `network_mode:
service:neo` and `ipc: service:neo`, captures display `:1` through a shared
`/tmp/.X11-unix` volume, encodes H.264 (x264 ultrafast, `TANDEM_STREAM_FPS`,
default 25), injects input with XTest, and listens on 127.0.0.1:8080 inside the
shared namespace. It captures and encodes only while a viewer is connected; at
Retina size that costs about one CPU core, roughly in proportion to the frame
rate, so a small server can lower `TANDEM_STREAM_FPS` (15–20). Media
uses one UDP mux port (TCP mux on the same number as a fallback), published on
the neo service (`TANDEM_WEBRTC_PORT`, default 59000). neko applies input only
from its *host*; its controls are locked so only the gateway can choose the host.

Gateway environment: `TANDEM_NEKO_URL` (unset = WebRTC off, VNC only),
`TANDEM_NEKO_USER_PASSWORD` (neko `multiuser` user password, only the gateway
knows it), `TANDEM_NEKO_API_TOKEN` (neko `session.api_token`, full admin, never
leaves the gateway).

### Sessions and routes

- `GET /api/me` adds `webrtc: boolean`.
- The gateway logs each Tandem viewer session into neko on first use
  (`POST {neko}/api/login` as `tandem-<short id>` with the user password),
  keeps neko's token server-side, and deletes that neko session on logout or
  expiry. The browser never sees a neko credential.
- `/neko/*` proxies to neko for viewer sessions only (cookie + Origin), with
  `Authorization: Bearer <that session's neko token>` injected and any client
  `Authorization`/`Cookie` for neko stripped. An explicit allowlist covers
  only what `@m1k1o/neko`'s client needs (its signalling WebSocket
  `/neko/api/ws` and the few read routes it calls); everything else under
  `/neko/` is 404 — in particular `/api/login`, `/api/members*`,
  `/api/sessions*`, `/api/room/settings`, `/api/room/control/*`,
  `/api/room/screen` writes, `/api/batch`, `/metrics`, `/debug/*`.

### Control and screen size

- At start the gateway sets room settings `locked_controls: true`,
  `implicit_hosting: false`, `control_protection: false` with the API token.
- Human holds control → `POST /api/room/control/give/{nekoSessionId}` for that
  viewer's neko session (logging it in first if needed). Agent → `POST
  /api/room/control/reset`. Re-applied whenever a neko session connects.
- Viewer message `{t:"screen", w, h}` (device pixels: CSS size × displayScale,
  even numbers, capped like VNC at 3840×2400) sets the display size through the
  admin API, debounced 500 ms, last request wins. It keeps the engine screen
  matched to the window, like VNC `SetDesktopSize`.

### Client

- `@m1k1o/neko` (pinned 3.2.0) is bundled into the web viewer. In Neo view the
  viewer mounts its video + input layer into the Neo window area, connected to
  `/neko`. If no video plays within 8 s, or ICE fails or disconnects for more
  than 10 s, the viewer switches to VNC for the rest of that page load and
  shows "VNC" in the bar; otherwise "WebRTC".
- Everything else from "Neo view" still applies: click-to-take-control (the
  first click is replayed once control arrives), Mac ⌘ → Ctrl, clipboard both
  ways, desktop app commands as engine shortcuts, Follow in Watch mode.

## Control coordinator

One server-wide state, persisted in `state.json`:

- `controller: "agent"` — Hermes's MCP calls pass. Viewer input is refused.
- `controller: "human"` — one viewer session holds control. Viewer input from that session passes; MCP calls that change the browser are held.

The three modes the user sees map onto it:

| UI mode | controller | Viewer behaviour |
|---|---|---|
| **Watch** | `agent` | View only, and the viewer follows the tab Hermes is working in (`agent.activity`). |
| **Agent** | `agent` | View only; the viewer stays on the tab you chose. |
| **Manual** | `human` (you) | You drive; Hermes is paused. |

Rules:

1. `control.take` always succeeds and takes effect immediately (a person beats an agent). A different viewer taking over replaces the previous holder.
2. `control.release` (or the holder's sessions all disconnecting for 60 s, or logout) hands control back to the agent.
3. MCP JSON-RPC methods other than `tools/call` always pass (`initialize`, `tools/list`, notifications, `ping`).
4. `tools/call` for a tool whose cached `annotations.readOnlyHint` is `true` always passes. Unknown tools and tools without the hint count as mutating.
5. While `controller=human`, a mutating `tools/call` waits up to `TANDEM_AGENT_HOLD_SECONDS`. If control returns in time it is forwarded; otherwise the gateway answers with a JSON-RPC result `{content:[{type:"text", text:"Tandem: a person has manual control of the browser, so browser actions are paused. Wait a minute and try again; do not switch to another browser."}], isError:true}`.
6. Calls already forwarded when a human takes over run to completion (they can't be aborted safely); `agentBusy`/`pendingAgentCalls` tell the viewer.
7. The gateway refreshes the tool annotation cache from Neo's `tools/list` at startup, whenever a `tools/list` response passes through, and every 10 minutes.

## Audit log

`$TANDEM_DATA_DIR/audit.log`, one JSON object per line, append-only, 0600:
`{ts, actor:"human"|"agent"|"system", sessionId?, ip?, event, detail}`.
Events: `login.ok`, `login.fail`, `logout`, `control.take`, `control.release`,
`control.auto_release`, `tab.new`, `tab.close`, `tab.activate`, `nav.go` (URL origin
only, no path or query), `agent.tool` (tool name, held ms, outcome; **never**
arguments, which may hold typed passwords), `agent.denied`, `desktop.open`.
Never log cookies, tokens, passwords, TOTP codes, typed text, clipboard text or full URLs.

## Desktop app bridge

The desktop app (Electron, `tandem/desktop`) loads the server's web viewer in a
window and exposes, through its preload script, exactly this object:

```ts
window.tandemDesktop?: {
  isDesktop: true;
  platform: "darwin" | "win32" | "linux";
  version: string;
  onCommand(cb: (command: string) => void): () => void; // returns unsubscribe
  writeClipboard(text: string): void;
  readClipboard(): string;
  openSettings(): void;                                   // change server URL
}
```

Commands sent from native menus and shortcuts:
`new-tab`, `close-tab`, `focus-address`, `reload`, `stop`, `back`, `forward`,
`next-tab`, `prev-tab`, `select-tab:1` … `select-tab:9` (9 = last tab),
`take-control`, `release-control`, `mode-watch`, `mode-agent`, `mode-manual`,
`open-desktop-view`, `edit-undo`, `edit-redo`, `edit-cut`, `edit-copy`,
`edit-paste`, `edit-select-all`, `show-audit`, `logout`.

The `edit-*` commands act on the focused local field (the address bar) when one
has focus, and otherwise on the remote page: copy/cut ask the server for the
selection (`clipboard.copy`) and write it with `writeClipboard`; paste reads
`readClipboard()` and sends `input.text`; undo/redo/select-all send Ctrl+Z /
Ctrl+Shift+Z / Ctrl+A key events. The page sets `document.title` to
`<active tab title> — Tandem Browser`, which the app uses as the window title.
The web viewer must work the same without `window.tandemDesktop` (plain browser).

## Agent (Hermes) connection

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  tandem:
    url: https://browser.example.com/mcp     # or http://127.0.0.1:8790/mcp on the VPS itself
    headers:
      Authorization: Bearer ${TANDEM_AGENT_TOKEN}
```

The `/mcp` route streams Neo's responses (SSE) unchanged and passes
`mcp-session-id` and `mcp-protocol-version` headers both ways.

## Agent CDP endpoint

`GET /cdp/TOKEN/json/version`, `/json` and `/json/list` expose Chromium discovery
with debugger URLs rewritten to the first `TANDEM_PUBLIC_ORIGIN` (WSS for HTTPS,
WS for HTTP). Discovery also accepts a trailing slash for Playwright. Connect to `/cdp/TOKEN/devtools/browser/ID` or
`/cdp/TOKEN/devtools/page/ID`. The same routes without `/TOKEN` accept
`Authorization: Bearer TOKEN`; those rewritten URLs also require the header.
Authentication failures match MCP's 401 response. All other CDP HTTP routes,
including new/close/activate/protocol and frontend files, return 404. Set
`TANDEM_CDP=off` to disable this surface. At most eight CDP sockets may connect.
Frames up to 32 MiB are supported; slow consumers are disconnected rather than
accumulating unbounded data.

While a human holds control, commands wait in arrival order for up to
`TANDEM_AGENT_HOLD_SECONDS`. Read-only commands bypass the queue: Target
getTargets/getTargetInfo/getBrowserContexts/setDiscoverTargets/setAutoAttach/
attachToTarget/detachFromTarget; Browser.getVersion; any domain's enable/disable;
Page captureScreenshot/getLayoutMetrics/getFrameTree/getNavigationHistory;
DOM getDocument/describeNode/getBoxModel/querySelector/querySelectorAll/
getOuterHTML/resolveNode; DOMSnapshot.captureSnapshot; Accessibility
getFullAXTree/getPartialAXTree/queryAXTree; Runtime getProperties/releaseObject/
releaseObjectGroup. All other commands (including Runtime.evaluate and
callFunctionOn) wait. Timed-out commands receive `{id, sessionId?, error:{code:
-32000,message:"Tandem: a person has control of the browser; try again later"}}`
and never reach Chromium. Browser responses/events always pass. In-flight
commands finish normally. CDP uses the same agent-busy/activity and Follow paths
as MCP. Audit events `cdp.connect` and `cdp.disconnect` include duration, message,
held and rejected counts and top method names, never bodies or credentials.

## Engine scheduling and loopback latency

`neo-net` reuses the gateway image with iproute2 and shares Neo's network
namespace. It alone runs as root with NET_ADMIN (all other capabilities dropped,
read-only filesystem, no new privileges). After Neo is healthy it sets quickack
on IPv4 loopback local routes and ::1 if present (replacing the generated IPv6
metric-zero route with metric one before removing it), checking every 30 seconds and
repairing missing flags. Linux delayed ACKs otherwise cost ~40 ms when Neo's
server and browser exchange small writes. Compose restarts it with the engine.
The gateway itself retains `cap_drop: [ALL]`.

Neko has `cpu_shares: 256`: under contention the browser gets CPU first and the
stream drops frames. A viewer hidden continuously for 15 seconds disconnects
only its neko client so the last listener stops encoding. Visibility resumes it
immediately, with a fresh first-frame guard; this intentional pause never
triggers VNC fallback or a connection error. The indicator reads Paused. Tandem's
control socket stays connected, and the current human gets neko host again on
signalling reconnect.
