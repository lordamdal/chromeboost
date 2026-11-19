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

export type BrowserClient = {
  id: string;
  ws: WebSocket;
  profileName?: string;
  profileEmail?: string;
  connectedAt: number;
};

export type BrowserInfo = {
  id: string;
  profileName?: string;
  profileEmail?: string;
  active: boolean;
  connectedAt: number;
};

let nextAutoId = 1;

export class WsBridge {
  private wss!: WebSocketServer;
  private browsers = new Map<string, BrowserClient>();
  private activeBrowserId: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private port: number = WS_PORT_BASE;
  private onBrowserChangeCallbacks: Array<() => void> = [];

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

  /** Register a callback fired whenever a browser connects or disconnects. */
  onBrowserChange(cb: () => void): void {
    this.onBrowserChangeCallbacks.push(cb);
  }

  private notifyBrowserChange(): void {
    for (const cb of this.onBrowserChangeCallbacks) {
      try { cb(); } catch { /* ignore */ }
    }
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
      // Don't assign a browser ID yet — wait for the "ready" message which
      // carries the browserId from the extension. Store on the socket so we
      // can look it up once "ready" arrives.
      let assignedId: string | null = null;

      ws.on("message", (data) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(data.toString()) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "progress") {
          const pending = this.pending.get(msg.requestId);
          if (pending) pending.refresh();
          return;
        }
        if (msg.type === "ready") {
          const browserId = (msg as { browserId?: string }).browserId
            || `browser-${nextAutoId++}`;
          const profileName = (msg as { profileName?: string }).profileName;
          const profileEmail = (msg as { profileEmail?: string }).profileEmail;

          // If this browserId is already connected (reconnect from same
          // profile), terminate the old socket and replace it.
          const existing = this.browsers.get(browserId);
          if (existing) {
            existing.ws.terminate();
          }

          assignedId = browserId;
          const client: BrowserClient = {
            id: browserId,
            ws,
            profileName,
            profileEmail,
            connectedAt: Date.now(),
          };
          this.browsers.set(browserId, client);

          // Auto-select the first browser that connects
          if (!this.activeBrowserId || !this.browsers.has(this.activeBrowserId)) {
            this.activeBrowserId = browserId;
          }

          const label = profileName || browserId;
          console.error(`[chromeboost] Browser connected: ${label} (${browserId}), ${this.browsers.size} browser(s) total`);

          // Send identity so the extension knows which project this server belongs to.
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

          this.notifyBrowserChange();
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
        if (assignedId) {
          const client = this.browsers.get(assignedId);
          // Only delete if this socket is still the one registered for this id
          // (a reconnect may have already replaced it).
          if (client && client.ws === ws) {
            const label = client.profileName || assignedId;
            console.error(`[chromeboost] Browser disconnected: ${label} (${assignedId}), ${this.browsers.size - 1} browser(s) remaining`);
            this.browsers.delete(assignedId);

            // Reject pending requests that were routed to this browser
            for (const [id, pending] of this.pending) {
              clearTimeout(pending.timer);
              pending.reject(new Error(
                `Chrome browser "${label}" disconnected. Reload the chromeboost extension in that Chrome profile and try again.`
              ));
              this.pending.delete(id);
            }

            // If the active browser disconnected, switch to another if available
            if (this.activeBrowserId === assignedId) {
              const remaining = [...this.browsers.keys()];
              this.activeBrowserId = remaining.length > 0 ? remaining[0] : null;
              if (this.activeBrowserId) {
                const next = this.browsers.get(this.activeBrowserId)!;
                console.error(`[chromeboost] Active browser switched to: ${next.profileName || next.id}`);
              }
            }

            this.notifyBrowserChange();
          }
        }
      });
    });
  }

  // ─── Browser management ──────────────────────────────────────────────────

  /** List all connected browsers. */
  listBrowsers(): BrowserInfo[] {
    return [...this.browsers.values()].map((b) => ({
      id: b.id,
      profileName: b.profileName,
      profileEmail: b.profileEmail,
      active: b.id === this.activeBrowserId,
      connectedAt: b.connectedAt,
    }));
  }

  /** Select which browser receives subsequent tool calls. */
  selectBrowser(idOrName: string): BrowserInfo | null {
    // Try exact id match first
    if (this.browsers.has(idOrName)) {
      this.activeBrowserId = idOrName;
      const b = this.browsers.get(idOrName)!;
      return { id: b.id, profileName: b.profileName, profileEmail: b.profileEmail, active: true, connectedAt: b.connectedAt };
    }
    // Try matching by profile name (case-insensitive substring)
    const lower = idOrName.toLowerCase();
    for (const b of this.browsers.values()) {
      if (b.profileName && b.profileName.toLowerCase().includes(lower)) {
        this.activeBrowserId = b.id;
        return { id: b.id, profileName: b.profileName, profileEmail: b.profileEmail, active: true, connectedAt: b.connectedAt };
      }
    }
    // Try matching by profile email
    for (const b of this.browsers.values()) {
      if (b.profileEmail && b.profileEmail.toLowerCase().includes(lower)) {
        this.activeBrowserId = b.id;
        return { id: b.id, profileName: b.profileName, profileEmail: b.profileEmail, active: true, connectedAt: b.connectedAt };
      }
    }
    return null;
  }

  /** Get the active browser's info, or null if none connected. */
  getActiveBrowser(): BrowserInfo | null {
    if (!this.activeBrowserId) return null;
    const b = this.browsers.get(this.activeBrowserId);
    if (!b) return null;
    return { id: b.id, profileName: b.profileName, profileEmail: b.profileEmail, active: true, connectedAt: b.connectedAt };
  }

  /** Get the active browser's WebSocket, or null. */
  private getActiveClient(): WebSocket | null {
    if (!this.activeBrowserId) return null;
    const b = this.browsers.get(this.activeBrowserId);
    if (!b || b.ws.readyState !== WebSocket.OPEN) return null;
    return b.ws;
  }

  isConnected(): boolean {
    return this.getActiveClient() !== null;
  }

  /** True if at least one browser is connected (regardless of active selection). */
  hasAnyBrowser(): boolean {
    for (const b of this.browsers.values()) {
      if (b.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  browserCount(): number {
    return this.browsers.size;
  }

  /** Send a message and wait for a response from the active browser. */
  async request(message: ServerMessagePayload, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ClientMessage> {
    recordToolCall();
    if (!this.isConnected()) {
      // Grace window for the multi-instance startup race
      const grace = Math.min(10_000, timeoutMs);
      const start = Date.now();
      while (!this.isConnected() && Date.now() - start < grace) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!this.isConnected()) {
        if (this.hasAnyBrowser()) {
          throw new Error(
            "No active browser selected. Use select_browser to pick one of the connected browsers."
          );
        }
        throw new Error(
          "ChromeBoost extension is not connected. Open Chrome and ensure the extension is installed."
        );
      }
    }
    const client = this.getActiveClient()!;
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
      client.send(JSON.stringify({ ...message, requestId }));
    });
  }

  /** Send a fire-and-forget message (no response expected). */
  send(message: ServerMessagePayload): void {
    const client = this.getActiveClient();
    if (!client) {
      if (this.hasAnyBrowser()) {
        throw new Error("No active browser selected. Use select_browser to pick one.");
      }
      throw new Error("ChromeBoost extension is not connected.");
    }
    const requestId = crypto.randomUUID();
    client.send(JSON.stringify({ ...message, requestId }));
  }
}
