# Gateway validation — 2026-11-05

All gateway source, tests, scripts, lockfile and documentation are under
`tandem/gateway/`. No commits, pushes, Git configuration or remote changes were
made. Branch: `tandem/foundation`.

## Final checks

Working directory: `/Users/saminyasar/Developer/tandem-browser/tandem/gateway`.

| Exact command | Result |
| --- | --- |
| `bun run typecheck` | exit 0; no TypeScript errors |
| `bun test` | 55 pass, 0 fail; 213 expectations; 6 test files; local Bun 1.3.14 |
| `bash test/run-live.sh` | 22 pass, 0 fail against the pinned Neo engine, gateway running in `oven/bun:1` with a placeholder public directory |
| `TANDEM_TEST_GATEWAY_IMAGE=tandem-gateway:local-test bash test/run-live.sh` | 22 pass, 0 fail; image runtime/permissions/assets check passed; Docker HEALTHCHECK reached healthy |

From `/Users/saminyasar/Developer/tandem-browser`, the requested direct build
command succeeded:

```sh
docker build -f tandem/gateway/Dockerfile -t tandem-gateway:local-test tandem
```

The final image was rebuilt with this exact command to avoid sending unrelated
large desktop releases through this machine's legacy Docker builder. The tar
still uses `tandem/` as its path root and includes web, gateway and branding:

```sh
COPYFILE_DISABLE=1 tar --no-xattrs -C tandem --exclude='node_modules' --exclude='dist' --exclude='release' -cf - web gateway branding | docker build -f gateway/Dockerfile -t tandem-gateway:local-test -
```

It completed all 24 Dockerfile steps. The image includes the built web viewer,
shared brand JSON and favicon; the runtime checks confirm uid 10001, a writable
`/var/lib/tandem`, 0600 sessions/audit files and public built assets. No volumes are
declared. The final image's short ID is `2cc5756adf9a`.

Engine tested:

```text
ghcr.io/browseros-ai/neo:0.52.1.2-ee2c294@sha256:dc004fe28e9a84050a98a84e9abca418e92a8b9056e8a02571741ce4af4d5856
```

## Live coverage

The 22 live checks cover auth and CSRF boundaries, wrong Origins, cookie/bearer
separation, TOTP login, WebSocket welcome and page tabs, input refusal under agent
control, human takeover, human tab provenance, valid JPEG binary frames, fresh
background-tab frames without activation, mouse/key/text dispatch, navigation and
history, noVNC HTTP files and a bidirectional RFB handshake, desktop socket closure
on control release, MCP initialization and annotations, read-only calls under
manual control, held calls released to the agent, the exact pause-timeout result
and JSON-RPC id, agent-created tab activity/provenance, audit redaction, tab cleanup
and logout closing the viewer with 4401.

Unit/integration tests additionally cover session idle/absolute expiration,
concurrent rate limiting, URL rules, typed input validation, raw protocol
violations, control release during an outstanding input attachment, persisted
control and disconnect grace periods, CDP reconnect, title-only activity changes,
JS dialog events, annotation refresh, fake-upstream MCP batches and streaming,
frame encoding, refcounting, backpressure and screenshot fallback.

## Protocol adaptation and limits

Neo's pinned server was directly probed with a harmless batch of two `ping`
requests after MCP initialization. It returned HTTP 415 with a JSON-RPC envelope
deserialization error. Gateway batches therefore fan out into individual upstream
requests, are gated independently, and return an `application/json` array. This is
the sole transport adaptation to the protocol's general SSE pass-through wording;
individual responses retain their original SSE bytes and relevant headers.

No protocol file was changed. The active foreground target remains best effort,
as the contract specifies. Live desktop validation stops at the noVNC files and
RFB stream; no GUI windows, native popup interaction or keystrokes on Samin's
desktop were used.

All containers created for this implementation, including the manually started
`tandem-dev-neo` and the failed build's intermediate container, were removed.
`tandem-probe-neo` was never used or modified. Uniquely named temporary test
profiles were removed as well.
