/**
 * ChromeBoost occlusion-aware hit testing — "can the cursor actually reach
 * this element, and if not, what is in the way?"
 *
 * The naive approach resolves a click target's coordinates straight from
 * `getBoundingClientRect()` and hands the centre point to CDP
 * `Input.dispatchMouseEvent`. That is correct only when nothing is painted on
 * top. The moment a page puts something over the target — a cookie scrim, a
 * sticky header, a toast, a Radix/Headless-UI modal backdrop, an intercom
 * bubble, a full-viewport `<div>` with `opacity: 0` used as a click-away
 * catcher — the trusted click lands on the overlay instead. The agent gets a
 * "clicked successfully" response and nothing happens, which is the single
 * most confusing failure mode in browser automation.
 *
 * This module closes that gap:
 *
 *   1. `deepElementFromPoint` resolves the element genuinely painted at a
 *      point, descending through open AND closed shadow roots so Radix
 *      portals, Stencil, and Lit components report their real inner node.
 *   2. `findClearPoint` searches the target's visible area for a point where
 *      the cursor would actually reach it, instead of blindly using the
 *      centre. That alone fixes partially-covered targets (a button half
 *      under a sticky footer).
 *   3. When every point is blocked, `describeOccluder` reports exactly what is
 *      covering the target — tag, id, classes, z-index, and whether it looks
 *      like a full-viewport scrim — so the caller can act instead of guess.
 *   4. `pierceAt` temporarily neutralises the covering layers with
 *      `pointer-events: none` so a *real* CDP click reaches the intended
 *      element, then restores the previous inline styles exactly.
 *
 * Piercing is deliberately non-destructive: it never removes nodes, never
 * clicks anything to dismiss it, and always restores. It also refuses to
 * touch an element that contains the target, because `pointer-events` is
 * inherited and disabling an ancestor would disable the target too.
 */

import { getShadowRoot } from "./shadow.js";
import { frameClipOf, framePathOf, isInFrame, viewportRect, type FrameRect } from "./frames.js";

/**
 * The document of a same-origin frame, or null. Hit testing has to be able to
 * cross this boundary: `document.elementFromPoint` stops at the `<iframe>`
 * element exactly the way it stops at a shadow host, so without descending,
 * every element inside a frame looks permanently occluded by the frame that
 * contains it.
 */
function sameOriginFrameDoc(el: Element): Document | null {
  if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") return null;
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    return doc && doc.body ? doc : null;
  } catch {
    return null;
  }
}

/** Offset of a frame's content-box origin within its parent's viewport. */
function frameContentOffset(frameEl: Element): { x: number; y: number } {
  const r = frameEl.getBoundingClientRect();
  let insetX = 0;
  let insetY = 0;
  try {
    const cs = frameEl.ownerDocument?.defaultView?.getComputedStyle(frameEl);
    if (cs) {
      const bl = parseFloat(cs.borderLeftWidth || "0");
      const bt = parseFloat(cs.borderTopWidth || "0");
      const pl = parseFloat(cs.paddingLeft || "0");
      const pt = parseFloat(cs.paddingTop || "0");
      insetX = (isFinite(bl) ? bl : 0) + (isFinite(pl) ? pl : 0);
      insetY = (isFinite(bt) ? bt : 0) + (isFinite(pt) ? pt : 0);
    }
  } catch { /* detached */ }
  return { x: r.left + insetX, y: r.top + insetY };
}

export type PointHit = {
  tag: string;
  selector: string;
  text: string;
  /** True when the element at the point is the target, or inside it. */
  role: "target" | "descendant" | "ancestor" | "occluder";
};

export type OccluderInfo = {
  tag: string;
  selector: string;
  text: string;
  z_index: string;
  position: string;
  /** Covers ≥85% of the viewport in both axes — i.e. a modal backdrop/scrim. */
  full_screen_scrim: boolean;
  /** `position: fixed` or `sticky` — a bar the page can be scrolled out from under. */
  pinned: boolean;
  /** Visually transparent but still intercepting — the classic invisible catcher. */
  transparent: boolean;
};

export type ClearPointResult = {
  found: boolean;
  x?: number;
  y?: number;
  /** How the winning point resolves relative to the target. */
  via?: "target" | "descendant" | "ancestor";
  occluded: boolean;
  occluder?: OccluderInfo;
  /** Number of candidate points tried. Useful when debugging a stubborn target. */
  probes: number;
  /** Set when the target has no visible area inside the viewport at all. */
  offscreen?: boolean;
};

// ─── Element resolution ─────────────────────────────────────────────────────

/**
 * The element actually painted at (x, y), descending through shadow roots.
 *
 * `document.elementFromPoint` stops at the shadow host, so on a Radix or Lit
 * page it reports the wrapper custom element rather than the button the user
 * sees. We keep descending while the hit is a shadow host, which is what makes
 * the occlusion check meaningful inside web components.
 */
export function deepElementFromPoint(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y);
  if (!el) return null;
  // Local coordinates within whichever document we are currently probing.
  let lx = x;
  let ly = y;
  for (let depth = 0; depth < 24; depth++) {
    const sr = getShadowRoot(el);
    if (sr) {
      let inner: Element | null = null;
      try {
        inner = sr.elementFromPoint(lx, ly);
      } catch {
        break;
      }
      if (!inner || inner === el) break;
      el = inner;
      continue;
    }
    // Same-origin frame: re-probe inside it, in that frame's coordinate space.
    const fdoc = sameOriginFrameDoc(el);
    if (!fdoc) break;
    const off = frameContentOffset(el);
    const nx = lx - off.x;
    const ny = ly - off.y;
    let inner: Element | null = null;
    try {
      inner = fdoc.elementFromPoint(nx, ny);
    } catch {
      break;
    }
    if (!inner) break;
    el = inner;
    lx = nx;
    ly = ny;
  }
  return el;
}

/**
 * The full painted stack at a point, outermost-last, descending through shadow
 * roots at each layer. Used to report what is between the cursor and the
 * target, and to drive piercing.
 */
export function deepElementsFromPoint(x: number, y: number): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();

  // `depth` guards against a frame that somehow re-enters itself; `lx/ly` are
  // the probe point expressed in the current document's coordinate space.
  const collect = (doc: Document | ShadowRoot, lx: number, ly: number, depth: number) => {
    if (depth > 8) return;
    let list: Element[] = [];
    try {
      list = Array.from(doc.elementsFromPoint(lx, ly));
    } catch {
      const one = doc.elementFromPoint(lx, ly);
      if (one) list = [one];
    }
    for (const el of list) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
      // Descend into this layer's shadow tree so the inner node is reported too.
      let cur: Element = el;
      for (let d = 0; d < 24; d++) {
        const sr = getShadowRoot(cur);
        if (!sr) break;
        let inner: Element | null = null;
        try { inner = sr.elementFromPoint(lx, ly); } catch { break; }
        if (!inner || inner === cur || seen.has(inner)) break;
        seen.add(inner);
        out.unshift(inner); // inner sits above its host visually
        cur = inner;
      }
      // A same-origin frame paints its own stack above itself. Splice that in
      // ahead of the frame element so the reported order still reads
      // topmost-first, which is what pierceAt and probe_point rely on.
      const fdoc = sameOriginFrameDoc(el);
      if (fdoc) {
        const off = frameContentOffset(el);
        const before = out.length;
        collect(fdoc, lx - off.x, ly - off.y, depth + 1);
        const added = out.splice(before, out.length - before);
        out.unshift(...added);
      }
    }
  };

  collect(document, x, y, 0);
  return out;
}

/**
 * `Node.contains`, but crossing shadow boundaries — walks up through shadow
 * hosts. Plain `contains` returns false for a node inside a shadow root even
 * when the host is a descendant of `container`, which would make every
 * web-component target look occluded by its own internals.
 */
export function composedContains(container: Element, node: Node | null): boolean {
  let cur: Node | null = node;
  for (let depth = 0; cur && depth < 200; depth++) {
    if (cur === container) return true;
    const parent: Node | null = cur.parentNode;
    if (parent) {
      cur = parent;
      continue;
    }
    // No parent: we're at the top of a shadow root (or a document).
    const host = (cur as ShadowRoot).host as Element | undefined;
    if (host) {
      cur = host;
      continue;
    }
    // A document's parent is the frame element that hosts it. Without this
    // hop, an element inside a frame is never "contained" by anything in the
    // parent page, so every frame-hosted target classified its own frame as
    // an occluder and reported itself permanently blocked.
    if ((cur as Document).nodeType === Node.DOCUMENT_NODE) {
      let frameEl: Element | null = null;
      try {
        frameEl = (cur as Document).defaultView?.frameElement ?? null;
      } catch {
        return false; // cross-origin parent: not reachable, so not contained
      }
      if (!frameEl) return false;
      cur = frameEl;
      continue;
    }
    return false;
  }
  return false;
}

/** Classify a hit relative to the intended target. */
function classify(hit: Element | null, target: Element): PointHit["role"] {
  if (!hit) return "occluder";
  if (hit === target) return "target";
  if (composedContains(target, hit)) return "descendant";
  if (composedContains(hit, target)) return "ancestor";
  return "occluder";
}

// ─── Description helpers ────────────────────────────────────────────────────

/** A short, human-readable, mostly-unique selector for an element. */
export function describeSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${CSS.escape(el.id)}`;
  const cls = (el.getAttribute("class") ?? "")
    .trim()
    .split(/\s+/)
    .filter((c) => c && c.length < 40)
    .slice(0, 3)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  const testid = el.getAttribute("data-testid");
  if (testid) return `${tag}[data-testid="${testid}"]`;
  const role = el.getAttribute("role");
  if (!cls && role) return `${tag}[role="${role}"]`;
  return cls ? `${tag}${cls}` : tag;
}

function shortText(el: Element): string {
  const t = ((el as HTMLElement).innerText || el.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  return t.slice(0, 60);
}

/** Snapshot the properties that tell the caller how to get past an overlay. */
export function describeOccluder(el: Element): OccluderInfo {
  let cs: CSSStyleDeclaration | null = null;
  try { cs = getComputedStyle(el); } catch { /* detached */ }
  const rect = el.getBoundingClientRect();
  // Measure "covers the whole viewport" against the viewport this element
  // actually lives in. A 100vw/100vh scrim inside a 400px-wide frame is a
  // scrim for everything in that frame, and comparing it to the top window's
  // dimensions would misreport it as a small local overlay.
  const ownView = (() => {
    try { return el.ownerDocument?.defaultView ?? window; } catch { return window; }
  })();
  const viewW = ownView?.innerWidth || window.innerWidth;
  const viewH = ownView?.innerHeight || window.innerHeight;
  const position = cs?.position ?? "static";
  const opacity = parseFloat(cs?.opacity ?? "1");
  const bg = cs?.backgroundColor ?? "";
  // rgba(...,0) or transparent, with no visible text, is the invisible
  // click-away catcher pattern used by most dropdown libraries.
  const bgTransparent = bg === "transparent" || /rgba\([^)]*,\s*0(\.0+)?\)\s*$/.test(bg);
  return {
    tag: el.tagName.toLowerCase(),
    selector: describeSelector(el),
    text: shortText(el),
    z_index: cs?.zIndex ?? "auto",
    position,
    full_screen_scrim:
      rect.width >= viewW * 0.85 && rect.height >= viewH * 0.85,
    pinned: position === "fixed" || position === "sticky",
    transparent: opacity < 0.05 || (bgTransparent && shortText(el).length === 0),
  };
}

// ─── Clear-point search ─────────────────────────────────────────────────────

/**
 * Candidate points inside the target's *visible* rectangle, ordered by how
 * natural they'd be for a human to aim at: centre first, then progressively
 * further out. Points are generated inside the viewport intersection, so a
 * target that is half-scrolled-off still gets probed on the part you can see.
 */
function candidatePoints(rect: FrameRect, clip: FrameRect): Array<[number, number]> {
  // `clip` is the top viewport intersected with every ancestor frame's box.
  // For a top-frame element that is just the viewport, so this is unchanged;
  // for a frame-hosted element it is what stops us probing a translated rect
  // that has scrolled out of its own frame and now overlaps unrelated parent
  // content.
  const left = Math.max(rect.left, clip.left, 0);
  const top = Math.max(rect.top, clip.top, 0);
  const right = Math.min(rect.right, clip.right, window.innerWidth);
  const bottom = Math.min(rect.bottom, clip.bottom, window.innerHeight);
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return [];

  const at = (fx: number, fy: number): [number, number] => [
    Math.round(left + w * fx),
    Math.round(top + h * fy),
  ];

  const fractions: Array<[number, number]> = [
    [0.5, 0.5],
    [0.5, 0.35], [0.5, 0.65], [0.35, 0.5], [0.65, 0.5],
    [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
    [0.5, 0.18], [0.5, 0.82], [0.18, 0.5], [0.82, 0.5],
    [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85],
    [0.08, 0.5], [0.92, 0.5], [0.5, 0.08], [0.5, 0.92],
  ];

  const seen = new Set<string>();
  const pts: Array<[number, number]> = [];
  for (const [fx, fy] of fractions) {
    const [x, y] = at(fx, fy);
    // Stay a hair inside the viewport; (0,0) and the far edges hit nothing.
    if (x < 1 || y < 1 || x > window.innerWidth - 2 || y > window.innerHeight - 2) continue;
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push([x, y]);
  }
  return pts;
}

/**
 * Find a point where a cursor click would actually land on `target`.
 *
 * Returns the winning coordinate, or — when the target is completely covered —
 * `occluded: true` plus a description of the topmost thing in the way. An
 * "ancestor" hit is accepted but reported, because clicking a wrapper usually
 * still triggers the handler (event delegation) yet is worth surfacing.
 */
export function findClearPoint(target: Element): ClearPointResult {
  // Top-level viewport coordinates throughout. CDP's Input.dispatchMouseEvent
  // speaks only that space, so a frame-hosted target's frame-local rect has to
  // be translated before anything aims at it. viewportRect is the identity for
  // a top-frame element.
  const rect = viewportRect(target);
  const clip = frameClipOf(target);
  const pts = candidatePoints(rect, clip);
  if (pts.length === 0) {
    return { found: false, occluded: false, offscreen: true, probes: 0 };
  }

  let firstOccluder: Element | null = null;
  let ancestorFallback: { x: number; y: number } | null = null;
  let probes = 0;

  for (const [x, y] of pts) {
    probes++;
    const hit = deepElementFromPoint(x, y);
    const role = classify(hit, target);
    if (role === "target" || role === "descendant") {
      return { found: true, x, y, via: role, occluded: false, probes };
    }
    if (role === "ancestor" && !ancestorFallback) {
      ancestorFallback = { x, y };
    }
    if (role === "occluder" && !firstOccluder && hit) {
      firstOccluder = hit;
    }
  }

  // Nothing resolved to the target itself. An ancestor hit is still clickable
  // in practice (the target may simply be pointer-events:none over a wrapper
  // that carries the handler), so prefer it over reporting failure.
  if (ancestorFallback) {
    return {
      found: true,
      x: ancestorFallback.x,
      y: ancestorFallback.y,
      via: "ancestor",
      occluded: false,
      probes,
    };
  }

  return {
    found: false,
    occluded: true,
    occluder: firstOccluder ? describeOccluder(firstOccluder) : undefined,
    probes,
  };
}

// ─── Piercing ───────────────────────────────────────────────────────────────

type PierceEntry = { el: HTMLElement; prev: string; had: boolean };
/** Active pierce sessions, keyed by token, so the caller can restore exactly. */
const pierceSessions = new Map<string, PierceEntry[]>();
let pierceCounter = 0;

/**
 * Temporarily disable pointer interception on whatever is covering `target` at
 * (x, y), so a real CDP click can reach it.
 *
 * Walks the stack top-down, setting `pointer-events: none !important` on each
 * intercepting layer and re-testing, until the target (or one of its
 * descendants) is the topmost hit. Stops at any element that contains the
 * target — `pointer-events` inherits, so disabling an ancestor would disable
 * the target as well and produce a click that hits nothing at all.
 *
 * Returns a token for `unpierce`, plus what it had to move out of the way.
 * The caller MUST call `unpierce` — leaving a page with dead overlays would be
 * a visible, confusing side effect.
 */
export function pierceAt(
  x: number,
  y: number,
  target: Element | null,
  maxLayers = 8,
): { token: string; pierced: OccluderInfo[]; clear: boolean } {
  const entries: PierceEntry[] = [];
  const pierced: OccluderInfo[] = [];
  let clear = false;

  for (let i = 0; i < maxLayers; i++) {
    const hit = deepElementFromPoint(x, y);
    if (!hit) break;
    if (target) {
      const role = classify(hit, target);
      if (role === "target" || role === "descendant" || role === "ancestor") {
        clear = true;
        break;
      }
    }
    if (!(hit instanceof HTMLElement)) break;
    // Never disable something the target lives inside — pointer-events is
    // inherited, so this would take the target down with it.
    if (target && composedContains(hit, target)) break;
    // Never disable a page root; that would make the whole document inert.
    // Checked against the hit's OWN document so a frame-hosted overlay is
    // measured against its frame's body, not the top page's.
    const hitDoc = hit.ownerDocument ?? document;
    if (hit === hitDoc.body || hit === hitDoc.documentElement) break;

    pierced.push(describeOccluder(hit));
    entries.push({
      el: hit,
      prev: hit.style.getPropertyValue("pointer-events"),
      had: hit.hasAttribute("style"),
    });
    hit.style.setProperty("pointer-events", "none", "important");
  }

  if (!target && entries.length > 0) clear = true;

  const token = `cbp-${++pierceCounter}`;
  pierceSessions.set(token, entries);
  return { token, pierced, clear };
}

/** Restore every inline style `pierceAt` touched. Idempotent. */
export function unpierce(token: string): { restored: number } {
  const entries = pierceSessions.get(token);
  if (!entries) return { restored: 0 };
  for (const { el, prev, had } of entries) {
    try {
      if (prev) el.style.setProperty("pointer-events", prev);
      else el.style.removeProperty("pointer-events");
      // If the element had no style attribute before us and we've emptied it
      // again, remove the attribute so the DOM is byte-identical to before.
      if (!had && el.getAttribute("style") === "") el.removeAttribute("style");
    } catch {
      /* element detached mid-click — nothing to restore */
    }
  }
  pierceSessions.delete(token);
  return { restored: entries.length };
}

/** Emergency cleanup — restores every outstanding pierce session. */
export function unpierceAll(): number {
  let n = 0;
  for (const token of Array.from(pierceSessions.keys())) {
    n += unpierce(token).restored;
  }
  return n;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/**
 * Report the painted stack at a viewport point. This is the tool an agent
 * reaches for when a click "worked" but nothing happened: it names the thing
 * that actually received the cursor.
 */
export function probePoint(x: number, y: number): {
  x: number;
  y: number;
  stack: Array<{ tag: string; selector: string; text: string; z_index: string; position: string; frame: string }>;
  top?: OccluderInfo;
  in_iframe: boolean;
  /** Addressable path of the frame the hit lives in, or "" for the top frame. */
  frame: string;
} {
  const stack = deepElementsFromPoint(x, y).slice(0, 8).map((el) => {
    let cs: CSSStyleDeclaration | null = null;
    try { cs = getComputedStyle(el); } catch { /* detached */ }
    return {
      tag: el.tagName.toLowerCase(),
      selector: describeSelector(el),
      text: shortText(el),
      z_index: cs?.zIndex ?? "auto",
      position: cs?.position ?? "static",
      frame: isInFrame(el) ? framePathOf(el) : "",
    };
  });
  const top = deepElementFromPoint(x, y);
  // `in_iframe` used to mean "the topmost paint here is an <iframe> element",
  // which was only ever true for frames we could NOT see into — the moment
  // hit testing descends, the reported element is the real one inside the
  // frame. It now means what a caller actually wants to know: the thing under
  // the cursor lives in a frame. `frame` names which one so the answer is
  // directly usable as another tool's frame argument.
  const insideFrame = !!top && isInFrame(top);
  return {
    x,
    y,
    stack,
    top: top ? describeOccluder(top) : undefined,
    in_iframe: insideFrame || (!!top && (top.tagName === "IFRAME" || top.tagName === "FRAME")),
    frame: top && insideFrame ? framePathOf(top) : "",
  };
}

/**
 * Scroll the page so `target` clears any `position: fixed`/`sticky` bar that
 * is covering it. Sticky headers and cookie bars are the most common cause of
 * a blocked click, and unlike a scrim they can simply be scrolled out from
 * under — no piercing needed.
 *
 * Returns true if it moved the page.
 */
export function scrollClearOfPinned(target: Element, occluder: OccluderInfo): boolean {
  if (!occluder.pinned || occluder.full_screen_scrim) return false;
  // Scroll the window the target lives in. A sticky toolbar inside an
  // iframe-hosted builder is cleared by scrolling that frame; scrolling the
  // top window instead would move the whole frame and leave the bar exactly
  // where it was relative to the target.
  let view: Window = window;
  try {
    view = target.ownerDocument?.defaultView ?? window;
  } catch { /* detached */ }
  const before = view.scrollY;
  const rect = target.getBoundingClientRect();
  // Nudge the target toward the vertical middle, the region least likely to be
  // covered by a top header or a bottom action bar.
  const desiredTop = view.innerHeight / 2 - rect.height / 2;
  const delta = rect.top - desiredTop;
  view.scrollBy({ top: delta, behavior: "instant" as ScrollBehavior });
  if (Math.abs(view.scrollY - before) > 1) return true;
  // The frame itself may be what needs moving (a short frame pinned under the
  // parent's own sticky header). Fall back to the top window.
  if (view !== window) {
    const topBefore = window.scrollY;
    const topRect = viewportRect(target);
    window.scrollBy({ top: topRect.top - (window.innerHeight / 2 - topRect.height / 2), behavior: "instant" as ScrollBehavior });
    return Math.abs(window.scrollY - topBefore) > 1;
  }
  return false;
}
