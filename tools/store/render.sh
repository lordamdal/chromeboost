#!/usr/bin/env bash
# Render every tools/store/NN-*.html to dist/store/NN-*.png at exactly
# 1280x800, the size the Chrome Web Store wants for listing screenshots.
#
# Same headless-Chrome approach as tools/og/render.sh, and the same
# --headless=new caveat: bare --headless writes the PNG but never exits on
# this build, so the watchdog is load-bearing rather than defensive.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUTDIR="$ROOT/dist/store"
W=1280; H=800

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }
mkdir -p "$OUTDIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

shopt -s nullglob
shots=("$ROOT"/tools/store/[0-9][0-9]-*.html)
[ ${#shots[@]} -gt 0 ] || { echo "no shots found in tools/store/" >&2; exit 1; }

for src in "${shots[@]}"; do
  name="$(basename "$src" .html)"
  out="$OUTDIR/$name.png"

  "$CHROME" \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --hide-scrollbars \
    --force-device-scale-factor=1 \
    --user-data-dir="$TMP/profile-$name" \
    --virtual-time-budget=2500 \
    --window-size=$W,$H \
    --screenshot="$TMP/$name.png" \
    "file://$src" >/dev/null 2>&1 &
  pid=$!
  ( sleep 40; kill -9 "$pid" 2>/dev/null ) & watchdog=$!
  wait "$pid" 2>/dev/null || true
  kill "$watchdog" 2>/dev/null || true

  [ -s "$TMP/$name.png" ] || { echo "Chrome produced no screenshot for $name" >&2; exit 1; }
  cp "$TMP/$name.png" "$out"

  gw=$(sips -g pixelWidth  "$out" | tail -1 | tr -dc 0-9)
  gh=$(sips -g pixelHeight "$out" | tail -1 | tr -dc 0-9)
  [ "$gw" = "$W" ] && [ "$gh" = "$H" ] \
    || { echo "$name: expected ${W}x${H}, got ${gw}x${gh}" >&2; exit 1; }
  echo "wrote $out (${gw}x${gh}, $(du -h "$out" | cut -f1))"
done
