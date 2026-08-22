/**
 * Form-field enumeration shared by the get_form_fields handler and the
 * find_input discovery tool. Pulled out of content/index.ts so both code
 * paths produce identical inventory data.
 *
 * Pass an iframe's contentDocument as `doc` to enumerate fields inside a
 * same-origin iframe — used by find_input's frame= parameter.
 *
 * All queries pierce open AND closed shadow roots via queryAllDeep so form
 * fields rendered inside Radix UI portals, Stencil/Lit web components, or
 * other shadow-host wrappers are reachable.
 */

import { queryAllDeep } from "./shadow.js";
import { framePathOf, isInFrame, uniqueSelectorIn, viewportRect } from "./frames.js";

export interface EnumeratedField {
  index: number;
  type: string;
  label: string;
  value: string;
  y: number;
  selector: string;
  /**
   * Addressable path of the same-origin iframe hosting this field, absent for
   * a top-frame field. Field discovery walks into frames now, so without this
   * the caller would get a selector that resolves nowhere from the top
   * document and no indication why.
   */
  frame?: string;
  context?: string;
  /** True when the field is `required`, `aria-required="true"`, or its
   *  containing `<label>` text ends in `*` (the de-facto required-field
   *  convention on dashboards that don't use semantic attributes). Used by
   *  the only_empty filter to surface required-but-empty fields the user
   *  hasn't filled yet, the "why is Submit disabled" diagnostic. */
  required?: boolean;
  /** True when the field's current value is empty/unchecked/unselected.
   *  Combined with `required`, lets the caller filter to required-but-empty
   *  fields in one pass. */
  empty?: boolean;
}

export interface EnumerateResult {
  fields: EnumeratedField[];
  hiddenFieldCount: number;
  captcha: CaptchaInfo | null;
  oauthIndicators: string[];
}

/**
 * Captcha presence on the page. Detection covers the three major vendors that
 * cover ~95% of forms: Google reCAPTCHA, Cloudflare Turnstile, hCaptcha.
 * sitekey is best-effort — useful when the agent needs to surface it to the
 * user verbatim (e.g. for an off-page captcha-solving service).
 */
export interface CaptchaInfo {
  kind: "recaptcha" | "turnstile" | "hcaptcha";
  sitekey: string | null;
}

/**
 * True if the element OR any ancestor is `display:none`, `visibility:hidden`,
 * or `aria-hidden="true"`. Catches the common "form section in a hidden
 * collapsible parent" pattern where the input itself reports default styles
 * but is invisible because of an ancestor.
 */
function isAncestorHidden(el: Element, doc: Document): boolean {
  const view = doc.defaultView;
  if (!view) return false;
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    if (cur.getAttribute("aria-hidden") === "true") return true;
    const s = view.getComputedStyle(cur);
    if (s.display === "none") return true;
    if (s.visibility === "hidden") return true;
    // Climb past shadow boundaries — parentElement is null at the shadow root,
    // so jump to the host via parentNode. Without this, an input inside a
    // shadow-rooted hidden wrapper would be reported as visible.
    if (cur.parentElement) {
      cur = cur.parentElement;
    } else {
      const pn: Node | null = cur.parentNode;
      cur = pn instanceof ShadowRoot ? pn.host : null;
    }
  }
  return false;
}

/**
 * Walk up an element's ancestors looking for the nearest section-like
 * heading. Returns the heading's trimmed text, or "" if none found within
 * 8 levels.
 */
export function getNearestHeading(el: Element, doc: Document): string {
  const body = doc.body;
  let node: Element | null = el.parentElement;
  for (let d = 0; d < 8 && node && node !== body; d++) {
    for (const sel of [
      "h1,h2,h3,h4,h5,h6",
      "legend",
      "[class*='section-title'],[class*='heading'],[class*='section-header']",
    ]) {
      const h = node.querySelector(sel);
      if (h && h !== el && !h.contains(el)) {
        return (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      }
    }
    node = node.parentElement;
  }
  return "";
}

/**
 * Compute a stable document-y coordinate even for hidden / zero-size
 * elements. getBoundingClientRect returns 0 for display:none elements,
 * which combined with scrollY produces the current scroll position
 * (wrong). Fall back to the offsetParent chain.
 */
function getDocumentY(el: HTMLElement, doc: Document): number {
  // Fields from different frames share one inventory, so their sort key has
  // to live in one coordinate space. For a frame-hosted field, "document y"
  // in its own document says nothing about where it appears relative to the
  // parent page's fields; its translated on-screen position does.
  if (isInFrame(el)) {
    return Math.round(viewportRect(el).top + window.scrollY);
  }
  const view = doc.defaultView;
  const scrollY = view?.scrollY ?? 0;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return Math.round(rect.top + scrollY);
  }
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

/**
 * Derive a human-readable label for a form input by checking, in order:
 * placeholder, aria-label, associated <label>, and nearby parent text.
 */
export function deriveInputLabel(el: HTMLElement, doc: Document): string {
  const inputEl = el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  let label =
    inputEl.getAttribute("placeholder") || inputEl.getAttribute("aria-label") || "";
  if (!label && el.id) {
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
    if (lbl) label = (lbl.textContent ?? "").trim();
  }
  if (!label) {
    let node: Element | null = el.parentElement;
    for (let d = 0; d < 4 && node && node !== doc.body; d++) {
      const heading = node.querySelector(
        "label, h1, h2, h3, h4, h5, legend, [class*='label']"
      );
      if (heading && heading !== el) {
        label = (heading.textContent ?? "").trim();
        break;
      }
      node = node.parentElement;
    }
  }
  return label;
}

/**
 * Derive a label for a file input, with a special-case parent-text climb
 * that's permissive enough to pick up labels on hidden-input drag-and-drop
 * uploaders.
 */
function deriveFileLabel(el: HTMLInputElement, doc: Document): string {
  let label = el.getAttribute("aria-label") || el.getAttribute("name") || "";
  if (!label && el.id) {
    // Pierce shadow roots so a <label for=…> living in a separate shadow tree
    // still associates with this input.
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
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
  return label;
}

// Validation-message phrasings that indicate a field is required. Deliberately
// specific (not a bare /required/i match) so unrelated helper text like
// "Required experience: 5 years" doesn't trip it. Covers the late-bound
// messages SPAs render only after a failed submit ("This question is required",
// "Please select an option", "You must answer this").
const REQUIRED_VALIDATION_RE =
  /\bis required\b|\brequired field\b|\bthis (?:question|field) is required\b|\bplease (?:answer|select|choose|enter|provide|complete)\b|\byou must (?:answer|select|choose|provide|complete)\b/i;

/**
 * Late-bound / conditional required detection. Many SPA forms (DataAnnotation,
 * survey builders, Radix/headlessui disclosure panels) don't set `required` or
 * `aria-required` up front — required-ness only surfaces as a visible
 * validation message after a submit attempt, or as `aria-invalid="true"`.
 * This catches those so get_form_fields(only_empty) stops reporting "0
 * required-but-empty" while submit is actually blocked.
 */
function hasRequiredValidation(el: HTMLElement, doc: Document): boolean {
  if (el.getAttribute("aria-invalid") === "true") return true;

  // Error element referenced by the field via aria-errormessage/-describedby.
  for (const attr of ["aria-errormessage", "aria-describedby"]) {
    const ids = (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const node =
        doc.getElementById(id) ?? queryAllDeep<HTMLElement>(doc, `#${CSS.escape(id)}`)[0];
      if (
        node &&
        REQUIRED_VALIDATION_RE.test(node.textContent ?? "") &&
        !isAncestorHidden(node, doc)
      ) {
        return true;
      }
    }
  }

  // Walk up to the nearest question/group container and look for a visible
  // error-styled element whose text reads as a required-validation message.
  let node: Element | null = el.parentElement;
  for (let d = 0; d < 6 && node && node !== doc.body; d++) {
    const errs = node.querySelectorAll(
      "[role='alert'],[aria-live],[class*='error'],[class*='invalid'],[class*='required']"
    );
    for (const m of Array.from(errs)) {
      if (
        REQUIRED_VALIDATION_RE.test(m.textContent ?? "") &&
        !isAncestorHidden(m, doc)
      ) {
        return true;
      }
    }
    // Stop once we've climbed to a recognisable question/group boundary so we
    // don't attribute a sibling question's error to this field.
    if (
      node.matches?.(
        "fieldset,[role='group'],[role='radiogroup'],[id*='question'],[class*='question'],[data-question],[class*='form-group']"
      )
    ) {
      break;
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * True when an input is required via the standard HTML attribute, ARIA, the
 * unofficial "label ends in *" convention, or a late-bound validation message
 * / aria-invalid state (see hasRequiredValidation).
 */
function isRequiredField(el: HTMLElement, doc: Document): boolean {
  if (el.hasAttribute("required")) return true;
  if (el.getAttribute("aria-required") === "true") return true;
  if (el.id) {
    const lbl = queryAllDeep<HTMLLabelElement>(doc, `label[for="${CSS.escape(el.id)}"]`)[0];
    if (lbl && /[*✱∗]\s*$/.test((lbl.textContent ?? "").trim())) return true;
  }
  // Wrapping <label> case
  const parentLabel = el.closest?.("label");
  if (parentLabel && /[*✱∗]\s*$/.test((parentLabel.textContent ?? "").trim())) {
    return true;
  }
  if (hasRequiredValidation(el, doc)) return true;
  return false;
}

/**
 * True when the field's value (or checked state) is empty / unselected.
 * Mirrors the logic in enumerate's value-extraction so the `empty` flag is
 * consistent with the displayed `value`.
 */
function isFieldEmpty(el: HTMLElement): boolean {
  if (el instanceof HTMLSelectElement) {
    // Compare against "" explicitly — a legitimate selected option with value
    // "0" (e.g. a numeric quantity dropdown) is NOT empty, but `!el.value`
    // would treat it as empty.
    return el.value === "" || el.selectedIndex < 0;
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return !el.checked;
    if (el.type === "file") return !el.files || el.files.length === 0;
    return el.value.trim().length === 0;
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value.trim().length === 0;
  }
  // Custom editors (CodeMirror/Monaco): consider empty if no text content.
  return (el.textContent ?? "").trim().length === 0;
}

/**
 * Build a unique-ish CSS selector for an element. Prefers id, falls back
 * to tag:nth-of-type. Mirrors the inline pattern in get_form_fields.
 */
function buildSelector(el: Element, doc: Document): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  // The old fallback was `tag:nth-of-type(<index among ALL such tags in the
  // document>)`, which is only correct when every matching element happens to
  // share one parent — `:nth-of-type` counts siblings. Frame descent made the
  // mismatch routine rather than occasional, since the index then spanned
  // several documents. uniqueSelectorIn builds a real path and verifies it
  // resolves to exactly one element before handing it back.
  return uniqueSelectorIn(el.ownerDocument ?? doc, el);
}

/**
 * Enumerate every form field in `doc`: file inputs, standard inputs,
 * textareas, selects, CodeMirror editors, Monaco editors. Returns the
 * fields in document-order (sorted by y) plus a count of hidden fields
 * that didn't make the cut.
 */
export function enumerateFormFields(doc: Document = document): EnumerateResult {
  const fields: EnumeratedField[] = [];
  let idx = 0;

  // File inputs — always include even if visually hidden (often 0×0 behind
  // custom drag zones). Tagged label includes a usage hint for Claude.
  for (const el of queryAllDeep<HTMLInputElement>(doc, "input[type=file]")) {
    const label = deriveFileLabel(el, doc);
    const context = getNearestHeading(el, doc);
    fields.push({
      index: ++idx,
      type: "file",
      label:
        (label.replace(/\s+/g, " ").slice(0, 80) || "(unnamed)") +
        " — use set_file_input(hint, filePath) to upload",
      value: el.files?.[0]?.name ?? "",
      y: getDocumentY(el, doc),
      selector: el.id ? `#${CSS.escape(el.id)}` : uniqueSelectorIn(el.ownerDocument ?? doc, el),
      ...(isInFrame(el) ? { frame: framePathOf(el) } : {}),
      required: isRequiredField(el, doc),
      empty: isFieldEmpty(el),
      ...(context ? { context } : {}),
    });
  }

  // Standard inputs (file handled above), textareas, selects
  const FIELD_SELECTORS =
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]), textarea, select";
  for (const el of queryAllDeep<HTMLElement>(doc, FIELD_SELECTORS)) {
    if (isAncestorHidden(el, doc)) continue;

    const label = deriveInputLabel(el, doc);

    let value = "";
    if (el instanceof HTMLSelectElement) {
      value = el.options[el.selectedIndex]?.text ?? el.value;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      value = el.checked ? "checked" : "unchecked";
    } else {
      value = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
    }

    const context = getNearestHeading(el, doc);
    fields.push({
      index: ++idx,
      type: el instanceof HTMLInputElement ? (el.type || "text") : el.tagName.toLowerCase(),
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: value.slice(0, 60),
      y: getDocumentY(el, doc),
      selector: buildSelector(el, doc),
      ...(isInFrame(el) ? { frame: framePathOf(el) } : {}),
      required: isRequiredField(el, doc),
      empty: isFieldEmpty(el),
      ...(context ? { context } : {}),
    });
  }

  // CodeMirror 6 editors
  for (const editor of queryAllDeep<HTMLElement>(doc, ".cm-editor")) {
    if (isAncestorHidden(editor, doc)) continue;
    const view = doc.defaultView;
    const rect = editor.getBoundingClientRect();
    const scrollY = view?.scrollY ?? 0;

    let label = editor.getAttribute("aria-label") ?? "";
    if (!label) {
      const container = editor.closest("div[class], section, fieldset, li") ?? editor.parentElement;
      if (container) {
        const heading = container.querySelector(
          "label, h1, h2, h3, h4, h5, legend, [class*='label']"
        );
        if (heading) label = (heading.textContent ?? "").trim();
      }
    }

    const currentText = (editor.querySelector(".cm-content")?.textContent ?? "").slice(0, 60);
    const context = getNearestHeading(editor, doc);
    fields.push({
      index: ++idx,
      type: "codemirror",
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: currentText,
      y: Math.round(rect.top + scrollY),
      selector: ".cm-editor",
      ...(isInFrame(editor) ? { frame: framePathOf(editor) } : {}),
      required: isRequiredField(editor, doc),
      empty: (editor.querySelector(".cm-content")?.textContent ?? "").trim().length === 0,
      ...(context ? { context } : {}),
    });
  }

  // Monaco editors
  for (const editor of queryAllDeep<HTMLElement>(doc, ".monaco-editor")) {
    if (isAncestorHidden(editor, doc)) continue;

    let label = editor.getAttribute("aria-label") ?? "";
    if (!label) {
      const container = editor.closest("div[class], section, fieldset, li") ?? editor.parentElement;
      if (container) {
        const heading = container.querySelector(
          "label, h1, h2, h3, h4, h5, legend, [class*='label'], [class*='title']"
        );
        if (heading && !editor.contains(heading)) label = (heading.textContent ?? "").trim();
      }
    }

    const lines = editor.querySelectorAll(".view-line");
    const currentText = Array.from(lines)
      .slice(0, 3)
      .map((l) => (l.textContent ?? "").trim())
      .join(" ")
      .slice(0, 60);
    const context = getNearestHeading(editor, doc);
    fields.push({
      index: ++idx,
      type: "monaco — use execute_script with monaco.editor.getModels() to read/write",
      label: label.replace(/\s+/g, " ").slice(0, 80),
      value: currentText,
      y: getDocumentY(editor, doc),
      selector: ".monaco-editor",
      ...(isInFrame(editor) ? { frame: framePathOf(editor) } : {}),
      required: isRequiredField(editor, doc),
      empty: currentText.trim().length === 0,
      ...(context ? { context } : {}),
    });
  }

  // Sort by vertical position on page, then renumber
  fields.sort((a, b) => a.y - b.y);
  fields.forEach((f, i) => {
    f.index = i + 1;
  });

  // Count hidden fields for the warning that get_form_fields appends.
  // Walks the ancestor chain so inputs inside a `display:none` collapsible
  // parent (the most common pattern for conditional form sections) are
  // counted, not just inputs hidden directly via their own style. Pierces
  // shadow roots so the count is accurate across web-component-heavy forms.
  const hiddenFields = queryAllDeep<HTMLElement>(
    doc,
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), textarea, select"
  ).filter((el) => isAncestorHidden(el, doc));

  return {
    fields,
    hiddenFieldCount: hiddenFields.length,
    captcha: detectCaptcha(doc),
    oauthIndicators: detectOAuthIndicators(doc),
  };
}

function detectCaptcha(doc: Document): CaptchaInfo | null {
  const getSitekey = (el: Element | null): string | null =>
    el?.getAttribute("data-sitekey") ?? null;

  // Google reCAPTCHA — covers v2 (visible/invisible), v3 (token-only), Enterprise.
  const recaptchaEl = queryAllDeep(
    doc,
    '[name="g-recaptcha-response"], .g-recaptcha, iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"]'
  )[0];
  if (recaptchaEl) {
    return { kind: "recaptcha", sitekey: getSitekey(queryAllDeep(doc, ".g-recaptcha")[0] ?? null) };
  }
  // Cloudflare Turnstile
  const turnstileEl = queryAllDeep(
    doc,
    '[name="cf-turnstile-response"], .cf-turnstile, iframe[src*="challenges.cloudflare.com/turnstile"]'
  )[0];
  if (turnstileEl) {
    return { kind: "turnstile", sitekey: getSitekey(queryAllDeep(doc, ".cf-turnstile")[0] ?? null) };
  }
  // hCaptcha
  const hcaptchaEl = queryAllDeep(
    doc,
    '[name="h-captcha-response"], .h-captcha, iframe[src*="hcaptcha.com/captcha"]'
  )[0];
  if (hcaptchaEl) {
    return { kind: "hcaptcha", sitekey: getSitekey(queryAllDeep(doc, ".h-captcha")[0] ?? null) };
  }
  return null;
}

function detectOAuthIndicators(doc: Document): string[] {
  // Scan obvious clickable elements for "Continue with X" / "Sign in with X"
  // strings, the standard pattern for OAuth provider buttons. Cuts off after
  // 6 matches to avoid noise from sites that list every conceivable provider.
  const out: string[] = [];
  const re = /^(continue|sign in|sign up|log in|log on)\s+with\s+(google|github|microsoft|apple|facebook|twitter|x|discord|slack|gitlab|linkedin|notion)$/i;
  for (const el of queryAllDeep<HTMLElement>(doc, 'button, a, [role="button"]')) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 60) continue;
    if (re.test(text)) {
      if (!out.includes(text)) out.push(text);
      if (out.length >= 6) break;
    }
  }
  return out;
}
