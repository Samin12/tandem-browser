# Tandem Browser changelog

Each entry separates **Imported upstream** (BrowserOS commits, with original PR
references), **Tandem changes**, **Compatibility** (risk, engine image pins and
contract checks), and **Breaking** (declared migration requirements). An absence
of declared breaking changes is not a guarantee of compatibility.

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
