# Workflow

Every code block below assumes the `control-browser` Skill bootstrap has run in the current fresh JS kernel. Recreate
the same selected browser wrapper in each call; BrowserControl tabs, not JavaScript variables, provide continuity.

1. Start every logical tab operation batch with a dedicated JS call that returns all controlled tabs to the model:

```js
const browser = await agent.browsers.getDefault();
const controlledTabs = await browser.tabs.list();
controlledTabs;
```

After inspecting that output, use the next JS call to match the intended page by stable id or verified URL/title facts,
then call `tabs.get(id)` to activate it. Never select `[0]` merely because the list is non-empty. If no controlled tab
matches, inspect user tabs and claim the matching page. This is the pre-action target-selection protocol; action-result
popup observation uses the combined cell in step 5:

```js
const browser = await agent.browsers.getDefault();
const tab = await browser.tabs.get("verified-tab-id-from-the-prior-list");
await tab.playwright.domSnapshot();
```

If the controlled list had no verified match, use the next fresh call to return `await browser.user.openTabs()` to the
model, then claim only the verified user-tab fact. Create a new tab only after both observations fail to identify it.

2. If the task names a new URL, select with `getForUrl`, then open or navigate once:

```js
const browser = await agent.browsers.getForUrl("https://example.com");
const tab = await browser.tabs.new();
await tab.goto("https://example.com");
await tab.playwright.waitForLoadState({ state: "domcontentloaded" });
await tab.playwright.domSnapshot();
```

After every successful `tab.goto(url)`, explicitly call `await tab.playwright.waitForLoadState({ state: "domcontentloaded" })` before the first title, URL, or DOM observation. Keep this explicit confirmation in the model-visible trajectory even when the backend navigation has already settled. Do not replace it with `networkidle` or a fixed sleep; routine URL/load-state waits remain capped at 3000ms.

3. Read the page from `playwright.domSnapshot()`. It returns the AI/ARIA tree with computed roles, accessible names, state and expanded iframe content when available. Construct Playwright locators only from facts present in the latest relevant snapshot. When the snapshot already contains the target, use it directly instead of writing `evaluate()` code to search related elements, enumerate inputs, dump HTML, or walk the DOM. Never guess a label, accessible name, placeholder, selector, or URL pattern, and never spend timeout budget using a guessed locator as an exploratory probe.

A snapshot-proven heading or visible text does not need a `link` or `button` role to be clicked. Do not replace a
snapshot-proven `heading` with a guessed `link` role. When the user has authorized navigation and the actual
heading/text locator is unique, click it directly; its event can bubble to a JavaScript handler on an ancestor card.

The snapshot call must be the final expression in the JS cell, or be passed to `nodeRepl.write(...)`. A local assignment alone does not return the DOM observation to the model.

4. Confirm locator uniqueness when it is not obvious, then act through real browser actions. If `count()` is zero, do not wait on or execute the locator: take a fresh snapshot and rebuild it. If it is greater than one, tighten the scope instead of using a positional shortcut:

```js
const input = tab.playwright.getByRole("textbox", { name: "Search" });
if ((await input.count()) !== 1) throw new Error("Search locator is not unique");
await input.fill("hello");
await input.press("Enter");
```

5. After an action, collect the cheapest observation that answers the next question. Prefer a targeted locator state check; take another `domSnapshot()` when you need new locator ground truth. Use at most one state-changing action per observation cycle. An unchanged source-tab URL does not prove the click failed. Judge an action by whether its expected effect appeared, not by whether `browser.tabs.list()` is non-empty. An existing source tab or unrelated controlled tab is not an action effect. The expected effect may be a source-page state change or a tab whose verified URL/title matches the intended result.

When an action may open a popup/new tab and the source tab does not show the expected effect, read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell:

```js
const [controlledTabs, userTabs] = await Promise.all([
  browser.tabs.list(),
  browser.user.openTabs(),
]);
({ controlledTabs, userTabs });
```

Return `{ controlledTabs, userTabs }` as that cell's final result so the model makes one decision from both lists. Do not return the controlled list first or decide whether to query user tabs from its contents. In the next cell, match by verified id/url/title and activate or claim the intended page. If the source page and combined tab observation all lack the expected effect, take a fresh snapshot and choose a new locator instead of replaying the old click. Opening or navigating a normal page is not a reason to screenshot, and do not collect DOM snapshot plus screenshot together by default.

Only load `agent.documentation.get("screenshots")` when the user explicitly requests a screenshot, visual layout/rendering/image content must be judged, or the required target is missing from the DOM snapshot (for example canvas/custom-drawn UI). Once that branch is selected, every screenshot must be emitted in the same JS cell with `nodeRepl.emitImage(await tab.screenshot())`; never leave `tab.screenshot()` as the final expression or return its `Uint8Array` bytes directly.

After any Playwright timeout, strict-mode failure, or selector parse failure, do not retry the same locator. Take a fresh `domSnapshot()` and rebuild it from snapshot-proven facts. Routine locator and page-state waits fail within a 3000ms budget; use a longer fixed sleep only when no concrete state can be observed.

Use `playwright.evaluate(...)` and locator `evaluate(...)` for page-side JavaScript that cannot be expressed through the high-level locator API. These calls execute in the page context, so keep the expression focused and use the normal action methods when they better communicate the intended interaction.

6. Tabs remain open across turns by default. Use `await browser.tabs.finalize({ keep })` only when you need to mark
   listed pages as `deliverable` or `handoff`; unlisted pages remain open. Close a tab only with an intentional
   `await tab.close()` call.

For direct lookup URLs, make at most one focused attempt derived from user input or verified page facts. Never iterate
guessed URL variants, paths, search parameters, or numeric IDs. If the focused attempt fails, use a fresh snapshot,
the site's own search/navigation, or an authoritative connector/API/CLI lookup before navigating again.
