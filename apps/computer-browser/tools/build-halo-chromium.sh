#!/bin/sh
# Builds the Halo agent browser (headless_shell) from the local Chromium checkout.
# Usage: tools/build-halo-chromium.sh [out-dir]   (default: out/Trial)
# Patches live in apps/computer-browser/chromium-patches/*.patch and are applied by `git am`
# on the `halo` branch of ~/chromium/src; export new ones with:
#   git -C ~/chromium/src format-patch -o <halo>/apps/computer-browser/chromium-patches <base>..halo
set -eu
SRC="${HALO_CHROMIUM_SRC:-$HOME/chromium/src}"
OUT="${1:-out/Trial}"
export PATH="$HOME/chromium/depot_tools:$PATH"
cd "$SRC"
autoninja -j "${HALO_BUILD_JOBS:-6}" -C "$OUT" headless_shell
echo "built: $SRC/$OUT/headless_shell"
echo "use:   HALO_CHROMIUM=$SRC/$OUT/headless_shell"
