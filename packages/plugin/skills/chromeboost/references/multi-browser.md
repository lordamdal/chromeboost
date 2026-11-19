# Multi-browser (multiple Chrome profiles)

ChromeBoost can drive multiple Chrome browsers simultaneously, each running
under a different Chrome profile. Each profile has its own logins, cookies,
extensions, and browsing data, so you can automate work across separate
accounts without logging out.

## Setup

1. Install the ChromeBoost extension in **each** Chrome profile you want to
   use. Each profile's extension connects independently to the MCP server.
2. All profiles connect to the same MCP server port. The server tracks each
   browser by a persistent ID generated per profile.

**Do not run both the Web Store copy and an unpacked copy in the same
profile.** They evict each other on reconnect.

## Tools

### `list_browsers`

Returns all connected Chrome browsers with their id, profile name, email,
and whether each is the active target.

```
list_browsers()
→ 2 browser(s) connected:
  id: abc-123  |  profile: Work  |  email: work@company.com  |  active: YES
  id: def-456  |  profile: Personal  |  email: me@gmail.com  |  active: no
```

### `select_browser`

Switch which browser receives subsequent tool calls. Accepts a browser id,
profile name, or email (case-insensitive substring match).

```
select_browser(browser: "Personal")
→ Active browser set to: Personal (def-456)
```

All tools after `select_browser` target the selected browser until you call
`select_browser` again. When only one browser is connected it is selected
automatically.

## Patterns

### Cross-account verification

```
# Check the sender's view
select_browser(browser: "Work")
open_page("https://app.example.com/sent")
find_text("Invoice #1234")

# Switch and check the recipient's view
select_browser(browser: "Personal")
open_page("https://app.example.com/inbox")
find_text("Invoice #1234")
```

### Parallel setup across profiles

```
# Set up Stripe in the work profile
select_browser(browser: "Work")
open_page("https://dashboard.stripe.com/apikeys")
get_page_text(selector=".secret-key")

# Set up SendGrid in the personal profile
select_browser(browser: "Personal")
open_page("https://app.sendgrid.com/settings/api_keys")
```

### Testing as different user roles

```
# Admin view
select_browser(browser: "Admin")
open_page("https://app.example.com/admin/users")
click_element("Invite User")

# Regular user view
select_browser(browser: "User")
open_page("https://app.example.com/dashboard")
wait_for(text="You have been invited")
```

## Notes

- Each browser gets its own Chrome window per Claude Code instance (the
  existing per-port window assignment). `select_browser` does not affect
  which window a browser uses.
- If the active browser disconnects, the server automatically selects
  another connected browser. The next tool call will target the new active.
- Browser IDs persist across extension reloads and Chrome restarts (stored
  in profile-scoped `chrome.storage.local`).
- Profile name defaults to the email local part of the signed-in Chrome
  account. Profiles with no signed-in account get an auto-generated id.
