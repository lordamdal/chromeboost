import { queryAllDeep } from "./shadow.js";
import { markerIds } from "../markers.js";
import { findClearPoint, scrollClearOfPinned, type OccluderInfo } from "./hittest.js";
import { framePathOf, isInFrame, resolveFrame, viewportRect } from "./frames.js";

/**
 * Phase 1 of the CDP click flow. Find the clickable element, scroll it into
 * view, tag it with a data attribute so the background worker can look it up
 * later via Runtime.evaluate, and return the viewport-centered coordinates
 * (with small jitter) for CDP Input.dispatchMouseEvent. Returns the element
 * label and a state note; leaves the element tagged for post-click inspection.
 *
 * If the matched element resolves to an `<input type=radio>` that is already
 * checked, returns `skipClick: true` and does NOT tag the element — the
 * caller should short-circuit without firing the click. Re-clicking an
 * already-checked radio toggles it OFF on React forms whose onChange handler
 * interprets the click as a deselect (common on React-controlled form widgets).
 */
export async function prepareClickTarget(
  textHint: string | undefined,
  nth?: number,
  within_selector?: string,
  near_text?: string,
  selector?: string,
  in_dialog?: boolean,
  dialog_query?: string,
  frame?: string,
): Promise<{
  success: boolean;
  message: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  skipClick?: boolean;
  nextCandidate?: string;
  scope_missed?: boolean;
  /** True when every candidate point inside the target is covered by something else. */
  occluded?: boolean;
  /** What is covering the target, when `occluded` is set. */
  occluder?: OccluderInfo;
  /** Whether the winning point resolved to the target, a child, or a wrapper. */
  hit_via?: "target" | "descendant" | "ancestor";
  /** Set when the page was scrolled to get the target out from under a pinned bar. */
  scrolled_clear?: boolean;
  /**
   * Addressable path of the same-origin iframe the target resolved inside,
   * absent for a top-frame target. Surfaced because "the button I clicked was
   * not the one you were looking at" is otherwise invisible: two frames on a
   * dashboard can both contain a "Save", and the caller deserves to know
   * which document answered.
   */
  frame?: string;
  target_disabled?: boolean;
  disabled_state?: {
    disabled: boolean;
    aria_disabled: string | null;
    pointer_events: string;
    opacity: string;
    visible: boolean;
  };
}> {
  // Clear any stale tags from a previous click. Shadow-piercing because the
  // previous click may have tagged an element inside a shadow root.
  for (const el of queryAllDeep(document, `[${markerIds.clickTargetAttr()}]`)) {
    el.removeAttribute(markerIds.clickTargetAttr());
  }
  for (const el of queryAllDeep(document, `[${markerIds.preCheckedAttr()}]`)) {
    el.removeAttribute(markerIds.preCheckedAttr());
  }
  for (const el of queryAllDeep(document, `[${markerIds.preDimensionsAttr()}]`)) {
    el.removeAttribute(markerIds.preDimensionsAttr());
  }

  // Frame scoping. Without a frame argument the search still reaches into
  // same-origin frames (queryAllDeep descends), ranking top-frame matches
  // first; naming a frame narrows it to that document, which is what you want
  // when two frames on a dashboard both contain a "Save".
  let scope: Document | Element = document;
  if (frame) {
    const res = resolveFrame(frame);
    if (!res.ok) {
      return {
        success: false,
        scope_missed: true,
        message:
          res.reason === "cross-origin"
            ? `Frame "${frame}" is cross-origin — click_element cannot resolve elements inside it. Use click_at_coordinates(frame: "${frame}", x, y), which dispatches at the renderer and does reach cross-origin frames. list_frames() reports the frame's size.`
            : `Frame "${frame}" not found. Call list_frames() to see which frames exist and how to address them.`,
      };
    }
    scope = res.node.doc;
  }
  if (dialog_query) {
    const d = findDialogByQuery(dialog_query);
    if (!d) {
      return { success: false, message: `dialog_query "${dialog_query}" did not match any open dialog`, scope_missed: true };
    }
    scope = d;
  } else if (in_dialog) {
    const d = findTopmostDialog();
    if (!d) {
      return { success: false, message: `in_dialog=true but no open [role=dialog]/[role=alertdialog]/<dialog open> on the page`, scope_missed: true };
    }
    scope = d;
  } else if (within_selector) {
    // Pierce shadow roots so a selector returned by find_text (which walks
    // closed shadow trees via chrome.dom.openOrClosedShadowRoot) is usable as
    // a click scope. Plain document.querySelector misses elements inside
    // Radix portals / Stencil components / Lit web components.
    const scoped = queryAllDeep(scope, within_selector)[0] ?? null;
    if (!scoped) {
      return { success: false, message: `within_selector "${within_selector}" did not match any element`, scope_missed: true };
    }
    scope = scoped;
  } else if (near_text) {
    const sectionScope = findSectionByHeading(near_text);
    if (!sectionScope) {
      return { success: false, message: `near_text "${near_text}" did not match any section heading`, scope_missed: true };
    }
    scope = sectionScope;
  }

  // Selector mode: skip textHint matcher, target by CSS selector directly via
  // queryAllDeep so open AND closed shadow roots are pierced. Use when the
  // target has no usable visible text (Reddit collapsed composer placeholder,
  // icon-only buttons, drop-zone overlays).
  let el: Element | undefined;
  let nextCandidate: string | undefined;
  let descriptor: string;
  if (selector) {
    const matches = queryAllDeep(scope, selector);
    const idx = (nth && nth >= 1 ? nth : 1) - 1;
    el = matches[idx];
    descriptor = `selector "${selector}"`;
    if (!el) {
      return { success: false, message: `No element matched ${descriptor}${matches.length > 0 ? ` at nth=${nth ?? 1} (found ${matches.length} total)` : ""}` };
    }
  } else {
    const lower = (textHint ?? "").toLowerCase().trim();
    const matches = findClickableAll(lower, scope);
    // Merged list: visible first, hidden last. nth=N picks the Nth across the
    // merged list — so if a flair-dropdown's hidden "Post this video as a GIF"
    // was previously match #1, the visible "Post" button now wins #1 instead.
    const merged = [...matches.visible, ...matches.hidden];
    const idx = (nth && nth >= 1 ? nth : 1) - 1;
    el = merged[idx];
    descriptor = `"${textHint ?? ""}"`;

    if (!el) {
      return { success: false, message: `No clickable element found for ${descriptor}` };
    }

    // If the resolved target is in the hidden bucket BUT there's a visible
    // alternative, surface it in nextCandidate so the caller can suggest a
    // retry. The 0×0/hidden refusal at the background-script level uses this
    // to give an actionable error message.
    const isHidden = !matches.visible.includes(el);
    nextCandidate = isHidden && matches.visible[0]
      ? describeCandidate(matches.visible[0], textHint ?? "")
      : undefined;
  }

  // Disabled-state snapshot. When the resolved target is disabled-but-otherwise-
  // visible (the common "Submit" mid-async-recheck case), surface the full
  // signal set so the caller doesn't have to execute_script-spelunk to read
  // disabled / aria-disabled / pointer-events / opacity separately. The
  // background handler uses `target_disabled` + `wait_until_enabled_ms` to
  // poll-then-click without manual retry logic.
  const disabledState = readDisabledState(el);
  const targetDisabled = disabledState.disabled || disabledState.aria_disabled === "true";

  const checkable = resolveCheckableInput(el);

  // Pre-flight: an already-checked radio should never be re-clicked.
  if (checkable && checkable.type === "radio" && checkable.checked) {
    await scrollSmartIntoView(el);
    const label =
      (el as HTMLElement).innerText?.trim() ||
      el.getAttribute("aria-label") ||
      textHint ||
      descriptor;
    const inFrame = isInFrame(el) ? framePathOf(el) : "";
    return { success: true, skipClick: true, message: `"${label}" — radio already checked, click skipped`, label, frame: inFrame || undefined };
  }

  await scrollSmartIntoView(el);
  el.setAttribute(markerIds.clickTargetAttr(), "true");
  // Record pre-click dimensions. If post-click the element is 0×0, it might
  // mean the click succeeded and the element was removed (modal close
  // dismissing its trigger button) rather than the click hitting nothing.
  const preRect = el.getBoundingClientRect();
  if (preRect.width > 0 && preRect.height > 0) {
    el.setAttribute(markerIds.preDimensionsAttr(), "1");
  }

  // Record pre-click state on the resolved input so postClickInspect can
  // verify the click landed and fall back to a full pointer-event chain
  // if the input's checked state didn't flip.
  if (checkable) {
    checkable.setAttribute(markerIds.preCheckedAttr(), checkable.checked ? "true" : "false");
  } else {
    // Custom-element radio/checkbox/switch (faceplate-radio-input, sl-radio):
    // record pre-click aria-checked so postClickInspect can detect toggles.
    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "switch") {
      el.setAttribute(markerIds.preCheckedAttr(), el.getAttribute("aria-checked") === "true" ? "true" : "false");
    }
  }

  // Top-level viewport coordinates: everything downstream of here feeds CDP
  // Input.dispatchMouseEvent, which has no notion of frames. viewportRect is
  // the identity for a top-frame element and adds the frame-chain offset for
  // anything inside a same-origin iframe.
  let rect = viewportRect(el);

  // ChromeBoost: occlusion-aware coordinate resolution.
  //
  // Aiming at a random point in the element's central 60% and hoping nothing is
  // on top silently mis-clicks whenever the page has painted
  // something over the target — cookie scrim, sticky header, toast, modal
  // backdrop, invisible click-away catcher. Here we hit-test instead: search
  // the element's visible area for a point where the cursor genuinely reaches
  // it. If a pinned bar is in the way, scroll out from under it and re-test.
  // If it is still covered, report the occluder so the caller can pierce it
  // rather than firing a click into an overlay and calling that success.
  let clear = findClearPoint(el);
  let scrolledClear = false;
  if (!clear.found && clear.occluder) {
    if (scrollClearOfPinned(el, clear.occluder)) {
      scrolledClear = true;
      clear = findClearPoint(el);
      rect = viewportRect(el);
    }
  }

  let x: number;
  let y: number;
  if (clear.found && clear.x !== undefined && clear.y !== undefined) {
    // Aim at the verified-reachable point, with a couple of px of human
    // jitter that stays inside the element.
    const jx = clear.x + Math.round((Math.random() - 0.5) * Math.min(6, rect.width / 4));
    const jy = clear.y + Math.round((Math.random() - 0.5) * Math.min(6, rect.height / 4));
    x = Math.min(Math.max(jx, rect.left + 1), rect.right - 1);
    y = Math.min(Math.max(jy, rect.top + 1), rect.bottom - 1);
  } else {
    // Fall back to the geometric centre — the caller decides whether to pierce.
    x = rect.left + rect.width / 2;
    y = rect.top + rect.height / 2;
  }

  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint ||
    descriptor;

  const occludedNote = clear.occluded && clear.occluder
    ? ` — covered by <${clear.occluder.tag}> ${clear.occluder.selector}` +
      `${clear.occluder.full_screen_scrim ? " (full-screen scrim)" : ""}` +
      `${clear.occluder.pinned ? " (pinned)" : ""}`
    : "";

  const framePath = isInFrame(el) ? framePathOf(el) : "";

  return {
    success: true,
    message: `Target prepared: "${label}"${framePath ? ` in iframe ${framePath}` : ""}${scrolledClear ? " (scrolled clear of a pinned bar)" : ""}${occludedNote}`,
    x,
    y,
    width: rect.width,
    height: rect.height,
    label,
    nextCandidate,
    occluded: clear.occluded || undefined,
    occluder: clear.occluder,
    hit_via: clear.via,
    scrolled_clear: scrolledClear || undefined,
    target_disabled: targetDisabled || undefined,
    disabled_state: targetDisabled ? disabledState : undefined,
    frame: framePath || undefined,
  };
}

/**
 * Snapshot the enabled-state signals of an element in one pass. Returns ALL
 * four fields the user's runbook says agents should read together: native
 * `disabled` property, `aria-disabled` attribute, computed `pointer-events`,
 * computed `opacity`. The `visible` field is true when the element is rendered
 * (non-zero rect, not display:none/visibility:hidden/opacity:0). Surfaced via
 * `prepareClickTarget` so a single `click_element` call carries enough info
 * for the agent to decide between "disabled is transient, wait" and "disabled
 * is permanent, find the missing field".
 */
function readDisabledState(el: Element): {
  disabled: boolean;
  aria_disabled: string | null;
  pointer_events: string;
  opacity: string;
  visible: boolean;
} {
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    disabled: !!(el as HTMLButtonElement).disabled,
    aria_disabled: el.getAttribute("aria-disabled"),
    pointer_events: cs.pointerEvents || "auto",
    opacity: cs.opacity || "1",
    visible: (rect.width > 0 && rect.height > 0) && cs.display !== "none" && cs.visibility !== "hidden",
  };
}

/**
 * Produce a one-line description of an alternative match — used in error
 * messages when the matcher had to fall back to a 0×0/hidden candidate but a
 * visible peer existed. Format: `"Save" button at (1180, 740, 54×40)`.
 */
function describeCandidate(el: Element, hint: string): string {
  const rect = viewportRect(el);
  const tag = el.tagName.toLowerCase();
  const text =
    ((el as HTMLElement).innerText || el.textContent || el.getAttribute("aria-label") || hint)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  return `"${text}" ${tag} at (${Math.round(rect.left)}, ${Math.round(rect.top)}, ${Math.round(rect.width)}×${Math.round(rect.height)})`;
}

/**
 * Phase 3 of the CDP click flow. After the CDP mouse event has fired, read
 * the tagged element's post-click state (radio/checkbox check state, 0×0
 * warning) and untag it. If the underlying radio/checkbox didn't change
 * state as expected (radio still unchecked, or checkbox didn't toggle),
 * automatically dispatch a full pointer-event chain on the input as a
 * fallback for React-controlled inputs whose handlers are bound to pointer
 * events rather than mouse events.
 */
export function postClickInspect(): { message: string; stateChanged: boolean } {
  // Shadow-piercing find: the click target may live inside a closed shadow
  // root (Reddit's <r-post-flairs-modal>, Radix portals, Stencil/Lit shells).
  // prepareClickTarget used queryAllDeep to tag it; we have to use the same
  // to find it again, or document.querySelector returns null.
  const el = queryAllDeep<HTMLElement>(document, `[${markerIds.clickTargetAttr()}]`)[0] ?? null;
  if (!el) return { message: "", stateChanged: false };

  let stateNote = "";
  let stateChanged = false;

  // Native HTMLInputElement radio/checkbox — resolve via label-wrapping etc.
  const checkable = resolveCheckableInput(el);
  if (checkable) {
    const preAttr = checkable.getAttribute(markerIds.preCheckedAttr());
    const preChecked = preAttr === "true";
    const radioFailed = checkable.type === "radio" && !checkable.checked;
    const checkboxFailed =
      checkable.type === "checkbox" && preAttr !== null && checkable.checked === preChecked;

    let fallbackUsed = false;
    if (radioFailed || checkboxFailed) {
      firePointerChain(checkable);
      fallbackUsed = true;
    }

    if (checkable.type === "radio") {
      stateChanged = checkable.checked;
    } else if (checkable.type === "checkbox" && preAttr !== null) {
      stateChanged = checkable.checked !== preChecked;
    }

    checkable.removeAttribute(markerIds.preCheckedAttr());
    stateNote = ` — now ${checkable.checked ? "checked" : "unchecked"}${fallbackUsed ? " (after pointer-chain fallback)" : ""}`;
  } else {
    // Custom-element radio/checkbox (faceplate-radio-input, sl-radio, etc.).
    // Check role and aria-checked. If role=radio and aria-checked=true (and the
    // pre-click attr said false/missing), that's a state change.
    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "switch") {
      const preAttr = el.getAttribute(markerIds.preCheckedAttr());
      const ariaChecked = el.getAttribute("aria-checked");
      const nowChecked = ariaChecked === "true";
      if (preAttr !== null) {
        const preChecked = preAttr === "true";
        stateChanged = nowChecked !== preChecked;
        // Per-element-type semantics: a radio counts as "state changed" iff it
        // ended in the checked state (radios can only be set, not unset by
        // direct click), while checkboxes/switches toggle.
        if (role === "radio") stateChanged = nowChecked;
        stateNote = ` — now ${nowChecked ? "checked" : "unchecked"}`;
        el.removeAttribute(markerIds.preCheckedAttr());
      } else if (nowChecked) {
        // No baseline recorded but element is now checked: treat as success.
        stateChanged = true;
        stateNote = ` — now checked`;
      }
    }
  }

  const rect = el.getBoundingClientRect();
  const nowZero = rect.width === 0 && rect.height === 0 &&
    !el.offsetWidth && !el.offsetHeight &&
    el.getClientRects().length === 0;
  if (nowZero) {
    // If pre-click dims were non-zero (we recorded that), this is a likely
    // success signal — the click closed/removed the target (modal close
    // button vanishes after Apply, popover closes after picking an option).
    // Don't warn; just note the disappearance.
    if (el.hasAttribute(markerIds.preDimensionsAttr())) {
      stateChanged = true;
      stateNote += " — element removed/hidden post-click (modal close, popover dismiss, or similar)";
    } else {
      stateNote += " — WARNING: element has 0×0 dimensions (likely inside a collapsed or hidden panel). The click may not have had any effect.";
    }
  }
  el.removeAttribute(markerIds.preDimensionsAttr());

  // NOTE: marker attribute is NOT removed here. The activity probe needs it
  // to find the target element for its post-click state snapshot. Removal
  // happens after the probe completes (background.ts untags via execute_script).
  return { message: stateNote, stateChanged };
}

/**
 * Resolve a clicked element to the underlying radio/checkbox input, if any.
 * Handles both the matched-element-is-input case and the matched-element-is-
 * label-of-input case (label[for=...] or label-wrapping-input).
 */
function resolveCheckableInput(el: Element): HTMLInputElement | null {
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    return el;
  }
  if (el instanceof HTMLLabelElement) {
    if (el.htmlFor) {
      const target = el.ownerDocument.getElementById(el.htmlFor);
      if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
        return target;
      }
    }
    const inner = el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (inner instanceof HTMLInputElement) return inner;
  }
  return null;
}

/**
 * Fire the full pointer-event chain on an input that didn't flip its
 * checked state via the standard click. This is the user-validated reliable
 * pattern for React-controlled radios/checkboxes whose handlers are bound
 * to pointer events. Does NOT call .click() — that's already been tried.
 *
 * Radix and similar dropdown libraries gate `onPointerDown` on
 * `event.isPrimary && event.pointerId != null`. Plain `new PointerEvent(...)`
 * with bubbles/cancelable alone leaves isPrimary=false and pointerId=0, which
 * those handlers ignore. Pass pointerId=1, isPrimary=true, plus the buttons
 * bitfield (1 while pressed, 0 on release) so the chain matches a real mouse.
 */
function firePointerChain(el: Element) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const baseOpts = {
    bubbles: true,
    cancelable: true,
    // The element's own window. A frame-hosted target given the top window
    // here produces events whose view does not match their target, which
    // React's synthetic event system and several UI kits reject outright.
    view: el.ownerDocument?.defaultView ?? window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const ptrDown = {
    ...baseOpts,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    buttons: 1,
    pressure: 0.5,
  };
  const ptrUp = { ...ptrDown, buttons: 0, pressure: 0 };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", ptrDown));
  } catch { /* PointerEvent may be unavailable in old browsers */ }
  el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, buttons: 1 }));
  try {
    el.dispatchEvent(new PointerEvent("pointerup", ptrUp));
  } catch { /* ignore */ }
  el.dispatchEvent(new MouseEvent("mouseup", baseOpts));
  el.dispatchEvent(new MouseEvent("click", baseOpts));
}

/**
 * Walk up the React fiber tree from `el` looking for an `onClick` prop, and
 * invoke it directly with a minimal synthetic event. Last-resort fallback for
 * the case where CDP-dispatched and synthetic clicks both produce zero
 * activity — typically a React-heavy SPA whose action button passes through
 * an isTrusted=true check OR a one-off `onPointerDown` capture handler that
 * the standard event chain skips. Returns true if a handler was found and
 * called (page may still no-op the call), false if no handler exists.
 *
 * Caveat: this depends on React's __reactProps$<hash> private fiber-key
 * convention, which has been stable across React 16/17/18 but is undocumented.
 * Production builds with mangled property names will break this — that's why
 * it's opt-in via `try_fiber=true` rather than an automatic post-rejection
 * fallback.
 */
export function reactFiberClick(el: Element): { fired: boolean; component?: string } {
  // When the element lives inside a shadow root, the React fiber tree is
  // attached to the React root INSIDE that shadow root, not to the main
  // document's React root. Walking parentElement from inside a shadow root
  // eventually crosses the shadow boundary and reaches light DOM elements
  // that have no __reactProps$ keys, causing the walk to fail. Worse, some
  // shadow root implementations expose non-Element nodes on the boundary
  // that crash on property access (the "toLowerCase" TypeError on Outlier).
  //
  // Fix: detect if el is inside a shadow root. If so, also search siblings
  // and children of the shadow root for a React root container, and walk
  // fibers from that container down to find the handler for el.
  let node: any = el; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let depth = 0; depth < 12 && node; depth++) {
    try {
      const fk = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      const onClick = fk ? node[fk]?.onClick : null;
      if (typeof onClick === "function") {
        const ev = {
          preventDefault() { /* noop */ },
          stopPropagation() { /* noop */ },
          stopImmediatePropagation() { /* noop */ },
          nativeEvent: { isTrusted: true },
          target: el,
          currentTarget: el,
          type: "click",
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
        };
        try {
          onClick(ev);
          const tag = node instanceof Element ? node.tagName.toLowerCase() : "(unknown)";
          return { fired: true, component: tag };
        } catch {
          return { fired: true };
        }
      }
    } catch {
      // Property access on cross-boundary nodes can throw (shadow DOM edge
      // cases where the node is a DocumentFragment or has restricted props).
      // Skip this node and continue walking up.
    }
    node = node instanceof Element ? node.parentElement : null;
  }

  // Shadow-root fallback: find the React root container inside the shadow
  // root and search its children for the fiber handler targeting el.
  let shadowRoot: ShadowRoot | null = null;
  let cur: Node | null = el;
  while (cur) {
    if (cur instanceof ShadowRoot) { shadowRoot = cur; break; }
    cur = cur.parentNode;
  }
  if (shadowRoot) {
    const containers = shadowRoot.querySelectorAll("*");
    for (const container of Array.from(containers)) {
      try {
        const rk = Object.keys(container).find((k) =>
          k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"));
        if (!rk) continue;
        let fiber: any = (container as any)[rk];
        for (let i = 0; i < 200 && fiber; i++) {
          if (fiber.stateNode === el || fiber.stateNode?.contains?.(el)) {
            const props = fiber.memoizedProps ?? fiber.pendingProps;
            if (typeof props?.onClick === "function") {
              const ev = {
                preventDefault() { /* noop */ },
                stopPropagation() { /* noop */ },
                stopImmediatePropagation() { /* noop */ },
                nativeEvent: { isTrusted: true },
                target: el,
                currentTarget: el,
                type: "click",
                bubbles: true,
                cancelable: true,
                defaultPrevented: false,
                isDefaultPrevented: () => false,
                isPropagationStopped: () => false,
              };
              try {
                props.onClick(ev);
                const tag = fiber.stateNode instanceof Element
                  ? fiber.stateNode.tagName.toLowerCase()
                  : "(shadow-fiber)";
                return { fired: true, component: tag };
              } catch {
                return { fired: true };
              }
            }
          }
          fiber = fiber.child ?? fiber.sibling ?? fiber.return?.sibling;
        }
      } catch {
        // Fiber traversal can throw on detached or mangled trees.
      }
    }
  }

  return { fired: false };
}

/**
 * Resolve the click target using the same matching logic as prepareClickTarget
 * (text + nth + within_selector + near_text), but skip tagging, scrolling, and
 * pre-flight checks. Used by the `react_fiber_click` content-script handler
 * after silently_rejected has fired — at that point the target was already
 * found and clicked once, we just need to re-find it to invoke the fiber prop.
 */
export function reactFiberClickByHint(
  textHint: string,
  nth?: number,
  within_selector?: string,
  near_text?: string,
  in_dialog?: boolean,
  dialog_query?: string,
  frame?: string,
): { success: boolean; message: string; fired: boolean; component?: string; label?: string } {
  // Same frame scoping as prepareClickTarget: this is the fiber-level retry
  // for a click the page silently rejected, so it has to re-find the very
  // same element, in the very same document.
  let scope: Document | Element = document;
  if (frame) {
    const res = resolveFrame(frame);
    if (!res.ok) {
      return {
        success: false,
        fired: false,
        message:
          res.reason === "cross-origin"
            ? `Frame "${frame}" is cross-origin — no DOM tool can reach into it. Use click_at_coordinates(frame: "${frame}", x, y).`
            : `Frame "${frame}" not found. Call list_frames() to see which frames exist.`,
      };
    }
    scope = res.node.doc;
  }
  if (dialog_query) {
    const d = findDialogByQuery(dialog_query);
    if (!d) return { success: false, message: `dialog_query "${dialog_query}" did not match`, fired: false };
    scope = d;
  } else if (in_dialog) {
    const d = findTopmostDialog();
    if (!d) return { success: false, message: `in_dialog=true but no open dialog`, fired: false };
    scope = d;
  } else if (within_selector) {
    const scoped = queryAllDeep(scope, within_selector)[0] ?? null;
    if (!scoped) {
      return { success: false, message: `within_selector "${within_selector}" did not match`, fired: false };
    }
    scope = scoped;
  } else if (near_text) {
    const sectionScope = findSectionByHeading(near_text);
    if (!sectionScope) {
      return { success: false, message: `near_text "${near_text}" did not match`, fired: false };
    }
    scope = sectionScope;
  }
  const lower = textHint.toLowerCase().trim();
  const matches = findClickableAll(lower, scope);
  const merged = [...matches.visible, ...matches.hidden];
  const idx = (nth && nth >= 1 ? nth : 1) - 1;
  const el = merged[idx];
  if (!el) {
    return { success: false, message: `No clickable element found for "${textHint}"`, fired: false };
  }
  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint;
  const fiber = reactFiberClick(el);
  if (!fiber.fired) {
    return {
      success: false,
      message: `Found "${label}" but no React fiber __reactProps$.onClick exists on the element or its ancestors (up to 12 levels). The button is probably bound via addEventListener (not React), or React's prop key has been mangled by a production minifier. Fall back to highlight_region + wait_for_click for a real human gesture.`,
      fired: false,
      label,
    };
  }
  return {
    success: true,
    message: `Invoked React fiber onClick on "${label}"${fiber.component ? ` (component: ${fiber.component})` : ""}`,
    fired: true,
    component: fiber.component,
    label,
  };
}

/**
 * Find a clickable element by text/aria-label and programmatically click it.
 * Handles elements that are off-screen inside nested scroll containers (e.g.
 * Stripe's drawer panels) and elements inside open shadow roots (Radix UI
 * components, Stencil/Lit web components, etc.).
 *
 * This is the fallback path when CDP Input.dispatchMouseEvent isn't available
 * (chrome:// pages, debugger attach fails). The CDP path produces isTrusted=true
 * clicks; this path produces isTrusted=false synthetic clicks.
 */
export async function clickElement(
  textHint: string,
  nth?: number
): Promise<{ success: boolean; message: string }> {
  const lower = textHint.toLowerCase().trim();
  const el = findClickable(lower, nth);

  if (!el) {
    return { success: false, message: `No clickable element found for "${textHint}"` };
  }

  // Scroll the element into view, including nested scroll containers
  await scrollSmartIntoView(el);

  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint;

  // Pre-flight: skip already-checked radios — re-clicking can toggle them OFF
  // on React forms whose onChange handler interprets the click as a deselect.
  const checkable = resolveCheckableInput(el);
  if (checkable && checkable.type === "radio" && checkable.checked) {
    return { success: true, message: `"${label}" — radio already checked, click skipped` };
  }
  const preChecked = checkable ? checkable.checked : null;

  // Humanize the click: dispatch mousemove → mousedown → small delay → mouseup → click,
  // with coord jitter, before falling back to native .click(). Sites doing
  // behavioral fingerprinting (LinkedIn, Akamai) flag teleport-clicks as bots.
  // We also still call .click() at the end so React/Stripe-style handlers fire reliably.
  dispatchHumanClickEvents(el);
  if (typeof (el as HTMLElement).click === "function") {
    (el as HTMLElement).click();
  } else {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // For radio buttons and checkboxes, confirm the new checked state and fall
  // back to a full pointer-event chain on the input if the standard click
  // didn't change state (React-controlled inputs bound to pointer events).
  let stateNote = "";
  if (checkable && preChecked !== null) {
    const radioFailed = checkable.type === "radio" && !checkable.checked;
    const checkboxFailed = checkable.type === "checkbox" && checkable.checked === preChecked;
    let fallbackUsed = false;
    if (radioFailed || checkboxFailed) {
      firePointerChain(checkable);
      fallbackUsed = true;
    }
    stateNote = ` — now ${checkable.checked ? "checked" : "unchecked"}${fallbackUsed ? " (after pointer-chain fallback)" : ""}`;
  }

  // Warn if element is truly invisible (0x0 bounding rect AND no offset dimensions
  // AND no client rects). This avoids false warnings on elements that are clipped
  // but still receive click events fine (e.g. hidden checkboxes with label proxies).
  const rect = el.getBoundingClientRect();
  const htmlEl = el as HTMLElement;
  if (
    rect.width === 0 && rect.height === 0 &&
    !htmlEl.offsetWidth && !htmlEl.offsetHeight &&
    el.getClientRects().length === 0
  ) {
    stateNote += " — WARNING: element has 0×0 dimensions (likely inside a collapsed or hidden panel). The click may not have had any effect. Try expanding the parent panel first, or use execute_script to click directly.";
  }

  return { success: true, message: `Clicked "${label}"${stateNote}` };
}

/**
 * Scroll the element into view in both the window AND any nested scrollable
 * ancestor containers (e.g. Stripe's slide-over drawer panels, or any
 * inner-pane SPA where document.body.scrollHeight is dwarfed by the
 * inner scroll container's scrollHeight).
 *
 * Returns a Promise that resolves once the element is confirmed visible in
 * the viewport via IntersectionObserver (or after a 500ms fallback timeout).
 * Shadow DOM radio buttons and Lit components need the scroll to fully
 * settle before a click will register; the old sync approach fired the click
 * in the same tick as the scroll, which was too fast.
 */
export async function scrollSmartIntoView(el: Element): Promise<void> {
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });

  let parent = el.parentElement;
  const ownRoot = el.ownerDocument?.documentElement ?? document.documentElement;
  while (parent && parent !== ownRoot) {
    const style = getComputedStyle(parent);
    const oy = style.overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      const elRect = el.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      if (elRect.bottom > pRect.bottom) {
        parent.scrollTop += elRect.bottom - pRect.bottom + 16;
      } else if (elRect.top < pRect.top) {
        parent.scrollTop -= pRect.top - elRect.top + 16;
      }
    }
    parent = parent.parentElement;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        setTimeout(done, 50);
      }
    }, { threshold: 0.1 });
    observer.observe(el);
    setTimeout(() => { observer.disconnect(); done(); }, 500);
  });
}

/**
 * Collect every candidate matching `lower`, then split into visible and
 * hidden buckets. The caller prefers visible — a hidden element (display:none,
 * [hidden] attr, 0×0 dimensions, aria-hidden) only wins if no visible peer
 * has the same text-strength.
 *
 * Without this split, an exact-text match on a hidden flair-dropdown item
 * outranks a partial-text match on the actually-visible submit button on
 * Reddit's new submit page.
 */
function findClickableAll(lower: string, scope: Document | Element = document): { visible: Element[]; hidden: Element[] } {
  const interactiveSelectors =
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], input[type="submit"], input[type="button"], label, [onclick], [tabindex]';

  const candidates = queryAllDeep(scope, interactiveSelectors);
  const ranked: Element[] = [];
  // Track which label-strength tier each candidate came from so the visual
  // sort below preserves "exact match beats partial" while still ordering
  // ties by reading position. Tier: 1=exact text, 2=partial text, 3=aria,
  // 4=input value, 5=title/data-testid.
  const tier: Map<Element, number> = new Map();

  function addIfNew(el: Element, t: number) {
    if (!ranked.includes(el)) {
      ranked.push(el);
      tier.set(el, t);
    }
  }

  // Exact text matches
  candidates.forEach((el) => {
    if (el.textContent?.toLowerCase().trim() === lower) addIfNew(el, 1);
  });

  // Partial text matches (sorted shortest first for specificity), deduplicated
  const partials = candidates
    .filter((el) => !ranked.includes(el) && el.textContent?.toLowerCase().includes(lower))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  partials.forEach((el) => addIfNew(el, 2));

  // aria-label matches
  queryAllDeep(scope, "[aria-label]").forEach((el) => {
    if (el.getAttribute("aria-label")?.toLowerCase().includes(lower)) addIfNew(el, 3);
  });

  // value attribute (input[type=submit], input[type=button])
  queryAllDeep<HTMLInputElement>(scope, "input[type=submit], input[type=button]").forEach((el) => {
    if (el.value.toLowerCase().includes(lower)) addIfNew(el, 4);
  });

  // title / data-testid
  queryAllDeep(scope, "[title], [data-testid]").forEach((el) => {
    const v = el.getAttribute("title") ?? el.getAttribute("data-testid") ?? "";
    if (v.toLowerCase().includes(lower)) addIfNew(el, 5);
  });

  const visible: Element[] = [];
  const hidden: Element[] = [];
  for (const el of ranked) {
    if (isVisibleAndUsable(el)) visible.push(el);
    else hidden.push(el);
  }

  // Reorder visible candidates by visual reading order WITHIN the same
  // label-strength tier (and, for partial matches, same textContent length).
  // Without this, nth picks the next candidate in DOM-tree-traversal order —
  // and across multiple shadow hosts, DOM order doesn't match visual top-to-
  // bottom. The canonical failure mode is four "Confirmed" radios stacked in
  // separate shadow-rooted cards: tier-1-exact all match, length is identical,
  // and nth=2 winds up landing on the wrong card. Visual sort fixes that.
  visible.sort((a, b) => {
    const ta = tier.get(a) ?? 99;
    const tb = tier.get(b) ?? 99;
    if (ta !== tb) return ta - tb;
    if (ta === 2) {
      // Partial-text tier still tiebreaks on length (more specific wins).
      const la = a.textContent?.length ?? 0;
      const lb = b.textContent?.length ?? 0;
      if (la !== lb) return la - lb;
    }
    // Top-viewport coordinates so candidates from different frames sort by
    // where they actually appear on screen, not by their position within
    // whichever document happens to host them.
    const ra = viewportRect(a);
    const rb = viewportRect(b);
    // Round y to 10px buckets so sub-pixel wobble doesn't flip the order.
    const ya = Math.round(ra.top / 10) * 10;
    const yb = Math.round(rb.top / 10) * 10;
    if (ya !== yb) return ya - yb;
    return ra.left - rb.left;
  });

  return { visible, hidden };
}

/**
 * Compatibility shim for the synthetic-click path. Returns the nth match
 * preferring visible candidates first, falling back to hidden if none
 * visible are available.
 */
function findClickable(lower: string, nth: number = 1): Element | null {
  const { visible, hidden } = findClickableAll(lower);
  const merged = [...visible, ...hidden];
  if (merged.length === 0) return null;
  return merged[nth - 1] ?? merged[merged.length - 1];
}

/**
 * Returns true if the element is actually rendered to the user:
 * - element AND all ancestors must not have [hidden], display:none,
 *   visibility:hidden, or opacity:0
 * - element must have non-zero bounding rect OR non-zero offsetWidth/Height
 * - aria-hidden=true on element or any ancestor disqualifies
 *
 * This is stricter than the old `isUsable` (which only checked the element's
 * own computed style and missed [hidden], ancestor display:none, and 0×0).
 * Without the ancestor walk, a hidden flair-dropdown item passed `isUsable`
 * and got picked over the actually-visible submit button on Reddit.
 */
function isVisibleAndUsable(el: Element): boolean {
  // Walk ancestors for the obvious DOM-attribute and computed-style killers.
  for (let cur: Element | null = el; cur && cur !== document.documentElement; cur = cur.parentElement) {
    if (cur.hasAttribute("hidden")) return false;
    if (cur.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(cur);
    if (cs.display === "none") return false;
    if (cs.visibility === "hidden") return false;
    if (cs.opacity === "0") return false;
  }
  if ((el as HTMLButtonElement).disabled) return false;
  // 0×0 dimensions: triple-check (bounding-rect, offset, getClientRects). An
  // element clipped by an overflow:hidden scroll container still reports
  // non-zero offsetWidth/Height, so clipped-but-clickable elements pass.
  const rect = el.getBoundingClientRect();
  const htmlEl = el as HTMLElement;
  if (
    rect.width === 0 && rect.height === 0 &&
    !htmlEl.offsetWidth && !htmlEl.offsetHeight &&
    el.getClientRects().length === 0
  ) {
    return false;
  }
  return true;
}

/**
 * Find the smallest section-like container whose heading text starts with
 * `needle`. Used by `near_text` to scope click candidates without needing a
 * stable CSS selector. Pierces shadow roots.
 */
function findSectionByHeading(needle: string): Element | null {
  const lower = needle.toLowerCase().trim();
  const headings = queryAllDeep(document, "h1, h2, h3, h4, h5, h6, [role='heading'], legend");
  for (const h of headings) {
    const text = (h.textContent ?? "").trim().toLowerCase();
    if (!text.startsWith(lower)) continue;
    const container = h.closest("section, fieldset, article, form, div, main, aside") ?? h.parentElement;
    if (container) return container;
  }
  return null;
}

/**
 * Resolve the topmost open dialog on the page. "Topmost" picks the dialog
 * with the highest CSS z-index, falling back to document-order last. Pierces
 * shadow roots so Radix portals (which mount their dialogs at document.body
 * inside a closed shadow root) are reachable. Returns null when no dialog
 * is currently open.
 */
export function findTopmostDialog(): Element | null {
  const candidates = queryAllDeep(document, '[role="dialog"], [role="alertdialog"], dialog[open]');
  if (candidates.length === 0) return null;
  let best: Element | null = null;
  let bestZ = -Infinity;
  for (const el of candidates) {
    // Skip dialogs that aren't actually visible. The closest [aria-hidden=true]
    // or [hidden] ancestor disqualifies the candidate.
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (el.hasAttribute("hidden")) continue;
    let z = 0;
    try {
      const view = el.ownerDocument.defaultView;
      if (view) {
        const cs = view.getComputedStyle(el as Element);
        const parsed = parseInt(cs.zIndex || "0", 10);
        if (Number.isFinite(parsed)) z = parsed;
      }
    } catch { /* cross-window — ignore */ }
    // Last-write-wins among equal z-index, biases toward the most-recently
    // appended dialog (document order).
    if (z >= bestZ) {
      bestZ = z;
      best = el;
    }
  }
  return best;
}

/**
 * Resolve a dialog by heading or aria-label substring. Used by
 * click_element(dialog_query="Select a snapshot") to scope candidates to a
 * specific named dialog when multiple dialogs are open (rare but happens on
 * confirm-inside-confirm flows).
 */
export function findDialogByQuery(query: string): Element | null {
  const lower = query.toLowerCase().trim();
  if (!lower) return null;
  const dialogs = queryAllDeep(document, '[role="dialog"], [role="alertdialog"], dialog[open]');
  for (const d of dialogs) {
    const aria = (d.getAttribute("aria-label") ?? "").toLowerCase();
    if (aria.includes(lower)) return d;
    // Check headings inside
    const heading = d.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
    const text = (heading?.textContent ?? "").toLowerCase().trim();
    if (text.includes(lower)) return d;
  }
  return null;
}

/**
 * Fire the full pointer chain on the currently tagged click target element.
 * Used as a fallback when CDP coordinate-based clicks are silently rejected
 * inside shadow DOM: CDP dispatch at coordinates works, but when the event
 * bubbles out of the shadow root, event.target is retargeted to the shadow
 * host, so React event delegation (which checks event.target) discards it.
 * Dispatching directly ON the element inside the shadow root avoids the
 * retargeting problem.
 */
export function pointerChainOnTagged(): { fired: boolean; label?: string } {
  // Shadow-piercing: same reason as postClickInspect — tagged element may
  // live inside a shadow root (Reddit's flair modal, Radix portals).
  const el = queryAllDeep<HTMLElement>(document, `[${markerIds.clickTargetAttr()}]`)[0] ?? null;
  if (!el) return { fired: false };
  firePointerChain(el);
  const label =
    el.innerText?.trim().slice(0, 60) ||
    el.getAttribute("aria-label") ||
    el.tagName.toLowerCase();
  return { fired: true, label };
}

/**
 * Dispatch a sequence of mouse events (mousemove → mouseover → mousedown → mouseup)
 * with humanlike coordinate jitter, before the actual .click() call. Anti-bot
 * systems flag elements that receive isolated click events with no preceding
 * pointer movement.
 *
 * NOTE: these events are still isTrusted=false. Sites that check isTrusted
 * (which is the strongest signal) won't be fooled — only behavioral-pattern
 * detectors. For full bypass we'd need CDP Input.dispatchMouseEvent.
 */
function dispatchHumanClickEvents(el: Element) {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Random point within central 60% of the element (avoid edges)
    const cx = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const cy = rect.top + rect.height * (0.2 + Math.random() * 0.6);
    // Start point: a few px away to simulate approach
    const sx = cx + (Math.random() - 0.5) * 40;
    const sy = cy + (Math.random() - 0.5) * 40;

    const mkEvent = (type: string, x: number, y: number) => new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: el.ownerDocument?.defaultView ?? window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: type === "mousedown" || type === "mouseup" ? 1 : 0,
    });

    el.dispatchEvent(mkEvent("mousemove", sx, sy));
    el.dispatchEvent(mkEvent("mouseover", cx, cy));
    el.dispatchEvent(mkEvent("mousemove", cx, cy));
    el.dispatchEvent(mkEvent("mousedown", cx, cy));
    el.dispatchEvent(mkEvent("mouseup", cx, cy));
  } catch {
    // Behavioral humanization is best-effort; never block the click.
  }
}
