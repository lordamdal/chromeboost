#!/usr/bin/env bash
# Render tools/og/card.html to apps/website/og.png at exactly 1200x630.
#
# Headless Chrome rather than an SVG rasteriser: the card leans on the same
# feTurbulence/feDisplacementMap gouache filters as the site, and neither
# rsvg-convert nor a working cairosvg is available here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/apps/website/og.png"

[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --headless=new is load-bearing. Bare --headless hangs indefinitely on this
# Chrome build: it writes the PNG but never exits, because the GoogleUpdater
# children it spawns keep the process group alive. The watchdog below reaps it
# either way, so a future Chrome regression costs 40s, not the whole run.
"$CHROME" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --hide-scrollbars \
  --force-device-scale-factor=1 \
  --user-data-dir="$TMP/profile" \
  --virtual-time-budget=2500 \
  --window-size=1200,630 \
  --screenshot="$TMP/og.png" \
  "file://$ROOT/tools/og/card.html" >/dev/null 2>&1 &
CHROME_PID=$!
( sleep 40; kill -9 "$CHROME_PID" 2>/dev/null ) & WATCHDOG=$!
wait "$CHROME_PID" 2>/dev/null || true
kill "$WATCHDOG" 2>/dev/null || true

[ -s "$TMP/og.png" ] || { echo "Chrome produced no screenshot" >&2; exit 1; }

cp "$TMP/og.png" "$OUT"
W=$(sips -g pixelWidth  "$OUT" | tail -1 | tr -dc 0-9)
H=$(sips -g pixelHeight "$OUT" | tail -1 | tr -dc 0-9)
[ "$W" = "1200" ] && [ "$H" = "630" ] || { echo "expected 1200x630, got ${W}x${H}" >&2; exit 1; }
echo "wrote $OUT (${W}x${H}, $(du -h "$OUT" | cut -f1))"
