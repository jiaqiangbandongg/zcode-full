# Built-in Browser Automation API

The browser registry understands backend types `iab`, `extension`, and `cdp`. Playwright is a `Tab` API surface, not a backend. The desktop host normally advertises `iab`, while ZCode CLI can explicitly advertise a managed headless Chromium as `cdp`. Never treat an unadvertised backend as available.

Start from the browser object model. Every Browser Use JS call runs in a fresh kernel, so run the Skill bootstrap and recreate the selected browser wrapper in each call. Read its complete effective documentation once:

```js
const browser = await agent.browsers.getDefault();
nodeRepl.write(await browser.documentation());
```

Start the next logical tab-operation batch by returning the complete controlled-tab observation. After the model inspects that result, bind the verified tab in the following cell; create a new tab only when no existing page is intended:

```js
const browser = await agent.browsers.getDefault();
const controlledTabs = await browser.tabs.list();
controlledTabs;
```

```js
const browser = await agent.browsers.getDefault();
const tab = await browser.tabs.new();
await tab.goto("https://example.com");
await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
await tab.playwright.domSnapshot();
```

After every successful `tab.goto(url)`, explicitly call `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })` before the first title, URL, or DOM observation. Keep this step in the model-visible trajectory even when `goto()` has already settled the backend navigation. Do not replace it with `networkidle` or a fixed sleep; routine URL/load-state waits remain capped at 3000ms.

For a CLI started with `--browser-use=headless`, select the advertised `cdp` backend (or use
`getForUrl(url)`). Headless is its launch/display mode, not a fourth backend type.

Keep the DOM observation as the final expression so the model receives it. Assigning it to a variable without returning or writing it does not surface the page state.

High-level methods return their payload directly. Actions return `undefined` on success. If a command fails, the method throws `BrowserCommandError`.

`playwright.domSnapshot()` is the default observation and locator ground truth. It returns the compact AI/ARIA tree rather than page `outerHTML`.

## API use behavior

- Recreate the same selected browser wrapper in every fresh REPL call; do not silently change backend. Before each new
  logical tab operation batch, call `tabs.list()` in a dedicated JS cell and return the complete result to the model.
  After inspecting it, use the next fresh JS call to match the intended id/url/title and call `tabs.get(id)`; no old
  Browser or Tab JavaScript binding exists across calls. Continuous actions in the same JS cell may reuse the
  just-validated Tab.
- For URL navigation, prefer `await agent.browsers.open(url)`: it reuses an existing same-site controlled tab (same
  hostname), activates it so the user sees it, and navigates in place instead of stacking new tabs. Pass
  `{ reuseTab: false }` or use `browser.tabs.new()` only when a parallel independent tab is genuinely needed.
- App-provided in-app-browser context is ambient UI state, not a browser-selection instruction. When it identifies a
  visible page, recover it from controlled tabs first, then user tabs; do not create a duplicate page before checking both.
- Base every interaction on visible page state, not DOM source order. After an action, collect the cheapest observation
  that answers the next question; do not take a snapshot and screenshot together by default.
- A snapshot-proven heading or visible text does not need a `link` or `button` role to be clicked. Do not replace a
  snapshot-proven `heading` with a guessed `link` role. If the user authorized navigation and that real target is unique,
  click it directly; a JavaScript card handler may receive the bubbled event.
- Use at most one state-changing action per observation cycle. An unchanged source-tab URL does not prove the click failed.
  Judge an action by whether its expected effect appeared, not by whether `browser.tabs.list()` is non-empty. An
  existing source tab or unrelated controlled tab is not an action effect. When an action may open a popup/new tab and
  the source tab does not show the expected effect, read `browser.tabs.list()` and `browser.user.openTabs()`
  unconditionally in the same observation cell. Return `{ controlledTabs, userTabs }` as that cell's final result so
  the model makes one decision from both lists. Do not return the controlled list first or decide whether to query user
  tabs from its contents.
- If the tab is already at the intended URL, do not call `goto()` again. Use `reload()` only when a refresh is required.
- For a read-only lookup, one focused direct URL derived from verified facts is acceptable. If that attempt fails or
  cannot be verified, do not loop over guessed URL variants, query grids, path names, or numeric resource IDs. Switch to
  the site's visible search/navigation or a purpose-built connector/API/CLI. Once one authoritative candidate exists,
  verify it directly instead of collecting more candidates.
- Minimize interruptions. For an underspecified but safe request, try the best evidence-backed path before asking a
  clarifying question.

Available entry points:

- `await agent.browsers.list()` returns runtime descriptors (`id`, `type`, capabilities, metadata) from the host registry. Connection generation remains an internal stale-routing guard.
- `await agent.browsers.get(idOrType)`, `getDefault()`, and `getForUrl(url)` return a `Browser`; an explicit unavailable selection fails instead of silently switching backend.
- `browser.tabs.list()` returns `TabInfo[]` for all controlled tabs, including the current `active` marker and actual
  CSS `viewport: { width, height }`. Inspect the whole list and match by stable id or verified URL/title; never select a
  multi-tab target by array position.
- `browser.tabs.get(tabId)` validates, binds, and activates a tab in its owning window/workspace/session scope. The
  renderer shows it only if that scope is currently foreground; background sessions never steal the user's current UI.
- `browser.tabs.new()` creates a real IAB tab and returns only after its guest ready acknowledgement.
- `browser.user.openTabs()` lists user tabs without granting control; call `browser.user.claimTab(tab)` explicitly before using one.
- Browser tabs persist across turns for the lifetime of the current ZCode process. `tabs.finalize({ keep })` marks
  only listed tabs as `handoff` or `deliverable`; unlisted tabs remain open. Only `tab.close()`, a user close, window
  close, or process exit removes a tab.
- Creating an IAB tab automatically opens the right pane and activates that tab so the user can see browser use in progress.
- Use `await (await browser.capabilities.get("visibility")).set(false | true)` only when the task explicitly needs to hide or show the pane again.
- `agent.documentation.get("screenshots")` loads screenshot guidance only when visual evidence is actually required.

Core `Tab` methods:

- `id`, `url()`, `title()`
- `goto(url)`
- `back()`, `forward()`, `reload()`, `close()`
- `screenshot(opts?)`
- `setViewportSize({ width, height })`, `viewportSize()` — Playwright-compatible responsive viewport control. IAB
  automatically opens the target tab in free-size mode. Width must be 320–3840 and height 320–2160; invalid input
  fails instead of being clamped.
- `getJsDialog()`
- `markDeliverable()`, `markHandoff()`
- `capabilities`, `cua`, `dom_cua`, `playwright`

Escape hatches:

- `tab.cua` is the coordinate path for canvas and custom-drawn controls.
- `tab.dom_cua` is the node path where `node_id` equals the snapshot `ref`.
- `cua.drag({ path, keys? })` preserves every supplied point. `cua.scroll({ x, y, scrollX, scrollY,
keypress? })` scrolls from the supplied viewport anchor. `dom_cua.scroll({ node_id?, x, y })` uses `x/y`
  as deltas and scrolls from the node center or, without a node, the viewport center.
- CUA and DOM CUA `keypress({ keys })` treat keys as one combination, not a sequence of independent presses.
  IAB does not expose CUA/DOM CUA `downloadMedia`; use a snapshot-proven Playwright locator's
  `downloadMedia()` when the selected element exposes a downloadable media/link URL.
- `tab.playwright` exposes the common Playwright surface: `locator/getBy*/frameLocator`, locator actions and
  queries, `evaluate`, `domSnapshot`, `waitForURL`, `waitForLoadState`,
  `waitForTimeout`, `expectNavigation`, and download events.
- Fixed waiting is `tab.playwright.waitForTimeout(timeoutMs)`, never `tab.waitForTimeout`. Prefer
  `locator.waitFor(...)`, `waitForURL(...)`, `waitForLoadState(...)`, or a fresh semantic observation.
- Routine locator, URL/load-state wait, and evaluate operations default to and are capped at 3000ms.
  A timeout is a signal to refresh the snapshot and rebuild the locator, not to retry it unchanged.
- IAB does not support file upload: `waitForEvent("filechooser")` / `fileChooser.setFiles(...)` fail with
  `capability_unsupported`; no fake upload success is exposed.
