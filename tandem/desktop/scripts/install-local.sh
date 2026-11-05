#!/bin/bash
# Build the desktop app for this Mac and install it into ~/Applications.
# The previous copy is moved to ~/.tandem/app-backups/<time>/; nothing is deleted.
# Usage: scripts/install-local.sh [--no-build] [--no-launch]
set -euo pipefail
[ "$(uname)" = Darwin ] || { echo "install-local.sh is for macOS" >&2; exit 1; }
cd "$(dirname "$0")/.."
build=1 launch=1
for arg in "$@"; do
  case "$arg" in --no-build) build=0 ;; --no-launch) launch=0 ;; *) echo "unknown option: $arg" >&2; exit 2 ;; esac
done
name=$(bun -e 'console.log(require("../branding/brand.json").productName)')
arch=$(uname -m); [ "$arch" = x86_64 ] && out=release/mac || out="release/mac-$arch"
app="$out/$name.app" dest="$HOME/Applications/$name.app"
exe="$dest/Contents/MacOS/$name"

if [ "$build" = 1 ]; then
  rm -rf "$out"
  # ELECTRON_RUN_AS_NODE (set by some agent shells) makes Electron tools run as plain Node.
  env -u ELECTRON_RUN_AS_NODE CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}" bash -c \
    'bun run build && bun run icons && bunx electron-builder --config electron-builder.cjs --mac dir --'"$( [ "$arch" = x86_64 ] && echo x64 || echo "$arch" )"
fi
[ -d "$app" ] || { echo "no build at $app (run without --no-build)" >&2; exit 1; }
codesign --verify --deep --strict "$app"

# Quit the running app (SIGTERM is Electron's normal quit) before replacing it.
running() { pgrep -f "^$exe\$" >/dev/null; }
if running; then
  pkill -TERM -f "^$exe\$" || true
  for _ in $(seq 1 40); do running || break; sleep 0.25; done
  running && { echo "$name is still running; quit it and run again" >&2; exit 1; }
fi

mkdir -p "$HOME/Applications"
ditto "$app" "$dest.new"
if [ -d "$dest" ]; then
  backup="$HOME/.tandem/app-backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup" && mv "$dest" "$backup/"
  echo "previous app: $backup/$name.app"
fi
mv "$dest.new" "$dest"
# Re-register so the Dock and Spotlight use the new bundle.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$dest" || true
echo "installed $dest ($(defaults read "$dest/Contents/Info" CFBundleShortVersionString))"

if [ "$launch" = 1 ]; then
  env -u ELECTRON_RUN_AS_NODE open -a "$dest"
  for _ in $(seq 1 40); do pid=$(pgrep -f "^$exe\$" | head -1 || true); [ -n "$pid" ] && break; sleep 0.25; done
  [ -n "${pid:-}" ] || { echo "$name did not start" >&2; exit 1; }
  sleep 2
  # macOS starts apps paused and lets them run once the requester confirms the
  # launch. A shell outside the login session (an agent or SSH) never does, so the
  # copy stays paused, unknown to the Dock, and holds the single-instance lock that
  # would make the user's own launch quit. Remove it; the user opens the app.
  if [ "$(ps -o state= -p "$pid" | cut -c1)" = T ]; then
    kill -KILL "$pid"
    echo "installed; this shell can't launch apps. Open $name from Spotlight or the Dock."
    exit 0
  fi
  echo "running (pid $pid)"
fi
