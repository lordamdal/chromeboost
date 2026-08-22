# Frame tests

Covers `content/frames.ts` and the frame-descent added to
`content/shadow.ts`. Run:

```
tests/frames/run.sh
```

jsdom is installed on demand into this directory and is not a repo
dependency. `.bundle.mjs` and `node_modules/` here are build artifacts.

## What is actually being asserted

jsdom does no layout, so every element's box is stubbed with a known
rect. That is deliberate. These tests are not checking that a browser
measures elements correctly; they are checking the arithmetic chromeboost
layers on top of `getBoundingClientRect`:

- `queryAllDeep` crosses same-origin frame boundaries and shadow roots,
  and still yields top-frame matches first (which is what keeps frame
  descent a safe default rather than a behaviour change).
- `{ frames: false }` genuinely stays in one document. Several internal
  callers depend on this — selector-uniqueness checks would reject a
  perfectly good selector if they counted matches in unrelated frames.
- `reachableFrames` enumerates nested frames with correct `>>>` paths and
  depths, and excludes cross-origin frames from the reachable tree.
- `viewportRect` translates a depth-2 element into top-viewport
  coordinates, including each frame's border and padding inset. This is
  the one that decides whether a click lands: CDP's `Input.dispatchMouseEvent`
  has no concept of frames.
- `frameClipOf` intersects the ancestor frame boxes, so an element
  scrolled out of view inside its own frame is treated as offscreen
  rather than clicked blind at a coordinate the parent page owns.
- `resolveFrame` accepts a CSS selector, a nested path, and a src / title
  substring, and distinguishes cross-origin from not-found.

## What these tests cannot cover

Hit testing (`deepElementFromPoint`, `findClearPoint`, `pierceAt`) needs
real layout and `elementFromPoint`, neither of which jsdom provides.
Verify those in a real browser against `tests/frames/harness/`.
