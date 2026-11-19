import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerBrowserMgmtTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "list_browsers",
    `List all Chrome browsers currently connected to this MCP server. Each browser is a separate Chrome profile with its own logins, cookies, and extensions. Use this to see which profiles are available before calling select_browser.

Returns each browser's id, profile name, profile email, whether it is the active target, and when it connected.`,
    {},
    async () => {
      const browsers = bridge.listBrowsers();
      if (browsers.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No Chrome browsers connected. Open Chrome with the ChromeBoost extension installed. To use multiple profiles, open each Chrome profile and ensure ChromeBoost is installed in each one.",
          }],
        };
      }
      const lines = browsers.map((b) => {
        const parts: string[] = [];
        parts.push(`id: ${b.id}`);
        if (b.profileName) parts.push(`profile: ${b.profileName}`);
        if (b.profileEmail) parts.push(`email: ${b.profileEmail}`);
        parts.push(b.active ? "active: YES" : "active: no");
        return parts.join("  |  ");
      });
      return {
        content: [{
          type: "text",
          text: `${browsers.length} browser(s) connected:\n${lines.join("\n")}`,
        }],
      };
    }
  );

  server.tool(
    "select_browser",
    `Switch which Chrome browser receives subsequent tool calls. Accepts a browser id, profile name, or profile email (case-insensitive substring match). All tools after this call target the selected browser until you call select_browser again.

Use list_browsers first to see what is available. When only one browser is connected it is selected automatically.`,
    {
      browser: z.string().describe("Browser id, profile name, or email to match"),
    },
    async ({ browser }) => {
      const result = bridge.selectBrowser(browser);
      if (!result) {
        const available = bridge.listBrowsers();
        if (available.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No browsers connected. Cannot select "${browser}".`,
            }],
          };
        }
        const names = available.map((b) =>
          b.profileName ? `"${b.profileName}" (${b.id})` : b.id
        ).join(", ");
        return {
          content: [{
            type: "text",
            text: `No browser matching "${browser}". Connected: ${names}`,
          }],
        };
      }
      const label = result.profileName
        ? `${result.profileName} (${result.id})`
        : result.id;
      return {
        content: [{
          type: "text",
          text: `Active browser set to: ${label}`,
        }],
      };
    }
  );
}
