import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import { recordToolCall } from "./usage.js";
import type { ClientMessage, DistributiveOmit, ServerMessage } from "./types.js";

type ServerMessagePayload = DistributiveOmit<ServerMessage, "requestId">;

const WS_PORT_BASE = 7970;
const WS_PORT_MAX = 9069;
const REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (value: ClientMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /**
   * Refreshes the request timer by `timeoutMs` from "now". Called when a
   * `progress` message arrives from the extension so long-running operations
   * (long type_text, slow downloads) don't trip the request timeout while
   * they're still making forward progress.
   */
  refresh: () => void;
};

export class WsBridge {
  private wss!: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private port: number = WS_PORT_BASE;

  /**
   * Resolves with the port actually bound. Port selection walks the range on
   * EADDRINUSE and only settles on the async "listening" event, so anything
   * that wants to report the port (the startup banner) has to await this
   * rather than read `port` straight after construction.
   */
  public readonly ready: Promise<number>;
  private markReady!: (port: number) => void;

  constructor() {
    this.ready = new Promise<number>((resolve) => { this.markReady = resolve; });
    this.bind(WS_PORT_BASE);
  }

  public getPort(): number {
    return this.port;
  }

  private bind(tryPort: number) {
    if (tryPort > WS_PORT_MAX) {
      console.error(
        `[chromeboost] All ports ${WS_PORT_BASE}-${WS_PORT_MAX} are in use. Cannot start MCP server.`
      );
      return;
    }

    const wss = new WebSocketServer({ port: tryPort });

    wss.on("error", (err: Error & { code?: string }) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[chromeboost] Port ${tryPort} in use, trying ${tryPort + 1}...`);
        this.bind(tryPort + 1);
      } else {
        console.error("[chromeboost] WS server error:", err);
      }
    });

    wss.on("listening", () => {
      this.wss = wss;
      this.port = tryPort;
      this.markReady(tryPort);
    });

    wss.on("connection", (ws) => {
      if (this.client) {
        this.client.terminate();
      }
      this.client = ws;
      console.error("[chromeboost] Extension connected");

      ws.on("message", (data) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(data.toString()) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "progress") {
          // Heartbeat from a long-running handler. Reset the request's
          // timeout so the next-progress-or-completion gap is what counts.
          const pending = this.pending.get(msg.requestId);
          if (pending) pending.refresh();
          return;
        }
        if (msg.type === "ready") {
          console.error("[chromeboost] Extension ready");
          // Send identity so the extension knows which project this server belongs to.
          // `host` tells the popup whether this MCP server was spawned by Claude Code
          // or Codex CLI:
          //   - Claude Code sets CLAUDE_PLUGIN_ROOT on the spawned process.
          //   - Codex doesn't forward any plugin env, so its launcher script in
          //     `.mcp.codex.json` sets CHROMEBOOST_HOST=codex before importing.
          // When neither is present (legacy npx flow, ad-hoc invocation) it stays unset.
          const cwd = process.cwd();
          const host = process.env.CHROMEBOOST_HOST
            ?? (process.env.CLAUDE_PLUGIN_ROOT ? "claude" : undefined);
          ws.send(JSON.stringify({
            type: "identity",
            cwd,
            label: path.basename(cwd),
            port: this.port,
            host,
          }));
          return;
        }
        const pending2 = this.pending.get(msg.requestId);
        if (pending2) {
          clearTimeout(pending2.timer);
          this.pending.delete(msg.requestId);
          if (msg.type === "error") {
            pending2.reject(new Error(msg.message));
          } else {
            pending2.resolve(msg);
          }
        }
      });

      ws.on("close", () => {
        console.error("[chromeboost] Extension disconnected");
        this.client = null;
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(
            "Chrome extension disconnected. Reload the chromeboost extension in Chrome and try again."
          ));
          this.pending.delete(id);
        }
      });
    });
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /** Send a message and wait for a response from the extension. */
  async request(message: ServerMessagePayload, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ClientMessage> {
    // Counted here rather than per-tool so every path through the bridge is
    // included exactly once. Debounced inside; never awaited.
    recordToolCall();
    if (!this.isConnected()) {
      // Grace window for the multi-instance startup race: a freshly spawned
      // MCP on a non-default port may arrive before the extension's WS to
      // that port has cleared its exponential-backoff timer.
      const grace = Math.min(10_000, timeoutMs);
      const start = Date.now();
      while (!this.isConnected() && Date.now() - start < grace) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!this.isConnected()) {
        throw new Error(
          "ChromeBoost extension is not connected. Open Chrome and ensure the extension is installed."
        );
      }
    }
    const requestId = crypto.randomUUID();
    return new Promise<ClientMessage>((resolve, reject) => {
      let lastProgressAt = Date.now();
      const fire = () => {
        this.pending.delete(requestId);
        reject(new Error(`Request timed out after ${timeoutMs}ms (last progress ${Date.now() - lastProgressAt}ms ago). The operation may have completed on the page; verify state before retrying.`));
      };
      let timer = setTimeout(fire, timeoutMs);
      const refresh = () => {
        clearTimeout(timer);
        lastProgressAt = Date.now();
        timer = setTimeout(fire, timeoutMs);
      };

      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        refresh,
      });
      this.client!.send(JSON.stringify({ ...message, requestId }));
    });
  }

  /** Send a fire-and-forget message (no response expected). */
  send(message: ServerMessagePayload): void {
    if (!this.isConnected()) {
      throw new Error("ChromeBoost extension is not connected.");
    }
    const requestId = crypto.randomUUID();
    this.client!.send(JSON.stringify({ ...message, requestId }));
  }
}
