#!/usr/bin/env bash
# Frame-logic tests. Local only, like tests/antibot — jsdom is not a repo
# dependency, so the runner installs it on demand and leaves package.json
# alone. npm hoists it to the repo root node_modules, which is where node
# resolves it from, so the presence check has to ask node rather than stat a
# directory next to this script.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

if ! node -e "require.resolve('jsdom')" >/dev/null 2>&1; then
  echo "installing jsdom (test-only, not saved to package.json)..."
  npm install jsdom --no-save --silent
fi

"$ROOT/node_modules/.bin/esbuild" entry.ts \
  --bundle --format=esm --platform=neutral \
  --outfile=.bundle.mjs --log-level=warning

node frames.test.mjs
