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
secrets in memory, and removes its containers and test profile on exit. Source
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

The gateway explicitly terminates its sockets at shutdown. Bun 1.3 can leave the
promise from `server.stop(true)` pending after a completed WebSocket handshake;
shutdown calls stop without waiting on that accounting promise, then closes its
stores. No GUI or independent browser session is started by the gateway.
