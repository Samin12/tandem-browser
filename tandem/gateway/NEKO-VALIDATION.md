# neko gateway validation — 2026-11-05

Branch: `tandem/neko-webrtc`. All implementation changes are under
`tandem/gateway/`; the concurrent web worker owns the web changes. No commits,
pushes, Git configuration, remotes or host GUI actions.

From `/Users/saminyasar/Developer/tandem-browser/tandem/gateway`:

```sh
bun run typecheck
bun test test/*.test.ts
bun test test/neko.test.ts
```

Results: typecheck exit 0; full suite **95 pass, 0 fail**, 746 expectations across
10 files; focused neko suite **13 pass, 0 fail**, 127 expectations. The fake neko
HTTP/WS server covers credential configuration, fresh optional health, startup
locks, lazy concurrent login caching, separate viewer identities, 401 re-login,
header/query stripping, exact route/method allowlisting, session/Origin auth,
initial-frame buffering, text/binary signalling, revoke/expiry/logout deletion,
revocation during login, control replacement/release/reconnect and rapid changes,
screen validation and last-wins debounce, disabled neko, failure isolation and
recovery while VNC remains usable.

From `/Users/saminyasar/Developer/tandem-browser/tandem/deploy`, the requested command:

```sh
docker compose -p tgwneko --env-file neo-image.env -f compose.ci.yaml up -d --wait --build
```

The image built, but startup failed because the other worker's `twebneko` stack
already owned host ports 8790 and 59000. That stack was left untouched. The same
stack then built and reached healthy with isolated host port overrides:

```sh
TANDEM_PORT=18890 TANDEM_WEBRTC_PORT=59002 docker compose -p tgwneko --env-file neo-image.env -f compose.ci.yaml up -d --wait --build
```

After the same-origin GET reconnect fix, the final image was rebuilt from a small
tar context (the legacy builder otherwise sends about 800 MB of unrelated desktop
artifacts). From `/Users/saminyasar/Developer/tandem-browser`:

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -C tandem --exclude='node_modules' --exclude='dist' --exclude='release' -cf - web gateway branding | docker build -f gateway/Dockerfile -t tgwneko-gateway -
```

Then from `tandem/deploy`:

```sh
TANDEM_PORT=18890 TANDEM_WEBRTC_PORT=59002 docker compose -p tgwneko --env-file neo-image.env -f compose.ci.yaml up -d --wait --no-build
```

From `/Users/saminyasar/Developer/tandem-browser`, the exact requested e2e command:

```sh
docker run --rm --network container:tgwneko-neo-1 -v /Users/saminyasar/Developer/tandem-browser:/repo -w /repo/tandem/gateway -e TANDEM_URL=http://127.0.0.1:8790 -e TANDEM_ORIGIN=http://127.0.0.1:8790 -e TANDEM_TEST_PASSWORD=tandem-local-test-password -e TANDEM_AGENT_TOKEN=tandem-local-test-token-00000000000000000000 -e TANDEM_TEST_NEKO=1 oven/bun:1.3.14 sh -c 'bun install --frozen-lockfile && bun run e2e'
```

Result: **26 pass, 0 fail**. New live checks verify `/api/me.webrtc`, authenticated
neko WebSocket upgrade plus `system/init`, anonymous rejection, blocked metrics
and control routes, host identity through admin `GET /api/room/control`, reset on
release, room safety settings, and actual display resizing through CDP
`screen.width*devicePixelRatio` / height. The original screen size is restored.
Existing VNC pointer/key filtering and uninterrupted stream across hand-back,
CDP frames/input, MCP control gating, audit redaction and logout all pass.

Cleanup, from `tandem/deploy`:

```sh
TANDEM_PORT=18890 TANDEM_WEBRTC_PORT=59002 docker compose -p tgwneko --env-file neo-image.env -f compose.ci.yaml down -v
```

Only resources created under `tgwneko` were removed.

## Allowlist and limits

- `GET /neko/api/whoami`: the pinned `@m1k1o/neko` core client's `authenticate()`
  and socket reconnect check. Streamed response body; credential headers removed.
- `GET /neko/api/ws`: WebSocket upgrade only. All core WebRTC signalling,
  keyboard/pointer input and clipboard use this socket and the negotiated data
  channel. Neko 3.2.0 accepts an upstream Authorization header; no token query is
  needed. All other paths/methods under `/neko/` return 404 for signed-in viewers.

Admin-only upstream calls are `POST /api/room/settings`, `POST
/api/room/control/give/{id}`, `POST /api/room/control/reset`, `POST /api/room/screen`
with `{width,height,rate:25}`, and `DELETE /api/sessions/{id}`. Internal login uses
`POST /api/login`; liveness uses `GET /health`. None is exposed through the viewer
proxy. Live tests independently use admin `GET /api/room/control` and `GET
/api/room/settings` inside the namespace.

The protocol's 'cookie + Origin' wording follows the existing viewer GET policy:
HTTP GET can omit Origin (as same-origin browser fetch does), explicit foreign
Origins are rejected, and WebSocket upgrades require an allowed Origin. This
interpretation is needed for the core client's reconnect check; the protocol could
clarify it. No protocol files were edited. The execution deviation was host port
allocation. Gateway live tests validate signalling/control/resize, not browser
video playback, ICE traversal across a real network, media quality, or frontend
fallback timing. Those belong to the concurrent web acceptance work. The isolated
host media port override is not a NAT/ICE deployment recipe.
