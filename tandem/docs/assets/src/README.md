# README artwork

From the repository root:

```sh
node tandem/docs/assets/src/render.mjs
```

The renderer uses `@resvg/resvg-js` from the existing `tandem/desktop/node_modules`
(no new dependency). If needed, install those dependencies with
`cd tandem/desktop && bun install --frozen-lockfile` first.

Edit `hero.svg`, `benefits.svg` or `connects.svg`, then run the command again.
Each SVG has a 1120px logical width; PNGs render at **2240px (2×)**. Text uses
Arial and Georgia, available on macOS. For consistent typography, render on a
machine with those fonts installed. `icon.png` is a 256px render of the existing
brand icon. Brand colors come from `tandem/branding/brand.json`.

The hero references the current `agent-driving.jpg` viewer capture and the
brand's `app-icon.svg`. The script inlines these references in memory before
rendering. It needs no network and opens no windows. The other SVGs use original
line icons and opaque cloud-blue backgrounds, including on GitHub's dark theme.

## Refresh the viewer screenshots

```sh
node tandem/docs/assets/src/capture-viewer.mjs /tmp/tandem-readme-blue
node tandem/docs/assets/src/render.mjs
```

Requires Bun, the existing web dependencies, and Google Chrome (the same
`CHROME_PATH` override as the preview). The script builds the current viewer,
captures TradingView's Apple page and Wikipedia's Tandem bicycle article at
1440px wide, then serves those real page frames through `web/dev/mock-server.ts`.
The viewer is captured in Lite view, Watch and Manual modes, at **1440 × 900 CSS
pixels, deviceScaleFactor 2**. These are development-harness compositions, not
screenshots of a deployed server or a live agent session. No page content or
production UI is fabricated. Public pages and prices can change between runs.

The dev-only `TANDEM_DEV_SCENE` environment variable points to a JSON file with
optional `frame` (absolute JPEG path), `width`/`height` (CSS frame dimensions),
`tabs`, `activeTargetId`, `autoActivity` and `pendingAgentCalls` fields. Omit it
to keep the original mock sample and behavior. The capture script writes its
scene files, original page frames and verified capture metadata to the output
directory, and high-quality JPEGs (at most 600 KiB each) to `docs/assets/`.
It closes its isolated headless browser and mock servers on completion.

## Preview the README

```sh
node tandem/docs/assets/src/preview-readme.mjs /tmp/tandem-readme
```

Requires an authenticated `gh` CLI and Google Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (override with
`CHROME_PATH`). Uses GitHub's Markdown API, embeds the local images and fetches
the badge images, then captures desktop (1280px) and narrow (390px) light/dark
previews and a contact sheet of every README image (including badges).
GitHub-style CSS is local to the preview, not injected into the README.
It opens no visible windows and deletes its temporary Chrome profile afterward.
The script checks that every local image exists, all images load, the real
viewport matches the requested width, and the page has no horizontal overflow.
Code blocks and tables can scroll within their own containers, as on GitHub.
