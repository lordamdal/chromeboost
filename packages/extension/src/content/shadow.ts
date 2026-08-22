/**
 * Shadow-DOM-piercing helpers.
 *
 * Many SPAs (chat widgets, Radix UI components, Stencil-based widgets,
 * Lit components, web-component-heavy sites) render content inside shadow
 * roots. Standard `document.querySelectorAll` and `innerText` don't traverse
 * those boundaries, so chromeboost needs its own deep-walk helpers.
 *
 * In MV3 content scripts (this file's runtime context), `chrome.dom
 * .openOrClosedShadowRoot()` pierces BOTH open AND closed shadow roots. We
 * use it when available; the bare `el.shadowRoot` fallback handles open-only
 * (page-context `execute_script` and any future caller not in a content
 * script).
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** Depth cap for same-origin frame descent, mirroring frames.ts. */
const MAX_FRAME_DESCENT = 5;

/**
 * The document of a same-origin `<iframe>`/`<frame>`, or null when the frame
 * is cross-origin, detached, or has not produced a body yet.
 *
 * Deliberately inlined here rather than imported from `frames.ts`: that module
 * builds on `queryAllDeep`, and routing this one accessor through it would
 * make the two modules mutually dependent at load time.
 */
function sameOriginFrameDoc(el: Element): Document | null {
  if (el.tagName !== "IFRAME" && el.tagName !== "FRAME") return null;
  try {
    const doc = (el as HTMLIFrameElement).contentDocument;
    return doc && doc.body ? doc : null;
  } catch {
    return null; // cross-origin
  }
}

export type DeepWalkOptions = {
  /**
   * Descend into same-origin iframes. Default true: chromeboost treats the
   * frame boundary the same way it treats the shadow boundary, because an
   * agent asked to click "Save" should not have to know which document the
   * button happens to live in. Pass false when the answer must be scoped to a
   * single document — uniqueness checks for selector generation, for one,
   * would otherwise count matches in unrelated frames and reject a selector
   * that is perfectly unique where it will be used.
   */
  frames?: boolean;
};

/**
 * Return the shadow root attached to `el`, open OR closed. Uses the
 * content-script-only `chrome.dom.openOrClosedShadowRoot()` API when present,
 * falls back to `el.shadowRoot` (open-only). Returns null for non-hosts.
 */
export function getShadowRoot(el: Element): ShadowRoot | null {
  const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
  if (chromeDom?.openOrClosedShadowRoot) {
    try {
      const sr = chromeDom.openOrClosedShadowRoot(el);
      if (sr) return sr;
    } catch { /* fall through to open-shadow probe */ }
  }
  return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * Like `querySelectorAll`, but also descends into open AND closed shadow
 * roots (via chrome.dom.openOrClosedShadowRoot). Returns a flat list of
 * matches across the entire tree.
 */
export function queryAllDeep<E extends Element = Element>(
  root: Document | Element | ShadowRoot,
  selector: string,
  options?: DeepWalkOptions
): E[] {
  const out: E[] = [];
  const seen = new WeakSet<Element>();
  const seenDocs = new Set<Document>();
  const intoFrames = options?.frames !== false;

  function recurse(r: ParentNode, depth: number) {
    for (const m of Array.from(r.querySelectorAll<E>(selector))) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
    for (const el of Array.from(r.querySelectorAll<Element>("*"))) {
      const sr = getShadowRoot(el);
      if (sr) recurse(sr, depth);
      if (!intoFrames || depth >= MAX_FRAME_DESCENT) continue;
      const fdoc = sameOriginFrameDoc(el);
      // Matches from the host document are collected before any frame is
      // entered, so a selector that resolves in both keeps ranking the
      // top-level element first. That ordering is what makes frame descent a
      // safe default rather than a behaviour change.
      if (fdoc && !seenDocs.has(fdoc)) {
        seenDocs.add(fdoc);
        recurse(fdoc, depth + 1);
      }
    }
  }

  const rootDoc = (root as Document).nodeType === Node.DOCUMENT_NODE ? (root as Document) : null;
  if (rootDoc) seenDocs.add(rootDoc);
  recurse(root, 0);
  return out;
}

/**
 * Walk every element in the tree, descending into shadow roots (open + closed).
 * Yields elements in document order (parent before children, host before
 * shadow content).
 */
export function* walkElementsDeep(
  root: Element | Document | ShadowRoot,
  options?: DeepWalkOptions
): Generator<Element> {
  const intoFrames = options?.frames !== false;
  const seenDocs = new Set<Document>();
  const queue: Array<Element | DocumentFragment> = [root as Element];
  while (queue.length) {
    const node = queue.shift()!;
    const el = node as Element;
    if (el.nodeType === 1) {
      yield el;
      const sr = getShadowRoot(el);
      if (sr) queue.push(sr as unknown as Element);
      if (intoFrames) {
        const fdoc = sameOriginFrameDoc(el);
        if (fdoc && !seenDocs.has(fdoc)) {
          seenDocs.add(fdoc);
          queue.push(fdoc.documentElement);
        }
      }
    }
    if ("children" in node) {
      for (const c of Array.from(node.children)) queue.push(c);
    }
  }
}

/**
 * Extract text content from `root` including shadow descendants. Skips
 * <script>, <style>, <noscript>, <template> by default; pass `extraSkipTags`
 * (uppercase tag names) to skip more (e.g. NAV/HEADER/FOOTER).
 */
export function extractTextDeep(root: Node, extraSkipTags?: Set<string>): string {
  const parts: string[] = [];
  const skip = extraSkipTags
    ? new Set([...SKIP_TAGS, ...extraSkipTags])
    : SKIP_TAGS;

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent;
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (skip.has(el.tagName)) return;
      const sr = getShadowRoot(el);
      if (sr) walk(sr);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }

  walk(root);
  return parts.join("");
}

/**
 * Walk every text node in the tree, descending into shadow roots (open +
 * closed). Yields text nodes in document order. Skips text inside <script>,
 * <style>, etc. so you only see user-visible text. Used by fill_input's
 * fuzzy text walk so label-near-input matching works inside shadow trees.
 */
export function* walkTextNodesDeep(root: Node, options?: DeepWalkOptions): Generator<Text> {
  if (root.nodeType === Node.TEXT_NODE) {
    yield root as Text;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    const sr = getShadowRoot(el);
    if (sr) yield* walkTextNodesDeep(sr, options);
    // Labels live in the same document as the input they describe. Now that
    // queryAllDeep resolves inputs inside same-origin frames, the label walk
    // has to enter those frames too or fill_input would pair a frame-hosted
    // input with whatever label happened to sit near it in the parent page.
    if (options?.frames !== false) {
      const fdoc = sameOriginFrameDoc(el);
      if (fdoc) yield* walkTextNodesDeep(fdoc.body, options);
    }
  }
  for (const child of Array.from(root.childNodes)) yield* walkTextNodesDeep(child, options);
}

/**
 * Describe the shadow-host elements attached to `root`'s subtree. Returns one
 * entry per host whose shadowRoot is currently attached, with an `open` flag
 * (true if `el.shadowRoot` is exposed via the standard property, false if it
 * is only reachable via `chrome.dom.openOrClosedShadowRoot` — closed roots).
 *
 * Used as a diagnostic signal: when execute_script returns an empty document
 * but `list_frames`/`get_page_text` report a non-empty `shadow_hosts` array,
 * the page is using closed shadow DOM (Radix portals, Stencil, Lit) and the
 * agent should switch to find_text/get_page_text/click_element/fill_input —
 * those pierce.
 *
 * `max` caps the number of returned entries to avoid response bloat on pages
 * with hundreds of web-component instances (a 25-host cap is plenty for the
 * "is shadow DOM in play here?" signal).
 */
export function collectShadowHosts(
  root: Document | Element = document,
  max: number = 25
): Array<{ selector: string; open: boolean; depth: number }> {
  const out: Array<{ selector: string; open: boolean; depth: number }> = [];
  function describeHost(el: Element, depth: number) {
    const tag = el.tagName.toLowerCase();
    let selector: string;
    if (el.id) {
      selector = `#${CSS.escape(el.id)}`;
    } else if (el.className && typeof el.className === "string" && el.className.trim()) {
      const cls = el.className.trim().split(/\s+/).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
      selector = `${tag}${cls}`;
    } else {
      selector = tag;
    }
    const open = !!(el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    out.push({ selector, open, depth });
  }
  function recurse(node: ParentNode, depth: number) {
    if (out.length >= max) return;
    for (const el of Array.from(node.querySelectorAll<Element>("*"))) {
      if (out.length >= max) return;
      const sr = getShadowRoot(el);
      if (sr) {
        describeHost(el, depth);
        recurse(sr, depth + 1);
      }
    }
  }
  recurse(root, 0);
  return out;
}

/**
 * Cheap count of shadow hosts. Used by get_page_text to surface a numeric
 * "this page uses shadow DOM" signal without enumerating selectors.
 */
export function countShadowHosts(root: Document | Element = document): number {
  let n = 0;
  for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
    if (getShadowRoot(el)) {
      n++;
      // Also recurse into the shadow tree to catch nested hosts (closed shadow
      // roots can contain further shadow hosts; Radix portals nest a few deep).
      const sr = getShadowRoot(el);
      if (sr) {
        for (const inner of Array.from(sr.querySelectorAll<Element>("*"))) {
          if (getShadowRoot(inner)) n++;
        }
      }
    }
  }
  return n;
}

/**
 * Get the actually-focused element, descending through any nested shadow roots.
 * `document.activeElement` returns the shadow host, not the focused element
 * inside the shadow tree — this drills down to find the real focus target.
 */
export function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active) {
    const sr = getShadowRoot(active);
    if (!sr || !sr.activeElement) break;
    active = sr.activeElement;
  }
  return active;
}
