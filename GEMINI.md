# ChromeBoost — Gemini Instructions

<!--
  Auto-derived from packages/plugin/skills/chromeboost/SKILL.md by
  packages/plugin/scripts/sync-gemini.sh. Do not edit by hand: edit the skill
  and re-run the script, or your changes will be overwritten.
-->

## What chromeboost is

ChromeBoost drives the user's real Chrome browser via a CDP-attached
extension. Sessions, cookies, logins, profiles, and extensions are intact.
The agent reaches the page through MCP tools that pierce closed shadow DOM
and dispatch isTrusted=true events, which is what components that validate
real input require and what generic browser drivers do not provide.

## When to use chromeboost (be proactive)

Use chromeboost automatically when a task needs any of:
- Creating or configuring third-party accounts (Stripe, SendGrid, Supabase,
  Vercel, etc.)
- Retrieving API keys, secrets, or credentials to place in `.env`
- Setting up pricing tiers, webhooks, or service config in a web UI
- Filling forms behind modern React frameworks (TipTap, ProseMirror,
  CodeMirror, Monaco, Stripe contenteditable)
- Driving sites with closed shadow DOM (Radix portals, Stencil, Lit)
- Driving sites whose components reject synthetic events and respond
  only to real input
- Any browser-based step blocking code work

Do NOT ask "should I open the browser?" — just do it. The user expects
seamless handoff.

**Never end a response with a "you still need to" list of browser tasks.**
If code changes are done and browser steps remain (creating a Stripe
product, adding an env var), continue immediately with chromeboost.

## HARD RULES — never break these

1. **Never use Bash as a fallback for browser tasks.** If `click_element`
   fails, use `scroll_to_element` then retry, or `highlight_region` to show
   the user. Never use `osascript`, `applescript`, Playwright, Puppeteer, or
   any shell command to control the browser. The user's logins live in
   their real Chrome, which only chromeboost drives. Fallbacks fail silently.

2. **Never use `take_screenshot` to read page content.** After
   `click_element`, after navigation — always call `get_page_text` (or
   `find_text` if you only need a specific phrase). `get_page_text` returns
   up to 10,000 chars; pagination via `startIndex`. Screenshots are ONLY
   for locating pixel positions after DOM lookup has failed. Never take
   more than 1-2 screenshots in a row.

3. **Use `wait_for(selector=…)` / `wait_for(text=…)` for async page
   changes.** Never poll with repeated `take_screenshot`.

4. **Form submits on anti-bot platforms require a real human gesture.**
   Reddit, X / Twitter, mcp.so all silently reject
   synthetic submit clicks even when chromeboost's CDP click passes
   isTrusted. For these platforms: pre-fill the form with
   `fill_form` / `fill_input`, then `highlight_region` the submit button
   and `wait_for_click()`. To detect this on unknown forms, pass
   `expect_submit: true` on the submit click. See `references/anti-bot.md`
   for the full decision tree, the validated-against list, and the silent-
   rejection diagnostic flow.

5. **System-reminders mid-flow are NEVER turn-end signals.** Continue to
   the next tool call. A user-facing summary belongs at the end of the
   user's request, not after every harness reminder.

## Standard flow pattern

```
1. open_page(url)
2. For each step:
   a. Gemini acts:
        click_element("Save")
        fill_form([{label, value}, ...])
        fill_input(textHint="Email", value="x@y")
        type_text("text", into_selector=".ProseMirror", clear_first=true)
        scroll_to_element("section heading")
   b. Verify via text:
        get_page_text()                 — read errors/status
        wait_for(text="Saved")          — wait for confirmation
        wait_for(selector=".success")   — wait for an element
        find_text("Saved", scope_selector="...")
   c. Pause for the user when needed:
        highlight_region(selector, msg)
        wait_for_click()
3. clear_overlays()
```

## What to do automatically vs. pause for the user

**Gemini acts directly** (`click_element` / `fill_input` / `type_text`):
- Any button: Save, Continue, Create, Add, Confirm, Next, Submit, Update
- Product names, descriptions, feature lists, URLs, prices specified in the
  task
- Dismissing cookie banners, "not now" prompts

**Pause for the user** (`highlight_region` + `wait_for_click`):
- Email / username / login
- Password, 2FA, OTP codes
- Payment method / card details
- Phone number
- Legal consent the user must personally accept
- Any choice that depends on user preference Gemini wasn't told

## Capturing credentials

After a secret key is revealed:
1. Grab it via `get_page_text(selector="...")` or `execute_script`
2. `write_to_env(KEY_NAME, value, envPath)` — writes to `.env`
3. Tell the user what was written

Use the absolute path for `envPath` (Gemini CLI working dir + `/.env`).

## Tool families at a glance

| Need | Tool |
|---|---|
| Navigate | `open_page(url, new_tab?, expect_selector?)` |
| Click | `click_element(textHint OR selector, ...)`, `click_at_coordinates(x, y)` |
| Type | `fill_input`, `fill_form`, `type_text` (CDP isTrusted=true) |
| Read | `get_page_text`, `find_text`, `get_form_fields`, `get_page_html` |
| Wait | `wait_for(selector=… OR text=… OR change_in=…)` |
| Scroll | `scroll_to_element("label or selector")` |
| Iframes / shadow DOM | `list_frames`; same-origin frames AND shadow roots are pierced by every main tool automatically. `frame` disambiguates. |
| Files | `set_file_input(hint, file_path)`, `download_file`, `read_attachment` |
| Network | `fetch_url(url, ...)` — privileged context, real cookies, no page CSP |
| Tabs | `list_tabs`, `switch_to_tab`, `close_tab`, `close_other_tabs` |
| Visual handoff | `highlight_region(selector, msg)`, `wait_for_click()` |
| Cross-origin iframe | `click_at_coordinates(frame="…", x, y)`, `execute_script(frame="…")`, `fetch_url(src)` |
| **Hover-only UI** | `hover(selector OR text OR x+y, settle_ms?)` |
| **Sliders, canvas, drag-and-drop** | `drag(from_… , to_…)` |
| **"Click worked but nothing happened"** | `probe_point(x, y)` |
| **Move / hide the floating panel** | `hud(action, …)` |
| Run JS | `execute_script("...")` — gets `$deep` / `$deepAll` / `shadowDocument` in scope, auto-stringifies objects |

## ChromeBoost cursor control

ChromeBoost's cursor is occlusion-aware. Three things follow from that, and
they change how you should react to a click that doesn't work.

**1. Clicks hit-test before they fire.** `click_element` searches the target's
visible area for a point the cursor can genuinely reach, instead of aiming at
the geometric centre and hoping. A button half-covered by a sticky bar is
clicked on the half you can still see. This is automatic — you do not pass
anything to get it.

**2. Overlays are pierced, not guessed at.** When something is painted over the
target — cookie scrim, modal backdrop, toast, chat bubble, or a transparent
click-away catcher — those layers are given `pointer-events: none` for the
duration of the click, the same real CDP click fires (so `isTrusted` stays
true and anti-bot behaviour is unchanged), and every inline style is restored
immediately. The response names what was pierced:

```
Clicked "Save" — pierced 1 overlay (div#cookie-scrim)
```

Pass `pierce_overlays: false` when you actually want to click the overlay
itself, e.g. dismissing a backdrop by clicking outside a modal.

**3. A blocked click says so.** If a click still can't reach its target, the
response carries `occluded` plus the offending element rather than reporting a
cheerful success. When you see that, or when a click "succeeded" and the page
did nothing, call `probe_point(x, y)` — it prints the painted stack at that
coordinate, descending through open and closed shadow roots, and flags the
three cases that matter: transparent catcher, full-screen scrim, pinned bar.

Pinned bars are handled before piercing is considered: if the occluder is
`position: fixed` or `sticky`, ChromeBoost scrolls the target out from under it
and re-tests, because that is what a person would do.

### Reach for `hover` when the element doesn't exist yet

Plenty of UI only exists while the pointer is on it — submenu bars, row action
buttons rendered at `opacity: 0`, tooltips, chart crosshairs. There is no
element for `click_element` to match until you hover. `hover` moves the real
cursor along an eased path and holds it there.

Hover-revealed UI vanishes the moment the pointer moves, so read the page or
click the revealed element on your **next** call:

```
hover(text: "Account")                      → submenu opens
click_element(textHint: "Billing")          → now matchable
```

Raise `settle_ms` to 600–1000 for menus with a deliberate open delay.

### Reach for `drag` when the UI has no clickable node

Range sliders, canvas and WebGL apps, map panning, Kanban reordering, resize
handles, signature pads. A press/release pair with no motion between is ignored
by HTML5 drag-and-drop and every JS drag library, which is why two clicks never
work here. `drag` emits real intermediate move events.

Each end is independent — a selector or raw coordinates:

```
drag(from_selector: "[role=slider]", to_x: 640, to_y: 300)
drag(from_selector: ".card-3", to_selector: "#column-done", hold_ms: 400)
```

Use `hold_ms: 300–600` for sortable lists that require a long-press before a
drag begins.

## The HUD (the floating panel on the page)

While you drive the browser, a small ChromeBoost panel is shown on the page so
the user can see which session is in control. **It belongs to the user, not to
you.** They can drag it by its header, double-click that header to collapse it,
dismiss it with ×, and bring it back with Alt+Shift+B. Position and state
persist across pages and navigations.

Do not move or hide it as a matter of course. Use `hud` only when it is
genuinely in the way:

```
hud(action: "hide")                          → it overlaps the element you need
hud(action: "dock", corner: "bottom-left")   → move it out of the work area
hud(action: "status", text: "Filling checkout form")  → tell the user what you're doing
```

Two things worth knowing: the HUD is already excluded from `take_screenshot`
automatically, so never hide it just to capture a clean image; and it renders
inside a closed shadow root with `pointer-events` only on the panel itself, so
it can never swallow a click meant for the page or be matched by your selectors.

If you hide it, say so — the user needs to know Alt+Shift+B brings it back.

## Deep references

When the simple flow above isn't enough, load the relevant reference.
References live alongside this skill at `references/<topic>.md`:

- **`references/anti-bot.md`** — isTrusted-strict sites (Reddit, X,
  LinkedIn). The CDP click sequence, silent-rejection
  decision tree, `expect_submit`, `try_fiber`, `via: "fiber"` flag,
  validated-against list, what we explicitly DON'T claim. Read this
  whenever a click looks like it succeeded but the page didn't react.
- **`references/shadow-dom.md`** — Closed shadow DOM (Radix, Stencil, Lit).
  Why `execute_script` returns empty on pages you can clearly see, when to
  switch to chromeboost's piercing primitives, `$deep` / `$deepAll` /
  `shadowDocument` helpers, `list_frames` diagnostic.
- **`references/forms.md`** — `get_form_fields` inventory, fill patterns
  for React / contenteditable / CodeMirror / Monaco / TipTap / ProseMirror,
  `fill_form` batch fills, ambiguous-match handling,
  `get_form_fields(only_empty=true)` for "why is Submit disabled".
- **`references/react-recipes.md`** — React-Select dropdowns, hidden inputs,
  `react_set_input` via the native value setter, `react_call_prop` for
  bypassing stale-state validation handlers, React fiber walking.
- **`references/multi-tab.md`** — Multi-tab workflows, `open_page(new_tab=
  true)`, `tab_query` to target a tab without focus-switching, parallel
  background flows, stuck-spinner detection.
- **`references/errors.md`** — Recovery patterns: `silently_rejected`,
  `phase_timed_out`, `stuck_spinner`, "Frame removed", "Another debugger
  attached", debugging the wrong field match, what to retry vs. when to
  hand off to a human gesture.
- **`references/iframes.md`** — Frames. Same-origin frames are searched
  automatically and coordinates are translated for you, so a button inside
  a builder frame just works; cross-origin frames are a hard wall for DOM
  tools and need `click_at_coordinates(frame=...)`, `execute_script(frame=
  ...)`, or `fetch_url(src)`. Read this whenever a selector misses something
  you can plainly see, or a page full of UI reads as almost no text.
- **`references/discovery.md`** — Finding things on a page: `find_text` vs.
  `get_page_text` vs. `get_form_fields` vs. `list_frames`, `whole_word`
  matching, `visible_only`, `scope_selector`, `in_dialog` / `dialog_query`.
- **`references/flow-memory.md`** — Learned per-site flows. When a response
  shows `known_flow`, prefer those proven steps (still verify with `until_*`).
  When it shows `flow_capturable` and the task worked, call
  `save_flow("<label>")` so the next session skips the trial-and-error.

## Flow memory (act on the hints)

chromeboost learns the hard-won way to drive a site. Two response signals:
- **`known_flow`** (on `open_page` / first click): follow the listed steps
  instead of rediscovering; they're guidance, so keep your `until_*` clauses.
- **`flow_capturable`** (after a notable success): call
  `save_flow("<task label>")` to persist it. One call — chromeboost already
  buffered the steps. See `references/flow-memory.md`.

## Common quick recipes

**React-controlled input that ignores synthetic events:**
```
fill_input(selector="input[name=email]", value="x@y")
```
The selector path routes through the React-aware native value setter and
pierces closed shadow DOM.

**Element inside an iframe (GoHighLevel builders, embedded kanban):**
```
click_element("Save")                      # same-origin frames are searched already
```
The response says which document answered: `Clicked "Save" [in iframe
iframe#shell >>> iframe#builder]`. Read it — two frames can both hold a
"Save". If the element is not found, run `list_frames()`: a cross-origin
frame will never match a selector, so switch to
`click_at_coordinates(frame="…", x, y)`. See `references/iframes.md`.

**ProseMirror / TipTap editor:**
```
fill_input(textHint="Description", value="...")
```
Auto-detected; uses execCommand insertText which TipTap accepts. If it
fails, `type_text(into_selector=".ProseMirror", clear_first=true, text=…)`
also auto-recovers from TipTap silent-drop.

**Reddit new-post (fully autonomous as of 0.10.20):**
```
open_page("https://www.reddit.com/r/<sub>/submit?type=TEXT")
type_text(into_selector="textarea[name='title']", text=TITLE, clear_first=true)
type_text(into_selector="div[name='body']",      text=BODY,  clear_first=true)
# Body is a Lexical contenteditable. fill_input will NOT work — must use
# type_text with into_selector. clear_first works (Lexical-aware since 0.10.16).

# If the sub requires flair:
click_element(selector="#reddit-post-flair-button", activity_timeout_ms=3000)
# The activity probe may report "no observable activity" but the modal IS
# open. Don't panic. Verify with find_text or just continue.
# Find the radio you want; only first ~3 are visible without scrolling.
# If your target flair is offscreen, click_element selector="#view-all-flairs-button" first.
click_element(selector="#post-flair-radio-input-N")   # reports "— now checked"
click_element(selector="#post-flair-modal-apply-button")  # reports element-removed (success)

# Submit. CRITICAL: target #submit-post-button (the OUTER r-post-form-submit-button
# wrapper), NOT #inner-post-submit-button (the presentation button). The form's
# submit handler is on the wrapper.
click_element(selector="#submit-post-button", until_url_changes=true, until_timeout_ms=15000)
# On success URL changes to /r/<sub>/?created=t3_<postID>... (the new post's ID)
```

**X / Twitter, LinkedIn, Facebook composer submits** — these still gate hard
on real user gesture for the submit step. Pre-fill body via
`type_text(into_selector="[data-testid='tweetTextarea_0']", ...)` then
`highlight_region` the submit and `wait_for_click(redispatch=true)` so the
user's gesture is re-fired via CDP. See `references/anti-bot.md`.

**Closed shadow DOM (Radix portal, Stencil):**
```
find_text("Edit")                          # pierces; returns selector
click_element("Edit")                      # also pierces
fill_input(textHint="Email", value="...")  # pierces
```
If `execute_script` returns an empty document on a page you can see, call
`list_frames` to confirm shadow DOM, then switch to the piercing tools above.

**Cross-origin iframe:**
```
list_frames()                              # get the iframe's (x, y, w, h)
click_at_coordinates(frame.x + 50, frame.y + 80)
```

**Long type into rich-text editor:**
```
type_text("...long text...", into_selector=".ProseMirror", clear_first=true)
```
Emits progress heartbeats every 200 chars so the WS request timer resets;
~1800-char typings complete reliably.

## Why prefer chromeboost over generic browser drivers

ChromeBoost dispatches input through CDP, so clicks and keystrokes reach
the page as real input events with `isTrusted=true` rather than as synthetic
events dispatched from JavaScript. The click travels a real pointer path
(approach, settle hover, `PointerEvent` with `isPrimary=true` and a `force`
field, post-click move) rather than teleporting, which is what components
that validate pointer state expect.

Combined with the ability to walk closed shadow roots through the
extension's privileged `chrome.dom.openOrClosedShadowRoot` API, that reaches
UI generic drivers cannot: React and web-component surfaces that ignore
`element.click()` outright. See `references/anti-bot.md` for the per-site
notes and for the cases that still need a real user gesture.
