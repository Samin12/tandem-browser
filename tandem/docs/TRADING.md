# Trading research with Tandem

The first use of Tandem is AI trading research: Hermes keeps market dashboards
open on the VPS, reads them, notices changes and reports, while you can look at
the same screens from your Mac at any time.

## What Hermes does

1. Opens the dashboards it monitors (TradingView charts and watchlists, news,
   broker portfolio pages) in its own tab group, once. Tabs stay open on the VPS
   and come back after restarts.
2. On a schedule (Hermes cron), reads them with read-only tools (`read`, `grep`,
   `snapshot`, `screenshot`): prices, levels, alerts, positions, headlines.
3. Compares with its last reading and records what changed: time, page, values,
   its interpretation.
4. Sends you a notification (Telegram/Slack through Hermes) when a rule you
   gave it fires.
5. Places trades **only in paper-trading accounts** you set up for that purpose.

You can open Tandem in Watch mode to see exactly what it sees, or take Manual
control to log in, solve a 2FA prompt, or look around yourself.

## What Hermes must not do

- No live-money orders, edits, cancellations, transfers, or account/funding
  changes through the browser.
- No workarounds when you hold control.

These rules are in the `tandem-browser` Hermes skill. They are instructions,
not a technical lock: a browser that is signed in to a live brokerage account
can be clicked. So keep the hard boundary at the account level:

- Sign the Tandem browser in to **paper / demo accounts only** (TradingView paper
  trading, broker sandbox). Don't sign it in to a live brokerage account with
  trading permission.
- If a live account must be visible for monitoring, use a read-only login or
  view-only sub-account if your broker offers one.

## Future live execution

If live trading is ever wanted, it should not go through browser clicks. It
needs, at minimum:

1. A separate execution service using the broker's official API (for example
   Alpaca), never the browser.
2. Explicit authorization from you per order (or per strategy, with a written
   mandate).
3. Deterministic risk limits enforced in code before any order: max position
   size, max daily loss, max order rate, allowed symbols, market hours.
4. Independent validation: a second check (separate process or model) that the
   order matches the signal and the limits, and a kill switch.
5. Full logging of signal → decision → order → fill.

Tandem stays the research and monitoring surface; it is not the execution path.
