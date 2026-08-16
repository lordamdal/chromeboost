import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./ws-bridge.js";
import { FlowStore } from "./flow-store.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerHighlightTools } from "./tools/highlight.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerFlowTools } from "./tools/flow.js";
import { registerCursorTools } from "./tools/cursor.js";
import { flushUsage } from "./usage.js";

declare const __CHROMEBOOST_VERSION__: string;
const PACKAGE_VERSION: string =
  typeof __CHROMEBOOST_VERSION__ !== "undefined" ? __CHROMEBOOST_VERSION__ : "dev";

export const SUPPORT_URL = "https://buy.stripe.com/6oU6oHbqTcD8gSQ1rQbAs00";

/**
 * Which CLI spawned us, for display only.
 *
 * Claude Code sets CLAUDE_PLUGIN_ROOT on the spawned process. Codex and Gemini
 * do not forward anything host-specific, so their launchers set
 * CHROMEBOOST_HOST explicitly. Mirrors the detection in ws-bridge.ts, which
 * sends the same value to the extension popup for its host badge.
 */
function hostDisplayName(): string {
  const raw = process.env.CHROMEBOOST_HOST
    ?? (process.env.CLAUDE_PLUGIN_ROOT ? "claude" : undefined);
  if (!raw) return "Your agent";
  const known: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
  return known[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Startup banner on stderr — the one surface every user sees every session.
 *
 * Kept to four lines and printed once at boot: a support ask that scrolls past
 * on every tool call would be noise, and noise is how you get muted. Colour is
 * applied only when stderr is a TTY, and suppressed under NO_COLOR, so piped
 * logs stay clean.
 */
function banner(toolCount: number, port: number | null): string {
  const tty = process.stderr.isTTY && !process.env.NO_COLOR;
  const c = (code: string, s: string) => (tty ? `[${code}m${s}[0m` : s);
  const dim = (s: string) => c("2", s);
  const bold = (s: string) => c("1", s);
  const cyan = (s: string) => c("36", s);
  const amber = (s: string) => c("33", s);

  const where = port ? `ws://localhost:${port}` : "starting…";
  return [
    "",
    `  ${amber("⚡")} ${bold("ChromeBoost")} ${dim(`v${PACKAGE_VERSION}`)}  ${dim("·")}  ${toolCount} tools  ${dim("·")}  ${dim(where)}`,
    `  ${dim(`${hostDisplayName()} now has hands in your real Chrome, logged in as you.`)}`,
    `  ${amber("☕")} ${dim("Free and MIT. If it saved you an afternoon:")} ${cyan(SUPPORT_URL)}`,
    "",
  ].join("\n");
}

main().catch((err) => { console.error("[chromeboost] Fatal error:", err); process.exit(1); });

async function main() {
  const bridge = new WsBridge();
  const flowStore = new FlowStore(PACKAGE_VERSION);

  const server = new McpServer({
    name: "chromeboost",
    version: PACKAGE_VERSION,
  });

  registerBrowserTools(server, bridge, flowStore);
  registerHighlightTools(server, bridge);
  registerCaptureTools(server, bridge);
  registerFlowTools(server, bridge, flowStore);
  registerCursorTools(server, bridge);

  const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  const toolNames = Object.keys(registered).sort();
  if (toolNames.length === 0) {
    console.error(`[chromeboost] WARNING: no tools registered.`);
  }

  // Print the banner once the WS port is actually bound, so it reports the real
  // port rather than the base of the range. Racing a 2s timeout means a failed
  // bind still produces a banner instead of silence.
  void Promise.race([
    bridge.ready,
    new Promise<null>((r) => setTimeout(() => r(null), 2000)),
  ]).then((port) => {
    console.error(banner(toolNames.length, port));
  });

  // MCP prompts — appear as slash commands in Claude Code
  server.prompt(
    "chromeboost-status",
    "Check if the chromeboost Chrome extension is connected and which tab is active",
    async () => {
      const connected = bridge.isConnected();
      if (!connected) {
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: "Check chromeboost status. The Chrome extension is NOT connected. Tell the user to reload the chromeboost extension in chrome://extensions.",
            },
          }],
        };
      }
      try {
        const response = await bridge.request({ type: "list_tabs" }, 3000);
        const tabs = (response as { tabs: Array<{ index: number; title: string; url: string; active: boolean }> }).tabs;
        const active = tabs.find((t) => t.active);
        const tabList = tabs.map((t) => `${t.index}. ${t.active ? "[active] " : ""}${t.title} — ${t.url}`).join("\n");
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Check chromeboost status.\n\nExtension: Connected\nActive tab: ${active?.title ?? "none"} — ${active?.url ?? ""}\nAll tabs:\n${tabList}`,
            },
          }],
        };
      } catch {
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: "Check chromeboost status. Extension is connected but not responding. The user may need to reload it.",
            },
          }],
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Watchdog: exit when the host (Claude Code / Codex) disconnects.
  // Codex does not always SIGTERM its MCP subprocesses on session end, so
  // without this the WS server keeps listening and the popup accumulates
  // ghost instances on ports 7970-7980.
  //
  // Two complementary signals:
  //   1. stdin close — fires when the host closes its end of the stdio pipe
  //   2. PPID reparented to 1 — fires when the parent dies and we're
  //      reparented to init (orphaned). Polled every 5s.
  const exitClean = (reason: string) => {
    // Persist any pending usage count so a short session still registers.
    flushUsage();
    console.error(`[chromeboost] host disconnected (${reason}), exiting.`);
    process.exit(0);
  };
  process.stdin.on("end", () => exitClean("stdin end"));
  process.stdin.on("close", () => exitClean("stdin close"));
  const originalPpid = process.ppid;
  setInterval(() => {
    const ppid = process.ppid;
    if (ppid === 1 || (originalPpid !== 1 && ppid !== originalPpid)) {
      exitClean(`ppid changed ${originalPpid}→${ppid}`);
    }
  }, 5000).unref();

}
