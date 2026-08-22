import { markerIds } from "../markers.js";
import { viewportRect } from "./frames.js";

const CALLOUT_HEIGHT = 52;
const CALLOUT_OFFSET = 8;

// Tracked highlights — repositioned on scroll
type TrackedHighlight = {
  /** Element to track (for find_and_highlight). */
  element?: Element;
  /** Document-absolute coordinates (for highlight_region). */
  docX?: number;
  docY?: number;
  width: number;
  height: number;
  message: string;
  boxEl: HTMLDivElement;
  calloutEl: HTMLDivElement;
  maskEl: HTMLDivElement;
};

let tracked: TrackedHighlight[] = [];
let scrollListenerAttached = false;

function ensureStyles() {
  const styleId = markerIds.styleElement();
  if (document.getElementById(styleId)) return;
  const style = document.createElement("style");
  style.id = styleId;
  const pulseName = markerIds.animationPulse();
  const fadeName = markerIds.animationFade();
  style.textContent = `
    @keyframes ${pulseName} {
      0%, 100% { box-shadow: 0 0 0 4px rgba(249,115,22,0.3), 0 0 14px rgba(249,115,22,0.2); }
      50%       { box-shadow: 0 0 0 6px rgba(249,115,22,0.5), 0 0 22px rgba(249,115,22,0.35); }
    }
    @keyframes ${fadeName} {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes chromeboost-indeterminate {
      0%   { left: -40%; width: 40%; }
      50%  { left: 30%;  width: 50%; }
      100% { left: 110%; width: 40%; }
    }
  `;
  document.head.appendChild(style);
}

function getOrCreateContainer(): HTMLDivElement {
  const id = markerIds.overlayContainer();
  let c = document.getElementById(id) as HTMLDivElement | null;
  if (!c) {
    c = document.createElement("div");
    c.id = id;
    c.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 2147483647;
    `;
    document.documentElement.appendChild(c);
  }
  return c;
}

export function clearAllOverlays() {
  tracked = [];
  document.getElementById(markerIds.overlayContainer())?.remove();
}

/**
 * Returns the current highlighted element's viewport rect, or null if nothing
 * is highlighted. Used by click-watch to decide if a click is on target.
 */
export function getHighlightedViewportRect(): {
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  if (tracked.length === 0) return null;
  const h = tracked[0];
  if (h.element) {
    // Overlays are appended to the TOP document, so a frame-hosted element's
    // frame-local rect would draw the highlight over the wrong part of the
    // page. That matters most in the one place highlights exist for: handing
    // a CAPTCHA-gated or otherwise agent-blocked click back to the user.
    const r = viewportRect(h.element);
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return {
    left: h.docX! - window.scrollX,
    top: h.docY! - window.scrollY,
    width: h.width,
    height: h.height,
  };
}

/** Find an element whose visible text contains the given string.
 *  Pierces open shadow roots so chat / form widgets (Radix UI, Stencil,
 *  Lit, other web components) are searchable too. */
export function findElementByText(text: string, root: Document = document): Element | null {
  const lower = text.toLowerCase().trim();

  let best: Element | null = null;
  let bestLen = Infinity;

  function consider(el: Element) {
    const len = (el.textContent ?? "").length;
    if (len < bestLen) { best = el; bestLen = len; }
  }

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent;
      if (!t || !t.toLowerCase().includes(lower)) return;
      const parent = (node as Text).parentElement;
      if (!parent) return;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return;
      consider(parent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return;
      const sr = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) walk(sr);
      // Same-origin frames: hover targets and highlight targets live inside
      // application frames as often as anywhere else, and a text search that
      // stops at the frame boundary reports "not found" for something plainly
      // on screen.
      if (tag === "IFRAME" || tag === "FRAME") {
        try {
          const fdoc = (node as HTMLIFrameElement).contentDocument;
          if (fdoc?.body) walk(fdoc.body);
        } catch { /* cross-origin */ }
      }
    }
    for (const c of Array.from(node.childNodes)) walk(c);
  }

  walk(root.body);

  if (!best) return null;

  let candidate: Element | null = best;
  while (candidate) {
    const r = candidate.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return candidate;
    candidate = candidate.parentElement;
  }

  return best;
}

function positionElements(h: TrackedHighlight) {
  let vpLeft: number, vpTop: number, w: number, ht: number;

  if (h.element) {
    const rect = viewportRect(h.element);
    vpLeft = rect.left;
    vpTop = rect.top;
    w = rect.width;
    ht = rect.height;
  } else {
    vpLeft = h.docX! - window.scrollX;
    vpTop = h.docY! - window.scrollY;
    w = h.width;
    ht = h.height;
  }

  h.boxEl.style.left = `${vpLeft}px`;
  h.boxEl.style.top = `${vpTop}px`;
  h.boxEl.style.width = `${w}px`;
  h.boxEl.style.height = `${ht}px`;

  // Dark mask with cutout: CSS clip-path polygon that covers the full viewport
  // except for the highlighted region
  const pad = 4;
  const cx1 = Math.max(0, vpLeft - pad);
  const cy1 = Math.max(0, vpTop - pad);
  const cx2 = Math.min(window.innerWidth, vpLeft + w + pad);
  const cy2 = Math.min(window.innerHeight, vpTop + ht + pad);
  h.maskEl.style.clipPath = `polygon(
    0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
    ${cx1}px ${cy1}px, ${cx1}px ${cy2}px, ${cx2}px ${cy2}px, ${cx2}px ${cy1}px, ${cx1}px ${cy1}px
  )`;

  const calloutTop =
    vpTop > CALLOUT_HEIGHT + CALLOUT_OFFSET + 8
      ? vpTop - CALLOUT_OFFSET - CALLOUT_HEIGHT
      : vpTop + ht + CALLOUT_OFFSET;
  h.calloutEl.style.top = `${calloutTop}px`;
  h.calloutEl.style.left = `${Math.max(8, Math.min(vpLeft, window.innerWidth - 340))}px`;
}

function ensureScrollListener() {
  if (scrollListenerAttached) return;
  scrollListenerAttached = true;
  document.addEventListener(
    "scroll",
    () => { for (const h of tracked) positionElements(h); },
    { passive: true, capture: true }
  );
  window.addEventListener(
    "resize",
    () => { for (const h of tracked) positionElements(h); },
    { passive: true }
  );
}

function createHighlightElements(message: string, _color: string, valueToType?: string): [HTMLDivElement, HTMLDivElement, HTMLDivElement] {
  ensureStyles();
  const container = getOrCreateContainer();

  // Dark mask covering the full viewport (cutout positioned in positionElements)
  const mask = document.createElement("div");
  mask.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100%; height: 100%;
    background: rgba(0, 0, 0, 0.45);
    pointer-events: none;
    transition: clip-path 0.15s ease;
  `;

  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed;
    border: 2px solid #f97316;
    border-radius: 6px;
    pointer-events: none;
    animation: ${markerIds.animationPulse()} 1.5s ease-in-out infinite;
    background: transparent;
  `;

  const callout = document.createElement("div");
  callout.style.cssText = `
    position: fixed;
    background: #ffffff;
    color: #f97316;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.4;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid rgba(249, 115, 22, 0.25);
    max-width: 320px;
    width: max-content;
    pointer-events: none;
    white-space: pre-wrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15), 0 1px 3px rgba(0, 0, 0, 0.1);
    animation: ${markerIds.animationFade()} 0.2s ease;
    z-index: 1;
  `;

  if (valueToType) {
    const label = document.createElement("div");
    label.textContent = message;
    label.style.cssText = `margin-bottom: 6px; opacity: 0.85; font-weight: 500;`;

    const valueBox = document.createElement("div");
    valueBox.textContent = valueToType;
    valueBox.style.cssText = `
      background: #fff7ed;
      border: 1px solid rgba(249, 115, 22, 0.3);
      border-radius: 4px;
      padding: 5px 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
      font-size: 12px;
      font-weight: 600;
      color: #ea580c;
      letter-spacing: 0.01em;
      user-select: text;
      pointer-events: auto;
    `;

    callout.appendChild(label);
    callout.appendChild(valueBox);
  } else {
    callout.textContent = message;
  }

  container.appendChild(mask);
  container.appendChild(box);
  container.appendChild(callout);
  return [box, callout, mask];
}

export function renderHighlight(opts: {
  /** Viewport coordinates in CSS pixels (screenshot is pre-downscaled to CSS resolution). */
  x: number;
  y: number;
  width: number;
  height: number;
  message: string;
  color?: string;
  valueToType?: string;
}) {
  const { message, color = "#f97316", valueToType } = opts;

  const docX = opts.x + window.scrollX;
  const docY = opts.y + window.scrollY;
  const cssW = opts.width;
  const cssH = opts.height;

  clearAllOverlays();

  const [box, callout, mask] = createHighlightElements(message, color, valueToType);
  const h: TrackedHighlight = { docX, docY, width: cssW, height: cssH, message, boxEl: box, calloutEl: callout, maskEl: mask };
  tracked.push(h);
  positionElements(h);
  ensureScrollListener();
}

export function highlightElement(el: Element, message: string, color = "#f97316", valueToType?: string) {
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  clearAllOverlays();

  const [box, callout, mask] = createHighlightElements(message, color, valueToType);
  const h: TrackedHighlight = { element: el, width: 0, height: 0, message, boxEl: box, calloutEl: callout, maskEl: mask };
  tracked.push(h);

  setTimeout(() => {
    positionElements(h);
    ensureScrollListener();
  }, 350);
}

// ─── Instance info box ──────────────────────────────────────────────────────
// Persistent badge in the top-right corner showing which Claude Code instance
// is driving this window. Hidden during take_screenshot so it doesn't pollute
// captured images.

const INFO_BOX_ID = "chromeboost-instance-info";

export function showInstanceInfo(info: { label?: string; port?: number; host?: string }) {
  hideInstanceInfo();
  ensureStyles();
  if (!info.label && !info.port) return;

  const el = document.createElement("div");
  el.id = INFO_BOX_ID;
  el.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    background: #ffffff;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    color: #374151;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    padding: 10px 14px 12px;
    border-radius: 10px;
    border: 1px solid #e5e7eb;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06);
    pointer-events: none;
    z-index: 2147483646;
    user-select: none;
    min-width: 180px;
    overflow: hidden;
  `;

  const title = document.createElement("div");
  title.style.cssText = `
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #f97316;
    margin-bottom: 4px;
  `;
  title.textContent = "ChromeBoost";

  const details = document.createElement("div");
  details.style.cssText = `
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
    font-size: 12px;
    color: #6b7280;
    margin-bottom: 8px;
  `;
  const parts: string[] = [];
  if (info.label) parts.push(info.label);
  if (info.port) parts.push(`port ${info.port}`);
  if (info.host) parts.push(info.host);
  details.textContent = parts.join("  ·  ");

  const barTrack = document.createElement("div");
  barTrack.style.cssText = `
    height: 3px;
    background: #f3f4f6;
    border-radius: 2px;
    overflow: hidden;
    position: relative;
  `;

  const barFill = document.createElement("div");
  barFill.style.cssText = `
    position: absolute;
    top: 0;
    height: 100%;
    background: linear-gradient(90deg, #fb923c, #f97316, #ea580c);
    border-radius: 2px;
    animation: chromeboost-indeterminate 1.4s ease-in-out infinite;
  `;

  barTrack.appendChild(barFill);
  el.appendChild(title);
  el.appendChild(details);
  el.appendChild(barTrack);
  document.documentElement.appendChild(el);
}

export function hideInstanceInfo() {
  document.getElementById(INFO_BOX_ID)?.remove();
}

export function setInstanceInfoVisible(visible: boolean) {
  const el = document.getElementById(INFO_BOX_ID);
  if (el) el.style.display = visible ? "" : "none";
}
