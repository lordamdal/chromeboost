/**
 * Same-origin iframe traversal, coordinate translation, and frame addressing.
 *
 * chromeboost already treats the shadow boundary as transparent: `queryAllDeep`
 * walks open AND closed shadow roots, so an agent never has to know that a
 * button lives inside a Lit component. The iframe boundary was not transparent
 * in the same way, and that asymmetry is a silent-failure generator. On an
 * iframe-hosted UI (GoHighLevel's funnel/form/email builders, Jira- and
 * Trello-style kanban boards, embedded editors) `click_element` reported "no
 * element matched" for a button the user could plainly see, and any tool that
 * DID resolve an element inside a frame would have handed the background a
 * frame-local `getBoundingClientRect()` to feed to CDP, which dispatches in
 * TOP-level viewport coordinates. That aims the cursor at the wrong pixel and
 * the miss grows with how far down the page the iframe sits.
 *
 * This module supplies the three primitives that close the gap:
 *
 *   1. `reachableFrames` — the same-origin frame tree, each node carrying the
 *      cumulative offset of its viewport origin in TOP coordinates.
 *   2. `viewportRect` / `frameClipOf` — an element's rect translated into TOP
 *      coordinates, plus the region its frame chain actually leaves visible.
 *   3. `resolveFrameRoot` — turn a `frame:` argument into a document, accepting
 *      a CSS selector, a nested `a >>> b` path, or a plain src/title substring.
 *
 * Cross-origin frames are deliberately absent from all of it. `contentDocument`
 * throws for them by design and no amount of piercing changes that; the honest
 * answer is to route the caller to `click_at_coordinates` (which resolves at
 * the renderer and so reaches them), `execute_script` with a frame target, or
 * `fetch_url`. `frameErrorHint` in index.ts does exactly that.
 */

import { queryAllDeep } from "./shadow.js";

/** Separator for nested frame paths: `iframe#outer >>> iframe.inner`. */
export const FRAME_PATH_SEP = ">>>";

/** Depth cap for frame descent. Deeper nesting than this is pathological. */
const MAX_FRAME_DEPTH = 5;
/** Total frame cap, so an ad-heavy page can't turn every query into a crawl. */
const MAX_FRAMES = 40;

export type FrameRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type FrameNode = {
  /** The frame's document. Always same-origin and readable. */
  doc: Document;
  /** The owning `<iframe>`/`<frame>` in the parent document; null for the top frame. */
  el: Element | null;
  /** Offset of this document's viewport origin, in TOP viewport CSS pixels. */
  offsetX: number;
  offsetY: number;
  /** Region of the TOP viewport this frame's content can paint into. */
  clip: FrameRect;
  /** Addressable path from the top document, e.g. `iframe#outer >>> iframe.inner`. */
  path: string;
  /** 0 for the top frame. */
  depth: number;
};

// ─── Basic frame access ─────────────────────────────────────────────────────

/** The frame's document if it is same-origin and loaded, else null. */
export function frameDocument(el: Element): Document | null {
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    // A frame that has not started loading reports an empty about:blank
    // document. That is readable but useless, and treating it as a real frame
    // would make queries pay for a walk that can never match.
    if (!doc || !doc.body) return null;
    return doc;
  } catch {
    return null; // cross-origin
  }
}

/** True when the frame exists but is cross-origin (as opposed to not loaded). */
export function isCrossOrigin(el: Element): boolean {
  try {
    return !(el as HTMLIFrameElement).contentDocument;
  } catch {
    return true;
  }
}

/**
 * Where the frame's content box starts, in its PARENT document's viewport.
 *
 * Borders and padding matter here: `getBoundingClientRect()` returns the
 * border box, but the child document's origin sits at the content box. An
 * iframe with a 2px border would otherwise skew every coordinate inside it by
 * 2px, which is enough to miss a tightly-packed kanban card handle.
 */
function contentBoxOrigin(frameEl: Element): { x: number; y: number } {
  const r = frameEl.getBoundingClientRect();
  let insetX = 0;
  let insetY = 0;
  try {
    const view = frameEl.ownerDocument?.defaultView;
    const cs = view?.getComputedStyle(frameEl);
    if (cs) {
      const bl = parseFloat(cs.borderLeftWidth || "0");
      const bt = parseFloat(cs.borderTopWidth || "0");
      const pl = parseFloat(cs.paddingLeft || "0");
      const pt = parseFloat(cs.paddingTop || "0");
      insetX = (isFinite(bl) ? bl : 0) + (isFinite(pl) ? pl : 0);
      insetY = (isFinite(bt) ? bt : 0) + (isFinite(pt) ? pt : 0);
    }
  } catch { /* detached or styleless */ }
  return { x: r.left + insetX, y: r.top + insetY };
}

function intersect(a: FrameRect, b: FrameRect): FrameRect {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function topViewportRect(): FrameRect {
  return {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

// ─── Addressing ─────────────────────────────────────────────────────────────

/**
 * A CSS selector that resolves `el` uniquely inside `doc`.
 *
 * The previous frame-selector builder fell back to
 * `iframe:nth-of-type(<index among ALL iframes in the document>)`, which is
 * wrong whenever the frames do not share one parent — `:nth-of-type` counts
 * siblings, not document-wide occurrences — so the selector it handed back
 * pointed at a different frame than the one it described. This walks up
 * building a real descendant path instead, and verifies uniqueness at each
 * step before returning.
 */
export function uniqueSelectorIn(doc: Document | ShadowRoot, el: Element): string {
  const tag = el.tagName.toLowerCase();

  const countsOne = (sel: string): boolean => {
    try {
      // frames: false is load-bearing. Uniqueness is a property of the
      // document the selector will be used in; counting matches from other
      // frames would reject a selector that is perfectly unique where it
      // actually gets applied, and push every frame onto a long positional
      // fallback path.
      return queryAllDeep(doc, sel, { frames: false }).length === 1;
    } catch {
      return false;
    }
  };

  if (el.id) {
    const byId = `${tag}#${CSS.escape(el.id)}`;
    if (countsOne(byId)) return byId;
  }
  const testid = el.getAttribute("data-testid");
  if (testid) {
    const byTestId = `${tag}[data-testid="${CSS.escape(testid)}"]`;
    if (countsOne(byTestId)) return byTestId;
  }
  const name = el.getAttribute("name");
  if (name) {
    const byName = `${tag}[name="${CSS.escape(name)}"]`;
    if (countsOne(byName)) return byName;
  }
  const cls = (el.getAttribute("class") ?? "")
    .trim()
    .split(/\s+/)
    .filter((c) => c && c.length < 40)
    .slice(0, 3)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  if (cls && countsOne(`${tag}${cls}`)) return `${tag}${cls}`;

  // Positional path. `:nth-of-type` is computed against real siblings here,
  // which is the part the old builder got wrong.
  const segment = (node: Element): string => {
    const t = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) return t;
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
    if (sameTag.length === 1) return t;
    return `${t}:nth-of-type(${sameTag.indexOf(node) + 1})`;
  };

  let path = segment(el);
  let cur: Element | null = el.parentElement;
  for (let depth = 0; depth < 8 && cur; depth++) {
    if (countsOne(path)) return path;
    path = `${segment(cur)} > ${path}`;
    cur = cur.parentElement;
  }
  return path;
}

/** The addressable path of the frame that owns `el`, or "" for the top frame. */
export function framePathOf(el: Element): string {
  const segments: string[] = [];
  let win: Window | null = null;
  try {
    win = el.ownerDocument?.defaultView ?? null;
  } catch {
    return "";
  }
  for (let depth = 0; depth < MAX_FRAME_DEPTH && win && win !== window; depth++) {
    let frameEl: Element | null = null;
    try {
      frameEl = win.frameElement;
    } catch {
      break; // cross-origin ancestor: nothing addressable above this point
    }
    if (!frameEl) break;
    const parentDoc = frameEl.ownerDocument;
    segments.unshift(uniqueSelectorIn(parentDoc, frameEl));
    win = parentDoc.defaultView;
  }
  return segments.join(` ${FRAME_PATH_SEP} `);
}

/** True when `el` lives inside a frame rather than the top document. */
export function isInFrame(el: Element): boolean {
  try {
    return (el.ownerDocument?.defaultView ?? window) !== window;
  } catch {
    return false;
  }
}

// ─── Coordinate translation ─────────────────────────────────────────────────

/**
 * `el.getBoundingClientRect()` translated into TOP viewport coordinates.
 *
 * This is the function that makes an iframe-hosted click land where it should.
 * CDP's `Input.dispatchMouseEvent` only speaks top-level viewport pixels, so
 * every coordinate chromeboost hands it has to be expressed in that space. For
 * a top-frame element the translation is the identity, which keeps every
 * existing call site byte-for-byte equivalent.
 */
export function viewportRect(el: Element): FrameRect {
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  let win: Window | null = null;
  try {
    win = el.ownerDocument?.defaultView ?? null;
  } catch {
    win = null;
  }
  for (let depth = 0; depth < MAX_FRAME_DEPTH && win && win !== window; depth++) {
    let frameEl: Element | null = null;
    try {
      frameEl = win.frameElement;
    } catch {
      break;
    }
    if (!frameEl) break;
    const origin = contentBoxOrigin(frameEl);
    left += origin.x;
    top += origin.y;
    win = frameEl.ownerDocument?.defaultView ?? null;
  }
  return { left, top, right: left + r.width, bottom: top + r.height, width: r.width, height: r.height };
}

/**
 * The region of the TOP viewport in which `el` can actually be painted —
 * the top viewport intersected with every ancestor frame's box.
 *
 * Without this, an element scrolled out of view INSIDE its iframe still
 * reports a plausible-looking translated rect that happens to land over some
 * unrelated part of the parent page. Clipping means the hit test rejects it
 * as offscreen instead of clicking whatever the parent has there.
 */
export function frameClipOf(el: Element): FrameRect {
  let clip = topViewportRect();
  let win: Window | null = null;
  try {
    win = el.ownerDocument?.defaultView ?? null;
  } catch {
    return clip;
  }
  const boxes: Element[] = [];
  for (let depth = 0; depth < MAX_FRAME_DEPTH && win && win !== window; depth++) {
    let frameEl: Element | null = null;
    try {
      frameEl = win.frameElement;
    } catch {
      break;
    }
    if (!frameEl) break;
    boxes.push(frameEl);
    win = frameEl.ownerDocument?.defaultView ?? null;
  }
  // Walk outermost-first so each box is translated with the offsets already
  // accumulated for the frames above it.
  for (const frameEl of boxes.reverse()) {
    const r = viewportRect(frameEl);
    clip = intersect(clip, r);
  }
  return clip;
}

// ─── Frame tree ─────────────────────────────────────────────────────────────

/**
 * Every same-origin frame reachable from the top document, depth-first,
 * top frame first.
 *
 * `queryAllDeep` is used for the per-level scan so frames nested inside web
 * components are found too — a Stencil-based dashboard shell hosting its
 * content frame inside a closed shadow root is exactly the case that used to
 * be invisible.
 */
export function reachableFrames(includeTop = true): FrameNode[] {
  const out: FrameNode[] = [];
  const seen = new Set<Document>();

  const top: FrameNode = {
    doc: document,
    el: null,
    offsetX: 0,
    offsetY: 0,
    clip: topViewportRect(),
    path: "",
    depth: 0,
  };
  seen.add(document);
  if (includeTop) out.push(top);

  const walk = (node: FrameNode) => {
    if (node.depth >= MAX_FRAME_DEPTH || out.length >= MAX_FRAMES) return;
    let frameEls: Element[] = [];
    try {
      // Shadow roots yes, frames no: this walk descends one level per
      // iteration so each child gets the right parent path. Letting the query
      // itself cross frames would attribute a grandchild frame to the wrong
      // parent and produce an unusable address.
      frameEls = queryAllDeep<Element>(node.doc, "iframe, frame", { frames: false });
    } catch {
      return;
    }
    for (const frameEl of frameEls) {
      if (out.length >= MAX_FRAMES) return;
      const doc = frameDocument(frameEl);
      if (!doc || seen.has(doc)) continue;
      seen.add(doc);
      const origin = contentBoxOrigin(frameEl);
      const box = frameEl.getBoundingClientRect();
      const child: FrameNode = {
        doc,
        el: frameEl,
        offsetX: node.offsetX + origin.x,
        offsetY: node.offsetY + origin.y,
        clip: intersect(node.clip, {
          left: node.offsetX + box.left,
          top: node.offsetY + box.top,
          right: node.offsetX + box.right,
          bottom: node.offsetY + box.bottom,
          width: box.width,
          height: box.height,
        }),
        path: node.path
          ? `${node.path} ${FRAME_PATH_SEP} ${uniqueSelectorIn(node.doc, frameEl)}`
          : uniqueSelectorIn(node.doc, frameEl),
        depth: node.depth + 1,
      };
      out.push(child);
      walk(child);
    }
  };

  walk(top);
  return out;
}

/**
 * Same-origin frame documents, excluding the top document. Used by the deep
 * query helpers to continue a walk across the frame boundary.
 */
export function reachableFrameDocuments(): Document[] {
  return reachableFrames(false).map((f) => f.doc);
}

// ─── frame: argument resolution ─────────────────────────────────────────────

export type FrameResolution =
  | { ok: true; node: FrameNode }
  | { ok: false; reason: "not-found" | "cross-origin" | "not-loaded"; crossOriginEl?: Element };

/**
 * Resolve a `frame:` argument to a frame node.
 *
 * Three accepted forms, tried in order:
 *   1. A nested path — `iframe#outer >>> iframe.inner` — as emitted by
 *      `list_frames` for frames more than one level deep.
 *   2. A CSS selector, matched shadow-piercingly against every reachable
 *      frame's own document (not just the top one). The old resolver used a
 *      bare `document.querySelector`, so a frame inside a shadow root or
 *      inside another frame was unaddressable.
 *   3. A plain substring of the frame's src, title, id, or name. This is the
 *      same affordance `click_element`'s textHint gives: on GoHighLevel,
 *      `frame: "funnel"` beats hunting for the builder's generated class list.
 */
export function resolveFrame(frame: string): FrameResolution {
  const wanted = frame.trim();
  if (!wanted) return { ok: false, reason: "not-found" };

  const nodes = reachableFrames(false);
  const byPath = nodes.find((n) => n.path === wanted);
  if (byPath) return { ok: true, node: byPath };

  // Nested path form. Walk it segment by segment so each hop is resolved in
  // the document it actually belongs to.
  if (wanted.includes(FRAME_PATH_SEP)) {
    const segments = wanted.split(FRAME_PATH_SEP).map((s) => s.trim()).filter(Boolean);
    let node: FrameNode | undefined = nodes.find(
      (n) => n.depth === 1 && matchesSelector(document, n.el, segments[0]),
    );
    if (!node) {
      const crossOriginEl = findCrossOrigin(document, segments[0]);
      return crossOriginEl
        ? { ok: false, reason: "cross-origin", crossOriginEl }
        : { ok: false, reason: "not-found" };
    }
    for (let i = 1; i < segments.length; i++) {
      const parent: FrameNode = node;
      const next: FrameNode | undefined = nodes.find(
        (n) => n.depth === parent.depth + 1 && n.path.startsWith(parent.path) && matchesSelector(parent.doc, n.el, segments[i]),
      );
      if (!next) {
        const crossOriginEl = findCrossOrigin(parent.doc, segments[i]);
        return crossOriginEl
          ? { ok: false, reason: "cross-origin", crossOriginEl }
          : { ok: false, reason: "not-found" };
      }
      node = next;
    }
    return { ok: true, node };
  }

  // Plain CSS selector against any reachable frame's owning document.
  const bySelector = nodes.find((n) => n.el && matchesSelector(n.el.ownerDocument, n.el, wanted));
  if (bySelector) return { ok: true, node: bySelector };

  // The selector may name a frame we cannot read. Say so specifically —
  // "not found" would send the caller looking for a typo that isn't there.
  const docsToScan: Array<Document> = [document, ...nodes.map((n) => n.doc)];
  for (const doc of docsToScan) {
    const crossOriginEl = findCrossOrigin(doc, wanted);
    if (crossOriginEl) return { ok: false, reason: "cross-origin", crossOriginEl };
  }

  // Substring of src / title / id / name.
  const needle = wanted.toLowerCase();
  const fuzzy = nodes.find((n) => frameIdentity(n.el).includes(needle));
  if (fuzzy) return { ok: true, node: fuzzy };

  for (const doc of docsToScan) {
    let frameEls: Element[] = [];
    try {
      frameEls = queryAllDeep<Element>(doc, "iframe, frame", { frames: false });
    } catch {
      continue;
    }
    const hit = frameEls.find((el) => isCrossOrigin(el) && frameIdentity(el).includes(needle));
    if (hit) return { ok: false, reason: "cross-origin", crossOriginEl: hit };
  }

  return { ok: false, reason: "not-found" };
}

function frameIdentity(el: Element | null): string {
  if (!el) return "";
  return [
    el.getAttribute("src") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("id") ?? "",
    el.getAttribute("name") ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function matchesSelector(doc: Document | null | undefined, el: Element | null, selector: string): boolean {
  if (!doc || !el) return false;
  try {
    return queryAllDeep(doc, selector, { frames: false }).includes(el);
  } catch {
    return false;
  }
}

function findCrossOrigin(doc: Document, selector: string): Element | null {
  let candidates: Element[] = [];
  try {
    candidates = queryAllDeep<Element>(doc, selector, { frames: false });
  } catch {
    return null;
  }
  return candidates.find((el) => /^(IFRAME|FRAME)$/.test(el.tagName) && isCrossOrigin(el)) ?? null;
}
