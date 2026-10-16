# UI Render Stability Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前实现以 `packages/ui/src/TaskList.tsx`、
> `packages/ui/src/TaskListItem.tsx` 和 `packages/ui/src/app-shell/WorkspaceShellLayout.tsx` 为准；
> 下文复选框是计划模板，不代表当前完成度，旧 `ChatMessage` 相关步骤也不代表 V4 会话渲染结构。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce repeated workspace UI renders in large sessions without changing task, shell, menu, or composer behavior.

**Architecture:** Stabilize props at existing component boundaries and defer heavy per-row context-menu content until the menu opens. Keep business state in current stores; use refs only to read latest values inside stable event callbacks.

**Tech Stack:** React 19, TypeScript, Zustand, Radix context menus/tooltips, Vitest.

## Global Constraints

- UI changes must follow `DESIGN.md`; no visual redesign is part of this work.
- Desktop continuous task flow and web remote replayable task flow must remain separate.
- UI logging, if added, must use `packages/ui/src/logger.ts`; this plan does not require new logging.
- Import paths must stay absolute.
- Run `pnpm typecheck` and `pnpm lint` before commit.

---

### Task 1: TaskList row action stability

**Files:**
- Modify: `packages/ui/src/TaskList.tsx`
- Test: `packages/ui/test/taskListRenderStability.test.ts`

**Interfaces:**
- Produces stable props for `MemoTaskItem`: `onArchiveTaskInline`, `onCancelArchiveConfirm`, `onTogglePinTask`, `onStartRenameTask`, `onArchiveTask`, `onMarkTaskAsUnread`.

- [ ] Add a failing test that re-renders `TaskList` with changed local state inputs while task data is unchanged, then asserts unchanged row action props keep reference identity.
- [ ] Run the specific test and verify it fails because the current row action props change.
- [ ] Refactor `TaskList` callbacks to read latest mutable values through refs where necessary and keep callback references stable.
- [ ] Run the specific test and verify it passes.

### Task 2: TaskListItem menu and hover content deferral

**Files:**
- Modify: `packages/ui/src/TaskListItem.tsx`
- Test: `packages/ui/test/taskListItemHoverActions.test.ts`

**Interfaces:**
- Keeps the current `TaskListItemContextMenu` open-only rendering behavior covered by a focused test.
- Keeps `loadTaskPaths` and `loadProviderConfig` tied to the open state.
- Defers hover-only archive tooltip/action content until the row is hovered or already confirming archive.

- [ ] Add a test proving closed task rows do not render `TaskListItemContextMenu`.
- [ ] Add a test proving opening the row context menu renders menu content once.
- [ ] Add a failing test proving idle rows do not mount the hover-only archive tooltip/action.
- [ ] Gate hover-only action content behind hover/archive-confirming state while preserving `ContextMenu` trigger behavior.
- [ ] Run the specific tests and verify they pass.

### Task 3: Workspace shell stable reset/callback props

**Files:**
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Test: existing render-stability tests or a focused new test if the component boundary can be isolated cheaply.

**Interfaces:**
- Stabilizes `resetKeys` arrays and render callback props passed to boundaries and mobile shell.

- [ ] Memoize reset key arrays by their semantic values.
- [ ] Memoize render callbacks that are passed as props.
- [ ] Run affected UI tests.

### Task 4: Chat composer and toolbar stable props

**Files:**
- Inspect/modify: `packages/ui/src/ChatView.tsx`
- Inspect/modify: `packages/ui/src/ChatView/ChatViewComposer.tsx`
- Inspect/modify: `packages/ui/src/ChatView/ChatPromptEditor.tsx`
- Inspect/modify: related toolbar controls if they own the unstable props.

**Interfaces:**
- Stabilizes equivalent `attachmentAction`, submit control, `initialConfig`, and toolbar callbacks where they cross memoized component boundaries.

- [ ] Add or extend a focused render-stability test if an existing composer test can isolate the boundary.
- [ ] Memoize equivalent action objects and callbacks.
- [ ] Run affected UI tests.

### Task 5: Final verification

**Files:**
- All changed code and docs.

- [ ] Run targeted tests for the changed UI files.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Review `git diff`.
- [ ] Commit with a Conventional Commits message.
