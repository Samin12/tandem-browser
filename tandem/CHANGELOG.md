# Tandem Browser changelog

Each entry separates **Imported upstream** (BrowserOS commits, with original PR
references), **Tandem changes**, **Compatibility** (risk, engine image pins and
contract checks), and **Breaking** (declared migration requirements). An absence
of declared breaking changes is not a guarantee of compatibility.

## 2026-11-05 — Agent speed and CDP clients

### Imported upstream

- No engine changes; the pinned Neo image is unchanged.

### Tandem changes

- Persist loopback quickack with a hardened `neo-net` helper in all deployments;
  give neko CPU weight 256 and pause invisible viewers after 15 seconds.
- Add token-authenticated CDP discovery and browser/page sockets for browser-use,
  Playwright, Puppeteer and chrome-devtools-mcp, sharing MCP's human control and
  agent activity state, with bounded queues, timeouts and redacted audit events.
- Document agent setup, supplied VPS performance measurements and URL secrets.

### Compatibility

- Gateway image now includes iproute2; only `neo-net` receives NET_ADMIN.
- `TANDEM_CDP` defaults to `on`; set `off` to disable agent CDP access.
- Disposable-engine CI also runs neko, CDP gating and MCP latency acceptance.

### Breaking

- None. Existing MCP clients and viewer authentication remain compatible.

## 2026-11-05 — Fork foundation

### Imported upstream

- Fork point: browseros-ai/BrowserOS `55664d0a` (AGPL-3.0).

### Tandem changes

- Begin the isolated Tandem gateway, web viewer, desktop client and deployment.

### Compatibility

- Engine image: `ghcr.io/browseros-ai/neo:0.52.1.2-ee2c294@sha256:dc004fe28e9a84050a98a84e9abca418e92a8b9056e8a02571741ce4af4d5856`.
- Neo ports: CDP 9110, MCP 9010, noVNC 6080; only gateway 8790 may be published on loopback.

### Breaking

- Initial fork; no prior Tandem deployment to migrate.
