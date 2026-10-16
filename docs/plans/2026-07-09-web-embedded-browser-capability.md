# Web Embedded Browser Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app and mobile remote control hide and block the embedded Browser side pane feature while desktop keeps it.

**Architecture:** Add a `supportsEmbeddedBrowser` capability at the Root/App boundary, defaulting to desktop-only. Thread it through quick pick, side pane rendering, and browser tab callbacks so unsupported shells cannot create Browser side pane tabs.

**Tech Stack:** React 19, TypeScript, Zustand state, Vitest unit tests, existing UI shell components.

## Global Constraints

- UI changes must follow `DESIGN.md`.
- Web and mobile must remain supported; desktop Electron keeps existing Browser behavior.
- UI logging must use `packages/ui/src/logger.ts`.
- Import paths remain absolute.
- Run `pnpm typecheck` and `pnpm lint`.

---

### Task 1: Capability Tests

**Files:**
- Modify: `packages/ui/test/quickPickCommands.test.ts`
- Modify: `packages/ui/test/animatedSidePanePanelLayout.test.ts`

**Interfaces:**
- Consumes: `createQuickPickCommands(options)`
- Produces: failing tests for `supportsEmbeddedBrowser`

- [ ] **Step 1: Add failing quick pick test**

Assert that `supportsEmbeddedBrowser: false` removes `toggle-preview` and `add-browser-tab`.

- [ ] **Step 2: Add failing side pane launcher test**

Assert that the exported launcher id resolver omits `browser` when `supportsEmbeddedBrowser: false`.

- [ ] **Step 3: Run tests and confirm red**

Run: `pnpm vitest run packages/ui/test/quickPickCommands.test.ts packages/ui/test/animatedSidePanePanelLayout.test.ts`

Expected: at least one assertion/export failure caused by missing capability support.

### Task 2: Capability Wiring

**Files:**
- Modify: `packages/ui/src/root/types.ts`
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/ui/src/app-shell/types.ts`
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/web/src/main.tsx`

**Interfaces:**
- Produces: optional `supportsEmbeddedBrowser?: boolean` prop

- [ ] **Step 1: Add Root/App prop**

Add `supportsEmbeddedBrowser?: boolean` with comments explaining it is desktop-only by default.

- [ ] **Step 2: Derive default**

In Root/App, use `explicitSupportsEmbeddedBrowser ?? Boolean(isDesktop)`.

- [ ] **Step 3: Pass web false explicitly**

Add `supportsEmbeddedBrowser={false}` to all Web Root render paths.

### Task 3: UI And Callback Gating

**Files:**
- Modify: `packages/ui/src/quickpick/quickPickCommands.ts`
- Modify: `packages/ui/src/hooks/useAppPanels.ts`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`

**Interfaces:**
- Consumes: `supportsEmbeddedBrowser`
- Produces: browser entries omitted and tab creation blocked

- [ ] **Step 1: Gate quick pick**

Only include `toggle-preview` and `add-browser-tab` when `supportsEmbeddedBrowser` is true.

- [ ] **Step 2: Gate callbacks**

`handleToggleBrowser` and `handleOpenBrowserTab` return early when unsupported. `handleOpenBrowserUrl` keeps Web external URL fallback but does not create Browser side pane tabs.

- [ ] **Step 3: Gate side pane launcher/menu**

Add a pure launcher id resolver and use it to omit Browser items when unsupported.

### Task 4: Verification And Commit

**Files:**
- No new files beyond previous tasks

- [ ] **Step 1: Run targeted tests**

Run: `pnpm vitest run packages/ui/test/quickPickCommands.test.ts packages/ui/test/animatedSidePanePanelLayout.test.ts`

- [ ] **Step 2: Run required checks**

Run: `pnpm typecheck`

Run: `pnpm lint`

- [ ] **Step 3: Commit**

Commit with Conventional Commits, for example:

```bash
git commit -m "feat(ui): disable embedded browser in web app"
```
