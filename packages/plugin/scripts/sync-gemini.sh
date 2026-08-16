#!/usr/bin/env bash
# Derive GEMINI.md (the Gemini CLI extension's context file) from the canonical
# Claude skill.
#
# skills/chromeboost/SKILL.md is hand-maintained and is the single source of
# agent guidance. Gemini loads a plain markdown context file rather than a
# skill with frontmatter, so this strips the frontmatter and swaps the host
# name. Never edit GEMINI.md directly.
#
# Run after any change to SKILL.md, alongside sync-skill.sh for the Codex copy.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SOURCE="$REPO_ROOT/packages/plugin/skills/chromeboost/SKILL.md"
DEST="$REPO_ROOT/GEMINI.md"

if [[ ! -f "$SOURCE" ]]; then
  echo "error: $SOURCE not found" >&2
  exit 1
fi

python3 - "$SOURCE" "$DEST" <<'PY'
import sys

source, dest = sys.argv[1], sys.argv[2]
src = open(source).read()

# Gemini loads the file as plain context, so the skill's YAML frontmatter goes.
body = src.split('---', 2)[2].lstrip() if src.startswith('---') else src

# Order matters: rewrite the compound host name before the bare one.
body = (body
        .replace('Claude Code', 'Gemini CLI')
        .replace('ChromeBoost — Claude Instructions', 'ChromeBoost — Gemini Instructions')
        .replace('Claude is the LLM', 'Gemini is the LLM')
        .replace('Claude', 'Gemini'))

# The derived body opens with its own H1; drop it so the header below is the only one.
lines = body.split('\n')
if lines and lines[0].startswith('# '):
    lines = lines[1:]
body = '\n'.join(lines).lstrip()

header = """# ChromeBoost — Gemini Instructions

<!--
  Auto-derived from packages/plugin/skills/chromeboost/SKILL.md by
  packages/plugin/scripts/sync-gemini.sh. Do not edit by hand: edit the skill
  and re-run the script, or your changes will be overwritten.
-->

"""
open(dest, 'w').write(header + body)
print(f"  wrote {dest} ({len(header + body)} bytes)")
PY

echo "✓ Synced GEMINI.md from $SOURCE"
