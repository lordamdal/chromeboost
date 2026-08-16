# ChromeBoost on Gemini CLI

The Chrome extension is identical across hosts. Only the packaging around the
MCP server differs, because Claude Code and Gemini CLI load extensions in
different shapes.

## Install

```bash
gemini extensions install https://github.com/lordamdal/chromeboost
```

Restart Gemini, then finish the browser half:

```
/chromeboost-setup
```

That copies the extension to `~/Downloads/ChromeBoost-Extension`, opens the
folder, and verifies the WebSocket connection with `list_tabs` before declaring
success.

For local development, symlink instead of installing so edits apply without
reinstalling:

```bash
gemini extensions link /absolute/path/to/chromeboost
```

## What the extension manifest provides

`gemini-extension.json` at the repo root declares:

| Field | Purpose |
|---|---|
| `mcpServers.chromeboost` | Spawns `packages/plugin/server/chromeboost.mjs` over stdio |
| `env.CHROMEBOOST_HOST` | Set to `gemini`, so the toolbar popup shows a Gemini badge |
| `contextFileName` | `GEMINI.md`, the agent-facing usage guidance |

`GEMINI.md` is generated from the canonical Claude skill. Do not edit it by
hand; edit `packages/plugin/skills/chromeboost/SKILL.md` and run:

```bash
bash packages/plugin/scripts/sync-gemini.sh
```

## Permissions: `trust` vs the policy engine

Gemini extension manifests **cannot set `trust`** (every other MCP option is
supported). That is deliberate on Gemini's side: an extension should not be able
to grant itself unprompted execution. So the choice is yours to make in
`~/.gemini/settings.json`.

### The blunt option

```json
{
  "mcpServers": {
    "chromeboost": { "trust": true }
  }
}
```

Every ChromeBoost tool runs with no confirmation. That includes
`execute_script`, which is arbitrary JavaScript in whatever authenticated tab is
active.

### Why the default is awkward

With `trust: false` (the default), tool calls prompt. That is fine interactively,
but in a headless run (`gemini -p "..."`, piped stdin, any non-TTY) Gemini treats
`ask_user` as **`deny`**. A long autonomous task does not pause waiting for you;
it gets refused mid-run and fails in confusing ways.

So `trust` is a real autonomy-vs-safety tradeoff, but only because it is
all-or-nothing per server.

### The better option

Gemini's policy engine gives per-tool decisions, which is what you actually
want. Rules live in `~/.gemini/policies/*.toml` (user tier).

```toml
# Everything read-only or navigational: no prompt, full background autonomy.
[[rule]]
mcpName = "chromeboost"
decision = "allow"
priority = 50

# execute_script is arbitrary JS in an authenticated tab.
# Ask when a human is present to answer.
[[rule]]
mcpName = "chromeboost"
toolName = "execute_script"
decision = "ask_user"
interactive = true
priority = 100

# ...and hard-deny it headless, where nobody can answer anyway.
[[rule]]
mcpName = "chromeboost"
toolName = "execute_script"
decision = "deny"
interactive = false
priority = 100
```

Two details that make this work:

- **`interactive = true / false`** scopes a rule to interactive or headless runs,
  which is what lets the same tool behave differently in each.
- A global **`deny`** (one with no `argsPattern`) removes the tool from the
  model's context entirely. Gemini never sees it as an option, which saves
  context and stops it planning around a tool it cannot call.

> **Caveat from Gemini's docs:** the workspace tier (`.gemini/policies` inside a
> project) is currently non-functional
> ([issue #18186](https://github.com/google-gemini/gemini-cli/issues/18186)).
> Put policies in `~/.gemini/policies/` or the admin tier.

## Differences from the Claude Code plugin

| | Claude Code | Gemini CLI |
|---|---|---|
| Packaging | plugin marketplace | `gemini extensions install` |
| Permissions | `settings.json` allowlist | `trust`, or the policy engine |
| Agent guidance | `SKILL.md`, loaded on demand | `GEMINI.md`, loaded as context |
| Setup command | `commands/chromeboost-setup.md` | `commands/chromeboost-setup.toml` |
| Support prompt | `Stop` hook | no equivalent event, so it never fires |

For Codex, see [Using Codex instead](../README.md#using-codex-instead) in the root
README: it registers the server with `codex mcp add` rather than through a
marketplace.

The usage counter that drives the support prompt lives at
`~/.chromeboost/usage.json`, shared across hosts, so a Gemini session still
counts toward it even though the prompt only surfaces under Claude Code.

## Ports

The MCP server binds the first free port in **7970-7980**, and the extension
scans that range. Several sessions across different hosts can run side by side;
the popup shows a badge per session so you can tell which is which.
