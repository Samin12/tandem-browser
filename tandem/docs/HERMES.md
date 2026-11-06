# Connecting Hermes

Install the native Tandem Browser plugin with one command:

```sh
hermes plugins install Samin12/tandem-browser/tandem/hermes/plugin --enable
```

Then run `hermes tandem setup` and start a new Hermes session. You need Hermes
Agent 0.21.5 or newer and a [running Tandem server](../deploy/README.md).
On the server, `cd /opt/tandem/tandem/deploy && ./tandem hermes-config` prints
your address and agent token. The installer or setup prompts for these values;
setup saves them in Hermes's `.env` and checks the gateway and authenticated CDP.

The plugin configures built-in browser tools (`browser_exec`, or `browser_*` when Browser Use mode is off) through Tandem's CDP provider,
adds Neo's richer MCP tools, registers the shared-control skill, and provides
`/tandem` for status and a viewer link. Hermes and you see the same browser.
Ending a Hermes session leaves the shared browser running.

Use `hermes tandem status` to check the connection, `hermes tandem open` to open
the viewer on macOS (or print its address elsewhere), and `hermes tandem remove`
to undo the MCP and browser selections while keeping credentials. See the
[plugin README](../hermes/plugin/README.md) for setup flags and uninstall steps.

## Manual setup

If you only want MCP without the plugin, put this in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  tandem:
    url: https://browser.example.com/mcp
    connect_timeout: 30.0
    timeout: 180
    headers:
      Authorization: Bearer ${TANDEM_AGENT_TOKEN}
    enabled: true
```

For Hermes on the server itself, use `http://127.0.0.1:8790/mcp` instead.
Put `TANDEM_AGENT_TOKEN=…` in `~/.hermes/.env` (or Hermes secrets), never the
actual token in YAML. The token opens the MCP and CDP gateway routes; it cannot
log in to the viewer. Check the connection with `hermes mcp test tandem`.
The per-server `timeout` allows the gateway's default 120-second Manual hold.

The plugin registers its skill directly from
`hermes/plugin/skills/tandem-browser/SKILL.md`; no skill-copy step is needed.
For manual MCP-only use, follow those same shared-control and trading rules.

## How shared control looks from Hermes

| Your mode | What Hermes's calls do |
|---|---|
| Watch / Agent | Pass straight through. |
| Manual (you took control) | Read-only tools (`snapshot`, `read`, `grep`, `screenshot`, `wait`, `history`, `diff`, `pdf`) still pass. Anything that changes the browser waits until you hand control back, up to 120 s, then returns "Tandem: a person has manual control…". Hermes waits and retries later. |

Calls already running when you take over finish first; the viewer shows
"Hermes is finishing N action(s)". Never bypass Manual control through another
browser or connection. Logins, codes, captchas and payments go to the human.
Trading research and paper trading are allowed; live orders and funding changes
are never performed through the browser.
