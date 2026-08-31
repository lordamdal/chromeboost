# ChromeBoost — repo-developer guide

This file is for developers working ON chromeboost. The usage reference for
agents (Claude Code, Codex, etc.) lives in
`packages/plugin/skills/chromeboost/` (and `skills-codex/chromeboost/` for
the Codex variant). When in doubt, the canonical user-facing docs are in
the skill, not here.

## What chromeboost is

ChromeBoost is a Chrome extension + MCP server pair that lets coding
agents drive the user's real Chrome browser. The extension attaches via
CDP; the MCP server exposes 35 tools (`click_element`, `fill_input`,
`type_text`, `get_page_text`, `hover`, `drag`, `probe_point`, `hud`, etc.)
over the standard Model Context Protocol. Agents call those tools; the extension performs the operations
in the user's logged-in Chrome window.

The core differentiator is the click + keystroke pipeline: a humanlike
CDP bezier sequence with `pointerType: "mouse"` (firing PointerEvent
isPrimary=true alongside MouseEvent), settle-hover micro-tremor,
post-click jitter, and isTrusted=true keystrokes. This is what defeats
anti-bot checks on Reddit, X / Twitter, and similar isTrusted-strict
React UIs.

ChromeBoost adds two things on top of that inherited pipeline:

**Occlusion-aware cursor control.** Clicks hit-test before firing
(`content/hittest.ts`) instead of aiming at an element's geometric centre
and hoping nothing is on top. Covered targets are detected and reported;
covering layers are temporarily neutralised with `pointer-events: none`
so the same real CDP click reaches the target, then restored exactly.
`hover` and `drag` cover the UI that is not click-shaped at all.

**A HUD the user owns.** The on-page status panel (`content/hud.ts`) is
draggable, collapsible, dismissible, and persists its position — replacing
a fixed, `pointer-events: none` badge welded to the top-right corner.

## Repository layout

```
packages/
  extension/                # Chrome MV3 extension (TypeScript)
    src/
      background.ts         # MCP message dispatcher, CDP helpers, ~3700 lines
      content/              # Content-script handlers (shadow-piercing DOM ops)
        hittest.ts          # Occlusion-aware hit testing + overlay piercing
        hud.ts              # Draggable / hideable on-page HUD (closed shadow root)
      offscreen.ts          # Persistent WebSocket connection to MCP server
      popup/                # Browser-action popup UI
      page-shims.ts         # MAIN-world page shims (focus, WebRTC, etc.)
    build.mjs               # esbuild
    pack.mjs                # Zip the dist/ for Chrome Web Store
    manifest.json
  mcp-server/               # MCP server bundled to packages/plugin/server/
    src/
      index.ts              # Tool registration entry
      ws-bridge.ts          # WebSocket server (extension <-> MCP)
      tools/                # Tool definitions per family
        cursor.ts           # hover, drag, probe_point, hud
      types.ts              # Message types between MCP and extension
    package.json            # Published to npm as "chromeboost"
  plugin/                   # Claude Code / Codex plugin manifest + skill
    .claude-plugin/
      plugin.json
    skills/chromeboost/
      SKILL.md              # User-facing routing + common patterns
      references/           # Topic-specific deep references
    skills-codex/chromeboost/
      SKILL.md              # Codex variant
      references/           # Same references, copied
    server/
      chromeboost.mjs        # Bundled MCP server (esbuild output)
    scripts/
      build-server.sh       # Bundle script
```

## Development commands

**Build:**
```
cd packages/extension && node build.mjs    # extension → dist/
cd packages/extension && node pack.mjs     # dist/ → chromeboost-<version>.zip
bash packages/plugin/scripts/build-server.sh  # MCP server → packages/plugin/server/chromeboost.mjs
```

**Type-check:**
```
cd packages/extension && npx tsc --noEmit
cd packages/mcp-server && npx tsc --noEmit
```
Extension has some pre-existing TS errors in `page-shims.ts` and
`content/find.ts` that are not load-bearing (the build uses esbuild,
not tsc). New errors should still be fixed.

**Test:**
```
# No unit tests today. Validation is manual + the anti-bot harness in
# tests/antibot/ (run locally; not in CI).
```

## Release process

1. Bump version in SEVEN files. Missing any one of them is not cosmetic:
   `.claude-plugin/marketplace.json` is what decides whether
   `/plugin update` refetches at all, so a bump that skips it leaves every
   installed copy on the old build with no way to notice.
   - `.claude-plugin/marketplace.json`        (gates `/plugin update`)
   - `packages/plugin/.claude-plugin/plugin.json`
   - `packages/plugin/.codex-plugin/plugin.json`
   - `gemini-extension.json`
   - `packages/extension/manifest.json`
   - `packages/extension/package.json`
   - `packages/mcp-server/package.json`

   Check with:
   ```
   grep -rn '"version"' --include='*.json' . | grep -v node_modules \
     | grep -v package-lock | grep -v '/dist/' | grep -v 'plugin/extension/'
   ```
2. Rebuild extension and bundle: `node packages/extension/build.mjs &&
   bash packages/plugin/scripts/build-server.sh && node
   packages/extension/pack.mjs`.
3. Commit. Use the form `feat: X.Y.Z, <subject>`.
4. `git push`. GitLab CI publishes the npm package automatically when
   the version in `packages/mcp-server/package.json` differs from the
   one on the npm registry.
5. Manually upload the new `chromeboost-X.Y.Z.zip` to the Chrome Web
   Store dev console (the listing is not auto-published yet).

The GitLab CI pipeline definition is in `.gitlab-ci.yml`.

## Tool-surface philosophy

- **Prefer flags on existing primitives over new composite tools.** The
  user pruned the surface from 38 → 26 tools in 0.9.4 to fix bloat.
- **Boot-time warnings beat helper tools.** Where a diagnostic could
  be a `_doctor` or `_status` tool, prefer attaching the warning to
  the existing tool whose response would carry the diagnostic context.
- **Every response field should be structured.** Avoid free-text
  diagnostics that the agent has to parse; expose machine-readable
  fields like `silently_rejected`, `phase_timed_out`, `scope_missed`,
  `hidden_count`, `last_text`, `initial_match_warning`,
  `selector_in_shadow`, `shadow_hosts_seen`, etc.

## Code conventions

- TypeScript throughout. Strict mode in `tsconfig.json`. ES modules.
- The extension is MV3. Background is a service worker. Offscreen holds
  the WebSocket because service workers terminate on idle.
- Indentation: 2 spaces (extension), tabs (none — esbuild handles
  formatting). Run `prettier` if reformatting.
- Comments explain WHY, not WHAT. Code is the WHAT.
- No em-dashes / en-dashes / hyphens-as-dashes in commit messages or
  user-facing prose.
- ASCII math only in chat output and tool descriptions (no LaTeX).

## Where to look when a tool misbehaves

- **Click fired but page didn't react** → first check whether it was
  occluded: the response carries `occluded` / names what was pierced, and
  `probe_point(x, y)` prints the painted stack. Logic lives in
  `content/hittest.ts`; the pierce/restore orchestration is in
  `background.ts` `case "click_element"` (search `pierceToken`). If it
  wasn't occluded, the anti-bot path is in the same handler (search
  `silently_rejected`, `phase_timed_out`).
- **HUD misplaced, missing, or eating clicks** → `content/hud.ts`. State
  persists in `chrome.storage.local` under `cbHudState`; Alt+Shift+B
  toggles it. The host container is `pointer-events: none` — only the
  panel itself is interactive.
- **Fill landed in wrong field** → `content/fill.ts` (`findInput`
  match ranks, ambiguity refusal).
- **Shadow DOM not pierced** → grep for `queryAllDeep` in
  `content/shadow.ts` to confirm the call site is using it.
- **Screenshot hangs** → `background.ts` `case "screenshot"`
  (fullscreen fast-fail in 0.9.13+).
- **WS bridge timeouts** → `mcp-server/src/ws-bridge.ts`. Progress
  heartbeats from `type_text` route via `chromeboost-progress`
  runtime messages through offscreen.

## Validation harness

`tests/antibot/` contains the platform-validation scaffolding. Live
tests run locally with `tests/antibot/run-local.sh` (not in CI — real
target sites are flaky and have rate limits). The README in that
directory documents the validation approach and the platforms covered.

## Telemetry / data handling

- No outbound telemetry. The MCP server only talks to the local
  WebSocket bridge. The extension only talks to the active page and
  the offscreen-held WebSocket.
- `redact.ts` strips high-confidence secret patterns (API keys, JWTs)
  from `get_page_text` output so Claude doesn't accidentally read keys
  into context. Use `read_element` + `write_to_env` to capture
  specific values intentionally.

## The skill files

The user-facing reference. `packages/plugin/skills/chromeboost/SKILL.md`
is what plugin-installed agents read. The `references/` subdirectory
holds the deep-dive material (anti-bot, shadow-dom, forms, etc.). When
adding a new tool or changing a major behavior:

1. Update the relevant `references/<topic>.md`.
2. Mirror changes to `skills-codex/chromeboost/references/` (the Codex
   variant uses the same references; only the top-level SKILL.md
   differs).
3. If the new behavior is broadly relevant, add a one-line mention to
   the main SKILL.md routing table or the "Common quick recipes"
   section.
4. Run `packages/plugin/scripts/sync-skill.sh` to regenerate the Codex
   variant and copy the references across. `skills/chromeboost/SKILL.md`
   is the canonical source; never edit `skills-codex/` by hand.

Do NOT add new content to this file. Repo-developer concerns only.

## Things deliberately NOT in chromeboost

- No LLM-mediated extraction tool. Claude is the LLM; adding another
  model call would double the latency for no gain.
- No daemon / session-management layer. The extension is persistent;
  no daemon needed.
- No hosted / cloud variant. ChromeBoost's value prop is the user's
  real logged-in Chrome.
- No index-based element selection. textHint and selector resolve in
  one call; index-based would require a `get_state` round-trip.
- No `chromeboost_doctor` composite tool. Diagnostics attach to the
  tool whose response would already carry the relevant context.

## Hosts

ChromeBoost runs under Claude Code, Codex, and Gemini CLI. The MCP server and
the extension are host-agnostic; only packaging differs.

| | Claude Code | Codex | Gemini CLI |
|---|---|---|---|
| Manifest | `packages/plugin/.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` | `gemini-extension.json` (repo root) |
| Server wiring | `packages/plugin/.mcp.json` | `codex mcp add` (see below) | `mcpServers` in the extension manifest |
| Agent guidance | `skills/chromeboost/SKILL.md` (canonical) | `skills-codex/` (generated) | `GEMINI.md` (generated) |
| Setup command | `commands/chromeboost-setup.md` | — | `commands/chromeboost-setup.toml` |

`SKILL.md` is the single source of guidance. After editing it run BOTH:

```
bash packages/plugin/scripts/sync-skill.sh    # Codex variant
bash packages/plugin/scripts/sync-gemini.sh   # GEMINI.md
```

### Codex packaging is unverified

`packages/plugin/.codex-plugin/` and `.mcp.codex.json` were inherited. The
launcher there hunts `~/.codex/plugins/cache` and its error message tells users
to run `codex plugin marketplace add`.

Codex CLI does have that machinery — `codex-rs/cli/src/{plugin,marketplace}_cmd.rs`
expose `codex plugin marketplace add` and `codex plugin install`, and
`core-plugins/src/manifest.rs` accepts `.claude-plugin/plugin.json` as an
alternate manifest with `.codex-plugin/plugin.json` as an overlay. So this repo
may already be installable that way.

What has NOT been verified is the marketplace manifest filename Codex expects at
a repo root, and nobody has run the flow end to end. Until someone does, the
documented Codex path is `codex mcp add`, whose argument shape IS confirmed from
`codex-rs/cli/src/mcp_cmd.rs`:

```
codex mcp add <name> [--env KEY=VALUE ...] -- <command> [args...]
```

If you confirm the marketplace path works, collapse the Codex install to two
commands like Claude Code and delete the clone step from the landing page.

Host identity flows from an env var to the popup badge:
`CHROMEBOOST_HOST` (set by the Codex and Gemini launchers) or
`CLAUDE_PLUGIN_ROOT` (set by Claude Code) is read in `ws-bridge.ts` and sent to
the extension, and again in `index.ts` for the startup banner.

Two traps when adding a host:

- `type Host` is declared in **both** `offscreen.ts` and `popup/index.ts`.
  Neither file is a module, so TypeScript merges them globally and updating one
  side alone silently gives the other the wrong union.
- The popup renders the badge via `hostBadgeFor()`, which falls back to a
  text-only badge. Indexing `HOST_ICONS` directly used to crash the whole popup
  render on an unrecognised host, and `host` is untrusted input off the socket.

## Distribution

ChromeBoost is distributed on two channels: the MCP server as a Claude Code
plugin marketplace from `github.com/lordamdal/chromeboost`, and the extension
on the Chrome Web Store (item id `alphgffnpbhpfaimmaaibbcdmpmcbndo`,
https://chromewebstore.google.com/detail/chromeboost/alphgffnpbhpfaimmaaibbcdmpmcbndo).
There is no npm package.

The store listing is the documented default for the extension, because it
installs in one click, needs no developer mode, and auto-updates. The plugin
still carries **both halves**: the bundled MCP server at
`packages/plugin/server/chromeboost.mjs` and the built extension at
`packages/plugin/extension/`. Both are committed, so a fresh
`/plugin install chromeboost@chromeboost` works with no clone, no
`npm install`, and no build step. `packages/extension/build.mjs` syncs
`dist/` into the plugin on every build — if you change extension source,
run `npm run build` and commit the synced payload alongside it, or users
get a stale extension.

Two channels means the extension can be at two versions at once. Store review
takes days, so after a release the plugin's bundled copy is the newer one until
the listing catches up. The `/chromeboost-setup` fallback path exists for
exactly that window.

**Users must not run both copies.** `ws-bridge.ts` keeps a single `client` and
calls `terminate()` on the old one whenever a new connection arrives, so an
unpacked copy and a store copy evict each other on their reconnect timers.
Anything user-facing that mentions installing should say so.

### The install path a user actually walks

The default is now the Web Store listing: `/chromeboost-setup` links to it,
checks `list_tabs`, and only falls back to the unpacked copy below when asked
or when the store version trails the plugin.

The unpacked path, still live behind that fallback:
`/chromeboost-setup` (`packages/plugin/commands/`) runs
`packages/plugin/scripts/install-extension.mjs`, which copies
`${CLAUDE_PLUGIN_ROOT}/extension` to `~/Downloads/ChromeBoost-Extension`
and prints `CHROMEBOOST_EXTENSION_PATH=<path>` as its last line.

The copy is deliberate, not incidental. Chrome loads unpacked extensions
*by path* and re-reads that path on every launch, so it has to live
somewhere stable and reachable — the plugin cache is neither: it's buried
several levels under `~/.claude/plugins/cache/`, hidden from the macOS file
picker by default, and its path changes on every plugin update. The script
writes a `DO-NOT-DELETE.txt` into the folder for the same reason.

Re-running overwrites in place, which makes it the upgrade path too: after
`/plugin update chromeboost`, re-run the command and hit reload on the
extension card — no re-picking the folder.

The command finishes by calling `list_tabs`. Do not remove that check; an
extension that loaded but never connected looks identical to a working one
from the Chrome side.
