#!/usr/bin/env node
/**
 * Stop hook — occasionally asks for a GitHub star or a coffee.
 *
 * ChromeBoost is free and has no billing surface, so this prompt is the only
 * thing standing between "people find it useful" and "the author hears about
 * it". That earns it a place, but not much room. The rules it plays by:
 *
 *   1. Only after real use. It reads the tool-call counter the MCP server
 *      writes; a session where ChromeBoost sat idle never sees it. Asking for
 *      support from someone the tool hasn't helped is just spam.
 *   2. Rarely. First prompt at 20 tool calls, then at most once every 21 days.
 *   3. Alternating. Star, then coffee, then star — so it never reads as the
 *      same nag twice.
 *   4. Silenceable, and it says so. CHROMEBOOST_NO_NAG=1 turns it off for good.
 *
 * Emits {"systemMessage": ...}, which Claude Code shows to the user and does
 * NOT put in the model's context — the point is to reach the human without
 * spending the agent's tokens or derailing its next turn.
 *
 * Never throws and always exits 0: a support prompt must not be able to break
 * someone's session.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = "https://github.com/lordamdal/chromeboost";
const COFFEE = "https://buy.stripe.com/6oU6oHbqTcD8gSQ1rQbAs00";

// Host-neutral: the MCP server writes here regardless of which CLI spawned it.
const STATE_DIR = path.join(os.homedir(), ".chromeboost");
const USAGE_PATH = path.join(STATE_DIR, "usage.json");
const LEGACY_USAGE_PATH = path.join(os.homedir(), ".claude", "chromeboost", "usage.json");
const STATE_PATH = path.join(STATE_DIR, "support.json");

const FIRST_PROMPT_AT_CALLS = 20;
const REPROMPT_AFTER_DAYS = 21;
const REPROMPT_AFTER_MS = REPROMPT_AFTER_DAYS * 24 * 60 * 60 * 1000;
/** Additional tool calls that must accumulate before asking again. */
const CALLS_BETWEEN_PROMPTS = 150;

function readJson(p, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

function silent() {
  process.stdout.write("{}");
  process.exit(0);
}

try {
  if (process.env.CHROMEBOOST_NO_NAG === "1") silent();

  let usage = readJson(USAGE_PATH, { toolCalls: 0, lastUsed: 0 });
  if (!usage.toolCalls) usage = readJson(LEGACY_USAGE_PATH, { toolCalls: 0, lastUsed: 0 });
  if (!usage.toolCalls) silent();

  const state = readJson(STATE_PATH, { lastShownAt: 0, shownCount: 0, callsAtLastShown: 0 });
  const now = Date.now();

  const isFirst = state.shownCount === 0;
  const due = isFirst
    ? usage.toolCalls >= FIRST_PROMPT_AT_CALLS
    : now - state.lastShownAt >= REPROMPT_AFTER_MS &&
      usage.toolCalls - state.callsAtLastShown >= CALLS_BETWEEN_PROMPTS;

  if (!due) silent();

  // Alternate the ask so repeat prompts don't read as the same message.
  const askForStar = state.shownCount % 2 === 0;
  const calls = usage.toolCalls.toLocaleString("en-US");

  const message = askForStar
    ? `⚡ ChromeBoost has driven your browser ${calls} times.\n` +
      `   If it's earning its keep, a star helps other people find it: ${REPO}\n` +
      `   (silence this: CHROMEBOOST_NO_NAG=1)`
    : `☕ ChromeBoost has driven your browser ${calls} times — still free, still MIT.\n` +
      `   If it saved you an afternoon: ${COFFEE}\n` +
      `   (silence this: CHROMEBOOST_NO_NAG=1)`;

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      STATE_PATH,
      JSON.stringify({
        lastShownAt: now,
        shownCount: state.shownCount + 1,
        callsAtLastShown: usage.toolCalls,
      }),
      "utf8"
    );
  } catch {
    // If we can't persist that we asked, don't ask — better to stay quiet than
    // to repeat on every single turn.
    silent();
  }

  process.stdout.write(JSON.stringify({ systemMessage: message }));
  process.exit(0);
} catch {
  silent();
}
