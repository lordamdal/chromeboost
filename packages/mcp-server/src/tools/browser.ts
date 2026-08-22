import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, copyFileSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { WsBridge } from "../ws-bridge.js";
import { isBlockedUrl } from "../policy.js";
import { FlowStore, isFragileSelector, type Atom } from "../flow-store.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  server.tool(
    "open_page",
    `Navigate to a URL. By default reuses the active tab. Set new_tab=true to open alongside the current tab without losing it. After navigating, call get_page_text to read the page — do NOT take a screenshot.

Set background=true (only with new_tab=true) to open the new tab WITHOUT switching focus to it. Use this when the current tab has a partially-filled form whose page auto-saves on focus loss (e.g. eBay seller listings) — switching away would trigger the auto-save and corrupt the in-progress draft.

After tabs.onUpdated fires status=complete, chromeboost also runs a 6s settle check (document.readyState=complete, no visible spinner element, 250ms of mutation quiet). If a spinner is still visible at the end of the window, the response carries \`stuck_spinner: true\` with the matching selector — the canonical case is an SPA route that left a permanent .spinner-wrapper because the API request died. Set expect_selector to wait for a known-good element to appear before considering the page settled — the response carries \`expect_selector_appeared: false\` if it never showed up.`,
    {
      url: z.string().url().describe("The URL to navigate to"),
      new_tab: z.boolean().optional().describe("Open in a new tab instead of replacing the current one (default false)"),
      background: z
        .boolean()
        .optional()
        .describe("If new_tab=true, do not switch focus to the new tab. Default false. Ignored when new_tab is false."),
      expect_selector: z
        .string()
        .optional()
        .describe("CSS selector for an element that must be present before the page is considered settled. The settle check waits up to 6s for it; if it never appears, the response carries expect_selector_appeared:false so you can detect dead-spinner routes (SPAs that leave a permanent spinner when the underlying API request dies)."),
    },
    async ({ url, new_tab, background, expect_selector }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `open_page refused: ${block.reason}` }] };
      }
      const response = await bridge.request({
        type: "navigate",
        url,
        newTab: new_tab ?? false,
        background: background ?? false,
        expect_selector,
      });
      const r = response as {
        stuck_spinner?: boolean;
        spinner_selector?: string | null;
        expect_selector_appeared?: boolean | null;
        current_url?: string;
        anti_bot_detected?: string | null;
        dismissed_beforeunload?: boolean;
      };
      const newTabBit = new_tab ? (background ? " (new background tab)" : " (new tab)") : "";
      let text = `Navigated to ${url}${newTabBit}`;
      if (r.stuck_spinner) {
        text += `\n\n⚠ stuck_spinner: true — page settled with a visible spinner (${r.spinner_selector ?? "unknown selector"}) still on screen after 6s. Current URL: ${r.current_url ?? url}. The route may be dead (some SPAs leave a permanent spinner when the underlying API request fails) — navigate elsewhere instead of reloading, or wait and try get_page_text to see if it ever recovers.`;
      }
      if (expect_selector && r.expect_selector_appeared === false) {
        text += `\n\n⚠ expect_selector "${expect_selector}" never appeared within the 6s settle window. The page may be partially loaded or stuck.`;
      }
      if (r.anti_bot_detected) {
        text += `\n\n⚠ anti_bot_detected: "${r.anti_bot_detected}" — the page returned a known block / challenge response. Page content is unlikely to be the intended target. Don't try to interact with it; navigate elsewhere or surface to the user.`;
      }
      if (r.dismissed_beforeunload) {
        text += `\n\nℹ dismissed_beforeunload: true — the previous page had unsaved content (typed text in a composer, form draft, etc.) and Chrome's "Are you sure you want to leave?" dialog was auto-dismissed so navigation could proceed. If that draft was load-bearing, navigate back and re-capture before continuing.`;
      }
      // Flow memory: surface any known good flow for this destination so the
      // agent follows the proven steps instead of rediscovering them.
      flowStore.noteUrl(r.current_url ?? url);
      text += flowStore.recallHint(r.current_url ?? url);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "switch_to_tab",
    `Switch the active tab to a different open tab. Use this after open_page(new_tab=true) to switch back to the original tab, or to jump between tabs.
Accepts: a tab number (1-based), a URL substring, or a title substring.
Pass it as either \`tab\` (mirrors the verb in the tool name — natural when targeting by index) or \`query\` (clearer when matching by URL/title substring). Both work identically.
Examples: switch_to_tab({tab: 1}) for the first tab, switch_to_tab({tab: "form"}) or switch_to_tab({query: "form"}) for a tab whose URL or title contains "form".`,
    {
      query: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring to match. Alias for `tab`."),
      tab: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring to match. Alias for `query`."),
    },
    async ({ query, tab }) => {
      const raw = query ?? tab;
      if (raw === undefined || raw === null || raw === "") {
        return {
          content: [
            { type: "text", text: "switch_to_tab requires either `tab` or `query` — a 1-based index, URL substring, or title substring." },
          ],
        };
      }
      const q = String(raw);
      const response = await bridge.request({ type: "switch_to_tab", query: q });
      // Newer extension returns the landed URL/title; older extensions return
      // a bare action_done. Handle both so a fresh server keeps working with
      // a not-yet-reloaded extension.
      const r = response as { url?: string; title?: string };
      const echo = r.url
        ? ` → "${r.title ?? ""}" (${r.url})`
        : "";
      return {
        content: [{ type: "text", text: `Switched to tab matching "${q}"${echo}` }],
      };
    }
  );

  server.tool(
    "list_tabs",
    "List all open tabs in the current window with their index, title, and URL. Use this before switch_to_tab if you're not sure which tab to switch to.",
    {},
    async () => {
      const response = await bridge.request({ type: "list_tabs" });
      if (response.type !== "tabs_response") throw new Error("Unexpected response");
      const tabs = (response as { tabs: Array<{ index: number; title: string; url: string; active: boolean }> }).tabs;
      const lines = tabs.map(t => `${t.index}. ${t.active ? "[active] " : ""}${t.title} — ${t.url}`);
      return {
        content: [{ type: "text", text: `Open tabs:\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "close_tab",
    `Close a tab by number, URL substring, or title substring. Mirrors switch_to_tab's matcher. Defaults to closing the ACTIVE tab when no query is given. Use this to clean up the tab pile after a multi-step workflow.`,
    {
      query: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring. Omit to close the active tab."),
    },
    async ({ query }) => {
      const raw = query === undefined || query === null || query === "" ? undefined : String(query);
      const response = await bridge.request({ type: "close_tab", query: raw });
      const r = response as { closed?: Array<{ index: number; title: string; url: string }>; message?: string };
      if (r.message) return { content: [{ type: "text", text: r.message }] };
      const closedList = (r.closed ?? []).map(t => `${t.index}. ${t.title} — ${t.url}`).join("\n");
      return {
        content: [{ type: "text", text: `Closed ${(r.closed ?? []).length} tab(s):\n${closedList}` }],
      };
    }
  );

  server.tool(
    "close_other_tabs",
    `Close every tab in the current window EXCEPT the active one (or any tab matching keep_query). Use at the end of a session to tidy up; do NOT use mid-flow if you may need to return to one of the closed tabs.`,
    {
      keep_query: z
        .string()
        .optional()
        .describe("URL substring or title substring. Tabs matching this are KEPT; all others are closed. When omitted, only the active tab is kept."),
    },
    async ({ keep_query }) => {
      const response = await bridge.request({ type: "close_other_tabs", keep_query });
      const r = response as { closed?: Array<{ index: number; title: string; url: string }>; kept?: Array<{ index: number; title: string; url: string }>; message?: string };
      if (r.message) return { content: [{ type: "text", text: r.message }] };
      const closedCount = (r.closed ?? []).length;
      const keptCount = (r.kept ?? []).length;
      const keptList = (r.kept ?? []).map(t => `  ${t.index}. ${t.title} — ${t.url}`).join("\n");
      return {
        content: [{ type: "text", text: `Closed ${closedCount} tab(s), kept ${keptCount}:\n${keptList}` }],
      };
    }
  );

  server.tool(
    "take_screenshot",
    `Capture a screenshot of the active tab. By default the image is returned to the agent inline UNLESS it exceeds ~500KB base64, in which case it's saved to a temp file and the path is returned instead (preserves the agent's context window). Set inline="always" to force inline regardless of size, or inline="never" to always write to a file. Set save_to or copy_to_clipboard to also share the image with the user. Reserved for cases where DOM lookup has already failed — use get_page_text and find_text for reading content.

Refuses fast on pages that are in fullscreen mode (captureVisibleTab hangs there). Exit fullscreen first with execute_script("document.exitFullscreen()") or pass allow_fullscreen: true if you really must try anyway.`,
    {
      copy_to_clipboard: z
        .boolean()
        .optional()
        .describe("Copy the PNG to the system clipboard (macOS only). Default false."),
      save_to: z
        .enum(["downloads", "cwd", "none"])
        .optional()
        .describe('Save the PNG to disk: "downloads" (~/Downloads), "cwd" (the agent\'s working directory), or "none" (default — image returned only to the agent, no disk artifact).'),
      inline: z
        .enum(["auto", "always", "never"])
        .optional()
        .describe('Whether to return the image base64 inline to the agent. "auto" (default): inline if under 500KB base64, otherwise write to a temp file and return the path. "always": inline regardless of size — large images may exceed the MCP token ceiling. "never": always return the path, never inline.'),
      allow_fullscreen: z
        .boolean()
        .optional()
        .describe("Bypass the fullscreen fast-fail. Default false. captureVisibleTab usually hangs in fullscreen mode and the request times out — set this only when you've confirmed the page can produce a screenshot in fullscreen."),
    },
    async ({ copy_to_clipboard = false, save_to = "none", inline = "auto", allow_fullscreen }) => {
      const sharing = copy_to_clipboard || save_to !== "none";
      // grid:false when sharing — coord grid is noise when the image is for
      // pasting into chats / uploading to forms.
      const response = await bridge.request({ type: "screenshot", grid: !sharing, allow_fullscreen });
      if (response.type !== "screenshot_response") {
        throw new Error("Unexpected response from extension");
      }

      const base64Len = response.image.length;
      const INLINE_CAP = 500_000; // ~375KB image
      const shouldInline = inline === "always" || (inline === "auto" && base64Len <= INLINE_CAP);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `chromeboost-${timestamp}.png`;
      const imageBuffer = Buffer.from(response.image, "base64");
      const tmpPath = join(tmpdir(), filename);
      // Always write the temp file when not inlining OR when sharing — used by
      // both the auto-file return path and the clipboard/copy paths.
      const needTmp = !shouldInline || sharing;
      if (needTmp) writeFileSync(tmpPath, imageBuffer);

      const notes: string[] = [];
      let landedPath = tmpPath;
      if (save_to !== "none") {
        const savePath = save_to === "cwd"
          ? join(process.cwd(), filename)
          : join(homedir(), "Downloads", filename);
        copyFileSync(tmpPath, savePath);
        notes.push(`Saved to ${savePath}`);
        landedPath = savePath;
      }
      if (copy_to_clipboard) {
        try {
          execSync(`osascript -e 'set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)'`);
          notes.push("Copied to clipboard");
        } catch {
          // Surface the failure explicitly rather than silently dropping it, so
          // the caller never assumes a clipboard copy that didn't happen
          // (clipboard copy is macOS-only; other platforms land here).
          notes.push("Clipboard copy failed (macOS-only feature)");
        }
      }

      // Viewport / page / scroll metadata footer — lets agents map pixel
      // positions in the image directly to CSS coordinates for
      // click_at_coordinates without a separate execute_script probe.
      const r = response as { viewport?: { width: number; height: number }; page?: { width: number; height: number }; scroll?: { x: number; y: number } };
      const meta = r.viewport && r.page && r.scroll
        ? ` viewport=${r.viewport.width}x${r.viewport.height}, page=${r.page.width}x${r.page.height}, scroll=(${r.scroll.x},${r.scroll.y}).`
        : "";

      if (shouldInline) {
        const msg = notes.length
          ? notes.join(". ") + "." + meta
          : `Screenshot captured (${response.width}x${response.height}, ${base64Len} base64 chars).${meta} Analyze the image to identify element positions for highlighting.`;
        return {
          content: [
            { type: "image", data: response.image, mimeType: "image/png" },
            { type: "text", text: msg },
          ],
        };
      }

      // Path-only return — image is too large for inline.
      notes.push(`Image saved to ${landedPath} (${response.width}x${response.height}, ~${Math.round(imageBuffer.byteLength / 1024)}KB).${meta} Read the file or use OS image viewer. To force inline despite size, pass inline="always".`);
      return {
        content: [{ type: "text", text: notes.join(". ") + "." }],
      };
    }
  );

  server.tool(
    "capture_terminal",
    `Capture a screenshot of the terminal window (Terminal, iTerm2, Warp, VS Code, Ghostty, etc.) and save it as a PNG.
Use this when you need a screenshot of terminal output — e.g. test results, build logs, or command output — to upload to a form via set_file_input.
Auto-detects the terminal app. Returns the image to Claude AND saves the PNG file.
The saved file path can be passed directly to set_file_input(hint, file_path) to upload it.`,
    {
      save_to: z
        .enum(["downloads", "cwd"])
        .optional()
        .describe('Where to save the PNG: "downloads" (~/Downloads, default) or "cwd" (working directory)'),
    },
    async ({ save_to = "downloads" }) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `terminal-${timestamp}.png`;
      const savePath = save_to === "cwd"
        ? join(process.cwd(), filename)
        : join(homedir(), "Downloads", filename);

      // Try to find a terminal window and capture just that window's bounds
      let captured = false;
      try {
        const bounds = execSync(`osascript -e '
          tell application "System Events"
            set termApps to {"Terminal", "iTerm2", "Warp", "kitty", "Alacritty", "Ghostty", "Code", "Cursor", "Windsurf"}
            repeat with appName in termApps
              if exists process (contents of appName) then
                tell process (contents of appName)
                  if (count of windows) > 0 then
                    set win to window 1
                    set pos to position of win
                    set sz to size of win
                    return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
                  end if
                end tell
              end if
            end repeat
            error "No terminal window found"
          end tell
        '`, { timeout: 5000 }).toString().trim();

        execSync(`screencapture -x -R${bounds} "${savePath}"`, { timeout: 5000 });
        captured = true;
      } catch {
        // Fallback: capture entire screen
        try {
          execSync(`screencapture -x "${savePath}"`, { timeout: 5000 });
          captured = true;
        } catch { /* screencapture requires screen recording permission */ }
      }

      if (!captured) {
        return {
          content: [{ type: "text", text: "Failed to capture terminal. Ensure Screen Recording permission is granted to your terminal app in System Settings > Privacy & Security > Screen Recording." }],
        };
      }

      // Read the captured image for returning to Claude
      const imageBuffer = readFileSync(savePath);
      const base64 = imageBuffer.toString("base64");

      // Copy to clipboard
      let clipboardNote = "";
      try {
        execSync(`osascript -e 'set the clipboard to (read (POSIX file "${savePath}") as «class PNGf»)'`);
        clipboardNote = "Copied to clipboard. ";
      } catch { /* ignore */ }

      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: `${clipboardNote}Saved to ${savePath}` },
        ],
      };
    }
  );

  server.tool(
    "clear_overlays",
    "Remove all highlights and callout annotations from the current page.",
    {},
    async () => {
      await bridge.request({ type: "clear" });
      return {
        content: [{ type: "text", text: "All overlays cleared." }],
      };
    }
  );

  server.tool(
    "get_form_fields",
    `Inventory form fields on the active page (inputs, textareas, selects, CodeMirror editors). Sorted top-to-bottom by on-screen position; includes fields below the fold.

Fields inside same-origin iframes are included and carry a \`frame\` value naming the frame that holds them — pass it back as fill_input's \`frame\`. Pass \`frame\` here to inventory one frame only.

Pass \`query\` to filter+rank by label/placeholder/aria-label/name/id (the old find_input behavior — match strength reported as aria-eq / placeholder-eq / label-text-eq / name-eq / id-eq / *-includes / fuzzy-text-walk). Pass \`exact: true\` to refuse fuzzy text-walk matches.

Pass \`only_empty: true\` to filter the inventory to required-but-empty fields. This is the "why is Submit disabled" diagnostic: it returns just the required fields that haven't been filled yet (or radios/checkboxes still unchecked) and skips everything that's already populated. Required-ness is detected via the \`required\` attribute, \`aria-required\`, or a trailing \`*\` in the associated label text.`,
    {
      query: z.string().optional().describe("If set, filter+rank fields by hint matching label/placeholder/aria-label/name/id."),
      max: z.number().int().min(1).optional().describe("Maximum fields to return when query is set (default 5). Ignored without query (full inventory)."),
      type_filter: z.string().optional().describe('Restrict to a specific input type (e.g. "email", "checkbox", "file"). Only with query.'),
      exact: z.boolean().optional().describe("Refuse fuzzy text-walk and *-includes matches. Only with query."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Honoured in BOTH inventory and query mode."),
      only_empty: z.boolean().optional().describe("Filter inventory to required-but-empty fields only. Use as a Submit-disabled diagnostic. Ignored when query is set."),
    },
    async ({ query, max, type_filter, exact, frame, only_empty }) => {
      if (query !== undefined) {
        // Filtered mode — route to find_input bridge message.
        const response = await bridge.request({ type: "find_input", query, type_filter, max, exact, frame });
        if (response.type !== "find_input_response") throw new Error("Unexpected response");
        const r = response as { fields: Array<{ label: string; placeholder: string; type: string; value: string; under?: string; position: unknown; match_kind: string }>; total_matches: number; truncated: boolean; frame_error?: string };
        if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
        if (r.fields.length === 0) return { content: [{ type: "text", text: `No form fields matched "${query}".` }] };
        const header = `Found ${r.fields.length}${r.truncated ? ` of ${r.total_matches}` : ""} input(s) for "${query}":`;
        const lines = r.fields.map((f, i) => {
          const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : "";
          const val = f.value ? ` value="${f.value}"` : "";
          const under = f.under ? ` [under: "${f.under}"]` : "";
          return `  ${i + 1}. "${f.label}" type=${f.type}${ph}${val}${under} — match: ${f.match_kind}`;
        });
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}\n\nTo fill: fill_input("${r.fields[0].label}", "<value>")` }] };
      }
      // Inventory mode. `frame` used to be dropped here while the tool still
      // advertised the parameter, so get_form_fields(frame: "...") with no
      // query returned the TOP document's fields as though they were the
      // frame's — a confidently wrong answer, which is worse than an error.
      const response = await bridge.request({ type: "get_form_fields", only_empty, frame });
      if (response.type !== "form_fields_response") throw new Error("Unexpected response");
      const r = response as {
        fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string; frame?: string; context?: string; required?: boolean; empty?: boolean }>;
        warning?: string;
        frame_error?: string;
        captcha?: { kind: string; sitekey: string | null } | null;
        oauthIndicators?: string[];
      };
      if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
      const fields = r.fields;
      const captchaLine = r.captcha
        ? `\n\n⚠ CAPTCHA detected: ${r.captcha.kind}${r.captcha.sitekey ? ` (sitekey: ${r.captcha.sitekey})` : ""}. Synthetic submits will be silently rejected. Pre-fill, then highlight the submit button and call wait_for_click.`
        : "";
      const oauthLine = r.oauthIndicators && r.oauthIndicators.length > 0
        ? `\n\nℹ OAuth providers detected on this form: ${r.oauthIndicators.join(", ")}. If the user wants to sign in via one of these, click it instead of filling email/password.`
        : "";
      if (fields.length === 0) {
        const empty = only_empty
          ? "No required-but-empty fields detected."
          : "No form fields found on page.";
        return { content: [{ type: "text", text: empty + (r.warning ?? "") + captchaLine + oauthLine }] };
      }
      const lines = fields.map(f => {
        const val = f.value ? ` [currently: "${f.value}"]` : "";
        const ctx = f.context ? ` [under: "${f.context}"]` : "";
        const req = f.required ? " *required" : "";
        // Naming the frame matters for the next call, not just for orientation:
        // fill_input needs it to reach the field at all.
        const fr = f.frame ? ` [in iframe: ${f.frame}]` : "";
        return `${f.index}. [${f.type}] "${f.label}"${req}${val}${ctx}${fr} — y:${f.y}`;
      });
      const header = only_empty
        ? `Required-but-empty fields (${fields.length}):`
        : `Form fields (${fields.length} total, sorted top-to-bottom):`;
      return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}${r.warning ?? ""}${captchaLine}${oauthLine}` }] };
    }
  );

  server.tool(
    "type_text",
    `Type text into the currently focused element via CDP keystrokes (produces isTrusted=true events). Use when fill_input fails because the page validates isTrusted (CodeMirror/Monaco/Ace editors, shadow DOM inputs, isTrusted-gated forms). Pass \`into_selector\` to focus the target before typing (shadow-piercing CSS) — combined with \`clear_first: true\`, this collapses the old "wait_for_click → execute_script selectAll → type_text" pattern into a single call. Pass \`frame\` to type into a frame — including a CROSS-ORIGIN one, since focus is set by a script injected into the frame itself and the keystrokes then follow focus wherever it landed. Combine with \`into_selector\` to pick a specific element inside that frame.

**TipTap / ProseMirror auto-recovery**: when \`into_selector\` targets a contenteditable inside a \`.tiptap\` / \`.ProseMirror\` / \`[data-tiptap-editor]\` ancestor, type_text verifies post-type that the text actually landed. If tiptap's internal state machine silently dropped the CDP keystrokes (a known failure mode where the editor reverts to placeholder a few seconds later), type_text automatically re-fills via \`document.execCommand('insertText', ...)\` which tiptap accepts. The response message records "TipTap/ProseMirror silently dropped..., recovered via execCommand insertText" when this fired.`,
    {
      text: z.string().describe("The text to type into the focused element"),
      into_selector: z
        .string()
        .optional()
        .describe(
          'CSS selector for the element to focus before typing (shadow-piercing — resolves selectors that find_text returns for closed-shadow-root content, e.g. Radix portals). When omitted, types into whatever is currently focused (the caller is responsible for focusing first via click_element).'
        ),
      clear_first: z
        .boolean()
        .optional()
        .describe(
          "Only with into_selector: run document.execCommand('selectAll') + 'delete' on the focused element before typing. Use to overwrite tiptap / ProseMirror editors and similar contenteditable surfaces in one call."
        ),
      frame: z
        .string()
        .optional()
        .describe(
          "Frame to type into. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a substring of the frame's src / title / id. Works for cross-origin frames. Before typing, into_selector (or the first contenteditable/input) inside the frame is focused; after typing, input/change events are dispatched in the frame's own context."
        ),
    },
    async ({ text, frame, into_selector, clear_first }) => {
      // Average ~80ms per char (60ms avg delay + overhead) but with a 5% slow
      // pause tail. 110ms/char gives margin over the empirical p99 and the
      // background also emits a "progress" heartbeat every 200 chars that
      // resets the bridge's request timer — combined, ~1800-char typings
      // complete reliably without timeout-ambiguity.
      const timeoutMs = Math.max(30_000, text.length * 110 + 15_000);
      const response = await bridge.request(
        { type: "type_text", text, frame, into_selector, clear_first },
        timeoutMs
      );
      const r = response as { success?: boolean; message?: string };
      // Flow memory: typing into a specific selector with type_text (rather than
      // fill_input) is a deliberate "this field needs real isTrusted keystrokes"
      // decision worth remembering — the canonical Reddit title/body case. Only
      // notable when an explicit target was given and the type succeeded.
      let capturable = "";
      if (into_selector && r.success !== false) {
        flowStore.observe({
          tool: "type_text",
          target: into_selector,
          selector: into_selector,
          signal: clear_first ? "type_text(clear_first)" : "type_text",
          fragile: isFragileSelector(into_selector),
          reason: "field needs real keystrokes (type_text, not fill_input)",
        } as Atom);
        capturable = flowStore.capturableHint(undefined);
      }
      return {
        content: [{ type: "text", text: (r.message ?? (r.success ? "Text typed successfully" : "Failed to type text")) + capturable }],
      };
    }
  );

  server.tool(
    "set_file_input",
    "Upload a file to a file input — works even when the input is hidden behind a custom drag-and-drop zone. Returns success=true only after an observable commit (file count goes up, input gets reset, or verify_selector appears within wait_ms). See CLAUDE.md for batch-upload guidance.",
    {
      hint: z.string().describe("Label text, name, or surrounding text of the file input. Use empty string to target the first file input on the page."),
      file_path: z.string().describe("Absolute path to the file to upload (e.g. /Users/you/Downloads/task.zip)"),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How long to wait for an observable change after setting the file (default 3000). Increase for slow uploaders that take a moment to render thumbnails."),
      verify_selector: z
        .string()
        .optional()
        .describe('Optional CSS selector that should appear after a successful upload (e.g. ".photo-thumbnail", "[data-uploaded=true]"). When matched, set_file_input returns success immediately.'),
    },
    async ({ hint, file_path, wait_ms, verify_selector }) => {
      // The WS request must outlive the upload-poll, with margin for CDP attach.
      const wsTimeout = Math.max(30_000, (wait_ms ?? 3000) + 10_000);
      const response = await bridge.request(
        { type: "set_file_input", hint, filePath: file_path, waitMs: wait_ms, verifySelector: verify_selector },
        wsTimeout
      );
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "File set successfully" : "Failed to set file") }],
      };
    }
  );

  server.tool(
    "execute_script",
    `Execute JavaScript in a tab's MAIN world (the page's own context, not the extension's isolated world). Use for reading framework state or DOM properties not visible in text — prefer get_page_text for visible content. Top-level \`return\` and \`await\` are supported.

**Object returns are auto-stringified** — return an object/array and the response carries its JSON. No need to wrap return values in JSON.stringify yourself.

**Shadow-piercing helpers are pre-injected** into every script:
- \`$deep(selector, root?)\` — querySelector that walks open shadow roots
- \`$deepAll(selector, root?)\` — querySelectorAll equivalent, returns an array
- \`shadowDocument\` — the open shadow root with the most interactive elements (buttons, inputs, links), or \`document\` if none. Useful when an SPA mounts ALL of its UI inside a single root shadow host (Outlier-style annotation dashboards): replace every \`document.querySelector*\` call with \`shadowDocument.querySelector*\` and the same code now reaches the SPA's content. On pages with multiple shadow roots (e.g. one for CSS theme vars, one for content), this picks the content root automatically.
- \`shadowDocuments\` — array of ALL open shadow roots on the page (in DOM order). Use when you need to search across multiple shadow roots or when the automatic pick is wrong.

The helpers pierce OPEN shadow roots only — MAIN world can't reach closed roots. For closed roots, use find_text / get_page_text / click_element / fill_input which pierce both kinds via chrome.dom.openOrClosedShadowRoot.

MAIN-world means the page's Content-Security-Policy applies: \`fetch()\` against authenticated APIs is often blocked by the page's connect-src directive. When that happens, switch to fetch_url — it runs in the extension's privileged context (full host_permissions, automatic cookie jar, no page CSP).

CSP-strict pages that disallow eval (Stripe, GitHub) silently fall through to a CDP eval path. Page alerts (alert/confirm/prompt) fired since the last script appear as PAGE ALERT in the result.

Pass \`tab_query\` to run the script against a specific tab without focus-switching (helpful for self-rescheduling loops where the active tab may have drifted while AFK). Accepts the same syntax as switch_to_tab: numeric index, URL substring, or title substring.

When the page navigates mid-script, the response carries \`navigated: true\` and result="[navigated]" instead of a thrown error — verify post-navigation state with get_page_text or wait_for. When host permission was lost (idle tab eviction), the handler reloads the tab once and retries; the response includes \`reauthorized: true\` so callers can see what happened.`,
    {
      code: z
        .string()
        .describe(
          "JavaScript expression or multi-statement script to evaluate in the page. Top-level `return` is supported."
        ),
      tab_query: z
        .string()
        .optional()
        .describe('Run against a specific tab without changing focus. Same syntax as switch_to_tab: numeric index, URL substring, or title substring. Omit to run against the active tab.'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe('Script execution timeout in milliseconds (default 30000). When the script exceeds this limit, execution is terminated via CDP Runtime.terminateExecution and the debugger is released cleanly. Without this, a hung script locks the debugger session indefinitely and every subsequent tool call fails with "Another debugger is already attached." Increase for large DOM traversals inside shadow roots; decrease when you want fast failure on scripts that might hang.'),
      frame: z.string().optional().describe("Address a frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id. Unlike every other frame parameter this one works for CROSS-ORIGIN frames as well: the script is injected into the frame under the extension's own host permissions rather than reached into from the parent, so the script's `document` IS the frame's document. Ambiguity (two frames loading the same URL) is reported, never guessed at."),
    },
    async ({ code, tab_query, timeout_ms, frame }) => {
      const response = await bridge.request({ type: "execute_script", code, tab_query, timeout_ms, frame });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      const { result, alert, navigated, reauthorized } = response as { result: string; alert?: string | null; navigated?: boolean; reauthorized?: boolean };
      let text = `Result: ${result}`;
      const flags: string[] = ["context: main"];
      if (navigated) flags.push("navigated");
      if (reauthorized) flags.push("tab reauthorized (auto-reload)");
      text = `[${flags.join(", ")}]\n${text}`;
      if (alert) {
        text += `\n\nPAGE ALERT: "${alert}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );

  server.tool(
    "inspect_request_headers",
    `Capture the request headers Chrome sends to a URL — useful for diagnosing server-side bot detection. Returns method, URL, and all headers. Cookie values are redacted by default to avoid leaking session tokens into the agent context; pass redact_cookies: false to see them. By default opens a background tab for the inspection so your active tab keeps its scroll position and form state — set new_tab: false to use the active tab instead.`,
    {
      url: z.string().url().describe("URL to navigate to and capture headers for"),
      redact_cookies: z.boolean().optional().describe("Replace each cookie's value with [REDACTED]. Default true. Set false only when you genuinely need the cookie content for debugging."),
      new_tab: z.boolean().optional().describe("Open the inspection in a background tab and close it when done. Default true (preserves the active tab's state). Set false to use the active tab — the active tab WILL navigate."),
    },
    async ({ url, redact_cookies = true, new_tab = true }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `inspect_request_headers refused: ${block.reason}` }] };
      }
      const response = await bridge.request({ type: "inspect_request_headers", url, new_tab }, 30_000);
      const r = response as { message?: string };
      let text = r.message ?? "(no headers captured)";
      if (redact_cookies) {
        // Redact the `cookie:` header value. Format from the extension is
        // "cookie: name1=val1; name2=val2" — replace each value with [REDACTED].
        text = text.replace(/^(cookie:\s*)(.+)$/gim, (_m, prefix, body) => {
          const pairs = String(body).split(";").map(s => s.trim()).filter(Boolean);
          const names = pairs.map(p => p.split("=")[0]);
          return `${prefix}[REDACTED — ${pairs.length} cookies: ${names.join(", ")}]`;
        });
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
