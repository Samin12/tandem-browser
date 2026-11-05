# tandem/

Everything that makes this fork Tandem Browser. Upstream BrowserOS lives in the
rest of the repo and is never edited here.

| Folder | What |
|---|---|
| `gateway/` | Server between the world and the browser engine: auth, live view, input, control, MCP proxy |
| `web/` | Browser-like viewer served by the gateway |
| `desktop/` | Mac / Windows / Linux app that opens your Tandem server |
| `deploy/` | Docker Compose, Caddy, installer, backups, `tandem` CLI, pinned engine image |
| `scripts/` | Upstream sync, engine image bump, contract checks |
| `branding/` | Name, colors, logo (`brand.json`) |
| `hermes/` | Hermes skill |
| `docs/` | Architecture, protocol, security, Hermes, trading |

Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), then
[`deploy/README.md`](deploy/README.md) to install.
