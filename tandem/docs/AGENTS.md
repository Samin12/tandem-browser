# Use Tandem from any agent

Tandem exposes the same always-on browser through Neo MCP and Chromium CDP.
Replace `HOST` with your Tandem hostname and `TOKEN` with `TANDEM_AGENT_TOKEN`.
Keep the complete CDP URL secret. Use HTTPS outside local development.

A person can take Manual control in the Tandem viewer at any time. Agent actions
wait until they hand it back (up to `TANDEM_AGENT_HOLD_SECONDS`, default 120 s).
Read-only operations continue. If an action times out, wait and retry later;
do not work around Manual control by switching connections or browsers.

## MCP clients

Claude Code:

```sh
claude mcp add --transport http tandem https://HOST/mcp --header "Authorization: Bearer TOKEN" -s user
```

Codex, in `~/.codex/config.toml` ([official MCP configuration](https://developers.openai.com/codex/mcp)):

```toml
[mcp_servers.tandem]
url = "https://HOST/mcp"
http_headers = { Authorization = "Bearer TOKEN" }
tool_timeout_sec = 180 # Allow Tandem's 120-second manual-control hold.
```

Hermes, in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  tandem:
    url: https://HOST/mcp
    headers:
      Authorization: Bearer TOKEN
```

These clients discover Neo's tools, including tabs, reading pages, snapshots,
clicking, typing and screenshots. Tandem uses the tools' `readOnlyHint` to decide
which calls may continue during Manual control.

## browser-use harness

For the browser-use Python heredoc harness (helpers are pre-imported):

```sh
BU_CDP_URL=https://HOST/cdp/TOKEN BU_NAME=tandem browser-use <<'PY'
print(list_tabs())
new_tab('https://example.com')
print(page_info())
PY
```

`BU_NAME=tandem` keeps this daemon separate from your local browser daemon. The
harness fetches `<BU_CDP_URL>/json/version`, then connects to the rewritten
WebSocket URL. The path credential works without custom HTTP or socket headers.
Use the same environment variables on subsequent calls to reuse this browser.
`browser-use-tandem`, if installed on your machine, is a convenience wrapper for
this setup. Plain `browser-use` without these settings uses the local browser.

## Playwright

Install `playwright` in your agent's project, then run:

```js
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('https://HOST/cdp/TOKEN');
try {
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    await page.goto('https://example.com');
    console.log(await page.title());
  } finally { await page.close(); }
} finally { await browser.close(); } // disconnects this CDP client
```

## Puppeteer

Install `puppeteer-core`, then run:

```js
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.connect({ browserURL: 'https://HOST/cdp/TOKEN' });
try {
  const page = await browser.newPage();
  try {
    await page.goto('https://example.com');
    console.log(await page.title());
  } finally { await page.close(); }
} finally { browser.disconnect(); }
```

Use `disconnect()` for Puppeteer; `browser.close()` would ask Chromium to quit.
Only close tabs you created.

## chrome-devtools-mcp

Configure your MCP client to launch:

```sh
npx -y chrome-devtools-mcp@latest --browserUrl=https://HOST/cdp/TOKEN
```

For example, register it in Claude Code:

```sh
claude mcp add -s user tandem-devtools -- npx -y chrome-devtools-mcp@latest --browserUrl=https://HOST/cdp/TOKEN
```

## Endpoint and limits

The base CDP URL is `https://HOST/cdp/TOKEN`. Discovery supports `/json/version`,
`/json` and `/json/list` (also with a trailing slash for Playwright); browser and page debugger sockets are proxied. Other
HTTP CDP endpoints, including `/json/new`, `/json/close`, `/json/activate`,
`/json/protocol` and frontend files, are blocked. Create/close tabs through CDP
commands instead. Eight concurrent sockets and frames up to 32 MiB are supported.
Set `TANDEM_CDP=off` on the gateway to disable agent CDP access; MCP stays enabled.

Clients that support Authorization headers on **both** discovery and WebSocket
connections can instead use `https://HOST/cdp` with `Authorization: Bearer TOKEN`.
Its discovery URLs omit the credential, and the socket must carry that header.
Always use the gateway; Chromium's port 9110 is private to the engine namespace.

## Performance

Measurements on the VPS (2 vCPU AMD EPYC), supplied before this change:

| Operation / condition | Before | With tuning |
|---|---:|---:|
| Neo MCP tabs list | 42 ms (Mac: 1 ms) | 4 ms with loopback quickack |
| Neo MCP page read | ~41 ms constant transport cost per call | ~26 ms total with quickack |
| Raw CDP round trip | 0.3 ms | 0.3 ms (no Neo MCP hop) |
| Snapshot / grep under streaming load | baseline | ~20% faster at neko cpu-shares 128 |
| Page load under streaming load | baseline | ~20% faster when neko was throttled |
| Neko at 2936×1914, 25 fps | ~90% of one core with a listener | 0 CPU without listeners |

The ~41 ms constant was present even through Neo's server on port 9210: Linux's
40 ms delayed ACK and Nagle interaction on the server/browser loopback hop.
`neo-net` persists quickack on IPv4 loopback local routes and ::1 and checks every
30 seconds. No Neo image change is needed. The shipped neko weight is **256**,
not the measured 128: the browser wins CPU contention while video drops frames.
A hidden viewer disconnects WebRTC after 15 seconds and reconnects immediately
when visible; encoding stops when the last viewer disconnects. Control remains
connected throughout. These settings reduce avoidable overhead; network RTT and
page work still affect end-to-end speed.
