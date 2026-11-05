# Connecting Hermes

Hermes talks to Tandem over MCP, the same way it talks to desktop BrowserOS neo,
but through Tandem's gateway, which adds authentication and the shared-control
rules. Hermes and you always see the same browser.

## 1. Get the agent token

On the VPS: `cd /opt/tandem/tandem/deploy && ./tandem hermes-config` prints the
token and ready-to-paste config. The token is `TANDEM_AGENT_TOKEN` in
`tandem/deploy/.env`. It only opens `/mcp`; it can't log in to the viewer.

## 2. Add the server to Hermes

Hermes on the same VPS (fastest, never leaves the machine):

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  tandem:
    url: http://127.0.0.1:8790/mcp
    connect_timeout: 30.0
    headers:
      Authorization: Bearer ${TANDEM_AGENT_TOKEN}
    enabled: true
```

Hermes anywhere else (for example on your Mac):

```yaml
mcp_servers:
  tandem:
    url: https://browser.example.com/mcp
    connect_timeout: 30.0
    headers:
      Authorization: Bearer ${TANDEM_AGENT_TOKEN}
    enabled: true
```

Put `TANDEM_AGENT_TOKEN=…` in `~/.hermes/.env` (or 1Password via Hermes
secrets), never in the YAML. Then check it: `hermes mcp test tandem`.

Set a long tool timeout if your Hermes config has one: a browser action can be
held for up to `TANDEM_AGENT_HOLD_SECONDS` (default 120 s) while you have
manual control.

## 3. Teach Hermes the rules

Copy `tandem/hermes/tandem-browser/` into `~/.hermes/skills/` (for example
`~/.hermes/skills/productivity/tandem-browser/`). The skill tells Hermes to use
Tandem for web work, to wait when you have control, to ask you for logins and
codes, and the trading limits.

## How shared control looks from Hermes

| Your mode | What Hermes's calls do |
|---|---|
| Watch / Agent | Pass straight through. |
| Manual (you took control) | Read-only tools (`snapshot`, `read`, `grep`, `screenshot`, `wait`, `history`, `diff`, `pdf`) still pass. Anything that changes the browser waits until you hand control back, up to 120 s, then returns "Tandem: a person has manual control…", and Hermes retries later. |

Calls already running when you take over finish first; the viewer shows
"Hermes is finishing N action(s)".
