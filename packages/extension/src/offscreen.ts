/**
 * Offscreen document — maintains persistent WebSocket connections to one or
 * more chromeboost MCP servers (one per port in the range 7970-9069).
 *
 * Each connection represents a separate Claude Code instance. Messages from
 * each connection are tagged with the source port so the background script
 * can route them to the correct assigned Chrome window.
 */

const PORT_BASE = 7970;
const PORT_MAX = 9069;
const RECONNECT_BASE_MS = 1000;
// Ports with nothing listening (the vast majority of the range, most of the
// time) climb to this ceiling and stay there instead of retrying every 5s
// forever. A real session's port resets to RECONNECT_BASE_MS on its very
// next successful open, so this only slows down ports that keep failing.
const RECONNECT_MAX_MS = 60_000;
// Coalesces publishLivePorts() calls that land in the same tick.
const PUBLISH_DEBOUNCE_MS = 200;

// Keep in step with the same type in popup/index.ts. Neither file is a module,
// so TypeScript treats both declarations as global and resolves them as one:
// updating only one side silently gives the other the wrong union.
type Host = "claude" | "codex" | "gemini";

type Conn = {
  port: number;
  ws: WebSocket | null;
  reconnectDelay: number;
  connected: boolean;
  label?: string;
  host?: Host;
};

const connections: Conn[] = [];

for (let p = PORT_BASE; p <= PORT_MAX; p++) {
  const conn: Conn = { port: p, ws: null, reconnectDelay: RECONNECT_BASE_MS, connected: false };
  connections.push(conn);
  connect(conn);
}

function connect(conn: Conn) {
  try {
    conn.ws = new WebSocket(`ws://localhost:${conn.port}`);
  } catch {
    scheduleReconnect(conn);
    return;
  }

  conn.ws.onopen = () => {
    // Connected to MCP server on this port
    conn.reconnectDelay = RECONNECT_BASE_MS;
    conn.connected = true;
    conn.ws!.send(JSON.stringify({ type: "ready" }));
    publishLivePorts();
  };

  conn.ws.onmessage = (event) => {
    let msg: { type: string; requestId?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Identity message — store label/host and re-publish so popup can show
    // the project name and the originating host (Claude Code or Codex).
    if (msg.type === "identity") {
      conn.label = (msg.label as string) || undefined;
      const host = msg.host as string | undefined;
      conn.host = host === "claude" || host === "codex" ? host : undefined;
      publishLivePorts();
      return;
    }

    // Forward to background, get response. Tag with source port so background
    // can route to the right Claude window assignment.
    chrome.runtime.sendMessage(
      { source: "chromeboost-offscreen", port: conn.port, payload: msg },
      (response: { ok: boolean; result?: unknown; error?: string }) => {
        if (chrome.runtime.lastError) {
          sendError(conn, msg.requestId, chrome.runtime.lastError.message ?? "Unknown error");
          return;
        }
        if (!response.ok) {
          sendError(conn, msg.requestId, response.error ?? "Unknown error");
          return;
        }
        const result = response.result as Record<string, unknown>;
        conn.ws?.send(JSON.stringify({ ...result, requestId: msg.requestId }));
      }
    );
  };

  conn.ws.onclose = () => {
    if (conn.connected) {
      // Disconnected from this port
    }
    conn.connected = false;
    conn.ws = null;
    publishLivePorts();
    scheduleReconnect(conn);
  };

  conn.ws.onerror = () => {
    // Errors are followed by onclose, which handles reconnect.
  };
}

function scheduleReconnect(conn: Conn) {
  // Jitter so the range's ~1000 dead ports (nothing ever listening on most
  // of them) desync from each other instead of retrying in lockstep forever,
  // which is what turned every backoff cycle into a simultaneous-failure burst.
  const jitter = conn.reconnectDelay * 0.3 * Math.random();
  setTimeout(() => connect(conn), conn.reconnectDelay + jitter);
  conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX_MS);
}

function sendError(conn: Conn, requestId: string, message: string) {
  conn.ws?.send(JSON.stringify({ type: "error", requestId, message }));
}

let publishTimer: ReturnType<typeof setTimeout> | null = null;

function publishLivePorts() {
  // Debounced: at 1100 candidate ports, a reconnect burst (extension startup,
  // or a batch of dead ports landing on the same backoff tick) can call this
  // from dozens of connections within one event-loop turn. Each call used to
  // be its own chrome.storage write + popup re-render, and a re-render blows
  // away the "Unassigned"/"Other windows" group's DOM node mid-animation —
  // that's what made the group's expand/collapse look broken. Coalesce into
  // one publish per burst instead.
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    // Offscreen documents cannot access chrome.storage directly — forward the
    // live ports to the background worker via runtime messaging, and let it
    // persist to storage and broadcast to the popup.
    const livePorts = connections
      .filter((c) => c.connected)
      .map((c) => ({ port: c.port, label: c.label, host: c.host }));
    chrome.runtime.sendMessage({ source: "chromeboost-offscreen", type: "status", livePorts }).catch(() => {
      // Background may be starting up, ignore
    });
  }, PUBLISH_DEBOUNCE_MS);
}

// Progress heartbeats: background dispatches "chromeboost-progress" messages
// to the offscreen during long-running handlers (type_text, set_file_input).
// We forward them straight to the right WS so the MCP server's request
// timer resets. Fire-and-forget — no response, no waiting.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.source === "chromeboost-progress" && typeof msg.port === "number") {
    const conn = connections.find((c) => c.port === msg.port);
    if (conn?.ws && conn.connected) {
      try {
        conn.ws.send(JSON.stringify({
          type: "progress",
          requestId: msg.requestId,
          phase: msg.phase,
          detail: msg.detail,
        }));
      } catch { /* WS may have closed mid-send; bridge will fire its own timeout */ }
    }
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
