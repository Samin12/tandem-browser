---
name: tandem-browser
description: "Use the Tandem Browser (server-hosted BrowserOS neo) for any web task; share it safely with the human, who can watch and take control."
version: 0.2.0
author: Tandem Browser
license: AGPL-3.0
metadata:
  hermes:
    tags: [Browser, MCP, Tandem, BrowserOS, Trading research]
---

# Tandem Browser

Tandem Browser is a real, always-on browser on the user's server, signed in to
their accounts. If `mcp__tandem__*` tools are available, use the richer Tandem
MCP tools (`run`, `tabs`, `navigate`, `snapshot`, `act`, `read`, `grep`,
`screenshot`, …). Otherwise Hermes's built-in browser tools (`browser_exec`, or `browser_*` when Browser Use mode is off) already drive
Tandem through its browser provider. The user watches the same tabs live from
their Mac or a web page and can take control at any moment.

## Rules

- Use Tandem for every browser task, through MCP when available or the built-in
  browser tools (`browser_exec` or `browser_*`) otherwise. Don't start another browser.
- On a new MCP connection, call `tabs` with `action:"list"` before opening
  anything, and reuse your task's tab group (see the server's own instructions).
  In provider mode, use the available browser tab-list tool before opening tabs.
- Open your own tab for new work. Leave the user's tabs and other agents' tabs as
  they are unless asked.
- If a tool answers **"Tandem: a person has manual control of the browser"**,
  the user is driving. Stop, wait about a minute, then try again. Never work
  around it with a different browser or tool. Read-only tools (snapshot, read,
  grep, screenshot) still work while you wait.
- If you hit a login, a one-time code, a captcha or a payment, stop and tell the
  user (through your normal messaging channel) what you need, so they can take
  control in Tandem, do it, and hand control back.
- Never type or store passwords, card numbers or codes the user didn't give you
  for that exact task. Never put them in notes, memories or logs.

## Trading research

- You may **watch**: open dashboards (e.g. TradingView), read prices, charts,
  watchlists, news and positions; compare with earlier readings; record what
  changed with timestamps; notify the user.
- You may use **paper trading** accounts the user set up for that purpose.
- You may **not** place, modify or cancel real (live-money) orders, change
  account or funding settings, or move money. If a page could place a live
  order, don't click its order buttons. If you're unsure whether an account is
  paper or live, treat it as live and stop.
- Any future live execution must go through a separate execution service with
  explicit user authorization per order, fixed risk limits, and an independent
  check, never through browser clicks.
- Keep a research log: time, page, what you observed, what you did, and why.
