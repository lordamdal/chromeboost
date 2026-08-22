import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve, relative, isAbsolute, dirname } from "path";
import type { WsBridge } from "../ws-bridge.js";
import { isBlockedUrl } from "../policy.js";

export function registerCaptureTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_input",
    `Fill a form input by visible label / placeholder / aria-label (\`textHint\`) OR by direct CSS selector (\`selector\`). Pass exactly one.

\`textHint\` mode: fuzzy-rank against label/placeholder/aria-label/name/id. Response includes the matched element's identifying attributes and match-strength (aria-eq, placeholder-eq, label-text-eq, name-eq, id-eq, *-includes, fuzzy-text-walk). Verify the match — fuzzy-text-walk is the lowest-confidence kind. Pass \`exact: true\` to refuse fuzzy and *-includes matches.

\`selector\` mode (replaces the old react_set_input): targets the input directly and routes through the React-aware native value-setter so React's onChange picks up the change. Handles same-origin iframe inputs via \`frame\`.

Works on React-controlled inputs, contenteditable (Stripe, Notion), and CodeMirror 6 editors. Use \`nth\` (1-based) when multiple inputs share the same label.`,
    {
      textHint: z.string().optional().describe("Label / placeholder / aria-label identifying the input. Exactly one of textHint or selector must be set."),
      selector: z.string().optional().describe("CSS selector of the input (e.g. 'input[name=email]'). Bypasses fuzzy matching."),
      value: z.string().describe("Value to fill"),
      nth: z.number().int().min(1).optional().describe("Which match to fill when multiple inputs share the same label (1 = first, default 1). textHint mode only."),
      exact: z.boolean().optional().describe("Refuse fuzzy text-walk and *-includes matches. textHint mode only. Default false."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Selector mode only. Works for CROSS-ORIGIN frames too: the value is set by a script injected into the frame itself rather than reached into from the parent."),
    },
    async ({ textHint, selector, value, nth, exact, frame }) => {
      if (!textHint && !selector) {
        return { content: [{ type: "text", text: "fill_input requires either textHint or selector." }] };
      }
      if (textHint && selector) {
        return { content: [{ type: "text", text: "fill_input: pass textHint OR selector, not both." }] };
      }
      if (selector) {
        // Pass "" instead of undefined for frame — chrome.scripting.executeScript
        // rejects `undefined` in args as unserializable. The extension handler
        // treats empty string as falsy (no iframe), same as undefined.
        const response = await bridge.request({ type: "react_set_input", selector, value, frame: frame ?? "" });
        const r = response as { success?: boolean; message?: string };
        if (!r.success) {
          const workaround =
            `\n\nWorkaround when selector-mode keeps failing:\n` +
            `  1. click_element("<visible label or selector text>") to focus the input.\n` +
            `  2. type_text("${value.slice(0, 40)}") via trusted keyboard events.\n` +
            `Or for React/CodeMirror/contenteditable that ignores synthetic events, drop into execute_script with the React-aware native value-setter (see CLAUDE.md → React Select recipes).`;
          return { content: [{ type: "text", text: `Failed to set "${selector}": ${r.message ?? "unknown"}${workaround}` }] };
        }
        return { content: [{ type: "text", text: r.message ?? `Set "${selector}"` }] };
      }
      const response = await bridge.request({ type: "fill_input", textHint: textHint!, value, nth, exact });
      if (response.type !== "fill_response") throw new Error("Unexpected response");
      const r = response as { success: boolean; message: string };
      if (!r.success) {
        const workaround =
          `\n\nWorkaround when textHint-mode keeps failing:\n` +
          `  1. find_input("${textHint}") to confirm the field exists and see its exact label.\n` +
          `  2. click_element("${textHint}") to focus it, then type_text("${value.slice(0, 40)}").\n` +
          `Or pass selector="<css>" instead of textHint to bypass fuzzy matching entirely.`;
        return { content: [{ type: "text", text: `Could not fill "${textHint}": ${r.message}${workaround}` }] };
      }
      return {
        content: [{ type: "text", text: `Filled "${textHint}": ${r.message}` }],
      };
    }
  );

  server.tool(
    "get_page_text",
    `Get the visible text content of the current page without taking a screenshot.
Use this instead of take_screenshot whenever you need to read what's on the page — errors, build status, form labels, confirmation messages, etc.
Returns up to 10,000 characters per call (~3k tokens). If the response ends with "... (N more characters)", call again with startIndex to read the next chunk.
Use the selector parameter to scope extraction to a specific section and avoid pulling unnecessary content.
Never use take_screenshot just to read page content — paginate with startIndex instead.

Whole-page reads append the text of substantial same-origin iframes, each under a \`--- iframe <path> ---\` header, so an app whose UI lives entirely inside a frame does not read as a blank page. Small ad/analytics frames are excluded by size. Pass \`frame\` to read one frame only, or \`include_frames: false\` to suppress the sections.`,
    {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to scope the extraction (e.g. 'main', '.error-toast', '[data-testid=\"status\"]'). Omit to auto-extract from the main content area."
        ),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Returns only that frame's text."),
      include_frames: z.boolean().optional().describe("Set false to suppress the appended same-origin frame sections on a whole-page read. Default true."),
      startIndex: z
        .number()
        .optional()
        .describe(
          "Character offset to start from. Use this to read past the first 20,000 characters — the response will tell you the next startIndex when more content exists."
        ),
    },
    async ({ selector, startIndex, frame, include_frames }) => {
      const response = await bridge.request({ type: "get_page_text", selector, startIndex, frame, include_frames });
      if (response.type !== "page_text_response") throw new Error("Unexpected response");
      const r = response as {
        text: string;
        selector_missed?: boolean;
        selector_in_shadow?: boolean;
        shadow_hosts_seen?: number;
        viewport?: { width: number; height: number };
        page?: { width: number; height: number };
        scroll?: { x: number; y: number };
      };
      let text = r.text;
      // Surface selector_in_shadow as a structured prefix — the in-text warning
      // was easy to miss in a 10K char chunk. selector_missed (true selector
      // miss) already carries an inline warning from the content script.
      if (r.selector_in_shadow) {
        text = `[note: selector "${selector}" matched inside a closed shadow root — chromeboost tools that pierce (get_page_text, find_text, click_element, fill_input) see it, but execute_script cannot. Don't drop to screenshots.]\n\n` + text;
      }
      // Shadow-host signal — surface ONLY when no selector was passed (so the
      // agent thinking "what's on this page?" gets the diagnostic) AND we
      // detected shadow hosts. Keeps the message terse on the common case.
      if (!selector && r.shadow_hosts_seen && r.shadow_hosts_seen > 0) {
        text = `[note: ${r.shadow_hosts_seen} shadow host${r.shadow_hosts_seen === 1 ? "" : "s"} detected on this page — call list_frames to see them. If execute_script returns an empty document, switch to find_text / get_page_text / click_element / fill_input — those pierce closed shadow roots.]\n\n` + text;
      }
      // Viewport / scroll metadata appended once, as a footer the agent can
      // use to compute coordinates for click_at_coordinates without a
      // separate execute_script probe. Skipped on continuation pages
      // (startIndex > 0) so it doesn't repeat across chunks.
      if ((startIndex ?? 0) === 0 && r.viewport && r.page && r.scroll) {
        const footer = `\n\n---\nviewport: ${r.viewport.width}x${r.viewport.height}, page: ${r.page.width}x${r.page.height}, scroll: (${r.scroll.x}, ${r.scroll.y})`;
        text = text + footer;
      }
      return {
        content: [{ type: "text", text: text || "(no text found on page)" }],
      };
    }
  );

  server.tool(
    "get_page_html",
    `Get the raw HTML of the current page or a scoped element. Use when you need to parse structure (tables, attribute values, nested data) and \`get_page_text\` strips too much, or when you're extracting structured data from a page Claude can't easily reason about from text alone.

Pierces open AND closed shadow roots for the \`selector\` lookup (Radix portals, Stencil/Lit web components). \`<script>\`, \`<style>\`, \`<noscript>\` are stripped before returning.

Default \`max_chars\` is 50,000. If the page is bigger, the response carries \`truncated: true\` and \`total_chars\` so you can decide whether to scope further with \`selector\`.

When the goal is "is X on this page?" or "find clickable Y", use \`find_text\` instead — it returns a focused match list rather than a wall of HTML.`,
    {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to scope the HTML to. Pierces closed shadow roots. Omit to return the main content area (or body)."
        ),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("Truncate after this many chars (default 50000). The response includes total_chars so you know if you missed anything."),
      frame: z.string().optional().describe("Address a same-origin frame instead of the top document. Accepts anything list_frames prints: a CSS selector, a nested 'outer >>> inner' path, or a plain substring of the frame's src / title / id (e.g. 'funnel-builder'). Returns only that frame's HTML."),
    },
    async ({ selector, max_chars, frame }) => {
      const response = await bridge.request({ type: "get_page_html", selector, max_chars, frame });
      if (response.type !== "page_html_response") throw new Error("Unexpected response");
      const r = response as {
        html: string;
        total_chars: number;
        truncated: boolean;
        selector_missed?: boolean;
        selector_in_shadow?: boolean;
      };
      const notes: string[] = [];
      if (r.selector_missed) notes.push(`selector "${selector}" not found, returning full body HTML`);
      if (r.selector_in_shadow) notes.push(`selector matched inside a closed shadow root`);
      if (r.truncated) notes.push(`truncated at ${max_chars ?? 50000} of ${r.total_chars} chars; scope further with selector to see more`);
      const header = notes.length > 0 ? `[${notes.join("; ")}]\n` : "";
      return {
        content: [{ type: "text", text: header + r.html }],
      };
    }
  );

  server.tool(
    "get_console_logs",
    `Read the browser console output (log, warn, error, info) captured since the page loaded.
Returns the last 200 messages with their level and timestamp.
Use this to check for JavaScript errors, debug React issues, or verify that an action produced the expected console output.
Pass level="error" to see only errors, or omit to see all levels.`,
    {
      level: z
        .enum(["log", "warn", "error", "info"])
        .optional()
        .describe('Filter by log level (e.g. "error" to see only errors). Omit for all levels.'),
    },
    async ({ level }) => {
      const response = await bridge.request({ type: "execute_script", code: `JSON.stringify(window._consoleLogs || [])` });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      let logs: Array<{ level: string; message: string; time: number }>;
      try {
        logs = JSON.parse((response as { result: string }).result);
      } catch {
        return { content: [{ type: "text", text: "No console logs captured (console capture may not be injected on this page yet — navigate first)." }] };
      }
      if (level) logs = logs.filter(l => l.level === level);
      if (logs.length === 0) {
        return { content: [{ type: "text", text: level ? `No ${level}-level console messages.` : "No console messages captured." }] };
      }
      const lines = logs.map(l => {
        const time = new Date(l.time).toISOString().slice(11, 23);
        return `[${time}] ${l.level.toUpperCase()}: ${l.message.slice(0, 500)}`;
      });
      return { content: [{ type: "text", text: `Console logs (${logs.length} entries):\n${lines.join("\n")}` }] };
    }
  );

  server.tool(
    "write_to_env",
    "Write a key=value pair to a .env file. Use this after capturing an API key or ID from the page.",
    {
      key: z.string().describe("Environment variable name (e.g. STRIPE_SECRET_KEY)"),
      value: z.string().describe("The value to write"),
      envPath: z
        .string()
        .describe(
          "Absolute path to the .env file (e.g. /Users/me/myproject/.env)"
        ),
    },
    async ({ key, value, envPath }) => {
      try {
        // Security: restrict writes to paths under the MCP server's working
        // directory (the Claude Code project root). Prevents accidental or
        // adversarial writes to sensitive locations like ~/.ssh/config,
        // ~/.zshrc, or other dotfiles outside the project.
        const cwd = process.cwd();
        const resolved = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
        const rel = relative(cwd, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(
            `Refusing to write .env outside the project directory. Target "${resolved}" is not under "${cwd}". If this is intentional, move the project to include the target path.`
          );
        }
        // Additional safety: filename must look like a .env file (.env, .env.local, .env.production etc.)
        const filename = resolved.split("/").pop() ?? "";
        if (!/^\.env(\.[\w-]+)?$/.test(filename)) {
          throw new Error(
            `Refusing to write: "${filename}" doesn't look like an env file. Expected .env, .env.local, .env.<name>, etc.`
          );
        }
        envPath = resolved;

        // Read existing content and update in-place if key exists, else append
        let existing = "";
        try {
          existing = readFileSync(envPath, "utf-8");
        } catch {
          // File doesn't exist yet, will create it
        }

        const lines = existing.split("\n");
        const keyPattern = new RegExp(`^${key}=`);
        const existingIndex = lines.findIndex((l) => keyPattern.test(l));

        if (existingIndex !== -1) {
          lines[existingIndex] = `${key}=${value}`;
          writeFileSync(envPath, lines.join("\n"), "utf-8");
        } else {
          // Append, ensuring file ends with newline
          const toAppend =
            (existing && !existing.endsWith("\n") ? "\n" : "") +
            `${key}=${value}\n`;
          appendFileSync(envPath, toAppend, "utf-8");
        }

        return {
          content: [
            {
              type: "text",
              text: `Written ${key}=<value> to ${envPath}`,
            },
          ],
        };
      } catch (err) {
        throw new Error(`Failed to write to .env: ${(err as Error).message}`);
      }
    }
  );

  server.tool(
    "read_attachment",
    `Fetch a URL via Chrome's privileged context (uses cookie jar, bypasses page CSP) and return parsed text. Supports docx (in-extension ZIP+XML extraction), txt/md/csv/json (UTF-8), html/xml (tag-stripped). For PDF, the response is a structured error pointing at download_file + local pdftotext. Truncates to max_chars (default 20000); reports total_chars + truncated for pagination.`,
    {
      url: z.string().describe("The full URL of the attachment. Uses Chrome's cookie jar — works on authenticated URLs."),
      format: z.enum(["txt", "md", "csv", "json", "xml", "html", "docx", "pdf"]).optional().describe("Override format auto-detection."),
      max_chars: z.number().int().min(1).optional().describe("Maximum characters to return (default 20000)."),
    },
    async ({ url, format, max_chars }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `read_attachment refused: ${block.reason}` }] };
      }
      const effective_max = max_chars ?? 20_000;
      const response = await bridge.request({ type: "read_attachment", url, format, max_chars: effective_max });
      if (response.type !== "read_attachment_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as { text: string; format: string; total_chars: number; truncated: boolean; mime: string };
      const header = `${url}\nformat: ${r.format} | mime: ${r.mime || "unknown"} | total_chars: ${r.total_chars}${r.truncated ? ` (truncated to ${effective_max})` : ""}\n${"─".repeat(40)}\n`;
      return {
        content: [{ type: "text", text: header + r.text }],
      };
    }
  );

  server.tool(
    "download_file",
    `Download a file from a URL to the user's local disk using Chrome's authenticated download flow.

Uses the user's existing Chrome session, so this works on authenticated URLs (Canvas attachments, Stripe document downloads, GitHub release tarballs behind SSO) without any auth setup on chromeboost's side. Returns the absolute path where the file landed, plus MIME type and byte size.

Use this when you need the BYTES of a file (binary parsing, large content, anything you'll process with another tool). For "I just need the text content of this attachment" use read_attachment instead — it downloads + parses in one call.

The file is saved to the user's default downloads directory (usually ~/Downloads). Pass filename to suggest a name; Chrome will add a numeric suffix if a file with that name already exists.`,
    {
      url: z.string().describe("The full URL to download (https://...). Chrome's cookie jar is automatically used."),
      filename: z.string().optional().describe("Suggested filename (Chrome will uniquify if it collides). Default: derived from URL or Content-Disposition header."),
      timeout_ms: z.number().int().min(1000).optional().describe("Abort if the download isn't complete in this many ms (default 60000)."),
    },
    async ({ url, filename, timeout_ms }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `download_file refused: ${block.reason}` }] };
      }
      const response = await bridge.request({ type: "download_file", url, filename, timeout_ms }, Math.max(30_000, (timeout_ms ?? 60_000) + 5_000));
      if (response.type !== "download_file_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as { path: string; mime: string; size: number };
      return {
        content: [{
          type: "text",
          text: `Downloaded ${url} → ${r.path}\nMIME: ${r.mime || "unknown"}\nSize: ${r.size} bytes`,
        }],
      };
    }
  );

  server.tool(
    "fetch_url",
    `Make an HTTP request to a URL from the extension's privileged context, bypassing the page's Content-Security-Policy.

This is the "privileged context for network access" companion to execute_script. The mental model:
- **execute_script (page context):** DOM access, page CSP applies, fetch() blocked by connect-src.
- **fetch_url (privileged context):** no DOM, full extension host_permissions (<all_urls>), Chrome's cookie jar included automatically, page CSP does not apply.

Use this when:
- You need bytes from an authenticated URL the user is already signed into (Canvas attachments, Stripe document downloads, internal API JSON).
- fetch() inside execute_script returns "Failed to fetch" or hits a Content-Security-Policy connect-src error.
- You want a clean response object (status, headers, body) instead of having to wire up your own request handling in page-context JS.

Returns: { status, status_text, headers, content_type, body_text or body_base64 (when binary), truncated, total_bytes }.
Cookies and Origin headers are set by Chrome — pass any extra request headers via the headers param.
Set binary=true for non-text responses (PDFs, images, zips) — the body is returned base64-encoded.`,
    {
      url: z.string().describe("The full URL to fetch (https://...). Same-origin or cross-origin, both work."),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .optional()
        .describe("HTTP method (default GET)"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Extra request headers (e.g. {'X-CSRF-Token': '...', 'Accept': 'application/json'}). Cookies are added automatically; do not set them here."),
      body: z
        .string()
        .optional()
        .describe("Request body for POST/PUT/PATCH/DELETE (ignored for GET/HEAD). Pass JSON as a string."),
      binary: z
        .boolean()
        .optional()
        .describe("If true, return body as base64 (body_base64). Use for PDFs, images, zips. Default false (UTF-8 text in body_text)."),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("Abort the request after this many ms (default 30000)."),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Truncate body at this many bytes (default 100000 ≈ 25K tokens, the MCP transport ceiling). Bumped down from 2MB in 0.9.4 because larger responses overflow the agent's context. For larger payloads, set `to_file` to write to disk instead."),
      to_file: z
        .string()
        .optional()
        .describe("Absolute path on disk under the agent's working directory. When set, the FULL response body is written to this path (no max_bytes truncation) and the response carries only {path, size, content_type, status, headers}. Parent directories are created if missing. Use this for anything you'd otherwise have to paginate through max_bytes."),
    },
    async ({ url, method, headers, body, binary, timeout_ms, max_bytes, to_file }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `fetch_url refused: ${block.reason}` }] };
      }
      // When to_file is set, request the full body — no truncation. The body
      // is written to disk on this side; the MCP response carries only metadata.
      // binary=true on the WS request ensures we get raw bytes (base64) so
      // non-text responses (PDF, zip, image) round-trip correctly.
      const effectiveMaxBytes = to_file ? Number.MAX_SAFE_INTEGER : (max_bytes ?? 100_000);
      const effectiveBinary = to_file ? true : binary;
      // Bump WS timeout for to_file path — large downloads may exceed 30s.
      const wsTimeout = to_file ? Math.max(120_000, (timeout_ms ?? 30_000) + 30_000) : Math.max(30_000, (timeout_ms ?? 30_000) + 5_000);

      const response = await bridge.request({
        type: "fetch_url",
        url,
        method,
        headers,
        body,
        binary: effectiveBinary,
        timeout_ms,
        max_bytes: effectiveMaxBytes,
      }, wsTimeout);
      if (response.type !== "fetch_url_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as {
        status: number;
        status_text: string;
        headers: Record<string, string>;
        content_type: string;
        body_text?: string;
        body_base64?: string;
        truncated: boolean;
        total_bytes: number;
        anti_bot_detected?: string | null;
      };
      const antiBotLine = r.anti_bot_detected
        ? `\n⚠ anti_bot_detected: "${r.anti_bot_detected}" — response body matches a known block / challenge page. Don't parse as the expected JSON/HTML; the user's IP may be challenged or the endpoint may require a real browser context.`
        : "";

      // to_file path: write bytes to disk, return metadata only.
      if (to_file) {
        const cwd = process.cwd();
        const resolved = isAbsolute(to_file) ? to_file : resolve(cwd, to_file);
        const rel = relative(cwd, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(
            `Refusing to write fetch_url body outside the project directory. Target "${resolved}" is not under "${cwd}".`
          );
        }
        mkdirSync(dirname(resolved), { recursive: true });
        const buf = r.body_base64
          ? Buffer.from(r.body_base64, "base64")
          : Buffer.from(r.body_text ?? "", "utf-8");
        writeFileSync(resolved, buf);
        const hdrLines = Object.keys(r.headers).sort().map((k) => `  ${k}: ${r.headers[k]}`).join("\n");
        return {
          content: [{
            type: "text",
            text: `HTTP ${r.status} ${r.status_text} — ${r.content_type || "no content-type"} — ${r.total_bytes} bytes\nWritten to: ${resolved}\nSize on disk: ${buf.byteLength}${antiBotLine}\n\nHeaders:\n${hdrLines}`,
          }],
        };
      }

      const header = `HTTP ${r.status} ${r.status_text} — ${r.content_type || "no content-type"} — ${r.total_bytes} bytes${r.truncated ? ` (truncated to ${max_bytes ?? 100_000}; set to_file=<path> to capture the full ${r.total_bytes} bytes)` : ""}${antiBotLine}`;
      const bodyPart = r.body_base64
        ? `\n\n[base64, ${r.body_base64.length} chars]\n${r.body_base64}`
        : r.body_text !== undefined
          ? `\n\n${r.body_text}`
          : "";
      return {
        content: [{ type: "text", text: header + bodyPart }],
      };
    }
  );
}
