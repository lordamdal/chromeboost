/**
 * Frame-traversal and coordinate-translation tests.
 *
 * These cover the two things that are easy to get quietly wrong and
 * impossible to notice from a passing type-check:
 *
 *   1. Does a deep query actually cross a same-origin frame boundary, and
 *      does it still rank top-frame matches first?
 *   2. Does an element three documents down translate to the right pixel in
 *      the TOP viewport? CDP input dispatch speaks only top-level coordinates,
 *      so an off-by-one-frame here is a click that silently lands elsewhere.
 *
 * jsdom performs no layout, so every box is stubbed with a known rect. That is
 * the point: the assertions are about the arithmetic chromeboost does on top
 * of getBoundingClientRect, not about whether a browser measures correctly.
 *
 * Run with tests/frames/run.sh (needs jsdom; see the README).
 */

import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><html><body>
  <button id="top-save">Save</button>
  <div id="host"></div>
  <iframe id="shell" title="app shell"></iframe>
  <iframe id="ad"></iframe>
</body></html>`, { url: "https://app.example.com/", pretendToBeVisual: true });

const { window } = dom;
const { document } = window;

// Globals the content modules expect.
globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.CSS = window.CSS ?? { escape: (v) => String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.chrome = {}; // no chrome.dom -> getShadowRoot falls back to el.shadowRoot (open only)

// A closed-ish shadow host with an open root (jsdom has no chrome.dom).
const host = document.getElementById("host");
const sr = host.attachShadow({ mode: "open" });
sr.innerHTML = `<button class="in-shadow">Publish</button>`;

// ── Build a real nested same-origin frame tree ────────────────────────────
// jsdom blanks an iframe's document the moment `src` is set (it will not
// fetch), so the attribute is faked instead. The code under test only ever
// reads it via getAttribute.
const fakeSrc = (el, src) => {
  const orig = el.getAttribute.bind(el);
  el.getAttribute = (n) => (n === "src" ? src : orig(n));
};

const shell = document.getElementById("shell");
const shellDoc = shell.contentDocument;
shellDoc.body.innerHTML = `
  <h3>Shell</h3>
  <button id="shell-save">Save</button>
  <iframe id="builder" title="funnel-builder"></iframe>`;
fakeSrc(shell, "/shell");
const builder = shellDoc.getElementById("builder");
fakeSrc(builder, "/builder/9f2");
const builderDoc = builder.contentDocument;
builderDoc.body.innerHTML = `
  <button id="inner-save">Save</button>
  <input id="inner-email" placeholder="you@example.com">
  <div id="card1">Card One</div>`;

// Cross-origin frame: make contentDocument throw, like a real one.
const ad = document.getElementById("ad");
fakeSrc(ad, "https://ads.example.com/x");
Object.defineProperty(ad, "contentDocument", { get() { throw new Error("cross-origin"); } });

// ── Geometry stubs. jsdom does no layout, so give each element a known box.
// Frame-local coordinates, exactly as a browser would report them.
const boxes = new Map([
  [shell,   { left: 16,  top: 336, width: 800, height: 520 }],
  [builder, { left: 10,  top: 90,  width: 700, height: 340 }],
  [builderDoc.getElementById("inner-save"), { left: 12, top: 40, width: 60, height: 28 }],
  [builderDoc.getElementById("card1"),      { left: 12, top: 90, width: 120, height: 40 }],
  [ad,      { left: 16,  top: 910, width: 120, height: 60 }],
]);
for (const [el, b] of boxes) {
  el.getBoundingClientRect = () => ({
    left: b.left, top: b.top, width: b.width, height: b.height,
    right: b.left + b.width, bottom: b.top + b.height, x: b.left, y: b.top,
  });
}
// Frames have a 2px border + 6px padding, so content origin is inset by 8.
for (const w of [window, shell.contentWindow, builder.contentWindow]) {
  const orig = w.getComputedStyle.bind(w);
  w.getComputedStyle = (el, ps) => {
    const cs = orig(el, ps);
    if (el === shell || el === builder) {
      return new Proxy(cs, {
        get: (t, k) =>
          k === "borderLeftWidth" || k === "borderTopWidth" ? "2px"
          : k === "paddingLeft" || k === "paddingTop" ? "6px"
          : Reflect.get(t, k),
      });
    }
    return cs;
  };
}
Object.defineProperty(window, "innerWidth",  { value: 1400, configurable: true });
Object.defineProperty(window, "innerHeight", { value: 900,  configurable: true });

const M = await import("./.bundle.mjs");

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// ── 1. queryAllDeep crosses frame AND shadow boundaries, top frame first ──
const saves = M.queryAllDeep(document, "button");
eq("queryAllDeep finds buttons across frames + shadow",
   saves.map(b => b.id || b.className),
   ["top-save", "in-shadow", "shell-save", "inner-save"]);

eq("queryAllDeep({frames:false}) stays in the top document",
   M.queryAllDeep(document, "button", { frames: false }).map(b => b.id || b.className),
   ["top-save", "in-shadow"]);

eq("queryAllDeep reaches a depth-2 input",
   M.queryAllDeep(document, "input").map(i => i.id), ["inner-email"]);

// ── 2. Frame tree: paths, depth, ordering ────────────────────────────────
const frames = M.reachableFrames(false);
eq("reachableFrames enumerates BOTH levels", frames.map(f => f.path),
   ["iframe#shell", "iframe#shell >>> iframe#builder"]);
eq("reachableFrames depths", frames.map(f => f.depth), [1, 2]);
eq("cross-origin frame is excluded from the reachable tree",
   frames.some(f => f.el?.id === "ad"), false);

// ── 3. uniqueSelectorIn ──────────────────────────────────────────────────
eq("uniqueSelectorIn qualifies by tag", M.uniqueSelectorIn(document, shell), "iframe#shell");

// ── 4. Coordinate translation: the part that makes clicks land ───────────
// inner-save is at (12,40) inside builder; builder content origin is
// (10+8)=18,(90+8)=98 inside shell; shell content origin is (16+8)=24,(336+8)=344.
// So page coords are (12+18+24, 40+98+344) = (54, 482).
const innerSave = builderDoc.getElementById("inner-save");
const r = M.viewportRect(innerSave);
eq("viewportRect translates depth-2 element to page coords",
   { left: r.left, top: r.top, width: r.width, height: r.height },
   { left: 54, top: 482, width: 60, height: 28 });

eq("viewportRect is the identity for a top-frame element",
   (() => { const t = M.viewportRect(shell); return { left: t.left, top: t.top }; })(),
   { left: 16, top: 336 });

// ── 5. Clip region ───────────────────────────────────────────────────────
// shell box (16,336,800x520) ∩ builder box translated (10+24, 90+344)=(34,434) 700x340
const clip = M.frameClipOf(innerSave);
eq("frameClipOf intersects the ancestor frame boxes",
   { left: clip.left, top: clip.top, right: clip.right, bottom: clip.bottom },
   { left: 34, top: 434, right: 734, bottom: 774 });

// ── 6. Frame addressing: selector, nested path, src substring ────────────
const bySel  = M.resolveFrame("iframe#builder");
const byPath = M.resolveFrame("iframe#shell >>> iframe#builder");
const bySrc  = M.resolveFrame("funnel-builder");
const byId   = M.resolveFrame("builder/9f2");
eq("resolveFrame by CSS selector",   bySel.ok  && bySel.node.path,  "iframe#shell >>> iframe#builder");
eq("resolveFrame by nested path",    byPath.ok && byPath.node.path, "iframe#shell >>> iframe#builder");
eq("resolveFrame by title substring",bySrc.ok  && bySrc.node.path,  "iframe#shell >>> iframe#builder");
eq("resolveFrame by src substring",  byId.ok   && byId.node.path,   "iframe#shell >>> iframe#builder");

// ── 7. Cross-origin is reported as such, not as 'not found' ──────────────
const xo = M.resolveFrame("iframe#ad");
eq("cross-origin frame reports reason", [xo.ok, xo.reason], [false, "cross-origin"]);
eq("missing frame reports not-found", (() => { const m = M.resolveFrame("iframe#nope"); return [m.ok, m.reason]; })(), [false, "not-found"]);

// ── 8. framePathOf / isInFrame ───────────────────────────────────────────
eq("framePathOf names the owning frame", M.framePathOf(innerSave), "iframe#shell >>> iframe#builder");
eq("isInFrame is false for top-frame elements", M.isInFrame(document.getElementById("top-save")), false);
eq("isInFrame is true for frame-hosted elements", M.isInFrame(innerSave), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
