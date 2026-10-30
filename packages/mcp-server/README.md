# chromeboost (MCP server)

The MCP server half of [ChromeBoost](../../README.md). It's a stdio↔WebSocket bridge:
your agent talks MCP over stdio, the Chrome extension connects over a local WebSocket,
and the server routes tool calls between them.

> This package is **not published to npm**. It builds from source in this repo. The
> recommended way to install ChromeBoost is the Claude Code / Codex plugin — see the
> [root README](../../README.md#install).

## Wiring it up by hand

If you'd rather skip the plugin and register the server directly:

```json
{
  "mcpServers": {
    "chromeboost": {
      "command": "node",
      "args": ["/absolute/path/to/ChromeBoost/packages/plugin/server/chromeboost.mjs"]
    }
  }
}
```

Build it first with `npm run build` from the repo root.

Going this route you lose the plugin's bundled skill and permission allowlist, so the
agent gets no usage guidance and you'll be prompted on every tool call.

## You still need the extension

The MCP server can't touch Chrome on its own. Load the extension unpacked from
`packages/extension/dist` — see the [root README](../../README.md#install).

The server binds the first free port in **7970–9069**; the extension scans that same
range, so several sessions can run side by side.

## Tools

35 tools across navigation, reading, interaction, cursor control, waiting, privileged
network, highlight/handoff, and utility.

Four are specific to ChromeBoost:

| Tool | For |
|---|---|
| `hover` | Hover-only menus, row actions at `opacity: 0`, tooltips, chart crosshairs |
| `drag` | Sliders, canvas/WebGL, map panning, drag-and-drop reordering, resize handles |
| `probe_point` | Print the painted element stack at a coordinate — diagnoses a swallowed click |
| `hud` | Move, dock, collapse or hide the on-page panel |

`click_element` and `click_at_coordinates` are occlusion-aware: they hit-test before
firing, scroll clear of pinned bars, pierce overlays, and report what blocked them.

The full agent-facing catalogue is
[`packages/plugin/skills/chromeboost/SKILL.md`](../plugin/skills/chromeboost/SKILL.md) —
read that before writing an agent that calls these tools.

## Build

```bash
npm run build           # from the repo root — builds both halves
```

Or just this package:

```bash
npm run build -w packages/mcp-server
```

Output is a single bundled ESM file at `packages/plugin/server/chromeboost.mjs`
(~950 KB), built with esbuild, plus a copy at `bin/chromeboost.mjs`.

## Layout

| File | What |
|---|---|
| `src/index.ts` | Tool registration entry |
| `src/ws-bridge.ts` | WebSocket server (MCP ↔ extension) |
| `src/types.ts` | Message types across the bridge |
| `src/tools/cursor.ts` | `hover`, `drag`, `probe_point`, `hud` |
| `src/tools/flow.ts` | `click_element`, `click_at_coordinates`, `wait_for`, handoff |
| `src/tools/browser.ts` | Navigation, tabs, network, scripting |
| `src/tools/capture.ts` | Reading the page, screenshots, forms |

## License

MIT — see [LICENSE](../../LICENSE).
