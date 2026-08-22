import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerHighlightTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "highlight_region",
    `Show the user where to look with an instructional callout. Pass exactly one of:
- text — search the page for this visible text, highlight the match
- selector — CSS selector, highlight the matched element
- x/y/width/height — pixel rectangle (use only when DOM lookup failed)

Text and selector lookups reach into same-origin iframes, and the callout is positioned in page coordinates either way — which matters because this is the handoff path for anything Claude cannot click itself, and a box drawn over the wrong part of the page is worse than none.

Returns whether the element was found. Set valueToType only when the user must personally type a sensitive value (password, payment data) — otherwise Claude should auto-fill after the click.`,
    {
      text: z.string().optional().describe("Visible text of the target element or text near it (e.g. 'API Keys', 'Create account')."),
      selector: z.string().optional().describe("CSS selector of the element to highlight (e.g. '#upload-zone'). The extension scrolls it into view automatically."),
      x: z.number().optional().describe("Left edge in CSS pixels — only when no selector/text."),
      y: z.number().optional().describe("Top edge in CSS pixels — only when no selector/text."),
      width: z.number().optional().describe("Width in CSS pixels — only when no selector/text."),
      height: z.number().optional().describe("Height in CSS pixels — only when no selector/text."),
      message: z.string().describe("Instruction to show the user in the callout."),
      valueToType: z.string().optional().describe("Only when the user must personally type a sensitive value. Omit when Claude will auto-fill."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a substring of the frame's src / title / id. The callout is drawn in page coordinates, so a frame-hosted target is translated automatically."),
    },
    async ({ text, selector, x, y, width, height, message, valueToType, frame }) => {
      if (text) {
        const response = await bridge.request({ type: "find_highlight", text, message, valueToType });
        if (response.type !== "find_highlight_response") throw new Error("Unexpected response");
        return {
          content: [{
            type: "text",
            text: response.found ? `Element containing "${text}" highlighted.` : `Element containing "${text}" not found.`,
          }],
        };
      }
      await bridge.request({ type: "highlight_region", selector, x, y, width, height, message, valueToType, frame });
      return {
        content: [{
          type: "text",
          text: selector ? `Highlighted "${selector}".` : `Region highlighted at (${x ?? 0},${y ?? 0}) ${width ?? 0}×${height ?? 0}.`,
        }],
      };
    }
  );
}
