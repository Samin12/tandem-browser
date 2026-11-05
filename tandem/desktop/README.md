# Desktop app

Thin Electron shell for the gateway's web viewer. Requires Bun 1.3+; Electron and
the other build tools are pinned in `package.json` / `bun.lock`.

From `tandem/desktop`:

```sh
bun install --frozen-lockfile
bun test
bun run build
bun run start
```

`start` clears `ELECTRON_RUN_AS_NODE` before launching Electron. It opens the local
connection settings on first run. Enter an HTTPS server origin, or an HTTP origin
on `localhost` / `127.0.0.1`. Paths, credentials, query strings and fragments are
refused. Checking and saving both call `GET /api/health`; saving requires `ok:true`
and Boolean `cdp` / `mcp` fields. Their connection state is displayed separately.

The server origin and normal window bounds are stored in `config.json` under
Electron's `app.getPath('userData')` (normally `~/Library/Application Support/Tandem
Browser` on macOS). Login cookies live in the persistent `persist:tandem` session.
Use **Change Server…** in the application / File menu to reconnect elsewhere.

## Packages

```sh
bun run icons       # branding SVG → build/icon.png, 1024 px
bun run dist        # native platform / architecture, suitable for CI
bun run dist:mac    # ad-hoc signed arm64 + x64 DMG and ZIP
bun run dist:win    # x64 NSIS installer; run on Windows
bun run dist:linux  # x64 AppImage + deb; run on Linux
```

All artifacts go to `release/`. Packaging reads `../branding/brand.json` and
`../branding/logo.svg`; build copies branding and the repository's AGPL license
into `dist/`, so installed apps do not depend on the checkout. Electron-builder
derives platform icons from the PNG. Runtime dependencies are Electron built-ins.

Install or update the app on this Mac (builds, verifies the signature, moves the
previous copy to `~/.tandem/app-backups/`, installs into `~/Applications`, opens it):

```sh
scripts/install-local.sh            # --no-build reuses release/, --no-launch skips opening
```

Without `CSC_LINK` or `CSC_NAME`, macOS builds are signed ad hoc (whole bundle, no
hardened runtime): a binary-only signature leaves macOS holding the app paused at
launch. For Developer ID signing, use electron-builder's `CSC_LINK` + `CSC_KEY_PASSWORD`,
or `CSC_NAME` for a local identity; hardened runtime and JIT entitlements then apply. To
enable notarization also set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. No credentials belong in this repository. These signing and
notarization paths need verification with release credentials. Windows signing
can use electron-builder's standard signing environment variables.

## Hidden packaged smoke test

After `dist:mac`, on the build Mac:

```sh
bun run smoke:packaged
# Or choose another packaged binary (for example, x64 under Rosetta):
bun run smoke:packaged 'release/mac/Tandem Browser.app/Contents/MacOS/Tandem Browser'
```

The runner starts two temporary local Bun servers, clears `ELECTRON_RUN_AS_NODE`,
launches the packaged binary with `TANDEM_SMOKE=1`, and uses isolated user data
under `release/`. Every app window has `show:false`. No keystrokes are sent and
the host clipboard is untouched. The app prints a JSON result and exits; the
runner also saves it as `release/smoke-result.json`.

Checks cover the exact bridge surface, absent Node access, callback unsubscribe,
a command sent through the actual native menu handler, document-title updates,
permission policy, denied and permitted desktop popups, shared sessions, local
settings and health checks, cross-origin navigation / absent bridge on a foreign
origin, and the offline page with Retry. All created windows must stay hidden.

For a custom fixture, launch with `env -u ELECTRON_RUN_AS_NODE TANDEM_SMOKE=1
TANDEM_SMOKE_URL=http://127.0.0.1:PORT '<binary>'`. The root page must register
`window.tandemDesktop.onCommand`, set its title to `smoke:ready`, and change it to
`smoke:command:new-tab` on that command. `/api/health` must return
`{ok:true,cdp:true,mcp:true,version:'test'}`; `/desktop/vnc.html` must serve a page.
`TANDEM_SMOKE_FOREIGN_URL` optionally enables foreign-origin checks. The fixture
must also be ready again after reloading `/`. `--smoke` and `--smoke-url=URL` are
equivalent to the main smoke environment flags.

## Bridge and shortcuts

The remote preload exposes exactly the `tandemDesktop` object in
`../docs/PROTOCOL.md`. Clipboard reads are synchronous as required by that
contract. Both clipboard IPC handlers recheck the top-level sender's origin;
clipboard text is never logged. Local pages use a separate, restricted
`tandemLocal` bridge. No local-page bridge is present on remote pages.

Native Edit items send `edit-*` commands to the viewer. Local settings fields
instead use Electron's editing methods. Next / previous tab supports Ctrl+Tab
and Ctrl+Shift+Tab, plus Cmd+Shift+] / [ on macOS; back / forward additionally
supports Alt+Left / Right on Windows and Linux. Close Window is CmdOrCtrl+Shift+W.
Hand Back to the agent is CmdOrCtrl+Shift+H. Reload Page sends `reload`; Reload App
(CmdOrCtrl+Shift+R) reloads the shell. Packaged devtools require
`TANDEM_DEVTOOLS=1`.

Protocol deviations: none. The remote browser, authentication UI, control
semantics, and remote editing behavior belong to the web viewer / gateway.
Live gateway integration, Windows / Linux packaging, and signed / notarized
releases require their respective environments.
