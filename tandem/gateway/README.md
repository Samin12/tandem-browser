# Tandem gateway

Bun 1.3+, TypeScript, no runtime dependencies. One CDP browser connection serves all
viewers, and all viewer and MCP actions drive that same Neo instance. The wire
contract is `../docs/PROTOCOL.md`.

From `tandem/gateway`:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run hash-password < /secure/password-file
bun run gen-secret
```

Set `TANDEM_PUBLIC_ORIGIN`, `TANDEM_PASSWORD_HASH`, and `TANDEM_AGENT_TOKEN` in the
process environment. Set `TANDEM_TOTP_SECRET` to enable TOTP. The hash-password
script reads stdin and removes one trailing line ending. The gen-secret script
prints a random 48-character agent token and a separate base32 TOTP secret and URI.
Keep their output private. No credentials are bundled or written by these scripts.

With Neo reachable on the same loopback network and the web viewer built:

```sh
TANDEM_PUBLIC_DIR=../web/dist TANDEM_BRAND_FILE=../branding/brand.json bun start
```

`bun dev` enables watch mode. Production requires HTTPS origins and an Argon2id
hash. For local HTTP development, set `TANDEM_ENV=development`, set
`TANDEM_PASSWORD` in the environment, and use a writable `TANDEM_DATA_DIR`.
`test/fixtures/public` provides a minimal public directory for gateway-only tests.
All remaining settings and defaults are in the protocol's environment table.

Build from the repository root:

```sh
docker build -f tandem/gateway/Dockerfile -t tandem-gateway:local-test tandem
```

The image builds the current web viewer and its shared branding, then runs the
gateway as uid/gid 10001. Its default writable data directory is `/var/lib/tandem`;
a host bind mount must allow that uid to write. It declares no volumes. BuildKit
uses `Dockerfile.dockerignore` to exclude dependencies and desktop releases from
the build context; Docker's legacy builder may send a much larger context.

Run the gateway in Neo's network namespace (`--network container:<neo>` or
Compose's `network_mode: service:neo`). Publish only the gateway's port through
the deployment configuration; the browser ports stay internal.

## Tests

`bun test` runs unit and HTTP integration tests with generated throwaway auth
credentials and fake upstream servers. `bun run e2e` runs against a real stack
using `TANDEM_URL`, `TANDEM_ORIGIN`, `TANDEM_TEST_PASSWORD`, `TANDEM_AGENT_TOKEN`,
and optional `TANDEM_TEST_TOTP_SECRET`. Configure a short agent hold on the test
stack: the timeout check intentionally waits for the real pause timeout.

```sh
bash test/run-live.sh
TANDEM_TEST_GATEWAY_IMAGE=tandem-gateway:local-test bash test/run-live.sh
```

The helper creates uniquely named Neo, gateway and test containers, uses the
pinned image from `../deploy/neo-image.env`, generates passwords/tokens/TOTP
secrets in memory, enables Neo's full browser UI, and removes its containers and
test profile on exit. Set `TANDEM_TEST_NEO_CONTAINER` to choose the engine container
name; an existing container is never replaced. Source
mode runs the gateway in `oven/bun:1` with the placeholder public directory. Image
mode additionally checks uid, file permissions, built public assets and Docker's
HEALTHCHECK. It never uses or removes `tandem-probe-neo`.

## Transport and runtime notes

Individual MCP responses stream through byte-for-byte, with a bounded side copy
for tool annotations and agent activity. Neo's pinned MCP server rejects JSON-RPC
batch envelopes with HTTP 415. Therefore gateway batches are split into individual
upstream requests, independently gated, and collected into an `application/json`
array. Notifications have no response element. This is the batch transport
adaptation to the protocol's general SSE pass-through rule.

Neo briefly rejects page commands with `Not attached to an active page` during
renderer swaps. Only that pre-dispatch rejection is retried, with the human
control/session guard checked again before every attempt. Other command failures
are not retried. Tabs already present at discovery have `opener:"unknown"`;
subsequent creations retain agent/human provenance across CDP reconnects.
`activeTargetId` is best effort as specified by the protocol.

Authenticated desktop sockets stay open across control changes. A streaming RFB
3.8 filter gates complete keyboard, pointer and clipboard messages against current
control, including messages split across WebSocket frames. Partial messages are
bounded at 1 MiB, with a 10 MiB total exception for signed-length clipboard
messages; individual WebSocket payloads are capped at 10 MiB. Unknown RFB types
close with 4403 and log only their type and rejection reason. Desktop sockets count
as session connections for the control disconnect grace period.

Viewer `follow` is per socket. Any enabled viewer makes agent activity activate
the latest tab at most once per 500 ms. Human takeover, disabling the last follower,
session revocation and disconnection cancel pending follow work. The live desktop
check uses a separate CDP probe inside the test network to observe DOM input events
and requires `TANDEM_TEST_CDP_URL` only when CDP is not at `http://127.0.0.1:9110`.

The gateway explicitly terminates its sockets at shutdown. Bun 1.3 can leave the
promise from `server.stop(true)` pending after a completed WebSocket handshake;
shutdown calls stop without waiting on that accounting promise, then closes its
stores. No GUI or independent browser session is started by the gateway.

## neko WebRTC

Set `TANDEM_NEKO_URL` to neko's internal HTTP origin to enable WebRTC, together
with `TANDEM_NEKO_USER_PASSWORD` and `TANDEM_NEKO_API_TOKEN`. Both credentials are
required when the URL is set. With no URL the gateway stays VNC-only. `/api/me`
reports `webrtc` from a fresh health probe; `/api/health` includes `neko` without
changing the CDP/MCP-derived `ok` value.

The viewer needs its Tandem cookie for `/neko/*`. WebSocket upgrades require an
allowed Origin; HTTP GETs may omit Origin, like other viewer GETs, and reject an
explicitly foreign Origin. Only
`GET /neko/api/whoami` and the `GET /neko/api/ws` WebSocket upgrade are exposed:
these are the pinned core client's authentication/reconnect and signalling
routes. Each viewer's neko token stays in memory and is injected as a Bearer
header, including on the upstream WebSocket. Client query parameters, cookies,
authorization and upstream credential headers are never forwarded. As with other
viewer routes, a client Authorization header is rejected, even alongside a cookie.
All neko management routes and HTTP writes return 404 for authenticated viewers.

Room settings and host mapping are applied through the admin API. A failed neko
operation leaves Tandem's coordinator, VNC, Follow and MCP available. Reconnects
restore room locks and host mapping; deleted/expired viewer sessions are removed
from neko, with failed deletions retried on recovery. The `screen` viewer command
accepts even integer device-pixel sizes from 320×240 through 3840×2400 and applies
the last request after 500 ms through `POST /api/room/screen` at 25 Hz.

`TANDEM_TEST_NEKO=1 bun run e2e` adds live neko health, signalling, host mapping and
real display resize checks. It must run inside the engine network namespace.
`TANDEM_TEST_NEKO_URL` and `TANDEM_TEST_NEKO_API_TOKEN` override the CI-only defaults;
the defaults use the throwaway credentials in `compose.ci.yaml`. See
`NEKO-VALIDATION.md` for the exact validation commands and limitations.
