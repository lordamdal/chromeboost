# Browser harness

Nested same-origin frames (depth 2), a cross-origin data: frame, a
sticky bar, a kanban pair, and a form field inside the inner frame.
Serve it and drive it with chromeboost to verify the parts jsdom cannot:

```
python3 -m http.server 8931 --directory tests/frames/harness
```

Then, in a browser driven by chromeboost:

| Call | Expected |
|---|---|
| `list_frames()` | 3 frames: `iframe#shell` (depth 1), `iframe#shell >>> iframe#builder` (depth 2), `iframe#ad` (cross-origin) |
| `probe_point(300, 560)` | stack descends past `<iframe>` into the inner document, each layer labelled with its frame |
| `find_text("Inner frame")` | one match carrying `frame: "iframe#shell >>> iframe#builder"` |
| `click_element("Save")` | clicks the TOP document's Save (top-frame matches rank first) |
| `click_element("Save", frame="funnel-builder")` | clicks the inner one; the inner log line reports `isTrusted=true` |
| `get_form_fields()` | includes `inner-email`, tagged with its frame |
| `drag(from_selector="#card1", to_selector="#done")` | the card moves columns; the inner log says "card dropped into Done" |
| `get_page_text()` | includes an `--- iframe ... ---` section for the shell frame, and NOT the tiny ad frame |

After changing extension source, run `npm run build` and reload the
extension card in the Chrome profile chromeboost is connected to — a
stale extension is indistinguishable from a broken change.
