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

The hero references the unchanged real `agent-driving.jpg` screenshot and the
brand's `app-icon.svg`. The script inlines these references in memory before
rendering. It needs no network and opens no windows. The other SVGs use original
line icons and opaque off-white backgrounds, including on GitHub's dark theme.

The original product screenshots are intentionally left unchanged.

## Preview the README

```sh
node tandem/docs/assets/src/preview-readme.mjs /tmp/tandem-readme
```

Requires an authenticated `gh` CLI and Google Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (override with
`CHROME_PATH`). Uses GitHub's Markdown API, embeds the local images and fetches
the badge images, then captures desktop (1280px) and narrow (390px) light/dark
previews. GitHub-style CSS is local to the preview, not injected into the README.
It opens no visible windows and deletes its temporary Chrome profile afterward.
The script checks that every local image exists, all images load, the real
viewport matches the requested width, and the page has no horizontal overflow.
Code blocks and tables can scroll within their own containers, as on GitHub.
