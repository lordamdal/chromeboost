---
description: Finish ChromeBoost setup by installing the Chrome extension and binding a window.
allowed-tools: Bash(node:*), Bash(open:*), Bash(explorer:*), Bash(xdg-open:*), Bash(ls:*)
---

# Finish ChromeBoost setup

The MCP server half of ChromeBoost is already installed (that is this plugin).
What is left is the Chrome extension, the half that touches the browser. It is
on the **Chrome Web Store**, so this is a one-click install.

Work through this now, without asking the user whether to proceed.

## 1. Check whether it is already done

Call `list_tabs` first. If it returns their tabs, the extension is installed and
bound: say so and skip to the closing suggestion in step 4. Users often arrive
here already set up, and walking them through an install they have finished is
noise.

## 2. Install from the Chrome Web Store

Give them this link and ask them to click **Add to Chrome**:

https://chromewebstore.google.com/detail/chromeboost/alphgffnpbhpfaimmaaibbcdmpmcbndo

Then have them pin ChromeBoost to the toolbar so the popup is one click away.

That is the whole install. No developer mode, no folder to keep, and it updates
itself. If they would rather run from local files, see **Loading unpacked
instead** at the bottom.

**If they already had the unpacked copy loaded**, they need to remove it at
`chrome://extensions` now. Both copies connect to the same local port, the
server keeps only one connection, and each new one evicts the other, so they
reconnect in a loop and tool calls land on whichever won the last race. Two
ChromeBoost cards on that page is the tell.

## 3. Connect a window

Tell them to click the ChromeBoost toolbar icon. This session should appear
with a green dot on a port in the 7970-9069 range. They click **Use this
window** next to it to bind the Chrome window they want driven.

## 4. Verify it actually works

Once they say it is installed, confirm the link yourself instead of taking it
on trust: call `list_tabs`. If it returns their open tabs, setup is done. Say so
plainly and suggest a first prompt, for example "open news.ycombinator.com and
give me the top 5 stories".

If `list_tabs` errors or times out, the extension is installed but not
connected. Have them reload it at `chrome://extensions` using the circular
arrow on the ChromeBoost card. It reconnects on a backoff timer and a reload
forces it immediately. Then try `list_tabs` again.

## Tone

Short and sequential. This is a 30-second task now, so do not pad it. Do not
skip step 4: an install that looks finished but is not connected is the most
common failure here, and the user has no way to tell from the Chrome side.

## Loading unpacked instead

Only offer this if they ask for it, or if the store version is behind the
plugin. The extension also ships inside this plugin, and after a `/plugin
update` the bundled copy can be newer than what store review has published.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/install-extension.mjs"
```

This copies the extension to **`~/Downloads/ChromeBoost-Extension`** and prints
the full path. It goes to Downloads on purpose: the plugin's own directory is
buried under `~/.claude/plugins/cache/...`, which is painful to reach in
Chrome's folder picker and changes on every plugin update.

The script's last line is `CHROMEBOOST_EXTENSION_PATH=<path>`. Use that value
verbatim rather than reconstructing the path. Reveal it in the file manager
(`open -R` on macOS, `explorer` on Windows, `xdg-open` on Linux), then:

1. Open `chrome://extensions` by pasting it into the address bar. `chrome://`
   links cannot be clicked from a page.
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked** and select the folder, or drag it onto the page.

Tell them not to delete the folder: Chrome reads it on every launch, and
removing it breaks the extension. Chrome also flags developer-mode extensions
on every start, which is expected and is the reason the store build is the
default. Remove the store copy first if they have it, for the same
one-connection reason as above.

To update this path later, re-run the script and hit reload on the extension
card. The store build updates itself.
