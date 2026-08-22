import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";
import { FlowStore, isFragileSelector, type Atom } from "../flow-store.js";

export function registerFlowTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  server.tool(
    "click_element",
    `Click an interactive element by its visible text/aria-label (textHint) OR by direct CSS selector (selector). Pass exactly one.

\`textHint\` mode: fuzzy-rank against visible text, aria-label, button content. Ranks visible candidates ahead of hidden.

\`selector\` mode: pierces open AND closed shadow roots via queryAllDeep. Use when the target has no visible text (icon buttons, custom-element placeholders like Reddit's collapsed comment composer, drop-zone overlays). Skips the textHint matcher entirely. \`nth\` still picks the Nth match.

Optionally pass an until_* clause to verify the click took effect:
- until_selector — CSS selector that should appear after the click
- until_url_contains — substring that should appear in the URL (requires an actual URL change if the substring was already in the pre-click URL)
- until_text_contains — substring that should appear in page text
- until_url_changes — ANY URL change (use for submits where the destination URL is unknown ahead of time)
- expect_submit — broad anti-bot detector for form submissions (toast, alert, modal, URL change, form removal). See note below.

Returns {success, message, before_url, after_url, navigated}. \`navigated\` is true when the post-click URL differs from the pre-click URL — surfaces silent redirects without a second list_tabs call. Refuses to click 0×0 elements and now ranks visible candidates above hidden when text/aria match; when forced to refuse a hidden element it surfaces the next visible candidate in the error message.

Scope matching with \`within_selector\` or \`near_text\` restricts where matches are searched — useful for long forms with repeated labels per section (e.g. one "Approve" radio per row). \`within_selector\` is a CSS selector; \`near_text\` finds the nearest container whose heading starts with the given text.

Shadow DOM (open AND closed) is pierced by default via chrome.dom.openOrClosedShadowRoot — Reddit faceplate-* / r-post-form-submit-button / web-component-heavy SPAs no longer need manual deepFind recipes.

ANTI-BOT SUBMIT CEILING — synthetic clicks on social/auth platforms (Reddit, X / Twitter, mcp.so) are silently rejected by isTrusted-aware form validators and CSRF/reCAPTCHA gates. Pass \`expect_submit: true\` to detect this case (returns success=false with "submit silently rejected" when no signal fires within 4s). For confirmed anti-bot sites, do NOT retry — pre-fill the form, then highlight the submit button and call wait_for_click so a real human gesture fires the submission.`,
    {
      textHint: z
        .string()
        .optional()
        .describe(
          "The visible label of the button or link (e.g. 'Save product', 'Continue', 'Add a product', 'Create'). Exactly one of textHint or selector must be set."
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the element to click (e.g. 'faceplate-textarea-input', '#open-composer', 'button[aria-label=\"More options\"]'). Pierces open AND closed shadow roots via queryAllDeep. Use when the target has no usable text. Exactly one of textHint or selector must be set."
        ),
      nth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which match to click when multiple elements share the same label (1 = first/topmost, default 1). Visible candidates are ranked above hidden, so a hidden flair-dropdown won't claim nth=1 over the visible submit button."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope to one frame when several contain the same label. Cross-origin frames are refused - use click_at_coordinates(frame=...) for those."),
      until_selector: z
        .string()
        .optional()
        .describe('Wait until this CSS selector appears on the page after the click (e.g. ".success-toast"). Returns success=false if it does not appear within until_timeout_ms.'),
      until_url_contains: z
        .string()
        .optional()
        .describe('Wait until the URL contains this substring after the click (e.g. "/checkout/complete"). If the substring was already in the pre-click URL, requires the URL to actually change before matching — prevents false positives on intra-prefix navigation like /tasks/OLD → /tasks/NEW with until_url_contains="tasks/".'),
      until_text_contains: z
        .string()
        .optional()
        .describe('Wait until the visible page text contains this substring after the click (e.g. "Listing published"). Returns success=false if it does not.'),
      until_url_changes: z
        .boolean()
        .optional()
        .describe('Wait until the URL changes after the click — for navigating submits whose destination URL is unknown ahead of time. Succeeds on any change away from the pre-click URL. Combine with until_url_contains for "must change AND must contain X".'),
      until_timeout_ms: z
        .number()
        .int()
        .min(500)
        .optional()
        .describe("How long to wait for the until-condition, in milliseconds (default 5000). Only used if one of until_* is set."),
      expect_submit: z
        .boolean()
        .optional()
        .describe('Broad anti-bot detector. After the click, watch up to 4s for ANY of: URL change, [role=alert] / [data-sonner-toast] / .toast / .notification / aria-live appearance, [role=dialog] / [aria-modal=true] appearance. Returns success=false with "submit silently rejected (likely anti-bot)" when no signal fires. Use on form submits when the until_* destination isn\'t known. Ignored when any until_* is set (those are more specific).'),
      within_selector: z
        .string()
        .optional()
        .describe('Limit candidate matches to this CSS selector\'s subtree (mirrors find_text\'s scope_selector). Use to scope nth-counting to one section of a long form: click_element("Approve", nth=1, within_selector="#section-b"). Returns success=false with scope_missed=true if the selector does not match.'),
      near_text: z
        .string()
        .optional()
        .describe('Find the nearest container whose heading starts with this text, then scope candidates to that container\'s subtree. Ignored when within_selector is set. Useful when the target section has no stable CSS selector but the heading is unique.'),
      try_fiber: z
        .boolean()
        .optional()
        .describe(`Opt-in last-resort fallback when silently_rejected fires. After the activity probe reports zero activity, chromeboost walks the React fiber tree from the matched element (up to 12 levels), finds the nearest \`__reactProps$.onClick\` prop, and invokes it with a minimal synthetic event. Now shadow-DOM-aware: when the element is inside a shadow root, the fiber walk searches for React root containers inside that shadow root instead of walking the light DOM. Returns fiber_attempted=true in the response when the path was taken. Do NOT default to this; reserve for repeat silently_rejected on a known-safe React site.`),
      activity_timeout_ms: z
        .number()
        .int()
        .min(500)
        .optional()
        .describe(`How long the activity probe watches for DOM mutations, focus changes, URL changes, or alert/toast/modal appearance after the click (default 1500ms). The probe returns early as soon as activity is detected, so the default adds only ~100ms on successful clicks. Increase to 2500-4000ms for buttons that trigger async API calls before producing visible DOM changes. The probe reports "silently_rejected" when zero activity is seen within this window; a higher value reduces false negatives but slows genuine rejection detection. For buttons where the click triggers a 3-5s API call with no immediate DOM change, use skip_activity_probe instead.`),
      skip_activity_probe: z
        .boolean()
        .optional()
        .describe(`Skip the 1500ms activity probe AND all automatic fallbacks (tap gesture, pointer chain, DOM .click(), fiber walk) after the CDP click. The click is dispatched and success is returned immediately without verifying page activity. Use for buttons that trigger slow async API calls (3-5s+) before producing visible DOM changes, where the activity probe would falsely report "silently_rejected" and the fallback chain would double-fire. Verify state yourself via find_text or execute_script after an appropriate delay. NOTE: this is set IMPLICITLY when any until_* clause is passed, since the until-clause already provides verification. WARNING: no automatic silent-rejection detection when this is set without an until-clause.`),
      via: z
        .enum(["auto", "cdp", "fiber"])
        .optional()
        .describe(`Click dispatch mode. "auto" (default): CDP click, then fiber fallback when try_fiber=true and the activity probe failed. "cdp": CDP click only, no fiber fallback ever. "fiber": skip the CDP bezier + activity probe entirely and invoke __reactProps$.onClick directly. Use "fiber" on React-heavy SPAs (Outlier-style dashboards) where you already know the site is fiber-only — cuts ~3 seconds of ceremony off the round trip. The fiber path is undocumented React internal access, prefer "auto" until you've confirmed the site needs it.`),
      in_dialog: z
        .boolean()
        .optional()
        .describe(`Scope candidate matches to the topmost open dialog (\`[role=dialog]\`, \`[role=alertdialog]\`, or \`<dialog open>\`), highest z-index wins. Use when Radix/Headless UI dialogs portal to document.body and a generic textHint like "Cancel" would otherwise match the wrong button. Returns scope_missed=true when no dialog is open.`),
      dialog_query: z
        .string()
        .optional()
        .describe(`Scope candidate matches to a specific dialog by heading or aria-label substring. Use when multiple dialogs are open and in_dialog (topmost) would pick the wrong one — e.g. click_element("Confirm", dialog_query="Delete account"). Mutually exclusive with in_dialog; dialog_query wins when both are set.`),
      wait_until_enabled_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`When the matched target is currently disabled (native disabled OR aria-disabled=true), poll for up to this many ms waiting for it to become enabled before clicking. Default 0 (do not wait — return target_disabled immediately). Use 2000-5000 for Submit-style buttons that briefly disable while an async copilot/validator/save is in flight. On timeout the response carries target_disabled=true plus a structured disabled_state snapshot (disabled, aria_disabled, pointer_events, opacity, visible) so the caller can decide between "wait more" or "field is genuinely missing — run get_form_fields(only_empty:true)".`),
      pierce_overlays: z
        .boolean()
        .optional()
        .describe(`ChromeBoost overlay piercing. ON by default. Before clicking, the target is hit-tested: if something is painted over it (cookie scrim, modal backdrop, sticky header, toast, invisible click-away catcher), those layers are temporarily given \`pointer-events: none\`, the SAME real CDP click is fired so isTrusted stays true, and every touched inline style is restored immediately. The response names what was pierced. Set false to disable and get the raw click plus an \`occluded_by\` report instead — useful when you WANT to click the overlay itself (e.g. dismissing a backdrop).`),
    },
    async ({ frame, textHint, selector, nth, until_selector, until_url_contains, until_text_contains, until_url_changes, until_timeout_ms, expect_submit, within_selector, near_text, try_fiber, activity_timeout_ms, skip_activity_probe, via, in_dialog, dialog_query, wait_until_enabled_ms, pierce_overlays }) => {
      // Validate exactly-one-of(textHint, selector)
      if ((!textHint && !selector) || (textHint && selector)) {
        return {
          content: [{ type: "text", text: "click_element requires exactly one of textHint or selector" }],
        };
      }
      // Identifier for error messages (which one the caller passed)
      const targetLabel = textHint ?? `selector="${selector}"`;
      // The WS request must outlive the until-poll, with a buffer for navigation.
      const wsTimeout = Math.max(30_000, (until_timeout_ms ?? 0) + 10_000);
      let response;
      try {
        response = await bridge.request(
          { type: "click_element", textHint, selector, nth, until_selector, until_url_contains, until_text_contains, until_url_changes, until_timeout_ms, expect_submit, within_selector, near_text, try_fiber, activity_timeout_ms, skip_activity_probe, via, in_dialog, dialog_query, wait_until_enabled_ms, pierce_overlays, frame },
          wsTimeout
        );
      } catch (err) {
        const errMsg = (err instanceof Error ? err.message : String(err));
        if (errMsg.includes("timed out")) {
          // Best-effort: ask the extension where the active tab is now. The
          // click handler may still be running, but a parallel list_tabs
          // request usually returns. If we see a URL, surface it — the agent
          // can decide whether the click actually landed.
          let stateLine = "";
          try {
            const tabsResp = await bridge.request({ type: "list_tabs" }, 3_000);
            const activeTab = (tabsResp as { tabs?: Array<{ url?: string; active?: boolean }> }).tabs?.find((t) => t.active);
            if (activeTab?.url) stateLine = `\nCurrent URL: ${activeTab.url}`;
          } catch { /* extension still busy or disconnected */ }
          return {
            content: [
              {
                type: "text",
                text: `Could not confirm click on "${targetLabel}": ${errMsg}. The click MAY have already fired — the page just took longer than ${wsTimeout}ms to respond. Verify with get_page_text or wait_for_selector before retrying. Re-clicking can toggle the wrong way on React-controlled radios.${stateLine}`,
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: `Could not click "${targetLabel}": ${errMsg}` },
          ],
        };
      }
      const r = response as {
        success: boolean;
        message: string;
        before_url?: string;
        after_url?: string;
        navigated?: boolean;
        scope_missed?: boolean;
        silently_rejected?: boolean;
        fiber_attempted?: boolean;
        recovered_via?: string;
        request_in_flight?: boolean;
        focused_after?: {
          tag: string;
          id: string;
          name: string;
          type: string;
          aria_label: string;
          value_preview: string;
        } | null;
      };
      // Surface silent redirects: a click whose post-URL differs from the
      // pre-URL is the canonical Canvas "Assessment link → course home" case.
      // Only emit the line when navigation actually happened so the
      // common-case output stays one line.
      const navLine = r.navigated && r.after_url ? `\n→ Navigated: ${r.after_url}` : "";
      // Surface focus landed after the click, so the agent knows whether to
      // chain type_text/fill_input on the same element. Omitted for radio /
      // checkbox / button targets where focus rarely lands on the focused
      // element of interest (and the line would be noise).
      let focusLine = "";
      const f = r.focused_after ?? null;
      if (f && !["button", "a"].includes(f.tag)) {
        const idBit = f.id ? `#${f.id}` : "";
        const nameBit = f.name ? ` name="${f.name}"` : "";
        const aria = f.aria_label ? ` aria-label="${f.aria_label.slice(0, 30)}"` : "";
        const valueBit = f.value_preview ? ` value="${f.value_preview.slice(0, 30)}"` : "";
        focusLine = `\n→ Focused: <${f.tag}${idBit}${nameBit}${aria}${valueBit}>`;
      }
      // Flow memory. Record this click as a notable "resolution" only when it
      // cost something to discover — a fallback fired, it navigated, or a
      // verified until_* clause was satisfied. Ordinary first-try clicks are
      // skipped (rediscovery is free; persisting them is noise). Recall surfaces
      // known flows for the origin once per session; capturable nudges a save.
      // Key the atom to where the click HAPPENED (before_url), not where it
      // landed — a submit on /submit that navigates to the new post page must
      // be recalled next time we're on /submit, not on the post page.
      const actionUrl = r.before_url ?? r.after_url;
      const nowUrl = r.after_url ?? r.before_url;
      const usedUntil = !!(until_selector || until_url_contains || until_text_contains || until_url_changes);
      if (r.success && (r.recovered_via || r.navigated || usedUntil)) {
        flowStore.observe({
          tool: "click_element",
          target: textHint ?? `selector=${selector}`,
          selector,
          recovered_via: r.recovered_via,
          signal: r.navigated ? "navigated" : until_url_changes ? "until_url_change" : usedUntil ? "until_*" : r.recovered_via,
          fragile: isFragileSelector(selector),
          reason: r.recovered_via ? `click recovered via ${r.recovered_via}` : r.navigated ? "navigating submit/link" : "verified terminal click",
        } as Atom, actionUrl);
      }
      flowStore.noteUrl(nowUrl);
      // Recall for where we are NOW; nudge save against where the steps accrued.
      const recall = flowStore.recallHint(nowUrl);
      const capturable = flowStore.capturableHint(actionUrl);

      if (!r.success) {
        return {
          content: [
            {
              type: "text",
              text: `Could not click "${targetLabel}": ${r.message}${navLine}${focusLine}${recall}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `${r.message}${navLine}${focusLine}${recall}${capturable}` }],
      };
    }
  );

  server.tool(
    "save_flow",
    `Persist the hard-won interaction steps chromeboost buffered for the current site as a reusable, named flow. chromeboost auto-buffers only NOTABLE resolutions (a click that needed a fallback, a verified submit, a field that needed real keystrokes) — so you just give the task a label and it commits whatever is buffered for the current origin. Next session, those steps are surfaced back as a known_flow hint so you skip the trial-and-error.

Call this when a response shows \`flow_capturable\`. Stored locally only (~/.chromeboost/flows.json), selectors/signals only — never typed text. Guidance, not autopilot: recalled steps are still verified on replay.`,
    {
      task_label: z.string().describe('Short human label for what this flow accomplishes, e.g. "submit text post", "set flair and submit", "log report time".'),
    },
    async ({ task_label }) => {
      const res = flowStore.commit(task_label);
      return { content: [{ type: "text", text: res.message }] };
    }
  );

  server.tool(
    "wait_for_click",
    `Wait for the user to click (or interact with) the currently highlighted element, then return.
Use this after highlighting a step so the flow advances automatically without the user returning to the chat.
After this resolves, highlight the next step immediately.
If the click causes page navigation, this resolves when the new page finishes loading.

Pass \`redispatch: true\` to turn the user's gesture into a CDP-dispatched isTrusted=true click. When the user clicks the highlighted area, chromeboost captures the coordinates and re-dispatches a full humanlike CDP click (bezier approach, settle hover, pointer events) at those exact coordinates. This produces an isTrusted=true event that passes anti-bot checks. Use for buttons that reject all synthetic clicks (shadow DOM buttons checking isTrusted, annotation dashboard "Collect Traces" buttons) where highlight_region + wait_for_click normally works but only the user's real gesture fires the action. With redispatch, the user still clicks, but chromeboost re-fires via CDP so subsequent automation (activity probe, state verification) works normally.`,
    {
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait for the click (default 120)"),
      redispatch: z
        .boolean()
        .optional()
        .describe('Re-dispatch the user\'s click via CDP at the captured coordinates (isTrusted=true). The user clicks the highlighted area, chromeboost captures the (x, y) and fires a full humanlike CDP click sequence at those coordinates. Use for anti-bot buttons that reject all synthetic clicks. Returns redispatched=true and redispatch_activity=true/false in the response.'),
    },
    async ({ timeout = 120, redispatch }) => {
      const watchMs = timeout * 1000;
      const response = await bridge.request(
        {
          type: "start_click_watch",
          timeout: watchMs,
          redispatch,
        },
        watchMs + 5_000,
      );

      const r = response as {
        type: string;
        url?: string;
        target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
        redispatched?: boolean;
        redispatch_activity?: boolean;
      };
      const targetLine = r.target
        ? `\nClicked element: <${r.target.tag}>${r.target.text ? ` "${r.target.text}"` : ""} at (${r.target.x}, ${r.target.y}) — selector: ${r.target.selector}`
        : "";
      const redispatchLine = r.redispatched
        ? `\nCDP re-dispatched: isTrusted=true click at (${r.target?.x ?? 0}, ${r.target?.y ?? 0})${r.redispatch_activity ? " — activity detected" : " — no immediate activity (async action may still be processing)"}`
        : "";

      if (r.type === "navigation_complete") {
        return {
          content: [
            {
              type: "text",
              text: `User clicked. Page navigated to: ${r.url ?? "(unknown)"}${targetLine}${redispatchLine}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `User clicked the highlighted element.${targetLine}${redispatchLine}` }],
      };
    }
  );

  server.tool(
    "click_at_coordinates",
    `Dispatch a real CDP mouse click at viewport (x, y). The only way to interact with cross-origin iframes — \`click_element\` refuses cross-origin frames because \`find_text\` can't enter them, but a CDP-level mouse event resolves at the renderer process and reaches the iframe's content the way an OS-level click does.

Coordinates are viewport CSS pixels, NOT screen coordinates. Pass \`frame\` to make them relative to a frame's own top-left corner instead — \`click_at_coordinates(frame: "iframe#builder", x: 50, y: 80)\` — and chromeboost adds the offset, including for a frame nested several levels deep. A point outside the named frame is refused rather than silently landing on the parent page.

Runs the same humanlike sequence as \`click_element\` (bezier approach path, settle-hover micro-tremor, press, release, post-click micro-move) so behavioural fingerprinters can't distinguish the call from any other chromeboost click. Skips the activity probe — cross-origin iframe activity isn't observable from the parent.

Refuses obviously-bad coordinates (negative, > 10000). Use this only when DOM matching has failed and you have a known target position from \`list_frames\` or a screenshot.

ChromeBoost: the response names the element that actually received the cursor (\`hit\`), so a click swallowed by a cookie banner is no longer indistinguishable from one that worked. When that element is visually transparent — the classic invisible click-catcher — the response says so and suggests \`pierce: true\`.

On a page whose main thread is saturated (heavy Angular/Ember dashboards — Google Analytics is the reference case), CDP input dispatch can stop acking in time. ChromeBoost shortens the gesture automatically when it detects high input latency, and if dispatch still can't finish it falls back to a synthetic click at the same point rather than failing. The response says which happened; a synthetic click is \`isTrusted=false\`, so an isTrusted-gated target will ignore it.`,
    {
      x: z.number().describe("Viewport CSS X coordinate (left=0). Get from list_frames or a screenshot grid."),
      y: z.number().describe("Viewport CSS Y coordinate (top=0). Get from list_frames or a screenshot grid."),
      button: z.enum(["left", "right", "middle"]).optional().describe('Mouse button (default "left").'),
      double: z.boolean().optional().describe("Fire a double-click instead of a single click. Default false."),
      pierce: z
        .boolean()
        .optional()
        .describe("Temporarily disable pointer interception on the topmost layer(s) at (x, y) so the click reaches the UI underneath, then restore. Default false — at a bare coordinate ChromeBoost can't know you meant the layer below, so this is opt-in. Use after a click reports it landed on a transparent catcher."),
      pierce_layers: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("How many stacked layers pierce may strip (default 3)."),
      frame: z
        .string()
        .optional()
        .describe(
          "Interpret x and y as offsets inside this frame rather than the page. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a substring of the frame's src / title / id. This is THE route into a cross-origin frame: chromeboost adds the frame's on-screen origin for you, and refuses a point that falls outside the frame instead of quietly clicking the parent page behind it."
        ),
    },
    async ({ x, y, button, double, pierce, pierce_layers, frame }) => {
      const response = await bridge.request({ type: "click_at_coordinates", x, y, button, double, pierce, pierce_layers, frame });
      const r = response as {
        success: boolean;
        message: string;
        before_url?: string;
        after_url?: string;
        navigated?: boolean;
        hit?: { selector: string; tag: string; text: string };
        degraded?: boolean;
      };
      const navLine = r.navigated && r.after_url ? `\n→ Navigated: ${r.after_url}` : "";
      return { content: [{ type: "text", text: `${r.message}${navLine}` }] };
    }
  );

  server.tool(
    "wait_for",
    `Wait for one of: a CSS selector to appear, a text substring (or any of an array of substrings) to appear, or an existing element's subtree to mutate. Pass exactly one of \`selector\`, \`text\`, or \`change_in\`. Pierces open AND closed shadow roots (text \`scope_selector\` pierces too). Pass \`shadow_root: true\` when waiting for the host's shadowRoot to attach (post-SPA-navigation hydration). \`scope_selector\` limits text-mode search; \`regex: true\` interprets text as a case-insensitive regex; \`frame: "iframe.selector"\` waits inside a same-origin iframe (text mode).

Text mode accepts an array — \`text: ["New session", "Error", "Stop"]\` resolves on the first match and the response carries \`matched_query\` so you know which entry fired. Useful for "wait for success OR failure" without a polling loop.

On timeout, the response carries \`last_text\` — the trailing 240 chars of the scope's content — so you can see the page state when the wait gave up. If the deploy panel shows "Starting up... 47%" and never reaches "Live", you'll see "Starting up... 47%" in last_text and know to extend the timeout instead of debugging a phantom failure.

Pass \`since: "now"\` in text mode to skip the initial check and only resolve on text appearing in a NEW DOM mutation — defeats the "stale instruction panels still in DOM" false-positive. When the wait DOES match on the initial check faster than 50ms, the response carries \`initial_match_warning\` suggesting since:"now" so you don't accidentally short-circuit on stale state.`,
    {
      selector: z.string().optional().describe("CSS selector to wait for."),
      text: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('Text substring(s) to wait for. String for single match, array for "any of" mode (resolves on the first match; response includes matched_query and matched_index).'),
      change_in: z.string().optional().describe("CSS selector of an existing element whose subtree should mutate (MutationObserver)."),
      timeout_ms: z.number().int().optional().describe("Max ms to wait (default 30000)."),
      poll_interval_ms: z.number().int().optional().describe("Selector-mode poll interval (default 500). Set to 15000 for slow server-side jobs."),
      shadow_root: z.boolean().optional().describe("Selector mode: require the matched host to have an attached shadowRoot. Default false."),
      scope_selector: z.string().optional().describe("Text mode: limit search to this CSS selector's subtree. Pierces shadow roots."),
      regex: z.boolean().optional().describe("Text mode: interpret query (each entry, if an array) as a case-insensitive regex."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope to one frame when several contain the same label. Text mode only."),
      since: z.enum(["now"]).optional().describe(`Text mode: gate on a NEW mutation. Skips the initial check so already-present matches don't short-circuit. Use when the page keeps stale text in the DOM after a route change (e.g. stacked instruction panels) and you need to wait for the next render.`),
      whole_word: z.boolean().optional().describe(`Text mode: gate matches on word boundaries. Use for common English words ("Live", "New", "Done") that would otherwise substring-match unrelated content (e.g. "Live" matching "delivery"). Default false.`),
      settle_ms: z.number().int().optional().describe("change_in mode: ms to wait after the first mutation for batching (default 150)."),
      max_chars: z.number().int().min(50).optional().describe("change_in mode: cap the returned text content (default 1000). Chat-style mutations can dump huge text; agents that need more should opt in explicitly."),
    },
    async (args) => {
      const { selector, text, change_in, timeout_ms, poll_interval_ms, shadow_root, scope_selector, regex, frame, since, settle_ms, max_chars, whole_word } = args;
      const isTextSet = text !== undefined && text !== null && !(Array.isArray(text) && text.length === 0) && text !== "";
      const set = [selector, isTextSet ? text : undefined, change_in].filter((v) => v !== undefined && v !== null && v !== "").length;
      if (set !== 1) {
        return { content: [{ type: "text", text: "wait_for: pass exactly one of selector, text, or change_in." }] };
      }
      const timeoutMs = timeout_ms ?? 30_000;
      if (selector !== undefined) {
        await bridge.request(
          { type: "wait_for_selector", selector, timeout: timeoutMs, refresh: poll_interval_ms, shadow_root },
          timeoutMs + 5_000
        );
        const suffix = shadow_root ? " (with attached shadowRoot)" : "";
        return { content: [{ type: "text", text: `Selector "${selector}" found on page${suffix}.` }] };
      }
      if (text !== undefined) {
        const response = await bridge.request(
          { type: "wait_for_text", query: text, timeout_ms: timeoutMs, scope_selector, regex, frame, since, whole_word },
          timeoutMs + 5_000
        );
        const r = response as {
          found: boolean;
          selector?: string;
          text?: string;
          context?: string;
          matched_query?: string;
          matched_index?: number;
          elapsed_ms: number;
          last_text?: string;
          initial_match_warning?: string;
          frame_error?: string;
        };
        if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
        const display = Array.isArray(text)
          ? text.map((t) => `"${t}"`).join(" / ")
          : `"${text}"`;
        if (!r.found) {
          const tail = r.last_text ? `\nLast text seen in scope (trailing 240 chars): ${JSON.stringify(r.last_text)}` : "";
          return { content: [{ type: "text", text: `Text ${display} did not appear within ${timeoutMs}ms.${tail}` }] };
        }
        const whichMatched = r.matched_query
          ? `\nmatched: "${r.matched_query}" (index ${r.matched_index})`
          : "";
        const warn = r.initial_match_warning ? `\n⚠ ${r.initial_match_warning}` : "";
        return { content: [{ type: "text", text: `Found ${display} after ${r.elapsed_ms}ms.${whichMatched}\nselector: ${r.selector}\ncontext: ${r.context}${warn}` }] };
      }
      // change_in mode
      const response = await bridge.request(
        { type: "wait_for_change", selector: change_in!, timeout: timeoutMs, settle: settle_ms ?? 150 },
        timeoutMs + 5_000
      );
      const r = response as unknown as { ok: boolean; text?: string; message?: string };
      if (!r.ok) return { content: [{ type: "text", text: r.message ?? `wait_for change_in timed out on "${change_in}"` }] };
      const fullText = r.text ?? "";
      const cap = max_chars ?? 1000;
      const preview = fullText.length > cap
        ? `${fullText.slice(0, cap)}... [truncated, ${fullText.length} chars total — pass max_chars to see more]`
        : fullText;
      return { content: [{ type: "text", text: `Element "${change_in}" changed.\n\n${preview}` }] };
    }
  );

  server.tool(
    "scroll_to_element",
    `Scroll an element into view by CSS selector or label/text match.
Use this instead of guessing scroll amounts when you know which field or section you need to reach.
Examples: scroll_to_element("#submit-btn"), scroll_to_element("Billing address"), scroll_to_element(".cm-editor")

Resolves into same-origin iframes. When the match is inside one, the frame is named in the response and the reported document y is measured within THAT frame, since that is the document being scrolled.`,
    {
      query: z.string().describe("CSS selector (e.g. '#my-input', '.section-header') or visible text / label to search for"),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope to one frame when several contain the same label."),
    },
    async ({ query, frame }) => {
      const response = await bridge.request({ type: "scroll_to_element", query, frame });
      const msg = (response as { message?: string }).message ?? `Scrolled to element matching "${query}".`;
      return { content: [{ type: "text", text: msg }] };
    }
  );

  server.tool(
    "find_text",
    `Search the active page for text and return actionable matches (text, surrounding context, best-effort CSS selector, clickable flag). Use this instead of get_page_text when checking "is X on the page?" or locating a clickable target. Pierces open AND closed shadow roots AND same-origin iframes; matches inside a frame carry a \`frame\` field naming it, and their \`position\` is already translated to page coordinates so it can be fed straight to click_at_coordinates.

When visible_only=true (the default) filters out all matches AND there were hidden matches, the response surfaces the hidden count so you can re-run with visible_only=false instead of guessing "is this on the page or not?"

Scope helpers: \`in_dialog: true\` restricts the search to the topmost open dialog; \`dialog_query: "Select"\` restricts it to a dialog whose heading or aria-label matches. Mirrors click_element's dialog scoping so the same flag works across discovery and action.`,
    {
      query: z.string().describe("Text to search for. Substring by default; regex=true → case-insensitive regex."),
      max: z.number().int().min(1).optional().describe("Maximum matches to return (default 5). total_matches is reported even when truncated."),
      scope_selector: z.string().optional().describe("Limit search to a CSS selector's subtree."),
      regex: z.boolean().optional().describe("Treat query as regex (case-insensitive). Default false."),
      visible_only: z.boolean().optional().describe("Skip display:none / visibility:hidden / aria-hidden=true. Default true."),
      context_chars: z.number().int().min(0).optional().describe("Surrounding context chars per match (default 40)."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope to one frame when several contain the same label."),
      in_dialog: z.boolean().optional().describe("Scope to the topmost open [role=dialog] / [role=alertdialog] / <dialog open>. Mirrors click_element."),
      dialog_query: z.string().optional().describe("Scope to the dialog whose heading or aria-label contains this substring. Mirrors click_element."),
      whole_word: z.boolean().optional().describe(`Gate matches on word boundaries. Use for common English words ("Live", "New", "Done", "Confirm") that would otherwise substring-match unrelated pre-rendered content (e.g. "Live" matching "delivery", "Done" matching "abandoned"). Default false to preserve the substring-by-default contract; flip on whenever your query is a single common word that may also appear inside larger words.`),
    },
    async ({ query, max, scope_selector, regex, visible_only, context_chars, frame, in_dialog, dialog_query, whole_word }) => {
      const response = await bridge.request({
        type: "find_text",
        query,
        max: max ?? 5,
        scope_selector,
        regex,
        visible_only,
        context_chars: context_chars ?? 40,
        frame,
        in_dialog,
        dialog_query,
        whole_word,
      });
      const r = response as unknown as {
        matches: Array<{
          text: string;
          context: string;
          selector: string;
          tag: string;
          role: string | null;
          clickable: boolean;
          position: { x: number; y: number; width: number; height: number } | null;
        }>;
        total_matches: number;
        hidden_count?: number;
        truncated: boolean;
        scope_missed?: boolean;
        frame_error?: string;
      };
      if (r.frame_error) {
        return { content: [{ type: "text", text: r.frame_error }] };
      }
      if (r.scope_missed) {
        return {
          content: [
            { type: "text", text: `Scope selector "${scope_selector}" did not match any element — no search performed.` },
          ],
        };
      }
      if (r.matches.length === 0) {
        // Distinguish "not on page" from "on page but hidden" so the agent
        // doesn't guess at visible_only=false unnecessarily.
        const hidden = r.hidden_count ?? 0;
        const hint = visible_only !== false && hidden > 0
          ? ` ${hidden} hidden match(es) skipped (display:none / visibility:hidden / aria-hidden / off-viewport). Set visible_only=false to include them.`
          : "";
        return {
          content: [
            { type: "text", text: `No visible matches found for "${query}".${hint}` },
          ],
        };
      }
      const lines = r.matches.map((m, i) => {
        const role = m.role ? `, role=${m.role}` : "";
        const click = m.clickable ? " — clickable" : "";
        const pos = m.position
          ? ` at (${m.position.x}, ${m.position.y}, ${m.position.width}×${m.position.height})`
          : "";
        return `  ${i + 1}. [${m.tag}${role}]${click}${pos} — selector: ${m.selector}\n     "${m.text}"\n     context: ${m.context}`;
      });
      const header = r.truncated
        ? `Found ${r.matches.length} of ${r.total_matches} matches for "${query}":`
        : `Found ${r.matches.length} match${r.matches.length === 1 ? "" : "es"} for "${query}":`;
      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "fill_form",
    `Fill multiple form fields in a single call by targeting each field by its label text.
Use this instead of calling fill_input repeatedly — it fills all fields in one round trip and returns a per-field success report.
Ideal for forms with many textareas or inputs where each fill would otherwise require a separate tool call.
fields is an array of {label, value} pairs. label should match the field's visible label, placeholder, or aria-label.

Each per-field result includes the matched element description (e.g. \`<input name="title" id="..." placeholder="...">\`) so Claude can spot when fill_form picked the wrong field.

Pass \`exact: true\` for forms with short generic labels (like "Rate" or "Amount") that may collide with similarly-labeled neighbours — fields without an exact aria-label/placeholder/name/id/label-text match will return success=false instead of silently filling the wrong field.`,
    {
      fields: z.array(
        z.object({
          label: z.string().describe("Visible label, placeholder, or aria-label of the field"),
          value: z.string().describe("Value to fill in"),
        })
      ).describe("List of fields to fill"),
      exact: z
        .boolean()
        .optional()
        .describe("If true, refuse fuzzy text-walk matches for every field. Default false."),
    },
    async ({ fields, exact }) => {
      const response = await bridge.request({ type: "fill_form", fields, exact });
      const r = response as { results: Array<{ label: string; success: boolean; message: string; matched?: string }>; succeeded: number; total: number };
      const lines = r.results.map(f => `${f.success ? "✓" : "✗"} "${f.label}": ${f.message}`);
      return {
        content: [{
          type: "text",
          text: `Filled ${r.succeeded}/${r.total} fields:\n${lines.join("\n")}`,
        }],
      };
    }
  );

  server.tool(
    "list_frames",
    `Map every frame boundary on the active page: iframes/frames at ANY nesting depth, same-origin and cross-origin, plus the shadow-host inventory. This is the discovery call to make when a selector "does not exist" on a page where you can plainly see the element.

Each frame's \`selector\` is an address other tools accept verbatim as \`frame\`. For a nested frame it is a path: \`iframe#shell >>> iframe.builder\`. You can also address a frame by a substring of its src, title, or id, which is usually shorter and more stable than a generated class list.

Per-frame fields:
- selector: pass to any tool's \`frame\` parameter
- depth: 1 for a top-level frame, 2 for a frame inside a frame, and so on
- src: the frame's src attribute (may be empty for about:blank frames)
- url: the frame's CURRENT document URL, which differs from src once the frame navigates
- origin: parsed origin (e.g. "https://canvadoc.instructure.com")
- accessible: true when DOM tools can read it (same-origin), false otherwise
- title: the frame's title attribute, often the most human-readable identifier
- x, y, width, height: the frame's VISIBLE box in viewport CSS pixels, already clipped by any ancestor frame
- content_origin_x / content_origin_y: where the frame's own (0, 0) sits in page coordinates

Same-origin frames need no special handling: click_element, find_text, fill_input, hover, drag, get_form_fields and the rest resolve into them automatically and translate coordinates back to page space, and they report a \`frame\` field when a match came from one. Use \`frame\` to disambiguate when two frames hold the same label.

Cross-origin frames cannot be read or queried by any DOM tool — that is the same-origin policy, not a chromeboost limitation. Three routes do work, and each frame's \`hint\` names them:
- click_at_coordinates(frame: "<selector>", x, y) — CDP input resolves at the renderer, so it reaches the frame like an OS click. Coordinates are relative to the frame.
- execute_script(frame: "<selector>", code) — injected per frame under the extension's own permissions.
- fetch_url(src) for its HTML, take_screenshot for its pixels.

Per-shadow-host fields:
- selector: short CSS hint for the host element (tag, id, or .class)
- open: true if the shadow root is exposed via \`el.shadowRoot\` (most web components), false if it is closed (Radix portals, Stencil/Lit defaults) — closed roots are invisible to execute_script but pierced by chromeboost's other tools.
- depth: nesting depth (0 = top-level host attached directly to the document)

Shadow hosts are capped at 25 to keep the response compact.`,
    {},
    async () => {
      const response = await bridge.request({ type: "list_frames" });
      if (response.type !== "list_frames_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as {
        frames: Array<{
          index: number; selector: string; depth?: number; src: string; origin: string; title: string;
          accessible: boolean; cross_origin?: boolean; url?: string; hint?: string;
          x: number; y: number; width: number; height: number;
          content_origin_x?: number; content_origin_y?: number;
        }>;
        shadow_hosts?: Array<{ selector: string; open: boolean; depth: number }>;
      };
      // Build a shadow-host section. Surfacing this here means the agent gets
      // the full "is this page using shadow DOM?" picture in one call —
      // matches the user's expectation that list_frames is the
      // discoverability tool for frame-like boundaries.
      const hosts = r.shadow_hosts ?? [];
      const closedCount = hosts.filter((h) => !h.open).length;
      const openCount = hosts.length - closedCount;
      let shadowSection = "";
      if (hosts.length > 0) {
        const hostLines = hosts.map((h) => {
          const kind = h.open ? "open" : "closed";
          const indent = "  ".repeat(h.depth);
          return `  ${indent}${h.selector} [${kind}]`;
        });
        shadowSection =
          `\n\nShadow hosts (${hosts.length}: ${openCount} open, ${closedCount} closed):` +
          (closedCount > 0
            ? "\n  (Closed roots are invisible to execute_script. Use find_text / get_page_text / click_element / fill_input — they pierce.)"
            : "") +
          "\n" + hostLines.join("\n");
      }
      if (r.frames.length === 0) {
        const noFrames = "No iframes or frames on this page.";
        return { content: [{ type: "text", text: hosts.length > 0 ? `${noFrames}${shadowSection}` : noFrames }] };
      }
      const reachable = r.frames.filter((f) => f.accessible).length;
      const blocked = r.frames.length - reachable;
      const lines = r.frames.map((f) => {
        const access = f.accessible ? "same-origin" : "cross-origin";
        const titleBit = f.title ? ` "${f.title}"` : "";
        const originBit = f.origin || "(no origin)";
        // Indent by nesting depth so a frame tree reads as a tree.
        const indent = "  ".repeat(Math.max(0, (f.depth ?? 1) - 1));
        const head = `${f.index}. ${indent}${f.selector}${titleBit} — ${originBit} [${access}] — ${f.width}x${f.height} @ (${f.x},${f.y})`;
        const srcLine = f.src ? `\n   ${indent}src: ${f.src}` : "";
        // Only show url when it actually differs from src; repeating it is noise.
        const urlLine = f.url && f.url !== f.src ? `\n   ${indent}url: ${f.url}` : "";
        const hintLine = f.hint ? `\n   ${indent}${f.hint}` : "";
        return head + srcLine + urlLine + hintLine;
      });
      const header = `Found ${r.frames.length} frame${r.frames.length === 1 ? "" : "s"} (${reachable} same-origin, ${blocked} cross-origin):`;
      const footer = reachable > 0
        ? `\n\nSame-origin frames are searched automatically by click_element / find_text / fill_input / hover / drag / get_form_fields — pass \`frame\` only to disambiguate.`
        : "";
      return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}${footer}${shadowSection}` }] };
    }
  );

}
