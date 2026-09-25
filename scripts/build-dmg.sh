#!/usr/bin/env bash
# Build PerfPilot.dmg with an Applications symlink so users can drag
# the .app to install. Tauri's bundled create-dmg shim has a known arg
# bug on v2, so we use hdiutil + ditto directly.
#
# Requires: the Tauri release build has already run.
#
# Args:
#   $1  Optional rustc target triple (e.g. aarch64-apple-darwin). When
#       passed, looks for the .app under
#       src-tauri/target/<triple>/release/bundle/macos/PerfPilot.app —
#       which is where `tauri build --target <triple>` puts it. Omit
#       for a default-arch build at src-tauri/target/release/...

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_TRIPLE="${1:-}"
if [ -n "$TARGET_TRIPLE" ]; then
  APP_SRC="$PROJECT_ROOT/src-tauri/target/${TARGET_TRIPLE}/release/bundle/macos/PerfPilot.app"
else
  APP_SRC="$PROJECT_ROOT/src-tauri/target/release/bundle/macos/PerfPilot.app"
fi
VERSION="$(node -p "require('$PROJECT_ROOT/package.json').version")"
OUT_DMG="$PROJECT_ROOT/PerfPilot-${VERSION}-arm64.dmg"

if [ ! -d "$APP_SRC" ]; then
  echo "error: $APP_SRC not found — run 'npm run tauri:build' (with --target $TARGET_TRIPLE if applicable) first" >&2
  exit 1
fi

# Portable mktemp across macOS / Linux / Windows Git Bash — same fix as
# scripts/fetch-k6.sh: avoid `-t PREFIX` (Windows rejects prefixes without
# X's) by creating a fresh directory and naming inside it.
STAGING_DIR="$(mktemp -d)"
STAGING="$STAGING_DIR/staging"
mkdir -p "$STAGING"
trap 'rm -rf "$STAGING_DIR"' EXIT

# ditto preserves Mac metadata + symlinks better than cp -R.
ditto "$APP_SRC" "$STAGING/PerfPilot.app"

# create-dmg creates the Applications drop-link itself via
# --app-drop-link; hdiutil has no such option and needs us to seed the
# symlink. So we only build the symlink on the fallback path.
if command -v create-dmg >/dev/null 2>&1; then
  echo "→ create-dmg (with layout)"
  # create-dmg positional args: <output.dmg> <source-folder>
  create-dmg \
    --volname "PerfPilot" \
    --volicon "$PROJECT_ROOT/src-tauri/icons/icon.icns" \
    --window-size 540 380 \
    --icon-size 128 \
    --icon "PerfPilot.app" 170 170 \
    --app-drop-link 360 170 \
    --no-internet-enable \
    "$OUT_DMG" \
    "$STAGING"
else
  echo "→ hdiutil fallback (no create-dmg)"
  ln -s /Applications "$STAGING/Applications"
  rm -f "$OUT_DMG"
  hdiutil create \
    -volname "PerfPilot" \
    -srcfolder "$STAGING" \
    -ov \
    -format UDZO \
    "$OUT_DMG"
fi

echo "✓ $OUT_DMG ($(du -h "$OUT_DMG" | awk '{print $1}'))"
