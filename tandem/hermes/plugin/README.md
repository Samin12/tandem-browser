# Tandem Browser for Hermes

Use Hermes's browser tools on your always-on Tandem browser.
Get Neo's richer MCP tools alongside them.
Watch the same browser and take control whenever you need to.

## Before you start

You need Hermes Agent 0.21.5 or newer and a [running Tandem server](https://github.com/Samin12/tandem-browser/tree/main/tandem/deploy).
On the server, run `./tandem hermes-config` from `tandem/deploy` to get your agent token.
Use HTTPS for remote servers. Keep the token and complete CDP address private.

## Install

```sh
hermes plugins install Samin12/tandem-browser/tandem/hermes/plugin --enable
hermes tandem setup
```

The installer may ask for your Tandem address and token. Setup asks for anything
still missing, checks the server and token, then saves credentials in Hermes's
`.env`. It configures MCP with an environment reference, not a token in YAML.
Start a new Hermes session when setup finishes.

You get built-in browser tools (`browser_exec`, or `browser_*` when Browser Use mode is off) driving Tandem, the `tandem` MCP tools,
the `tandem:tandem-browser` skill, and `/tandem` for a quick status check.
The plugin leaves the shared browser running when a session ends.

## Commands

| Command | What it does |
|---|---|
| `hermes tandem setup [--url URL]` | Check Tandem and configure browser and MCP tools. |
| `hermes tandem setup --no-browser-tools` | Configure MCP without changing the browser provider. |
| `hermes tandem setup --no-mcp` | Configure the browser provider without changing MCP. |
| `hermes tandem setup --yes` | Replace an existing different Tandem MCP entry without asking. |
| `hermes tandem status` | Check gateway, token and configuration; show the viewer address. |
| `hermes tandem open` | Print the viewer address; open it on macOS. |
| `hermes tandem remove` | Remove Tandem MCP and its browser selection; keep `.env` credentials. |
| `/tandem` | Show status and where to watch or take over. |

A `/mcp` suffix on the address is accepted. Setup uses a 180-second MCP tool
timeout so the gateway can wait up to 120 seconds while you have Manual control.
If a call times out during Manual control, wait and retry after handing control back.

## Uninstall

```sh
hermes tandem remove
hermes plugins uninstall tandem
```

Restart Hermes. Remove `TANDEM_URL` and `TANDEM_AGENT_TOKEN` from your Hermes
`.env` yourself if you no longer need them.
