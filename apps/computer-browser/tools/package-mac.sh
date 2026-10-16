#!/bin/sh
# Builds a macOS .app into release/. The main process locates the Python
# approver relative to its own file (../../..), so the stage mirrors the repo:
# apps/computer-browser + halo/ + experiments/e007 under one app root.
set -eu
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STAGE="$ROOT/release/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/apps/computer-browser" "$STAGE/experiments"

npm --prefix "$ROOT/frontend" run build
for d in main preload renderer shared approver assets contracts runtime-src; do
  cp -R "$ROOT/apps/computer-browser/$d" "$STAGE/apps/computer-browser/$d"
done
cp "$ROOT/apps/computer-browser/package.json" "$ROOT/apps/computer-browser/package-lock.json" "$STAGE/apps/computer-browser/"
# Beta builds expire: HALO_BUILD_EXPIRES=2027-02-28 (or +30 for thirty days from now) writes build-info.json.
if [ -n "${HALO_BUILD_EXPIRES:-}" ]; then
  node "$ROOT/apps/computer-browser/tools/set-build-expiry.js" "$STAGE/apps/computer-browser/build-info.json" "$HALO_BUILD_EXPIRES"
fi
cp -R "$ROOT/halo" "$STAGE/halo"
cp "$ROOT/experiments/__init__.py" "$STAGE/experiments/"
cp -R "$ROOT/experiments/e007_dual_agent_provenance_gate" "$STAGE/experiments/"
find "$STAGE" -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
(cd "$STAGE/apps/computer-browser" && npm ci --omit=dev --ignore-scripts)
cat > "$STAGE/package.json" <<J
{ "name": "halo-computer-browser", "version": "0.1.0-beta", "main": "apps/computer-browser/main/index.js" }
J
ELECTRON_VERSION="$(node -p "require('$ROOT/apps/computer-browser/node_modules/electron/package.json').version")"
npx --yes @electron/packager "$STAGE" Halo --platform=darwin --arch=arm64 \
  --electron-version="$ELECTRON_VERSION" --out="$ROOT/release" --overwrite --no-asar \
  --icon="$ROOT/apps/computer-browser/assets/icon.icns" \
  --extend-info="$ROOT/apps/computer-browser/tools/mac-info-extra.plist" 2>&1 | tail -5
