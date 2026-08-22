// Bundle entry for the frame-logic tests. Re-exports only what the suite
// exercises, so esbuild pulls in shadow.ts + frames.ts and nothing else.
export { queryAllDeep, walkTextNodesDeep } from "../../packages/extension/src/content/shadow.js";
export {
  reachableFrames,
  resolveFrame,
  uniqueSelectorIn,
  viewportRect,
  frameClipOf,
  framePathOf,
  isInFrame,
} from "../../packages/extension/src/content/frames.js";
