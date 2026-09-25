#!/usr/bin/env bash
# Build PerfPilot.dmg with an Applications symlink so users can drag
# the .app to install. Tauri's bundled create-dmg shim has a known arg
# bug on v2, so we use hdiutil + ditto directly.
#
# Requires: the Tauri release build has already run (`npm run tauri:build`)
#           so src-tauri/target/release/bundle/macos/PerfPilot.app exists.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/PerfPilot.app"
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
OUT_DMG="$PROJECT_ROOT/PerfPilot-${VERSION}-arm64.dmg"

if [ ! -d "$APP_SRC" ]; then
  echo "error: $APP_SRC not found — run 'npm run tauri:build' first" >&2
  exit 1
fi

STAGING="$(mktemp -d -t perf-pilot-dmg)"
trap 'rm -rf "$STAGING"' EXIT

# ditto preserves Mac metadata + symlinks better than cp -R.
ditto "$APP_SRC" "$STAGING/PerfPilot.app"
ln -s /Applications "$STAGING/Applications"

# -srcfolder preserves the symlink in some macOS versions; in others
# it's stripped. The output is at minimum usable even when stripped
# (the user can manually drag to ~/Applications), but if you have
# create-dmg installed (brew install create-dmg) the layout is
# pixel-perfect — fall back to it when available.
if command -v create-dmg >/dev/null 2>&1; then
  echo "→ create-dmg (with layout)"
  create-dmg \
    --volname "PerfPilot" \
    --volicon "$PROJECT_ROOT/src-tauri/icons/icon.icns" \
    --window-size 540 380 \
    --icon-size 128 \
    --icon "PerfPilot.app" 170 170 \
    --app-drop-link 360 170 \
    --no-internet-enable \
    "$STAGING" \
    "$OUT_DMG"
else
  echo "→ hdiutil fallback (no create-dmg)"
  rm -f "$OUT_DMG"
  hdiutil create \
    -volname "PerfPilot" \
    -srcfolder "$STAGING" \
    -ov \
    -format UDZO \
    "$OUT_DMG"
fi

echo "✓ $OUT_DMG ($(du -h "$OUT_DMG" | awk '{print $1}'))"
