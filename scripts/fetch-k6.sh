#!/usr/bin/env bash
# Fetch the k6 binary matching the host target triple and drop it where
# Tauri's `bundle.externalBin` expects it: src-tauri/binaries/k6-<triple>.
#
# Why a script: the binary is ~60 MB and platform-specific. Keeping it out
# of git and fetching on demand keeps the repo lean and lets each platform
# pick up the right asset.
#
# Usage:
#   scripts/fetch-k6.sh                # latest release
#   K6_VERSION=v1.0.0 scripts/fetch-k6.sh
#
# Requires: curl, unzip, rustc (for the target triple).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$(rustc -vV | sed -n 's|host: ||p')"
VERSION="${K6_VERSION:-v2.3.0}"
OUT_DIR="$PROJECT_ROOT/src-tauri/binaries"

mkdir -p "$OUT_DIR"

# GitHub asset naming: k6-<version>-<os>-<arch>.zip where os/arch are
# k6's own conventions, not Rust's. Map the triple once. Windows assets
# carry an `.exe` suffix both inside the zip and on the on-disk sidecar.
case "$TARGET" in
  aarch64-apple-darwin)        ASSET_OS="macos";   ASSET_ARCH="arm64"; EXE_EXT="" ;;
  x86_64-apple-darwin)         ASSET_OS="macos";   ASSET_ARCH="amd64"; EXE_EXT="" ;;
  x86_64-unknown-linux-gnu)    ASSET_OS="linux";   ASSET_ARCH="amd64"; EXE_EXT="" ;;
  aarch64-unknown-linux-gnu)   ASSET_OS="linux";   ASSET_ARCH="arm64"; EXE_EXT="" ;;
  x86_64-pc-windows-msvc)      ASSET_OS="windows"; ASSET_ARCH="amd64"; EXE_EXT=".exe" ;;
  *) echo "error: unsupported target $TARGET" >&2; exit 1 ;;
esac

OUT="$OUT_DIR/k6-${TARGET}${EXE_EXT}"
URL="https://github.com/grafana/k6/releases/download/${VERSION}/k6-${VERSION}-${ASSET_OS}-${ASSET_ARCH}.zip"
# `mktemp -d` (a temp *directory*) avoids the GNU-vs-Windows mktemp template
# mismatch we hit on `windows-latest` — Windows rejects `-t k6-fetch` because
# the prefix has no X's, while GNU accepts it. Building the zip path inside
# a fresh dir sidesteps both.
TMP_DIR="$(mktemp -d)"
TMP="$TMP_DIR/k6-fetch.zip"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "→ fetching $URL"
curl -sL --fail "$URL" -o "$TMP" || {
  echo "error: download failed — check VERSION ($VERSION) and target ($TARGET)" >&2
  exit 1
}

# The zip nests the binary under k6-<version>-<os>-<arch>/k6[.exe] — extract
# straight into the on-disk sidecar path so the filename matches Tauri's
# `<bin-name>-<target-triple>[.exe]` convention.
unzip -p "$TMP" "k6-${VERSION}-${ASSET_OS}-${ASSET_ARCH}/k6${EXE_EXT}" > "$OUT"
chmod +x "$OUT" 2>/dev/null || true

echo "→ wrote $OUT"
if [ -z "$EXE_EXT" ]; then
  "$OUT" version
else
  echo "    (Windows binary — skipping version probe on this host)"
fi