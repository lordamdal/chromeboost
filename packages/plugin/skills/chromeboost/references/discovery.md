# Discovery reference

How to find things on a page without dumping the whole document into
context. The four discovery primitives and when to reach for each.

## When to use each

| Question | Primitive |
|---|---|
| Is "X" on the page? | `find_text("X")` |
| Where is the "Save" button? | `find_text("Save")` (returns selector + clickable flag) |
| What are all the form fields here? | `get_form_fields()` |
| Find a specific input by hint | `get_form_fields(query="Email", type_filter="email")` |
| What's the page actually showing? | `get_page_text()` |
| I need the raw HTML / attributes | `get_page_html(selector="...")` |
| Are there iframes / shadow hosts? | `list_frames()` |
| Element is in an iframe | nothing special if same-origin — see `references/iframes.md` |

Use the most-targeted primitive that answers your question. Don't dump
`get_page_text` when `find_text("Saved")` suffices.

## `find_text` — locate by visible text

```
find_text("Save")                             # default: visible only, max 5
find_text("Save", max=10)
find_text("Save", scope_selector=".dialog")   # scope to a section
find_text("Save", regex=true)                 # case-insensitive regex
find_text("Live", whole_word=true)            # word-boundary match
find_text("Save", visible_only=false)         # include hidden matches
find_text("Save", frame="funnel-builder")     # scope to one same-origin frame
find_text("Cancel", in_dialog=true)           # scope to topmost dialog
find_text("Confirm", dialog_query="Delete")   # scope to named dialog
```

Same-origin iframes are searched automatically, top-frame matches
first; a match inside one carries a `frame` field naming it. Pass
`frame` only to scope the search to a single frame.

Returns per-match: surrounding context, best-effort CSS selector,
`clickable` flag, and viewport position (already translated to page
coordinates, so it feeds `click_at_coordinates` directly). Pass the matched text to
`click_element` (preferred) or the selector to a piercing primitive.

The `whole_word: true` flag eliminates false positives on common
English words ("Live", "New", "Done", "Confirm") that would otherwise
substring-match inside larger words ("delivery", "abandoned",
"discomfort").

When `visible_only=true` (default) filters all matches out AND there
were hidden matches, the response surfaces the hidden count:
`"No visible matches found for X. N hidden match(es) skipped..."`.

## `get_form_fields` — inventory inputs / textareas / selects / editors

```
get_form_fields()                             # full inventory, top-to-bottom
get_form_fields(query="Email")                # filter+rank by hint
get_form_fields(query="Card", type_filter="text")
get_form_fields(query="Address", exact=true)  # refuse fuzzy
get_form_fields(only_empty=true)              # required-but-empty only
get_form_fields(frame="funnel-builder")       # scope to one same-origin frame
```

Pierces closed shadow DOM and same-origin iframes. Fields found inside
a frame carry a `frame` value; pass that same value to `fill_input` or
the selector will not resolve. Reports captcha presence and OAuth
provider buttons. See `references/forms.md` for the fill patterns that
follow.

## `get_page_text` — read visible text

```
get_page_text()                               # auto-extract main content
get_page_text(selector=".error-toast")        # scope to a section
get_page_text(startIndex=10000)               # paginate
```

Returns up to 10,000 chars per call (~3K tokens). Pierces closed shadow
DOM. The response's footer carries viewport / page / scroll metadata
so you can map text positions to click coordinates.

Use this instead of `take_screenshot` whenever you need to READ what's
on the page — errors, build status, form labels, confirmation messages.

`get_page_text()` also appends the text of substantial same-origin
iframes under `--- iframe <path> ---` headers, so an app whose UI lives
entirely inside a frame does not read as a blank page. Pass
`include_frames: false` to suppress, or `frame="..."` to read one.

## `get_page_html` — read raw HTML

```
get_page_html()                               # main content or body
get_page_html(selector="table.data")          # scoped to selector
get_page_html(selector="table", max_chars=200000)
```

When you need to parse structure (tables, attribute values, nested
data) and `get_page_text` strips too much. Pierces closed shadow DOM
for the selector lookup. `<script>`, `<style>`, `<noscript>` are
stripped. Response includes `total_chars` and `truncated` so you know
if you missed content.

When the goal is "is X on this page?" or "find a clickable Y", prefer
`find_text` — focused match list vs. wall of HTML.

## `list_frames` — iframes AND shadow hosts

```
list_frames()
```

Every frame at every nesting depth, same-origin and cross-origin.

Per-iframe: `selector` (an address other tools accept verbatim as
`frame` — a CSS selector, a nested `outer >>> inner` path, or a substring
of the frame's src / title / id), `depth`, `src`, `url` (the frame's
current document, which drifts from `src` once it navigates), `origin`,
`accessible`, `title`, plus the frame's clipped visible box.

Same-origin frames need nothing: `click_element`, `find_text`,
`fill_input`, `hover`, `drag`, and `get_form_fields` all resolve into
them and report which frame answered. Cross-origin frames carry a `hint`
naming the three routes that do reach them —
`click_at_coordinates(frame=..., x, y)`, `execute_script(frame=...)`,
and `fetch_url(src)`. Full treatment in `references/iframes.md`.

Also reports shadow-host inventory: open/closed flag, depth. Non-zero
closed count signals that `execute_script` will return empty — switch
to piercing primitives.

## `wait_for` — async appearance

```
wait_for(selector=".success")
wait_for(text="Saved")
wait_for(text=["Saved", "Error", "Failed"])   # any-of mode
wait_for(text="Live", whole_word=true)
wait_for(change_in=".toast")                  # observe mutations on existing element
```

Pierces closed shadow DOM. `since: "now"` skips the initial check
(useful when the page kept stale text from a prior step). On timeout,
`text` mode returns `last_text` showing what was actually in the
scope when the wait gave up.

## `scroll_to_element` — when the target is off-screen

```
scroll_to_element("Billing address")          # by visible text
scroll_to_element("#submit-btn")              # by CSS selector
```

Walks `overflow:auto/scroll` ancestors so inner scroll panes actually
move (the tall-inner-pane case where `document.body.scrollHeight` is
tiny but the inner scroll container is 15000+ px tall). Pierces closed
shadow roots.

## Discovery vs. dump rule

If the question is "is X here?" or "where is X?", reach for
`find_text` / `get_form_fields(query)` / `wait_for(text)` first.
Reserve `get_page_text` for reading actual content and an unscoped
`get_form_fields()` for understanding a whole form's structure. Don't
dump when you can spotlight.
