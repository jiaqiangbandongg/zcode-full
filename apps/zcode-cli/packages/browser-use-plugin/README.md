# Browser Use

The official built-in ZCode plugin for browser automation. It ships the `node_repl` MCP server, browser-client bootstrap module, skill, and documentation/capability manifests.

## What it provides

- `node_repl` MCP server — exposes a single `js` tool, which the model sees as `mcp__node_repl__js`. Shared with Computer Use, so its model-facing text is scoped to both official capabilities. (`js_reset` and `js_add_node_module_dir` were removed on 2026-09-18 along with the moduleDirs machinery: every `js` call already starts fresh, and module search roots are the host's job to inject, not the model's to configure. Imports are limited to `node:*` builtins and absolute `file://` URLs under the skill root.)
- `scripts/browser-client.mjs` — explicitly bootstraps `agent.browsers` inside each fresh `js` kernel; BrowserControl tabs, not JavaScript globals, provide continuity.
- `scripts/computer-use-client.mjs` — shared-host copy of the CUA SDK bootstrap; it keeps the CUA skill on the same `ZCODE_PLUGIN_ROOT` while the CUA plugin remains SDK/skill/docs-only.
- `control-browser` skill — tells the agent how to bootstrap and drive an advertised ZCode browser backend (Desktop IAB or CLI-managed headless CDP), select a browser and read `browser.documentation()` once, use the Playwright DOM snapshot→locator→act workflow, observe controlled and user tab registries together after a possible popup action, and request screenshots only for visual evidence.
- `web-gui-tester` skill — layers a pure-GUI black-box testing workflow on top of `control-browser`, requiring Browser Use semantic evidence plus inspected screenshots while respecting current console, upload, and runtime capability boundaries.

The IAB runtime is provided by the desktop host; the managed headless CDP runtime is provided only by an explicitly opted-in CLI process. The plugin assets define the model guidance and the effective runtime object graph; unsupported members are removed by the manifest interpreter instead of failing after invocation.
