# Agent speed validation — 2026-11-05

Branch: `tandem/agent-speed`, based on `767a80f2`. All changes are in `tandem/`
and `.github/workflows/tandem-ci.yml`. No Neo image changes, production VPS
access, host GUI windows, pushes or PRs. Docker used the local Colima arm64 engine.

## Results

| Check | Result |
|---|---|
| Gateway `bun run typecheck` | pass |
| Gateway `bun test` | **106 pass, 0 fail**, 854 expectations, 11 files |
| Web `bun run typecheck` | pass |
| Web `bun test` | **143 pass, 0 fail**, 394 expectations, 7 files |
| Web `bun run build` | pass |
| Disposable-engine e2e, `TANDEM_TEST_NEKO=1` | **29 pass, 0 fail** |
| Headless real WebRTC visibility acceptance | **8 pass, 0 fail** |
| Real Playwright `chromium.connectOverCDP(base)` | pass: discovery, attach, create, evaluate, close |
| Standard `docker compose config --format json` | **4/4 pass**, shared image, caps, health dependency and CPU shares asserted |
| `actionlint .github/workflows/tandem-ci.yml` | pass; aggregate `tandem-ci-ok` unchanged |
| `git diff --check` | pass |

Gateway tests cover path/bearer authentication, encoded tokens, URL rewriting
including frontend ws parameters, the exact read allowlist, ordered hold/release,
per-command timeout/session ID, disconnect cancellation, audit redaction,
5 MiB screenshot responses, eight-connection capacity/recovery and disabled CDP.
A fake upstream runs HTTP and WebSocket tests. The live e2e connects to the
rewritten discovery URL, creates a target, evaluates JavaScript, holds another
evaluation during Manual, allows Browser.getVersion meanwhile, releases and
closes the target. Existing VNC, MCP, control, audit and neko checks also pass.

The headless viewer checks real decoded video, short hides, a 15-second pause,
the uninterrupted control socket/human ownership, no VNC fallback during an
11-second pause, immediate resume with a fresh decoded frame, restored neko
host and no runtime exceptions. Neko logs show `last listener, stopping` and
pipeline destruction during the pause. See `web/dev/WEBRTC.md` for the command.

## Commands

From `tandem/gateway`:

```sh
bun run typecheck
bun test
```

From `tandem/web`:

```sh
bun run typecheck
bun test
bun run build
```

From the repository root (free host ports 18971 and 59171, dedicated project):

```sh
TANDEM_PORT=18971 TANDEM_WEBRTC_PORT=59171 docker compose -p tagentspeed \
  --env-file tandem/deploy/neo-image.env -f tandem/deploy/compose.ci.yaml \
  up -d --wait --build

docker run --rm --network container:tagentspeed-neo-1 \
  -v "$PWD:/repo" -w /repo/tandem/gateway \
  -e TANDEM_URL=http://127.0.0.1:8790 -e TANDEM_ORIGIN=http://127.0.0.1:8790 \
  -e TANDEM_TEST_PASSWORD=tandem-local-test-password \
  -e TANDEM_AGENT_TOKEN=tandem-local-test-token-00000000000000000000 \
  -e TANDEM_TEST_NEKO=1 oven/bun:1.3.14 bun run e2e

docker exec tagentspeed-neo-net-1 ip route show table local
docker exec tagentspeed-neo-net-1 ip -6 route show table local
```

Observed loopback routes after a fresh stack start:

```text
local 127.0.0.0/8 dev lo proto kernel scope host src 127.0.0.1 quickack 1
local 127.0.0.1 dev lo proto kernel scope host src 127.0.0.1 quickack 1
local ::1 dev lo proto kernel metric 1 quickack 1 pref medium
```

Clearing quickack on the /8 and ::1 routes in this disposable namespace, then
waiting 31 seconds, produced `quickack 1` on both again. Container inspection
confirmed neko `CpuShares=256`, gateway `CapDrop=[ALL]`, `CapAdd=[]`.

All four deployment files were rendered with standard `docker compose ...
config --format json`: `compose.yaml`, `compose.local.yaml`, `compose.ci.yaml`,
`hostinger/compose.yaml`. Required production interpolation variables used
throwaway placeholders. Empty throwaway `.env` files were created exclusively
where missing for service env-file resolution and removed immediately afterward.
The normalized JSON was parsed to verify shared gateway/helper image tags,
root/NET_ADMIN only on the helper, read-only filesystem, healthy Neo dependency,
and neko's CPU weight. No deployment credentials were needed.

Cleanup (only this project and its volumes):

```sh
TANDEM_PORT=18971 TANDEM_WEBRTC_PORT=59171 docker compose -p tagentspeed \
  --env-file tandem/deploy/neo-image.env -f tandem/deploy/compose.ci.yaml down -v
```

## Measured latency and implementation choices

The final e2e run measured gateway MCP `tabs` with `{action:"list"}` inside the
engine namespace, using five warmups followed by 20 measured calls:
**median 1.84 ms, min 1.43 ms, p95 2.95 ms**. The test enforces median <30 ms.
Earlier isolated runs measured medians 1.97 ms and 5.09 ms. These are local
Docker measurements, not a new VPS or WAN benchmark. The supplied 2-vCPU EPYC
VPS measurements (42 → 4 ms tabs, ~26 ms read, 0.3 ms raw CDP, and streaming CPU
observations) are recorded separately in `docs/AGENTS.md`.

- Linux normalizes IPv6 metric zero on route changes, so changing the generated
  ::1 route in place failed. The helper installs a quickack-enabled metric-one
  replacement before removing metric zero; there is no route gap. Missing IPv6
  is harmless. IPv4 routes keep their existing metadata.
- Build-based Compose files build the gateway image once; `neo-net` references
  the same tag with `pull_policy: never`. Building both services with the same
  tag raced in the local classic Docker builder. `up --build` now succeeds.
  Hostinger keeps the requested shared image plus `pull_policy: missing`.
- Playwright appends `/` to `/json/version/`. Discovery accepts that spelling
  (also `/json/` and `/json/list/`); other HTTP endpoints remain blocked.
- The headless Docker visibility test disables Chrome's mDNS host-candidate
  masking, because multicast discovery failed on peer reconnect in that local
  test topology. The production client has no such flag or code workaround.
- The injected-clock unit suite and real browser check caught/fixed an illegal
  timer receiver binding. A regression test now covers default clock binding.
- The gateway already reapplied neko host on `system/init` and socket attachment.
  No gateway behavior change was needed for pause/resume; new unit and live tests
  prove the current human receives host again while `/ws` stays connected.

No VPS/WAN acceptance or live Claude Code, Codex, Hermes, browser-use, Puppeteer
or chrome-devtools-mcp account sessions were run. Their setup examples are in the
agent guide; real Playwright and raw CDP exercised the gateway locally.
