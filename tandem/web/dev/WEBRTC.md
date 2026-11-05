# Neo WebRTC acceptance

`webrtc-check.mjs` drives Chromium headlessly **inside the disposable engine's
network namespace**. It uses the real gateway, neko sidecar and Neo display;
CDP prepares and observes a click-counter fixture, while viewer input performs
the takeover click, native browser commands, keyboard and clipboard actions.
ICE loss and initial missing media are deliberately injected in the test browser.
No browser windows open on the host.

From the repository root, check the web package:

```sh
cd tandem/web
bun run typecheck
bun test
bun run build
```

Create the isolated stack at DPR/displayScale 2 (ports 8790 and 59000 must be free):

```sh
cd tandem/deploy
TANDEM_DISPLAY_SCALE=2 docker compose -p twebneko --env-file neo-image.env -f compose.ci.yaml up -d --wait --build
```

Set `TANDEM_PASSWORD` in your shell to the **throwaway** password in
`compose.ci.yaml`. Run from the repo root. The `/work` bind supplies the existing
Playwright 1.65 research installation; neither bind changes its contents.

```sh
docker run --rm --name twebneko-pw --network container:twebneko-neo-1 \
  -e TANDEM_PASSWORD \
  -v "$PWD/tandem/web/dev:/scripts:ro" \
  -v "$PWD/tandem/web/dev/screenshots/webrtc:/out" \
  -v "$HOME/.cache/neko-research/pwnode:/work:ro" -w /work \
  mcr.microsoft.com/playwright:v1.65.0-noble node /scripts/webrtc-check.mjs
```

Artifacts: `dev/screenshots/webrtc/{agent,manual,fallback,no-frame-fallback}.png`
(all 1440×900 CSS, DPR 2 → 2880×1800 PNG) and `results.json` with the actual
assertions. Test failures additionally write `failure.png` and `failure.json`.
The expected no-media case logs one intentional neko transport setup error;
uncaught browser exceptions fail the test.

Always remove only this stack afterwards:

```sh
cd tandem/deploy
TANDEM_DISPLAY_SCALE=2 docker compose -p twebneko --env-file neo-image.env -f compose.ci.yaml down -v
```

The bar's latency remains Tandem's viewer-WebSocket roundtrip time. Media stays
muted for reliable autoplay. Local clipboard writes use neko's `clipboard/set`
signalling API with acknowledgment (or a bounded wait), then Ctrl+V, so explicit
local text wins over an older remote selection. Authentication uses the already
verified Tandem session and the gateway's signalling proxy; no neko credentials
are stored or requested in the browser.
