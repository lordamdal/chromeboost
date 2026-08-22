/**
 * Discovery tools — grep the DOM, locate form fields by hint, and wait for
 * text to appear. Implements the find_text / find_input / wait_for_text
 * MCP tools so Claude doesn't have to dump get_page_text and scan it, or
 * write execute_script bodies for routine inspection.
 *
 * All three accept a Document parameter so the same handlers can target a
 * top-level page or a same-origin iframe (see frame= on the MCP side).
 */

import { queryAllDeep, walkTextNodesDeep } from "./shadow.js";
import { framePathOf, isInFrame, viewportRect } from "./frames.js";
import { deriveInputLabel, getNearestHeading } from "./forms.js";

// ─── findText ──────────────────────────────────────────────────────────────

export interface FindTextMatch {
  text: string;
  context: string;
  selector: string;
  tag: string;
  role: string | null;
  clickable: boolean;
  position: { x: number; y: number; width: number; height: number } | null;
  /**
   * Addressable path of the same-origin iframe this match lives in, absent
   * for a top-frame match. Present so a result set spanning several documents
   * is still unambiguous: two frames on a dashboard can each contain "Save",
   * and `position` alone cannot tell them apart.
   */
  frame?: string;
}

export interface FindTextResult {
  matches: FindTextMatch[];
  total_matches: number;
  /** Count of matches that exist in the DOM but were filtered out because
   *  visible_only=true. Lets callers distinguish "not on page" from "on page
   *  but hidden" so the agent learns to pass visible_only=false when needed. */
  hidden_count: number;
  truncated: boolean;
  scope_missed?: boolean;
}

export interface FindTextOpts {
  max?: number;
  scope_selector?: string;
  regex?: boolean;
  visible_only?: boolean;
  context_chars?: number;
  /** When true, treat the query as a whole-word match. Common English words
   *  like "Live", "New", "Done", "Confirm" otherwise substring-match against
   *  pre-rendered persona / instructional content (e.g. "delivery apps" for
   *  query "Live") and trip false positives on wait_for. */
  whole_word?: boolean;
}

const CLICKABLE_TAGS = new Set(["A", "BUTTON"]);
const CLICKABLE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "option",
  "tab",
  "checkbox",
  "radio",
  "switch",
]);

/**
 * Walk the DOM looking for `query` in text nodes. Returns up to `max`
 * matches plus a total count. For each match: surrounding context, a
 * best-effort CSS selector for the nearest meaningful ancestor, and a
 * `clickable` flag indicating whether that ancestor is a button/link/role.
 *
 * Pierces open shadow roots via walkTextNodesDeep — selectors won't reach
 * across shadow boundaries via document.querySelector, so callers should
 * use click_element with the matched text rather than the selector when
 * the match is shadow-rooted (the response includes the shadow_rooted hint).
 */
export function findText(
  query: string,
  opts: FindTextOpts = {},
  doc: Document = document
): FindTextResult {
  const max = Math.max(1, opts.max ?? 10);
  const visibleOnly = opts.visible_only ?? true;
  const contextChars = Math.max(0, opts.context_chars ?? 60);

  let scope: Element | null;
  if (opts.scope_selector) {
    // Pierce open + closed shadow roots so selectors emitted by find_text
    // itself (which walks closed shadow trees) are valid as scopes. Plain
    // doc.querySelector misses elements inside Radix portals / Stencil
    // components / Lit web components.
    scope = queryAllDeep(doc, opts.scope_selector)[0] ?? null;
    if (!scope) {
      return { matches: [], total_matches: 0, hidden_count: 0, truncated: false, scope_missed: true };
    }
  } else {
    scope = doc.body;
  }
  if (!scope) {
    return { matches: [], total_matches: 0, hidden_count: 0, truncated: false };
  }

  const matcher = compileMatcher(query, opts.regex ?? false, opts.whole_word ?? false);
  if (!matcher) {
    return { matches: [], total_matches: 0, hidden_count: 0, truncated: false };
  }

  const matches: FindTextMatch[] = [];
  const seenAnchors = new WeakSet<Element>();
  let total = 0;
  let hidden = 0;

  for (const textNode of walkTextNodesDeep(scope)) {
    const text = textNode.textContent ?? "";
    if (!text.trim()) continue;

    const m = matcher(text);
    if (!m) continue;
    total++;

    const anchor = findMeaningfulAncestor(textNode);
    if (!anchor) continue;
    if (seenAnchors.has(anchor)) continue;
    seenAnchors.add(anchor);
    if (visibleOnly && !isVisible(anchor, doc)) {
      hidden++;
      continue;
    }

    if (matches.length >= max) continue;

    matches.push({
      text: m.matched,
      context: extractContext(text, m.start, m.end, contextChars),
      selector: buildPathSelector(anchor),
      tag: anchor.tagName.toLowerCase(),
      role: anchor.getAttribute("role"),
      clickable: isClickable(anchor),
      position: getPosition(anchor),
      ...(isInFrame(anchor) ? { frame: framePathOf(anchor) } : {}),
    });
  }

  return {
    matches,
    total_matches: total,
    hidden_count: hidden,
    truncated: total > matches.length,
  };
}

// ─── findInputs ────────────────────────────────────────────────────────────

export type InputMatchKind =
  | "aria-eq"
  | "placeholder-eq"
  | "label-text-eq"
  | "name-eq"
  | "id-eq"
  | "aria-includes"
  | "placeholder-includes"
  | "label-text-includes"
  | "name-includes"
  | "id-includes"
  | "fuzzy-text-walk";

const INPUT_RANK: Record<InputMatchKind, number> = {
  "aria-eq": 1,
  "placeholder-eq": 2,
  "label-text-eq": 3,
  "name-eq": 4,
  "id-eq": 5,
  "aria-includes": 6,
  "placeholder-includes": 7,
  "label-text-includes": 8,
  "name-includes": 9,
  "id-includes": 10,
  "fuzzy-text-walk": 11,
};
const INPUT_EXACT_MAX = 5;

export interface FoundInput {
  label: string;
  placeholder: string;
  type: string;
  value: string;
  under?: string;
  /** Addressable path of the same-origin iframe hosting this field, if any. */
  frame?: string;
  position: { x: number; y: number; width: number; height: number } | null;
  match_kind: InputMatchKind;
}

export interface FindInputsResult {
  fields: FoundInput[];
  total_matches: number;
  truncated: boolean;
}

export interface FindInputsOpts {
  type_filter?: string;
  max?: number;
  exact?: boolean;
}

type AnyInput = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/**
 * Find form inputs whose label/placeholder/aria/name/id matches `query`.
 * Mirrors fill.ts:findInput's match ranks (aria-eq → ... → fuzzy-text-walk)
 * but returns the top N matches with section context, instead of picking
 * one to fill. Intended as a cheap discovery step before fill_input.
 *
 * Pierces open shadow roots. Includes radios, checkboxes, and file inputs
 * (which fill_input excludes from its editable filter) so this can answer
 * "is the agree-to-terms checkbox here?" too.
 */
export function findInputs(
  query: string,
  opts: FindInputsOpts = {},
  doc: Document = document
): FindInputsResult {
  const lower = query.toLowerCase().trim();
  const max = Math.max(1, opts.max ?? 5);
  const exact = opts.exact ?? false;
  const typeFilter = opts.type_filter?.toLowerCase();

  if (!lower) {
    return { fields: [], total_matches: 0, truncated: false };
  }

  const matches: Array<{ el: AnyInput; kind: InputMatchKind }> = [];
  const seen = new WeakSet<Element>();
  function add(el: AnyInput, kind: InputMatchKind) {
    if (seen.has(el)) return;
    // Exclude type=hidden — never user-fillable, just CSRF/state noise.
    // Visually-hidden file inputs (drag-zone uploaders) keep type="file"
    // and are NOT excluded by this check.
    if (el instanceof HTMLInputElement && el.type === "hidden") return;
    seen.add(el);
    matches.push({ el, kind });
  }

  // Strongest: equality on aria-label / placeholder / name / id
  for (const el of queryAllDeep<AnyInput>(doc, "input, textarea, select")) {
    if (!matchesTypeFilter(el, typeFilter)) continue;
    const aria = (el.getAttribute("aria-label") ?? "").toLowerCase().trim();
    if (aria === lower) {
      add(el, "aria-eq");
      continue;
    }
    const placeholder = ((el as HTMLInputElement).placeholder ?? "").toLowerCase().trim();
    if (placeholder === lower) {
      add(el, "placeholder-eq");
      continue;
    }
    const name = ((el as HTMLInputElement).name ?? "").toLowerCase().trim();
    if (name === lower) {
      add(el, "name-eq");
      continue;
    }
    if (el.id.toLowerCase().trim() === lower) {
      add(el, "id-eq");
    }
  }

  // <label>(textContent === query) → input via for= or wrapping
  for (const label of queryAllDeep<HTMLLabelElement>(doc, "label")) {
    const labelText = (label.textContent ?? "").toLowerCase().trim();
    if (!labelText || labelText !== lower) continue;
    const target = resolveLabelTarget(label, doc);
    if (target && matchesTypeFilter(target, typeFilter)) add(target, "label-text-eq");
  }

  if (!exact) {
    for (const el of queryAllDeep<AnyInput>(doc, "input, textarea, select")) {
      if (!matchesTypeFilter(el, typeFilter)) continue;
      const aria = (el.getAttribute("aria-label") ?? "").toLowerCase();
      if (aria && aria.includes(lower) && aria !== lower) add(el, "aria-includes");
    }
    for (const el of queryAllDeep<HTMLInputElement | HTMLTextAreaElement>(
      doc,
      "input[placeholder], textarea[placeholder]"
    )) {
      if (!matchesTypeFilter(el, typeFilter)) continue;
      const placeholder = (el.placeholder ?? "").toLowerCase();
      if (placeholder && placeholder.includes(lower) && placeholder !== lower) {
        add(el, "placeholder-includes");
      }
    }
    for (const label of queryAllDeep<HTMLLabelElement>(doc, "label")) {
      const labelText = (label.textContent ?? "").toLowerCase().trim();
      if (!labelText || labelText === lower) continue;
      if (labelText.includes(lower)) {
        const target = resolveLabelTarget(label, doc);
        if (target && matchesTypeFilter(target, typeFilter)) add(target, "label-text-includes");
      }
    }
    for (const el of queryAllDeep<AnyInput>(doc, "input, textarea, select")) {
      if (!matchesTypeFilter(el, typeFilter)) continue;
      const name = ((el as HTMLInputElement).name ?? "").toLowerCase();
      if (name && name.includes(lower) && name !== lower) add(el, "name-includes");
      const id = el.id.toLowerCase();
      if (id && id.includes(lower) && id !== lower) add(el, "id-includes");
    }

    // Fuzzy text-walk — last resort. Mirrors fill.ts:findInput's walker so
    // labels-as-text-near-input cases are reachable for discovery too.
    if (doc.body) {
      for (const textNode of walkTextNodesDeep(doc.body)) {
        if (!textNode.textContent?.toLowerCase().includes(lower)) continue;
        const anchor = textNode.parentElement;
        if (!anchor) continue;
        if (!isVisible(anchor, doc)) continue;

        let node: Element | null = anchor;
        for (let depth = 0; depth < 8 && node; depth++) {
          const inputs = queryAllDeep<AnyInput>(node, "input, textarea, select");
          const input = inputs.find((el) => matchesTypeFilter(el, typeFilter));
          if (input) {
            add(input, "fuzzy-text-walk");
            break;
          }
          let sibFound = false;
          for (const sibling of [node.nextElementSibling, node.previousElementSibling]) {
            if (sibling) {
              const sibInputs = queryAllDeep<AnyInput>(sibling, "input, textarea, select");
              const sibInput = sibInputs.find((el) => matchesTypeFilter(el, typeFilter));
              if (sibInput) {
                add(sibInput, "fuzzy-text-walk");
                sibFound = true;
                break;
              }
            }
          }
          if (sibFound) break;
          const dnPN: Node | null = node.parentNode;
          const parent: Element | null =
            node.parentElement ?? (dnPN instanceof ShadowRoot ? dnPN.host : null);
          if (!parent || parent === doc.body) break;
          node = parent;
        }
      }
    }
  }

  matches.sort((a, b) => INPUT_RANK[a.kind] - INPUT_RANK[b.kind]);

  let final = matches;
  if (exact) {
    final = matches.filter((m) => INPUT_RANK[m.kind] <= INPUT_EXACT_MAX);
  }
  const total = final.length;
  final = final.slice(0, max);

  const fields = final.map((m) => enrichInput(m.el, m.kind, doc));
  return { fields, total_matches: total, truncated: total > fields.length };
}

// ─── waitForText ───────────────────────────────────────────────────────────

export interface WaitForTextOpts {
  timeout_ms?: number;
  scope_selector?: string;
  regex?: boolean;
  /**
   * "now" — only resolve after at least one MutationObserver record has fired.
   * Use when the page keeps already-rendered copies of the wait-target text in
   * the DOM (e.g. stacked step-instruction panels) so the default initial
   * findText check short-circuits the wait.
   */
  since?: "now";
  /**
   * When true, gate matches on word boundaries (\b...\b) so common English
   * words don't substring-match unrelated content. Prevents the "wait for
   * 'Live' matched 'delivery'" false positive on pages with heavy persona
   * data above the status panel.
   */
  whole_word?: boolean;
}

export interface WaitForTextResult {
  found: boolean;
  selector?: string;
  text?: string;
  context?: string;
  /** When `query` was an array, the specific entry that matched. */
  matched_query?: string;
  /** Zero-based index into the input array when `query` was an array. */
  matched_index?: number;
  elapsed_ms: number;
  /** On timeout, the trailing slice of the scope's text content (best-effort,
   *  capped) so callers can see "what was visible when the wait gave up". */
  last_text?: string;
  /** Set when the initial check matched <50ms in and the agent likely caught
   *  stale DOM from a prior step. Suggests passing `since: "now"`. */
  initial_match_warning?: string;
}

/**
 * Wait for `query` (a single string OR an array of strings — any-of mode) to
 * appear in the DOM. Resolves on the first match or when `timeout_ms`
 * elapses. Uses a MutationObserver, no polling. The initial check fires
 * synchronously before the observer attaches so already-present text
 * resolves immediately. On timeout, the result carries `last_text`, the
 * trailing slice of the scope's content, so callers can see what state the
 * scope was actually in when the wait gave up.
 */
export function waitForText(
  query: string | string[],
  opts: WaitForTextOpts = {},
  doc: Document = document
): Promise<WaitForTextResult> {
  const timeoutMs = Math.max(100, opts.timeout_ms ?? 10_000);
  const start = performance.now();
  const queries = Array.isArray(query) ? query : [query];
  const initialMatchThresholdMs = 50;

  const sinceNow = opts.since === "now";

  const findOpts = {
    scope_selector: opts.scope_selector,
    regex: opts.regex,
    visible_only: true,
    context_chars: 60,
    whole_word: opts.whole_word,
  };

  // Stable identity for a match so we can tell a genuinely NEW occurrence apart
  // from pre-existing text that an unrelated mutation merely re-surfaced.
  const matchKey = (m: FindTextMatch) => `${m.selector} ${m.text} ${m.context}`;

  const findCandidates = (): Array<{ match: FindTextMatch; query: string; index: number }> => {
    const out: Array<{ match: FindTextMatch; query: string; index: number }> = [];
    for (let i = 0; i < queries.length; i++) {
      // since:"now" needs every current occurrence (to baseline + diff), so
      // widen max in that mode; otherwise the first match is enough.
      const r = findText(queries[i], { ...findOpts, max: sinceNow ? 25 : 1 }, doc);
      for (const m of r.matches) out.push({ match: m, query: queries[i], index: i });
    }
    return out;
  };

  // since:"now" baseline: snapshot every match present at call time. We only
  // resolve on a match whose key is NOT in this set, so the wait fires on text
  // that was genuinely ADDED to the scope — not on the query string that was
  // already sitting in e.g. the prompt textarea, and not on late-rendered
  // re-paints of text that already existed.
  const baselineKeys = new Set<string>();
  if (sinceNow) {
    for (const c of findCandidates()) baselineKeys.add(matchKey(c.match));
  }

  const check = (): { match: FindTextMatch; query: string; index: number } | null => {
    for (const c of findCandidates()) {
      if (sinceNow && baselineKeys.has(matchKey(c.match))) continue;
      return c;
    }
    return null;
  };

  return new Promise<WaitForTextResult>((resolve) => {
    // When since="now" is set the initial-check short-circuit is skipped,
    // callers explicitly want to wait for a NEW mutation, not match against
    // already-present text. Used to defeat the "stacked instructions still
    // in DOM after the route changed" footgun on SPAs that keep all
    // prior step content visible-but-stacked.
    if (!sinceNow) {
      const initial = check();
      if (initial) {
        const elapsed = Math.round(performance.now() - start);
        const warning =
          elapsed < initialMatchThresholdMs
            ? `matched on initial check (elapsed_ms=${elapsed}, no mutation observed). If the page kept this text in the DOM from a prior step, pass since: "now" to gate on a new mutation.`
            : undefined;
        resolve({
          found: true,
          selector: initial.match.selector,
          text: initial.match.text,
          context: initial.match.context,
          matched_query: queries.length > 1 ? initial.query : undefined,
          matched_index: queries.length > 1 ? initial.index : undefined,
          elapsed_ms: elapsed,
          initial_match_warning: warning,
        });
        return;
      }
    }

    let scope: Element | Document | null = doc;
    if (opts.scope_selector) {
      // Pierce open + closed shadow roots so the wait can observe inside
      // Radix portals / Stencil web components, matches findText's scope
      // behavior so a caller can wait on a section previously located via
      // find_text.
      scope = queryAllDeep(doc, opts.scope_selector)[0] ?? null;
      if (!scope) {
        resolve({
          found: false,
          elapsed_ms: Math.round(performance.now() - start),
        });
        return;
      }
    }
    const observeTarget: Element | Document = scope ?? doc;

    const observer = new MutationObserver(() => {
      // since:"now" gating is handled by the baseline-key diff inside check():
      // a match only resolves if its key wasn't present at call time. The
      // observer just re-runs the check whenever the DOM changes (it observes
      // childList + characterData, the mutations that can bring in new text).
      const m = check();
      if (m) {
        observer.disconnect();
        clearTimeout(timer);
        resolve({
          found: true,
          selector: m.match.selector,
          text: m.match.text,
          context: m.match.context,
          matched_query: queries.length > 1 ? m.query : undefined,
          matched_index: queries.length > 1 ? m.index : undefined,
          elapsed_ms: Math.round(performance.now() - start),
        });
      }
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      // Capture the trailing slice of the scope's text so the caller learns
      // what state the page was actually in when the wait gave up. Caps at
      // 240 chars — enough for "Currently visible: 'Starting up... 47%'"
      // without bloating the response.
      let lastText: string | undefined;
      try {
        const target = scope instanceof Document ? (scope.body ?? scope.documentElement) : scope;
        if (target) {
          const txt = (target.textContent ?? "").replace(/\s+/g, " ").trim();
          lastText = txt.length > 240 ? txt.slice(-240) : txt;
        }
      } catch { /* ignore */ }
      resolve({
        found: false,
        elapsed_ms: Math.round(performance.now() - start),
        last_text: lastText,
      });
    }, timeoutMs);
    observer.observe(observeTarget, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

type Matcher = (text: string) => { matched: string; start: number; end: number } | null;

function compileMatcher(query: string, regex: boolean, wholeWord: boolean = false): Matcher | null {
  if (!query) return null;
  if (regex) {
    // Wrap the user's regex in word boundaries when whole_word is set. The
    // non-capturing group lets pipes/alternation inside `query` still work.
    const source = wholeWord ? `\\b(?:${query})\\b` : query;
    let re: RegExp;
    try {
      re = new RegExp(source, "i");
    } catch {
      return null;
    }
    return (text) => {
      const m = text.match(re);
      if (!m || m.index === undefined) return null;
      return { matched: m[0], start: m.index, end: m.index + m[0].length };
    };
  }
  if (wholeWord) {
    // Whole-word substring: escape regex metacharacters in the user's query,
    // then wrap in word boundaries. Eliminates common English false positives
    // (Live → "delivery", Done → "abandoned", Confirm → "discomfort").
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(`\\b${escaped}\\b`, "i");
    } catch {
      return null;
    }
    return (text) => {
      const m = text.match(re);
      if (!m || m.index === undefined) return null;
      return { matched: m[0], start: m.index, end: m.index + m[0].length };
    };
  }
  const lower = query.toLowerCase();
  return (text) => {
    const idx = text.toLowerCase().indexOf(lower);
    if (idx < 0) return null;
    return { matched: text.slice(idx, idx + lower.length), start: idx, end: idx + lower.length };
  };
}

function extractContext(text: string, start: number, end: number, chars: number): string {
  const left = Math.max(0, start - chars);
  const right = Math.min(text.length, end + chars);
  let snippet = text.slice(left, right).replace(/\s+/g, " ").trim();
  if (left > 0) snippet = "…" + snippet;
  if (right < text.length) snippet = snippet + "…";
  return snippet;
}

function findMeaningfulAncestor(textNode: Text): Element | null {
  const direct = textNode.parentElement;
  if (!direct) return null;
  let node: Element | null = direct;
  for (let d = 0; d < 5 && node; d++) {
    if (isMeaningful(node)) return node;
    const dnPN: Node | null = node.parentNode;
    node =
      node.parentElement ?? (dnPN instanceof ShadowRoot ? (dnPN.host as Element) : null);
  }
  return direct;
}

function isMeaningful(el: Element): boolean {
  const tag = el.tagName;
  if (CLICKABLE_TAGS.has(tag)) return true;
  if (/^H[1-6]$/.test(tag)) return true;
  if (tag === "LABEL" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "P" || tag === "LI" || tag === "TD" || tag === "TH") return true;
  const role = el.getAttribute("role");
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (el.hasAttribute("aria-label")) return true;
  return false;
}

function isClickable(el: Element): boolean {
  // Walk ancestors to catch hidden-via-parent cases. Reddit's flair dropdown
  // hosts <button>s inside a [hidden] panel — the button itself reports
  // tag=BUTTON and not disabled, so without the ancestor check find_text
  // would label it clickable. The walk stops at documentElement to avoid
  // false positives on document.body itself.
  for (let cur: Element | null = el; cur && cur !== el.ownerDocument.documentElement; cur = cur.parentElement) {
    if (cur.hasAttribute("hidden")) return false;
    if (cur.getAttribute("aria-hidden") === "true") return false;
    const view = el.ownerDocument.defaultView;
    if (view) {
      try {
        const cs = view.getComputedStyle(cur);
        if (cs.display === "none") return false;
        if (cs.visibility === "hidden") return false;
      } catch { /* cross-window or detached — ignore */ }
    }
  }
  const tag = el.tagName;
  if (tag === "BUTTON") return !(el as HTMLButtonElement).disabled;
  if (tag === "A") return el.hasAttribute("href");
  const role = el.getAttribute("role");
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type.toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") return true;
    if (type === "checkbox" || type === "radio") return true;
  }
  if (el.hasAttribute("onclick")) return true;
  return false;
}

function isVisible(el: Element, doc: Document): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const view = doc.defaultView;
  if (!view) return true;
  let s: CSSStyleDeclaration;
  try {
    s = view.getComputedStyle(el);
  } catch {
    return true;
  }
  if (s.display === "none") return false;
  if (s.visibility === "hidden") return false;
  if (s.opacity === "0") return false;
  return true;
}

function getPosition(
  el: Element
): { x: number; y: number; width: number; height: number } | null {
  // Top-level viewport coordinates. These positions are routinely fed straight
  // into click_at_coordinates, so reporting a frame-local rect would hand the
  // caller a coordinate that aims at the wrong part of the page.
  const rect = viewportRect(el);
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Build a best-effort CSS selector for an element. Walks up to 6 levels,
 * stopping early if it hits an element with an id. Produces a chained
 * descendant selector (e.g. `nav > ul > li:nth-of-type(2) > a`) that's
 * usually unique enough for a follow-up document.querySelector. Skips
 * `:nth-of-type` when the element is the only child of its tag in its
 * parent. Won't reach across shadow boundaries — for shadow-rooted
 * matches the caller should use click_element with the matched text.
 */
function buildPathSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      return parts.join(" > ");
    }
    // data-testid is a stable, intent-revealing anchor (e.g.
    // "carousel-add-button-bottom") that survives re-renders better than
    // nth-of-type, and surfacing it tells the agent the element's role.
    const testid = current.getAttribute("data-testid");
    if (testid) {
      parts.unshift(`[data-testid="${CSS.escape(testid)}"]`);
      return parts.join(" > ");
    }
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(current.tagName.toLowerCase());
      break;
    }
    const tag = current.tagName.toLowerCase();
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
    if (sameTag.length === 1) {
      parts.unshift(tag);
    } else {
      const idx = sameTag.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
    }
    current = parent;
  }
  return parts.join(" > ");
}

function resolveLabelTarget(label: HTMLLabelElement, doc: Document): AnyInput | null {
  if (label.htmlFor) {
    const target = doc.getElementById(label.htmlFor);
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return target;
    }
  }
  const inner = label.querySelector<AnyInput>("input, textarea, select");
  return inner ?? null;
}

function matchesTypeFilter(el: AnyInput, filter?: string): boolean {
  if (!filter || filter === "any") return true;
  const elType =
    el instanceof HTMLInputElement ? el.type.toLowerCase() : el.tagName.toLowerCase();
  return elType === filter;
}

function enrichInput(el: AnyInput, kind: InputMatchKind, doc: Document): FoundInput {
  const placeholder = (el as HTMLInputElement).placeholder ?? "";
  let label = "";
  if (el.type === "file") {
    // File inputs reuse the file-label heuristics indirectly via deriveInputLabel;
    // deriveInputLabel falls back to parent-text climb which is good enough for
    // hidden-input drag-and-drop uploaders.
    label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
    if (!label && el.id) {
      const lbl = doc.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) label = (lbl.textContent ?? "").trim();
    }
    if (!label) {
      let node: Element | null = el.parentElement;
      for (let d = 0; d < 5 && node; d++) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text && text.length < 120) {
          label = text.slice(0, 80);
          break;
        }
        node = node.parentElement;
      }
    }
  } else {
    label = deriveInputLabel(el, doc);
  }

  let value = "";
  if (el instanceof HTMLSelectElement) {
    value = el.options[el.selectedIndex]?.text ?? el.value;
  } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    value = el.checked ? "checked" : "unchecked";
  } else {
    value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
  }

  const under = getNearestHeading(el, doc);
  const rect = viewportRect(el);
  const position =
    rect.width === 0 && rect.height === 0
      ? null
      : {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };

  const type =
    el instanceof HTMLInputElement ? el.type || "text" : el.tagName.toLowerCase();

  return {
    label: label.replace(/\s+/g, " ").slice(0, 80) || "(unnamed)",
    placeholder: placeholder.slice(0, 80),
    type,
    value: value.slice(0, 60),
    ...(under ? { under } : {}),
    ...(isInFrame(el) ? { frame: framePathOf(el) } : {}),
    position,
    match_kind: kind,
  };
}
