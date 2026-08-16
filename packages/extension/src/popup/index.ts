/**
 * Popup UI — shows all detected Claude Code instances grouped by:
 *   1. THIS WINDOW   — instances assigned to the currently-focused window
 *   2. OTHER WINDOWS — instances assigned to a different Chrome window (collapsible)
 *   3. UNASSIGNED    — live instances with no window yet (collapsible)
 *
 * Each instance card shows the project name (large), with port + window status (small).
 * Falls back to "Port 7970" if no project label has been received yet.
 */

const groupsEl = document.getElementById("groups")!;
const statusPill = document.getElementById("status-pill")!;

type Host = "claude" | "codex" | "gemini";
type PortInfo = { port: number; label?: string; host?: Host };

type State = {
  livePorts: PortInfo[];
  instances: Record<string, number>; // port → windowId
  currentWindowId: number;
  validWindowIds: Set<number>;
};

const HOST_ICONS: Record<Host, { src: string; label: string }> = {
  claude: { src: "icons/host-claude.png", label: "Claude" },
  codex: { src: "icons/host-codex.png", label: "Codex" },
  gemini: { src: "icons/host-gemini.png", label: "Gemini" },
};

/**
 * Resolve a host badge, tolerating hosts this build has never heard of.
 *
 * `host` arrives over the WebSocket from whatever spawned the MCP server, so it
 * is untrusted input, not a value this file controls. Indexing HOST_ICONS
 * directly meant an unrecognised host (anyone setting CHROMEBOOST_HOST to
 * something new) hit `undefined.label` and took the entire popup render down
 * with it. Unknown hosts now degrade to a text-only badge.
 */
function hostBadgeFor(host: string): { src: string | null; label: string } {
  const known = (HOST_ICONS as Record<string, { src: string; label: string }>)[host];
  if (known) return known;
  const label = host.charAt(0).toUpperCase() + host.slice(1);
  return { src: null, label };
}

const collapsedGroups = new Set<string>();

function resizePopup() {
  document.body.style.height = "auto";
  document.body.style.height = document.body.scrollHeight + "px";
}

async function loadState(): Promise<State> {
  const [storage, currentWindow, allWindows] = await Promise.all([
    chrome.storage.local.get(["chromeboostLivePorts", "claudeInstances"]),
    chrome.windows.getCurrent(),
    chrome.windows.getAll(),
  ]);

  // Support both old format (number[]) and new format ({port, label}[])
  const rawPorts = (storage.chromeboostLivePorts as (number | PortInfo)[]) ?? [];
  const livePorts: PortInfo[] = rawPorts.map((p) =>
    typeof p === "number" ? { port: p } : p
  );
  const instances = (storage.claudeInstances as Record<string, number>) ?? {};
  const validWindowIds = new Set(allWindows.map((w) => w.id!).filter(Boolean));

  // Clear assignments to closed windows
  let dirty = false;
  for (const port of Object.keys(instances)) {
    if (!validWindowIds.has(instances[port])) {
      delete instances[port];
      dirty = true;
    }
  }
  if (dirty) {
    await chrome.storage.local.set({ claudeInstances: instances });
  }

  return { livePorts, instances, currentWindowId: currentWindow.id!, validWindowIds };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderInstanceCard(
  port: number,
  label: string | undefined,
  host: Host | undefined,
  isLive: boolean,
  assignedWindowId: number | undefined,
  currentWindowId: number,
): string {
  const isThisWindow = assignedWindowId === currentWindowId;
  const cardClass = ["instance"];
  if (isThisWindow) cardClass.push("this-window");
  if (!isLive) cardClass.push("offline");

  const displayName = label ?? `Port ${port}`;
  const nameClass = label ? "instance-name" : "instance-name unlabeled";

  const metaPieces: string[] = [];
  if (label) metaPieces.push(`Port ${port}`);
  if (!isLive) metaPieces.push(`<span class="meta-tag unassigned">offline</span>`);
  if (assignedWindowId) {
    metaPieces.push(
      isThisWindow
        ? `<span class="meta-tag">✓ this window</span>`
        : `<a class="meta-tag elsewhere go-to-window" href="#" data-window-id="${assignedWindowId}">go to window →</a>`
    );
  } else {
    metaPieces.push(`<span class="meta-tag unassigned">unassigned</span>`);
  }
  const metaHtml = metaPieces.join('<span class="meta-sep">·</span>');

  const primaryBtn = isThisWindow
    ? "✓ Assigned to this window"
    : assignedWindowId
      ? "Use this window instead"
      : "Use this window";
  const primaryDisabled = isThisWindow;

  const buttons = `
    <div class="btn-row">
      <button class="btn btn-primary" data-action="set" data-port="${port}"${primaryDisabled ? " disabled" : ""}>${primaryBtn}</button>
      ${assignedWindowId ? `<button class="btn btn-secondary" data-action="clear" data-port="${port}">Clear</button>` : ""}
    </div>
  `;

  let hostBadge = "";
  if (host) {
    const h = hostBadgeFor(host);
    const icon = h.src ? `<img class="host-icon" src="${h.src}" alt="" />` : "";
    hostBadge = `<div class="host-badge" title="${escapeHtml(h.label)} session"><span class="host-label">${escapeHtml(h.label)}</span>${icon}</div>`;
  }

  return `
    <div class="${cardClass.join(" ")}" style="view-transition-name: card-${port}">
      <div class="instance-row">
        <div class="dot ${isLive ? "connected" : ""}"></div>
        <div class="${nameClass}">${escapeHtml(displayName)}</div>
        ${hostBadge}
      </div>
      <div class="instance-meta">${metaHtml}</div>
      ${buttons}
    </div>
  `;
}

function renderGroup(
  key: string,
  title: string,
  cards: string[],
  collapsible: boolean,
  emptyMessage?: string,
): string {
  if (cards.length === 0 && !emptyMessage) return "";
  const collapsed = collapsible && collapsedGroups.has(key);
  const groupClass = ["group"];
  if (collapsed) groupClass.push("collapsed");
  const headerClass = collapsible ? "group-header" : "group-header static";

  const body = cards.length > 0
    ? `<div class="group-body">${cards.join("")}</div>`
    : `<div class="group-body"><div class="empty">${emptyMessage}</div></div>`;

  const countBadge = cards.length > 0 ? `<span class="group-count">${cards.length}</span>` : "";
  const toggle = collapsible ? `<span class="group-toggle">▾</span>` : "";

  return `
    <div class="${groupClass.join(" ")}" data-group="${key}">
      <div class="${headerClass}" data-toggle-group="${collapsible ? key : ""}">
        <span class="group-title">${title}</span>
        <span class="group-right">${countBadge}${toggle}</span>
      </div>
      ${body}
    </div>
  `;
}

function render(state: State) {
  // Build label and host maps
  const labelMap = new Map<number, string>();
  const hostMap = new Map<number, Host>();
  for (const p of state.livePorts) {
    if (p.label) labelMap.set(p.port, p.label);
    if (p.host) hostMap.set(p.port, p.host);
  }

  // Deduplicate labels: if multiple ports share the same project name,
  // append (1), (2), etc. like duplicate filenames.
  const labelCounts = new Map<string, number>();
  const displayLabelMap = new Map<number, string>();
  for (const [port, label] of labelMap) {
    const n = (labelCounts.get(label) ?? 0) + 1;
    labelCounts.set(label, n);
    displayLabelMap.set(port, n > 1 ? `${label} (${n - 1})` : label);
  }
  // Second pass: if a label appeared more than once, the first one also needs a suffix
  for (const [port, label] of labelMap) {
    if ((labelCounts.get(label) ?? 0) > 1 && displayLabelMap.get(port) === label) {
      // Renumber all instances of this label sequentially
      let idx = 0;
      for (const [p] of labelMap) {
        if (labelMap.get(p) === label) {
          idx++;
          displayLabelMap.set(p, idx === 1 ? label : `${label} (${idx - 1})`);
        }
      }
    }
  }

  // All known ports = live + assigned (even if offline)
  const allPorts = new Set<number>([
    ...state.livePorts.map((p) => p.port),
    ...Object.keys(state.instances).map(Number),
  ]);
  const sortedPorts = Array.from(allPorts).sort((a, b) => a - b);

  if (sortedPorts.length === 0) {
    groupsEl.innerHTML = `
      <div class="empty empty-onboard">
        <div class="empty-title">No Claude Code sessions yet</div>
        <div class="empty-subtitle">Get connected in two steps:</div>
        <div class="empty-steps">
          <div class="empty-step">
            <div class="step-num">1</div>
            <div class="step-body">
              Add &amp; install the ChromeBoost plugin in Claude Code:
              <code>/plugin marketplace add /path/to/ChromeBoost</code>
              <code>/plugin install chromeboost</code>
            </div>
          </div>
          <div class="empty-step">
            <div class="step-num">2</div>
            <div class="step-body">
              Open Claude Code in your project — sessions show up here automatically.
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const thisWindow: string[] = [];
  const otherWindows: string[] = [];
  const unassigned: string[] = [];

  for (const port of sortedPorts) {
    const isLive = state.livePorts.some((p) => p.port === port);
    const label = displayLabelMap.get(port) ?? labelMap.get(port);
    const host = hostMap.get(port);
    const assignedWindowId = state.instances[String(port)];
    const card = renderInstanceCard(port, label, host, isLive, assignedWindowId, state.currentWindowId);
    if (assignedWindowId === state.currentWindowId) {
      thisWindow.push(card);
    } else if (assignedWindowId) {
      otherWindows.push(card);
    } else {
      unassigned.push(card);
    }
  }

  const groups: string[] = [];
  groups.push(
    renderGroup(
      "this",
      "This window",
      thisWindow,
      false,
      "No session assigned to this window yet — use a card below."
    )
  );
  if (otherWindows.length > 0) {
    groups.push(renderGroup("others", "Other windows", otherWindows, true));
  }
  if (unassigned.length > 0) {
    groups.push(renderGroup("unassigned", "Unassigned", unassigned, true));
  }

  groupsEl.innerHTML = groups.join("");

  // Set max-height on each expanded group body so CSS transitions work.
  // Collapsed bodies get max-height:0 via CSS; expanded ones need an
  // explicit pixel value (auto doesn't transition).
  for (const body of groupsEl.querySelectorAll<HTMLElement>(".group:not(.collapsed) .group-body")) {
    body.style.maxHeight = body.scrollHeight + "px";
  }

  resizePopup();

  const activeCount = state.livePorts.length;
  const pillText = statusPill.querySelector(".pill-text")!;
  if (activeCount > 0) {
    statusPill.classList.remove("idle");
    pillText.textContent = `${activeCount} active`;
  } else {
    statusPill.classList.add("idle");
    pillText.textContent = "No active sessions";
  }
}

type DocumentWithViewTransitions = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => unknown;
};

function renderAnimated(state: State) {
  const doc = document as DocumentWithViewTransitions;
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(() => {
      render(state);
    });
  } else {
    render(state);
  }
}

groupsEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;

  // "go to window" link — focus that Chrome window
  const goToWindow = target.closest<HTMLElement>(".go-to-window");
  if (goToWindow) {
    e.preventDefault();
    const wid = Number(goToWindow.getAttribute("data-window-id"));
    if (wid) chrome.windows.update(wid, { focused: true });
    return;
  }

  const toggleKey = target.closest<HTMLElement>("[data-toggle-group]")?.getAttribute("data-toggle-group");
  if (toggleKey) {
    const group = groupsEl.querySelector<HTMLElement>(`[data-group="${toggleKey}"]`);
    const body = group?.querySelector<HTMLElement>(".group-body");
    const expanding = collapsedGroups.has(toggleKey);

    if (expanding) {
      collapsedGroups.delete(toggleKey);
    } else {
      collapsedGroups.add(toggleKey);
    }

    if (group && body) {
      if (expanding) {
        group.classList.remove("collapsed");
        body.style.maxHeight = "0";
        requestAnimationFrame(() => {
          body.style.maxHeight = body.scrollHeight + "px";
          const onEnd = () => { body.removeEventListener("transitionend", onEnd); resizePopup(); };
          body.addEventListener("transitionend", onEnd);
          resizePopup();
        });
        group.querySelector(".group-toggle")!.removeAttribute("style");
      } else {
        body.style.maxHeight = body.scrollHeight + "px";
        requestAnimationFrame(() => {
          group.classList.add("collapsed");
          const onEnd = () => { body.removeEventListener("transitionend", onEnd); resizePopup(); };
          body.addEventListener("transitionend", onEnd);
          // Resize during the animation so the popup shrinks with the content
          const shrink = () => {
            if (!group.classList.contains("collapsed")) return;
            resizePopup();
            if (body.offsetHeight > 0) requestAnimationFrame(shrink);
          };
          requestAnimationFrame(shrink);
        });
      }
    } else {
      render(await loadState());
    }
    return;
  }

  // Card buttons — re-render through View Transitions API so each card's
  // view-transition-name lets the browser interpolate its old → new position
  // when it moves between groups (slides instead of pops).
  const action = target.getAttribute("data-action");
  const portStr = target.getAttribute("data-port");
  if (!action || !portStr) return;

  const { claudeInstances } = await chrome.storage.local.get("claudeInstances");
  const instances = (claudeInstances as Record<string, number>) ?? {};

  if (action === "set") {
    const currentWindow = await chrome.windows.getCurrent();
    instances[portStr] = currentWindow.id!;
  } else if (action === "clear") {
    delete instances[portStr];
  }

  await chrome.storage.local.set({ claudeInstances: instances });
  renderAnimated(await loadState());
});

// Default: collapse the bigger groups so "this window" stands out
collapsedGroups.add("others");
collapsedGroups.add("unassigned");

// Listen for live-port changes from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source === "chromeboost-offscreen" && msg.type === "status") {
    loadState().then((s) => { render(s); resizePopup(); });
  }
});

// ─── On-page HUD controls ──────────────────────────────────────────────────
// The HUD can be dismissed from the page itself (× button), so the popup has
// to offer a way back that doesn't rely on the user remembering Alt+Shift+B.
// State lives in chrome.storage.local under `cbHudState`, written by the
// content script — reading it here keeps the button label honest.

const HUD_STORAGE_KEY = "cbHudState";

type StoredHudState = { x: number; y: number; collapsed: boolean; hidden: boolean };

async function readHudState(): Promise<StoredHudState> {
  const got = await chrome.storage.local.get(HUD_STORAGE_KEY);
  const s = got[HUD_STORAGE_KEY] as Partial<StoredHudState> | undefined;
  return { x: s?.x ?? -1, y: s?.y ?? 12, collapsed: s?.collapsed ?? false, hidden: s?.hidden ?? false };
}

function paintHudControls(s: StoredHudState) {
  const toggle = document.getElementById("hud-toggle") as HTMLButtonElement | null;
  const collapse = document.getElementById("hud-collapse") as HTMLButtonElement | null;
  if (toggle) toggle.textContent = s.hidden ? "Show" : "Hide";
  if (collapse) {
    collapse.textContent = s.collapsed ? "Expand" : "Collapse";
    // Collapsing a hidden HUD isn't a meaningful action.
    collapse.disabled = s.hidden;
  }
}

/**
 * Push a HUD action to the active tab's content script. Storage is the source
 * of truth (so the next page load agrees), but the current tab needs telling
 * directly or the change wouldn't show until navigation.
 */
async function applyHudAction(action: "hide" | "show" | "collapse" | "expand") {
  const next = await readHudState();
  if (action === "hide") next.hidden = true;
  if (action === "show") next.hidden = false;
  if (action === "collapse") next.collapsed = true;
  if (action === "expand") next.collapsed = false;
  await chrome.storage.local.set({ [HUD_STORAGE_KEY]: next });
  paintHudControls(next);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    // Fails harmlessly on chrome:// and other pages with no content script.
    chrome.tabs.sendMessage(tab.id, {
      type: "hud_control",
      requestId: `popup-${Date.now()}`,
      action,
    }).catch(() => { /* no content script on this page */ });
  }
}

document.getElementById("hud-toggle")?.addEventListener("click", async () => {
  const s = await readHudState();
  await applyHudAction(s.hidden ? "show" : "hide");
});

document.getElementById("hud-collapse")?.addEventListener("click", async () => {
  const s = await readHudState();
  await applyHudAction(s.collapsed ? "expand" : "collapse");
});

readHudState().then(paintHudControls);

loadState().then((s) => {
  render(s);
  requestAnimationFrame(() => document.body.classList.add("ready"));
});
