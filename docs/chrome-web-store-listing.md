# Chrome Web Store listing, paste-ready

Everything the dev console asks for, in the order the tabs appear. Copy each
block verbatim. Source of truth for anything factual here is
`packages/extension/manifest.json` and `apps/website/privacy.html`.

Item: `725eb5e5-98b2-450d-9d0a-d8616654e6d1`
Package to upload: `packages/extension/chromeboost-1.1.0.zip`
Privacy policy URL: `https://chromeboost.work/privacy`
Terms of use URL: `https://chromeboost.work/terms`

---

## Tab 1: Store listing

**Name**
```
ChromeBoost
```

**Summary** (132 char limit, this is 112)
```
Let Claude Code, Codex or Gemini CLI drive the Chrome you already use, signed in as you. Free, MIT, no telemetry.
```

**Category**
```
Developer Tools
```

**Language**
```
English (United States)
```

**Description**
```
ChromeBoost gives your local AI coding assistant hands in the Chrome you already use.

Not a headless browser in a data centre. Your browser, already signed into your accounts, with your extensions and your session cookies. You ask in plain English from Claude Code, Codex, or Gemini CLI, and you watch the work happen in a real tab.

WHAT PEOPLE USE IT FOR

- Pull API keys out of a dashboard and write them straight into .env
- Fill long, awkward forms in React apps that normally fight automation
- Walk a signup flow and screenshot every step into a folder
- Configure a third party service such as Stripe, Supabase, Vercel or GitHub without leaving your editor
- Give your agent the page context it needs, without copy and paste

YOU STAY IN CONTROL

Anything irreversible stops and waits for you. Posting, paying, passwords and two factor codes are yours to confirm. ChromeBoost fills in everything around them and hands control back.

An on page status panel shows which session is driving. You can drag it, collapse it, or dismiss it, and bring it back with Alt+Shift+B.

HOW IT WORKS

ChromeBoost is two halves: this extension, and a small MCP server that runs on your own machine. They talk over a WebSocket bound to localhost. There is no ChromeBoost account, no cloud service, and no telemetry. The extension has exactly one network destination and it is your own computer.

The companion MCP server is required. Setup is two commands and is documented at https://chromeboost.work

WHY THE AUTOMATION ACTUALLY WORKS

Clicks hit test before they fire, so a button sitting under a cookie banner, a sticky header or a modal backdrop is still reached, and you are told what was in the way. Hover and drag are first class, so hover only menus, range sliders, canvas apps and drag to reorder lists all work. Input is dispatched through the Chrome DevTools Protocol so it arrives as real input, which is what modern web applications respond to.

OPEN SOURCE

MIT licensed. Full source: https://github.com/lordamdal/chromeboost
Privacy policy: https://chromeboost.work/privacy
```

---

## Tab 2: Privacy practices

**Single purpose** (one narrow purpose, this is what reviewers read first)
```
ChromeBoost lets a developer's own AI coding assistant operate their browser on their behalf: opening pages, reading page content, and performing the clicks, typing, hovers and drags that the developer asked for. The extension is the hands for a local MCP server running on the same machine; it performs browser actions and returns the results.
```

### Permission justifications

**debugger**
```
Browser input is dispatched through the Chrome DevTools Protocol so that clicks and keystrokes arrive as genuine input events. This is a functional requirement, not a preference: many modern web applications built on React and on web components ignore synthetic events dispatched from JavaScript, so an ordinary element.click() silently does nothing and the automation the user asked for fails. CDP is the only API available to an extension that produces input the page treats the same as the user's own. It is also used to read rendered element geometry when hit testing a click target, and to capture screenshots the user requested.
```

**Host permission (<all_urls>)**
```
The user chooses which site to work on at the moment they give an instruction, so the set of hosts cannot be declared in advance. A developer may ask the assistant to read their Stripe dashboard in one session and fill a form on their own staging site in the next. ChromeBoost acts only on the tab the user has directed it to, and only in response to an explicit instruction. It does not read, index or monitor pages in the background.
```

**tabs**
```
Listing open tabs, opening a new tab at a requested URL, switching between tabs, and closing a tab, when the user asks for those things. Multi step tasks frequently span more than one tab, for example opening a dashboard in a second tab while a form stays filled in the first.
```

**activeTab**
```
Reading the text of the tab the user is working on, and capturing a screenshot of it when the user asks for one.
```

**scripting**
```
Injecting the content script that performs DOM work in the page: locating an element by its visible label, hit testing a click target to detect an overlay covering it, filling form inputs including contenteditable and shadow DOM inputs, and rendering the on page status panel.
```

**offscreen**
```
Holding the WebSocket connection to the local MCP server. A Manifest V3 service worker is terminated when idle, which would drop the connection mid task. An offscreen document keeps the single localhost connection alive for the length of the session.
```

**storage**
```
Remembering the position, collapsed state and visibility of the on page status panel so it stays where the user put it, and tracking which local agent sessions are currently connected and on which port. All of it is local to the browser profile and none of it is transmitted.
```

**windows**
```
Focusing and arranging browser windows during tasks that span multiple tabs or windows, so the tab being worked on is the one in front of the user.
```

**downloads**
```
Saving a file when the user explicitly asks for a download, for example exporting a CSV from a dashboard, and reading back a file the assistant was told to retrieve.
```

**Remote code**
```
No, I am not using remote code
```
All executable code ships inside the package. The extension loads no external
scripts. Verify with: `unzip -l packages/extension/chromeboost-1.1.0.zip`

### Data usage

Tick **Website content**. ChromeBoost reads page text and DOM structure when a
tool call asks for it, and passes it to the local MCP server, which hands it to
the AI agent on the user's machine.

Also tick **Personally identifiable information** and **Authentication
information**. Neither is targeted or collected on purpose, but a page the user
directs the agent at can contain both, and disclosing the possibility is safer
than a removal for under-disclosure later. The redaction pass over page text
strips high confidence secrets such as API keys and JWTs, which is worth
mentioning in the review notes but is not a reason to leave the boxes unticked.

Do not tick: health, financial and payment information, personal
communications, location, web history, or user activity. None of those are read
as a category, and ChromeBoost keeps no history of what it visited.

All three certifications can be signed truthfully:

- Not being sold to third parties: correct, there is no data relationship at all.
- Not being used or transferred for purposes unrelated to the single purpose: correct.
- Not being used or transferred to determine creditworthiness or for lending: correct.

---

## Tab 3: Distribution

- Visibility: **Public**
- Regions: **All regions**

### Trader status depends on who publishes

This is a legal declaration, and the answer flips on the publisher identity:

| Publishing as | Declare | Consequence |
|---|---|---|
| An individual (lordamdal) | **Non-trader** | No contact details published on the listing |
| A company (e.g. Beaverhand) | **Trader** | Company name, address, phone and email are published on the EU listing |

Publishing under a company name is acting for business purposes, so it is
trader status even though the extension is free. The external donation link
does not by itself make an individual a trader, because it is not a contract
made on this marketplace.

Decide this before submitting; changing it later means changing the public
contact details on a live listing.

---

## Screenshots

Five are rendered, 1280x800, which is one of the two sizes the store accepts.
Upload them in this order; the first is the one shown in search results.

| File | What it shows |
|---|---|
| `dist/store/01-hands.png` | The pitch, and that irreversible steps wait for you |
| `dist/store/02-keys.png` | API keys going straight into .env |
| `dist/store/03-occlusion.png` | A click reaching a button under a cookie banner |
| `dist/store/04-hud.png` | The status panel, and that the user owns it |
| `dist/store/05-notclick.png` | Hover and drag, for UI that is not click shaped |

Source is `tools/store/*.html`. Re-render after editing with:

```
bash tools/store/render.sh
```

A 440x280 small promo tile is optional and not currently generated. The store
will list without one.

---

## Notes for the reviewer

Paste this into the "Notes to reviewer" box. It pre-answers what the
`debugger` permission will otherwise trigger a manual review question about.

```
ChromeBoost is an open source developer tool. Full source, including everything in this package: https://github.com/lordamdal/chromeboost

It is one half of a pair. The other half is an MCP server that the developer installs and runs on their own machine. The extension connects to it over a WebSocket bound to localhost and performs the browser actions the developer's AI coding assistant asks for. Without that local server running, the extension does nothing at all.

Why chrome.debugger: input is dispatched through CDP so that clicks and keystrokes are real input events. Applications built on React and on web components ignore JavaScript-dispatched synthetic events, so element.click() fails on a large share of the modern web. CDP is the only route an extension has to input the page handles normally. It is also used for hit testing geometry and for screenshots.

There is no backend, no account, no telemetry and no analytics in the extension. The only network destination is ws://localhost:PORT. This is verifiable in packages/extension/src/offscreen.ts, which contains the single WebSocket construction in the codebase.

Privacy policy: https://chromeboost.work/privacy
Terms of use: https://chromeboost.work/terms

To test: install the MCP server per https://chromeboost.work, load the extension, and the browser action popup will show a connected session.
```
