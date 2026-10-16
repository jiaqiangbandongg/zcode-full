# Worklog — Plugin Marketplace Browse Redesign + On-Demand Component Details

- **Date:** 2026-06-26
- **Branch:** `feature-harness-improve`
- **Author:** 插件市场前端开发
- **Spec:** [`docs/plugin-marketplace-ui-ux.md`](../../plugin-marketplace-ui-ux.md) (2026-06-25 revision section)

## Goal

Redesign the plugin **Marketplace** browse tab into a left marketplace switcher, a right
plugin card grid, and a list↔detail view toggle. The detail view must show each component's **name + description**
(Skills / Subagents / Commands / Hooks / MCPs) — even for **uninstalled** plugins.

## Key constraint & the decision that shaped everything

The original constraint was "don't change the data protocol". But investigation proved
that the marketplace protocol (`ZCodeAvailablePluginSummary`) carries only a coarse
`componentTypes` array — **no component names, no descriptions, no per-plugin manifest RPC**.
Showing name + description per component is therefore impossible without a new
CLI→UI data channel.

We checked the marketplace format:
- The marketplace entry schema *allows* an inlined manifest, but real `marketplace.json`
  files only carry a **pointer** (`"source": "./plugins/<name>"`).
- So component names and descriptions are only available by reading the plugin directory
  (installed cache or source) on demand.

**User decisions:** (1) add an on-demand RPC; (2) include component names and
descriptions by reading each component's frontmatter. This is the only protocol change.

## What was built

### 1. New protocol method `plugins/describe` (the only protocol change)
`packages/shared/src/zcode-protocol/index.ts`
- `zcodeProtocolMethods.pluginsDescribe = "plugins/describe"`
- params `{ workspace, marketplace, pluginName }`
- result `{ components: Array<{ kind: agent|command|skill|hook|mcp, items: Array<{ name, description? }> }>, diagnostics? }`
- registered in the session-method contract table.

### 2. CLI handler (apps/zcode-cli)
- `adapters/src/plugins/marketplace.ts` → `describeMarketplacePlugin({ marketplace, name, storageRoot })`:
  - installed → `resolveInstalledPluginRoot` (local cache dir, offline);
  - uninstalled → `resolvePluginSourceRoot` (temp clone via `mkdtemp`, cleaned up in `finally`) — mirrors `validateMarketplacePlugin`.
- `adapters/src/plugins/plugin-components.ts` (**new, 201 lines**): pure component enumerator
  over a resolved root + manifest. Reads `commands/`, `agents/` (`.md` frontmatter),
  `skills/` (`SKILL.md` frontmatter), hooks (manifest events), mcp (manifest server names).
  Extracted out of marketplace.ts to keep that file from growing further (it already
  exceeds the repo `max-lines` baseline — pre-existing).
- `bootstrap/src/plugins.ts` → `describeZCodePlugin` wrapper.
- `bootstrap/src/zcode-protocol/plugins.ts` → `describePlugin` handler (maps adapter result → protocol shape).
- `bootstrap/src/zcode-protocol/server.ts` → routed the new method.

### 3. Services layer
`packages/services/src/zcode-agent/{zcodeAgent.ts,zcodeAgentService.ts}` →
`describePlugin(params)` following the `pluginsValidate` call pattern.

### 4. UI (packages/ui)
- **`PluginMarketplaceManagement.tsx`** (rewritten): marketplace source card (kept) → search →
  left `MarketplaceSwitcher` (vertical, degrades to horizontal chips on narrow widths) +
  right content area that toggles between `MarketplaceGrid` (view A: card grid) and
  `MarketplaceDetailView` (view B: `← Back`). Detail opening triggers on-demand describe;
  loading / error / empty all degrade gracefully (fall back to `componentTypes` badges + retry).
- **`PluginComponentGroups.tsx`** (new): shared "name — description" two-line renderer, used by
  both the marketplace detail view and the installed-plugin detail dialog for consistent output.
- **`pluginManagedResourceGroups.ts`**: `describeResultToDisplayGroups()` maps the describe
  result into ordered display groups (agent→command→skill→hook→mcp).
- **`InstalledPluginManagement.tsx`**: switched its group rendering to the shared component.
- **`store/pluginManagementStore.ts`**: `describeCache` (keyed by pluginId, loading/loaded/error)
  + `describePlugin` action; cache hits skip refetch, `force` retries.
- **i18n**: en-US + zh-CN keys for the switcher, Get button, loading/error/empty states.

### Out of scope (YAGNI)
A left category nav (Featured / Infrastructure / …) — the protocol has no
`category` field, deferred. install/uninstall/marketplace CRUD untouched.

## Verification

- `tsc -b` clean for all touched packages (shared, services, ui, cli adapters+bootstrap).
  Note: a pre-existing `packages/desktop/test/e2e/reporting/e2e-ui-coverage.ts` istanbul-types
  error exists on baseline (confirmed via `git stash`) — unrelated to this change.
- `oxlint` clean for all new/modified files. The `max-lines` errors on
  `marketplace.ts`/`index.ts`/`plugins.ts` are pre-existing baseline violations (confirmed via
  stash); extraction of `plugin-components.ts` reduced marketplace.ts's net growth.
- **Unit tests:** full suite via pre-push hook — **656 files / 5262 tests passed**.
- **CDP screenshots** (real desktop app, dev:desktop:test, port 9229) in `tmp/shots/`:
  - `00-current.png`: card grid + marketplace switcher render correctly.
  - `01-detail.png`: detail view toggle works; "← 返回", not-installed badge, source line,
    and **components section showing "技能 6 项" (green badge)** — confirming `plugins/describe`
    works end-to-end and renders name+description groups.

### Bugfix during verification
The user's screenshot exposed garbled card text. Root cause: `MarketplacePluginCard`'s outer
grid used `grid-cols-[auto_minmax(0,1fr)_auto]` (3 columns) with only 2 direct children, so the
"Get" button landed in the middle `1fr` column and overlapped the text. Fixed to 2 columns
`[minmax(0,1fr)_auto]`. Re-verified by screenshot.

## Commits (all on origin/feature-harness-improve)
- `bdd833ddf` docs(plugins): spec marketplace browse redesign and on-demand plugins/describe
- `443dc16b8` feat(plugins): add plugins/describe to enumerate marketplace plugin components
- `30bb48bdf` feat(ui): redesign plugin marketplace browse with switcher, card grid and detail view

## Follow-ups / risks
- **Windows/Linux:** the CLI describe path uses only `node:path`/`node:fs`/`mkdtemp(tmpdir())`,
  no hand-written separators — but git-clone-on-describe for uninstalled plugins was only
  exercised on macOS. Cross-platform clone/cleanup still needs a Windows pass.
- **Network cost:** describing an uninstalled plugin clones its source to a temp dir each time
  (then cleans up). Result is UI-cached per pluginId per session, but a cold open of many
  uninstalled plugins = many clones. Consider a CLI-side short-lived cache if this bites.
- **Frontmatter parsing** in `plugin-components.ts` is a lightweight name/description extractor
  (duplicates the skills/commands adapter idiom rather than importing it). If a third frontmatter
  consumer appears, extract a shared util.
- The category nav was deferred pending a protocol `category` field.

## Throwaway artifacts (not committed)
- `tmp/cdp-shot.mjs` — CDP screenshot helper (raw `ws` over page target; puppeteer hangs on Electron).
- `tmp/shots/*.png` — verification screenshots.
- `.claude/plans/plugin-ui-redesign-notes.md` — prior-session notes (a different task: the
  installed-list redesign), intentionally left untracked.
