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

The gateway is the only thing that can reach the browser. It runs with
`network_mode: service:neo`, so Neo's loopback ports are its loopback ports.
Only port 8790 leaves the namespace, and only to 127.0.0.1 on the host and to Caddy.

## Gateway environment

| Variable | Default | Meaning |
|---|---|---|
| `TANDEM_LISTEN` | `0.0.0.0:8790` | Address inside the shared namespace |
| `TANDEM_PUBLIC_ORIGIN` | (required) | e.g. `https://browser.example.com`. Exact `Origin` the viewer must send. Comma-separate extra origins (e.g. `http://localhost:8790` for local dev). |
| `TANDEM_PASSWORD_HASH` | (required unless `TANDEM_PASSWORD`) | Argon2id hash from `bun run hash-password` (Bun.password) |
| `TANDEM_PASSWORD` | unset | Plain password, dev only; hashed in memory at startup. Refused when `TANDEM_ENV=production`. |
| `TANDEM_TOTP_SECRET` | unset | Base32 secret. When set, login also needs a 6-digit code (RFC 6238, SHA1, 30 s, ±1 step). |
| `TANDEM_AGENT_TOKEN` | (required) | Bearer token for `/mcp`. At least 32 chars. Never accepted for viewer routes. |
| `TANDEM_ENV` | `production` | `production` or `development` (development allows `TANDEM_PASSWORD` and non-Secure cookies on http origins) |
| `TANDEM_DATA_DIR` | `/var/lib/tandem` | `sessions.sqlite`, `audit.log` (JSONL), `state.json` (control mode) |
| `TANDEM_SESSION_IDLE_HOURS` | `12` | Viewer session idle timeout |
| `TANDEM_SESSION_MAX_HOURS` | `72` | Absolute session lifetime |
| `TANDEM_AGENT_HOLD_SECONDS` | `120` | How long a mutating MCP call waits while a human has control before it fails |
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
| `POST /api/login` `{password, totp?}` | none, rate-limited | Sets the cookie. 5 failures per IP per 15 min, then 429 with `Retry-After`. Constant-time compare. |
| `POST /api/logout` | session | Clears session |
| `GET /api/me` | session | `{user:"owner", sessionId, expiresAt, totp:boolean}` |
| `GET /api/health` | none | `{ok, cdp:boolean, mcp:boolean, version}`; never leaks URLs or titles |
| `GET /api/audit?limit=200` | session | Last audit entries |
| `GET /ws` (upgrade) | session + Origin | Viewer socket, below |
| `GET /desktop/*` | session; WebSocket part also needs human control | Neo's own noVNC page, proxied (full raw desktop, fallback for native popups) |
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | `Authorization: Bearer $TANDEM_AGENT_TOKEN` | Neo MCP proxy with control gating |

Responses on every route: `Cache-Control: no-store` for `/api/*`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, a CSP of `default-src 'self'; img-src 'self' data: blob:;
connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`.
The `/desktop/*` route relaxes CSP only as noVNC needs.

## Viewer WebSocket `/ws`

Text frames are JSON objects with a `t` field. Binary frames are screencast images.

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
