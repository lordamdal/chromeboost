import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

/**
 * ChromeBoost cursor tools.
 *
 * A click-only tool surface leaves whole classes of UI unreachable, because
 * plenty of interfaces are not click-shaped:
 *
 *   - hover-only UI — menu bars that open a submenu on mouseenter, row action
 *     buttons rendered at opacity 0 until hovered, tooltips, chart crosshairs
 *   - drag-shaped UI — range sliders, canvas/WebGL apps, map panning, Kanban
 *     reordering, resize handles, signature pads
 *   - overlay-covered UI — anything sitting under a scrim, backdrop, sticky
 *     bar, or invisible click-away catcher
 *
 * These tools cover all three, plus `probe_point` for diagnosing why a click
 * that "succeeded" did nothing.
 */
export function registerCursorTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "hover",
    `Move the real cursor onto an element (or a raw coordinate) and leave it there, using a trusted CDP mouse path.

Use this for UI that only exists while hovered:
- nav bars that open a submenu on mouseenter (no click target exists to match)
- "…" / edit / delete buttons rendered at \`opacity: 0\` until the row is hovered
- tooltips and popovers whose text you need to read
- chart crosshairs and data-point readouts

The pointer approaches along an eased path (not a teleport) so behavioural fingerprinters see natural motion, then holds still for \`settle_ms\` so mouseenter handlers and CSS transitions actually run.

IMPORTANT: hover-revealed UI disappears as soon as the pointer moves. Read the page (get_page_text / find_text) or click the revealed element on your NEXT call — do not take a screenshot first if the screenshot path would move the cursor.

Pass exactly one of \`selector\`, \`text\`, or \`x\`+\`y\`.`,
    {
      selector: z.string().optional().describe("CSS selector of the element to hover. Pierces open AND closed shadow roots."),
      text: z.string().optional().describe("Visible text of the element to hover, when it has no stable selector."),
      x: z.number().optional().describe("Viewport CSS X coordinate. Use with y when there is no DOM element (canvas, cross-origin iframe)."),
      y: z.number().optional().describe("Viewport CSS Y coordinate."),
      settle_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe("How long to hold the cursor still after arriving, in ms (default 220). Raise to 600-1000 for menus with an intentional open delay."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope the search to one frame when several contain the same label. Cross-origin frames are refused here - use click_at_coordinates(frame=...) or execute_script(frame=...)."),
    },
    async ({ selector, text, x, y, settle_ms, frame }) => {
      const coordSet = x !== undefined && y !== undefined;
      const provided = [selector, text, coordSet ? "coords" : undefined].filter(Boolean).length;
      if (provided !== 1) {
        return {
          content: [{ type: "text", text: "hover: pass exactly one of selector, text, or x+y." }],
        };
      }
      const response = await bridge.request(
        { type: "hover", selector, text, x, y, settle_ms, frame },
        20_000
      );
      const r = response as { success: boolean; message: string };
      return { content: [{ type: "text", text: r.message }] };
    }
  );

  server.tool(
    "drag",
    `Press the mouse at one point, move along a path, and release at another — a real CDP press-move-release with intermediate move events.

This is the only way to drive UI that has no clickable DOM node:
- range sliders and volume/price controls (\`<input type=range>\` and custom ones)
- canvas / WebGL apps, drawing surfaces, signature pads
- map panning and zoom-box selection
- drag-and-drop reordering (Kanban cards, sortable lists, file drop zones)
- any of the above inside an iframe: selectors resolve into same-origin frames and the endpoints are translated to page coordinates automatically
- resize handles and split-pane dividers

Intermediate moves matter: HTML5 drag-and-drop and every JS drag library ignore a press/release pair with no motion between them, which is why a pair of clicks never works for these.

Specify each end as either a selector or raw coordinates: \`from_selector\`/\`to_selector\`, or \`from_x\`+\`from_y\`/\`to_x\`+\`to_y\`. The two ends are independent — dragging a slider handle to a coordinate is the common case.`,
    {
      from_selector: z.string().optional().describe("CSS selector for the drag start (e.g. the slider thumb, the card to move). Pierces shadow roots."),
      from_x: z.number().optional().describe("Viewport CSS X to start the drag from. Use with from_y instead of from_selector."),
      from_y: z.number().optional().describe("Viewport CSS Y to start the drag from."),
      to_selector: z.string().optional().describe("CSS selector for the drop target (e.g. the destination column)."),
      to_x: z.number().optional().describe("Viewport CSS X to release at. Use with to_y instead of to_selector."),
      to_y: z.number().optional().describe("Viewport CSS Y to release at."),
      steps: z
        .number()
        .int()
        .min(6)
        .max(60)
        .optional()
        .describe("How many intermediate move events to emit (default 24). Raise for long drags across a canvas; lower for a short slider nudge."),
      hold_ms: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe("How long to dwell after pressing before moving, in ms (default 90). Raise to 300-600 for libraries that require a long-press before a drag starts (touch-style sortable lists)."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Same-origin frames are already searched without this, with top-frame matches ranked first; pass it to scope the search to one frame when several contain the same label. Cross-origin frames are refused here - use click_at_coordinates(frame=...) or execute_script(frame=...). Raw from_x/from_y/to_x/to_y become relative to the frame's own top-left corner, so a kanban board inside a builder frame can be driven with the coordinates you read off it."),
    },
    async (args) => {
      const { from_selector, from_x, from_y, to_selector, to_x, to_y, steps, hold_ms, frame } = args;
      const hasFrom = !!from_selector || (from_x !== undefined && from_y !== undefined);
      const hasTo = !!to_selector || (to_x !== undefined && to_y !== undefined);
      if (!hasFrom || !hasTo) {
        return {
          content: [
            {
              type: "text",
              text: "drag: needs a start and an end. Give each as a selector (from_selector / to_selector) or as coordinates (from_x+from_y / to_x+to_y).",
            },
          ],
        };
      }
      const response = await bridge.request(
        { type: "drag", from_selector, from_x, from_y, to_selector, to_x, to_y, steps, hold_ms, frame },
        45_000
      );
      const r = response as { success: boolean; message: string };
      return { content: [{ type: "text", text: r.message }] };
    }
  );

  server.tool(
    "probe_point",
    `Report the stack of elements painted at a viewport coordinate, outermost-last, descending through open AND closed shadow roots.

This is the diagnostic for the most confusing failure in browser automation: a click that reports success while the page does nothing. That almost always means something invisible is on top — a modal backdrop, a cookie scrim, a chat bubble, or a transparent click-away catcher. \`probe_point\` names it.

Typical loop: \`click_element\` reports \`occluded\` → \`probe_point\` at the reported coordinate to see the stack → either dismiss the overlay properly, or re-click with \`pierce_overlays: true\` (the default) / \`click_at_coordinates(pierce: true)\`.

Hit testing descends through same-origin iframes as well as shadow roots, so the reported element is the real one inside the frame rather than the \`<iframe>\` wrapper. Each layer carries a \`frame\` path when it lives in one, which is directly usable as another tool's \`frame\` argument. A bare \`<iframe>\` at the top of the stack now means specifically a CROSS-ORIGIN frame: nothing can see inside it, so drive it with \`click_at_coordinates(frame: ..., x, y)\`.`,
    {
      x: z.number().describe("Viewport CSS X coordinate (left=0)."),
      y: z.number().describe("Viewport CSS Y coordinate (top=0)."),
    },
    async ({ x, y }) => {
      const response = await bridge.request({ type: "probe_point", x, y });
      const r = response as {
        stack?: Array<{ tag: string; selector: string; text: string; z_index: string; position: string; frame?: string }>;
        top?: { selector: string; transparent: boolean; full_screen_scrim: boolean; pinned: boolean };
        in_iframe?: boolean;
        frame?: string;
      };
      const stack = r.stack ?? [];
      if (stack.length === 0) {
        return { content: [{ type: "text", text: `Nothing painted at (${x}, ${y}) — the coordinate may be outside the viewport.` }] };
      }
      const lines = stack.map((s, i) => {
        const bits = [`z-index:${s.z_index}`, s.position];
        if (s.frame) bits.push(`in iframe ${s.frame}`);
        return `${i === 0 ? "→ TOP  " : "       "}<${s.tag}> ${s.selector} [${bits.join(", ")}]${s.text ? ` "${s.text.slice(0, 50)}"` : ""}`;
      });
      const notes: string[] = [];
      if (r.top?.transparent) notes.push("The topmost element is visually transparent — a click-catcher overlay. Retry the click with pierce enabled.");
      if (r.top?.full_screen_scrim) notes.push("The topmost element covers the viewport — a modal backdrop. Close the modal, or pierce it.");
      if (r.top?.pinned) notes.push("The topmost element is position:fixed/sticky — scrolling the target away from it may be enough.");
      if (r.frame) {
        notes.push(`The element here lives inside same-origin iframe ${r.frame}. DOM tools reach it: click_element / find_text / fill_input resolve into it automatically, and you can pass frame: "${r.frame}" to scope to it.`);
      } else if (r.in_iframe) {
        notes.push("The topmost element is a cross-origin <iframe> — no DOM tool can enter it. Use click_at_coordinates(frame: \"<selector from list_frames>\", x, y), which dispatches at the renderer and does reach it.");
      }
      return {
        content: [
          {
            type: "text",
            text: `Element stack at (${x}, ${y}):\n${lines.join("\n")}${notes.length ? `\n\n${notes.map((n) => `⚠ ${n}`).join("\n")}` : ""}`,
          },
        ],
      };
    }
  );

  server.tool(
    "hud",
    `Control the ChromeBoost HUD — the small floating panel shown on the page while you are driving the browser.

The user can already drag it by its header, collapse it by double-clicking that header, dismiss it with ×, and bring it back with Alt+Shift+B; position and state persist across pages. This tool is for when the HUD itself is in the way of the work:

- \`hide\` / \`show\` — take it off the page entirely (e.g. it overlaps the element you need to click, or the user asked for a clean recording)
- \`collapse\` / \`expand\` — shrink to a compact pill
- \`dock\` — drop it into a named corner
- \`move\` — place it at exact viewport coordinates
- \`status\` — write a one-line message into the panel so the user can see what you are doing

The HUD is already excluded from \`take_screenshot\` automatically, so you do not need to hide it before capturing.`,
    {
      action: z
        .enum(["show", "hide", "collapse", "expand", "dock", "move", "status", "state"])
        .describe("What to do. Use `state` to read the current position and visibility without changing anything."),
      corner: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional()
        .describe('Target corner for action="dock".'),
      x: z.number().optional().describe('Viewport CSS X of the panel\'s top-left corner, for action="move".'),
      y: z.number().optional().describe('Viewport CSS Y of the panel\'s top-left corner, for action="move".'),
      text: z.string().optional().describe('Status line to display, for action="status". Auto-clears to "Idle" after a few seconds.'),
    },
    async ({ action, corner, x, y, text }) => {
      if (action === "dock" && !corner) {
        return { content: [{ type: "text", text: 'hud: action="dock" needs a corner (top-left, top-right, bottom-left, bottom-right).' }] };
      }
      if (action === "move" && (x === undefined || y === undefined)) {
        return { content: [{ type: "text", text: 'hud: action="move" needs both x and y.' }] };
      }
      const response = await bridge.request({ type: "hud_control", action, corner, x, y, text });
      const r = response as {
        success?: boolean;
        message?: string;
        state?: { x: number; y: number; collapsed: boolean; hidden: boolean; present: boolean };
      };
      const s = r.state;
      const stateLine = s
        ? `\nHUD state: ${s.hidden ? "hidden" : s.collapsed ? "collapsed" : "expanded"} at (${Math.round(s.x)}, ${Math.round(s.y)})${s.present ? "" : " (not currently injected on this page)"}`
        : "";
      return { content: [{ type: "text", text: `${r.message ?? "HUD updated"}${stateLine}` }] };
    }
  );
}
