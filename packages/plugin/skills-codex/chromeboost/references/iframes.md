# iframes reference

chromeboost treats a **same-origin** frame boundary the way it treats a
shadow boundary: transparently. A button inside an application frame
matches `click_element("Save")` with no extra argument, and its
coordinates are translated to page space before the cursor moves.

A **cross-origin** frame is a hard wall for every DOM tool. That is the
same-origin policy, not a chromeboost limitation. Three routes still get
in, and `list_frames` names them per frame.

Know which kind you have before debugging anything else:

```
list_frames()
```

## What `list_frames` gives you

Every frame at every nesting depth, both kinds, plus the shadow-host
census.

```
Found 3 frames (2 same-origin, 1 cross-origin):
1. iframe#shell "app shell" — https://app.example.com [same-origin] — 1334x524 @ (16,335)
   src: /shell
2.   iframe#builder "funnel-builder" — https://app.example.com [same-origin] — 1300x460 @ (28,352)
   src: /builder/9f2
3. iframe#pay "checkout" — https://js.stripe.com [cross-origin] — 400x60 @ (40,700)
   src: https://js.stripe.com/v3/elements-inner
   cross-origin: DOM tools cannot read it. click_at_coordinates(frame: "iframe#pay", x, y) ...
```

Each `selector` is an **address**, accepted verbatim by every tool's
`frame` parameter. Three forms work:

| Form | Example |
|---|---|
| CSS selector | `frame="iframe#builder"` |
| Nested path | `frame="iframe#shell >>> iframe#builder"` |
| src / title / id substring | `frame="funnel-builder"` |

The substring form is usually the stable one. Builder frames tend to
carry generated class names that change between deploys, while the
`title` or the src path does not.

`x, y, width, height` are the frame's **visible** box, already clipped
by any ancestor frame. `content_origin_x` / `content_origin_y` are where
the frame's own `(0, 0)` sits in page coordinates.

## Same-origin: nothing special required

These all resolve into frames automatically, ranking top-frame matches
first:

```
click_element("Save")                 # finds it wherever it lives
find_text("Publish")                  # matches carry a `frame` field
get_form_fields()                     # fields carry a `frame` field
fill_input(textHint="Email", value="x@y.z")
hover(selector=".row-actions")
drag(from_selector="#card1", to_selector="#done")
scroll_to_element("Billing")
probe_point(640, 400)                 # descends into the frame
```

Responses say which document answered:

```
Clicked "Save" [in iframe iframe#shell >>> iframe#builder]
```

Read that line. Two frames on one dashboard can each hold a "Save", and
a click that reports plain success without saying where it landed is not
verifiable.

Pass `frame` to **disambiguate**, not to enable:

```
click_element("Save", frame="funnel-builder")
get_form_fields(frame="funnel-builder")
get_page_text(frame="funnel-builder")
```

### Coordinates are always page coordinates

Every position chromeboost reports — `find_text` match positions,
`get_form_fields` ordering, `probe_point` — is in top-level viewport
pixels, already translated out of the frame. Feed them straight to
`click_at_coordinates` with no arithmetic.

That translation is also why clicks land: CDP's input dispatch has no
concept of frames, so an untranslated frame-local rect aims at the wrong
pixel, and the error grows with how far down the page the frame sits.

### Whole-page reads include frame text

`get_page_text()` appends the text of substantial same-origin frames
under labelled headers:

```
--- iframe iframe#shell >>> iframe#builder (https://app.example.com/builder/9f2) ---
```

Small ad / analytics / pixel frames are excluded by size. Suppress the
sections with `include_frames: false`, or read one frame with
`get_page_text(frame="...")`.

## Cross-origin: three routes in

### 1. Real input — `click_at_coordinates(frame=...)`

CDP input resolves at the renderer process, so it reaches a cross-origin
frame the way an OS-level click does. Pass `frame` and the coordinates
become relative to that frame's own top-left corner:

```
click_at_coordinates(frame="iframe#pay", x: 50, y: 20)
```

A point outside the named frame is refused, with the absolute
coordinate offered in the error, rather than silently clicking the
parent page behind it.

### 2. Scripting — `execute_script(frame=...)`

Injected per frame under the extension's own host permissions, so the
script's `document` **is** the frame's document:

```
execute_script(frame="iframe#pay", code: "return document.title")
```

Ambiguity is reported, never guessed at: two frames loading the same URL
returns an error listing both frame ids.

Caveat: if the frame's CSP blocks eval, the CDP fallback cannot help —
it only evaluates in the top frame — so the call refuses rather than
running your code in the wrong document.

### 3. Typing — `type_text(frame=...)`

Focus is set by a script injected into the frame; the keystrokes then
follow focus wherever it landed, staying `isTrusted=true`:

```
type_text(frame="iframe#pay", into_selector="input[name=cardnumber]", text="...")
```

Never use this for real card numbers or credentials. Highlight the field
and let the user type it.

### Reading it

`fetch_url(src)` returns the frame's HTML from the extension's
privileged context with cookies attached. `take_screenshot` captures its
pixels.

## Debugging checklist

**"No element matched" for something you can see.**
`list_frames()`. If the element's frame is cross-origin, no selector will
ever match it — switch to coordinates. If it is same-origin and the
match still fails, the selector is wrong, not the frame.

**Click reported success, nothing happened.**
`probe_point(x, y)` at the reported coordinate. The stack labels each
layer with its frame. A bare `<iframe>` at the top means cross-origin.

**Coordinates look plausible but land somewhere else.**
Check `list_frames` — the frame may have scrolled its content, or an
ancestor frame may be clipping it. `x, y, width, height` are the clipped
visible box; an element scrolled out of view inside its frame is
reported as offscreen rather than clicked blind.

**`get_page_text` returns almost nothing on a page full of UI.**
The app renders inside a frame. The frame sections should appear
automatically; if they do not, the frame is cross-origin — use
`fetch_url(src)` or `take_screenshot`.

## Limits

- Frame descent stops at depth 5 and 40 frames per page.
- Cross-origin frames cannot be read, queried, or searched. Ever.
- `execute_script(frame=...)` needs a URL match to resolve a frame id;
  two frames on the same URL are reported ambiguous.
- A frame that has not finished loading has no readable body and is
  skipped; `wait_for` a selector inside it first.
