# Session Workbench Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build renderer-local v4 session workbench groups so sidebar sessions can be dragged into the chat workbench and split around a target pane in IDE-style groups.

**Architecture:** Add a focused `workbenchGroupStore` that owns group layouts, session uniqueness, active group/focused pane, and localStorage persistence. Reuse existing pane layout pure functions where possible, extend them only for before/after directional splits, and keep the v4 protocol/agent runtime unchanged. Wire sidebar drag payloads and workbench drop zones through explicit client gates so desktop and ordinary Web App work while mobile and `/remote` stay disabled.

**Tech Stack:** TypeScript, React, Zustand, Vitest, native HTML drag/drop, existing v4 `SessionPane`/`V4PaneConversationProvider`.

## Global Constraints

- Write/update specs before code; the source spec is `docs/v4-session-workbench-groups.md`.
- UI changes must follow `DESIGN.md`, use semantic tokens, support light/dark/Zai themes, desktop and ordinary Web App, and not enable mobile or `/remote` web-remote drag split.
- `workspaceIdentity?.trim() || workspacePath` is the identity/isolation key; `workspacePath` remains display/execution path.
- Workbench group state is renderer-local only; do not modify v4 protocol, agent runtime, main process, relay, or remote replayable state.
- One session belongs to at most one group; duplicate sessions must not show a drop preview or create a second pane.
- Every task starts with a failing test and verifies the failure before production code.
- Preserve existing user worktree changes; do not stage unrelated files such as `packages/ui/src/v4/ConversationHeader.tsx` unless the task explicitly edits them.

---

### Task 1: Directional Pane Split Helper

**Files:**

- Modify: `packages/ui/src/v4/paneLayoutTree.ts`
- Test: `packages/ui/test/v4PaneLayoutStore.test.ts`

**Interfaces:**

- Produces: `splitPaneAtSide(state, anchorPaneId, side, binding): PaneLayoutSnapshot`
- `side` type: `"left" | "right" | "up" | "down"`
- Later tasks use this helper for drag drop zones.

- [ ] **Step 1: Write the failing tests**

Add tests near the existing `splitPaneAt` tests:

```ts
it("splitPaneAtSide：left/up 把新 pane 放在 anchor 前，right/down 放在 anchor 后", () => {
  let state = splitPaneAtSide(
    INITIAL_PANE_LAYOUT,
    V4_PRIMARY_PANE_ID,
    "left",
    bound(SCOPE_A, "sess-left"),
  );
  expect(leafPaneIds(state.root)).toEqual(["pane-1", V4_PRIMARY_PANE_ID]);
  expect(state.root.type === "split" && state.root.direction).toBe("row");
  expect(state.panes["pane-1"]).toEqual(bound(SCOPE_A, "sess-left"));

  state = splitPaneAtSide(INITIAL_PANE_LAYOUT, V4_PRIMARY_PANE_ID, "up", bound(SCOPE_A, "sess-up"));
  expect(leafPaneIds(state.root)).toEqual(["pane-1", V4_PRIMARY_PANE_ID]);
  expect(state.root.type === "split" && state.root.direction).toBe("column");

  state = splitPaneAtSide(
    INITIAL_PANE_LAYOUT,
    V4_PRIMARY_PANE_ID,
    "right",
    bound(SCOPE_A, "sess-right"),
  );
  expect(leafPaneIds(state.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
  expect(state.root.type === "split" && state.root.direction).toBe("row");

  state = splitPaneAtSide(
    INITIAL_PANE_LAYOUT,
    V4_PRIMARY_PANE_ID,
    "down",
    bound(SCOPE_A, "sess-down"),
  );
  expect(leafPaneIds(state.root)).toEqual([V4_PRIMARY_PANE_ID, "pane-1"]);
  expect(state.root.type === "split" && state.root.direction).toBe("column");
});

it("splitPaneAtSide：未知 anchor 或达到上限时 no-op", () => {
  expect(splitPaneAtSide(INITIAL_PANE_LAYOUT, "missing", "right", bound(SCOPE_A, "x"))).toBe(
    INITIAL_PANE_LAYOUT,
  );

  let state = INITIAL_PANE_LAYOUT;
  for (let i = 0; i < MAX_WORKBENCH_PANES - 1; i++) {
    state = splitPaneAtSide(state, V4_PRIMARY_PANE_ID, "right", bound(SCOPE_A, `sess-${i}`));
  }
  expect(countPanes(state)).toBe(MAX_WORKBENCH_PANES);
  expect(splitPaneAtSide(state, V4_PRIMARY_PANE_ID, "right", bound(SCOPE_A, "overflow"))).toBe(
    state,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/v4PaneLayoutStore.test.ts -t "splitPaneAtSide"`

Expected: FAIL because `splitPaneAtSide` is not exported.

- [ ] **Step 3: Implement the helper**

Add:

```ts
export type PaneSplitSide = "left" | "right" | "up" | "down";
```

Add a pure helper that maps side to direction and before/after order:

```ts
export function splitPaneAtSide(
  state: PaneLayoutSnapshot,
  anchorPaneId: string,
  side: PaneSplitSide,
  binding: PaneBinding,
): PaneLayoutSnapshot {
  if (!leafExists(state.root, anchorPaneId) || !canAddPane(state)) {
    return state;
  }
  const newPaneId = allocatePaneId(state.root);
  const anchorLeaf: PaneLayoutNode = { type: "leaf", paneId: anchorPaneId };
  const newLeaf: PaneLayoutNode = { type: "leaf", paneId: newPaneId };
  const before = side === "left" || side === "up";
  const splitNode: PaneLayoutNode = {
    type: "split",
    id: allocateSplitNodeId(state.root),
    direction: side === "left" || side === "right" ? "row" : "column",
    ratio: DEFAULT_SPLIT_RATIO,
    first: before ? newLeaf : anchorLeaf,
    second: before ? anchorLeaf : newLeaf,
  };
  return {
    root: replaceLeaf(state.root, anchorPaneId, splitNode),
    panes: { ...state.panes, [newPaneId]: binding },
    focusedPaneId: newPaneId,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/test/v4PaneLayoutStore.test.ts -t "splitPaneAtSide"`

Expected: PASS.

---

### Task 2: Workbench Group Store

**Files:**

- Create: `packages/ui/src/v4/workbenchGroupStore.ts`
- Test: `packages/ui/test/workbenchGroupStore.test.ts`

**Interfaces:**

- Produces:
  - `buildWorkbenchSessionKey(scope, sessionId): string`
  - `createWorkbenchGroupFromSessions(primary, added, side): WorkbenchGroupState`
  - Zustand store `useWorkbenchGroupStore`
  - Store actions: `openSessionFromSidebar`, `splitSessionIntoGroup`, `focusPane`, `closePane`, `bindPaneSession`, `getActiveContext`
- Consumes Task 1 `splitPaneAtSide`.

- [ ] **Step 1: Write failing store tests**

Create tests for:

```ts
it("creates a group by splitting an ungrouped session around the active single session");
it("clicking a grouped session activates its group and focused pane");
it("rejects duplicate session membership and 4-pane overflow");
it("garbage collects a group when closing leaves one session");
it("persists and restores localStorage state with workspaceIdentity keys");
```

Use local scopes:

```ts
const SCOPE_A = { workspacePath: "/ws/a" };
const SCOPE_B = {
  workspacePath: "/ws/b",
  workspaceIdentity: "remote:ssh:host:/ws/b",
  remoteSessionId: "remote-1",
};
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/ui/test/workbenchGroupStore.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure model and store**

Implement `WorkbenchGroup` with `primaryBinding`, `root`, `panes`, `focusedPaneId`, `updatedAt`. Persist to `zcode-v4-session-workbench-groups:v1`. Sanitize restored groups by requiring at least two valid bound sessions; otherwise drop the group and session index.

Use Chinese comments only where the group GC or restore logic would otherwise be easy to misread.

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm vitest run packages/ui/test/workbenchGroupStore.test.ts packages/ui/test/v4PaneLayoutStore.test.ts`

Expected: PASS.

---

### Task 3: Render Group Layouts in V4WorkspaceChatArea

**Files:**

- Modify: `packages/ui/src/v4/V4WorkspaceChatArea.tsx`
- Modify: `packages/ui/src/v4/WorkbenchPane.tsx`
- Test: `packages/ui/test/workbenchGroupStore.test.ts` or a new focused render test if needed.

**Interfaces:**

- Consumes `useWorkbenchGroupStore.getActiveContext()`.
- `WorkbenchLeafPane` gains optional `primaryBinding` and group-aware callbacks.
- `V4WorkspaceChatArea` gains `onPaneActiveSessionChange?: (scope, sessionId) => void`.

- [ ] **Step 1: Write failing test**

Add a store/render-adjacent test that sets active group A/B, focuses B, and expects active context to be B while primary binding remains A.

- [ ] **Step 2: Verify failure**

Run: `pnpm vitest run packages/ui/test/workbenchGroupStore.test.ts -t "active context"`

Expected: FAIL before group-aware active context exists.

- [ ] **Step 3: Implement group rendering**

In `V4WorkspaceChatArea`, choose the layout source:

```ts
const activeGroup = useWorkbenchGroupStore((state) =>
  selectRenderableActiveGroup(state, {
    workspacePath,
    workspaceIdentity,
    sessionId,
  }),
);
```

If `activeGroup` exists, render its root/panes/focusedPaneId. Pass `primaryBinding` for `workspace-main`. If no group exists, preserve existing shell-driven single/global layout behavior.

In `WorkbenchPane`, compute `scope` and `sessionId` from `primaryBinding` for primary group panes, from `binding` for non-primary, or from shell fallback for old single pane mode.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run packages/ui/test/workbenchGroupStore.test.ts packages/ui/test/v4PaneLayoutStore.test.ts`

Expected: PASS.

---

### Task 4: Sidebar Click and Drag Sources

**Files:**

- Modify: `packages/ui/src/TaskListItem.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/v4/splitPaneEntryContext.tsx` if the enable semantics need a name update.
- Test: `packages/ui/test/taskListItemHoverActions.test.ts` or focused store tests.

**Interfaces:**

- Sidebar drag payload:

```ts
type WorkbenchSessionDragPayload = {
  kind: "zcode/session";
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
};
```

- `handleSelectTaskInChat` first asks group store whether the session belongs to a group; if yes, activate group and focus pane, then call existing `handleSelectTask` for active header/sidebar context.

- [ ] **Step 1: Write failing tests**

Add tests proving:

- grouped session click calls group activation before old select path;
- a task already in any group is not draggable;
- ordinary desktop/web task can produce a drag payload.

- [ ] **Step 2: Verify tests fail**

Run the focused tests.

- [ ] **Step 3: Implement click interception and drag source**

Use `useV4SplitPaneEntryEnabled()` as the coarse client gate, but change the provider enabled expression in `WorkspaceShellLayout` to ordinary desktop/web:

```ts
enabled={!isWebRemoteControlShell && !isWebRemoteControlMobileViewport}
```

Add `draggable={canDragSessionToWorkbench}` and `onDragStart` to `TaskListItem`. Do not show drag affordance when `useWorkbenchGroupStore` says the session is already grouped.

- [ ] **Step 4: Run focused tests**

Run the same focused tests and ensure PASS.

---

### Task 5: Workbench Drop Zones and Preview

**Files:**

- Modify: `packages/ui/src/v4/WorkbenchPane.tsx`
- Modify: `packages/ui/src/v4/V4WorkspaceChatArea.tsx`
- Create if useful: `packages/ui/src/v4/workbenchDragDrop.ts`
- Test: `packages/ui/test/workbenchGroupStore.test.ts` plus any pure drop-zone helper tests.

**Interfaces:**

- Pure helper `resolveWorkbenchDropSide(rect, clientX, clientY): PaneSplitSide | null`.
- Center returns `null`; edge zones return `"left" | "right" | "up" | "down"`.

- [ ] **Step 1: Write failing helper tests**

Test left/right/up/down/center geometry using a fixed rect.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/ui/test/workbenchDragDrop.test.ts`

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helper and drop UI**

Use native `onDragOver`, `onDragLeave`, and `onDrop` on each `ChatPaneShell`. Only call `event.preventDefault()` when the payload is valid, the group is not full, the session is not duplicate, and `resolveWorkbenchDropSide` returns a side.

Render an absolutely positioned overlay inside the pane:

```tsx
<div className="pointer-events-none absolute inset-y-0 right-0 w-1/2 border border-brand/60 bg-brand/12" />
```

Use corresponding classes for top/bottom/left. Keep it token-based and theme-safe.

- [ ] **Step 4: Run focused tests**

Run helper tests and group store tests.

Expected: PASS.

---

### Task 6: Active Context and Persistence Wiring

**Files:**

- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
- Modify: `packages/ui/src/v4/V4WorkspaceChatArea.tsx`
- Modify: `packages/ui/src/v4/WorkbenchPane.tsx`
- Test: store/focused tests.

**Interfaces:**

- `onPaneActiveSessionChange(scope, sessionId)` from pane focus calls existing `handleSelectTaskInChat(scope.workspacePath, sessionId, scope.workspaceIdentity)`.
- `bindPaneSession` updates group membership when fork/create changes a pane session.

- [ ] **Step 1: Write failing tests**

Add tests for:

- focus grouped B returns B active context;
- binding a pane from old session to new session updates `sessionIndex`;
- closing a pane removes session index and GC's group if only one remains.

- [ ] **Step 2: Verify tests fail**

Run group store tests.

- [ ] **Step 3: Implement active context callbacks**

When group pane receives focus, update group focus and notify shell of the session. Ensure callback no-ops if the focused pane has no session. Keep the existing draft/single pane behavior unchanged.

- [ ] **Step 4: Run focused tests**

Run group store and pane layout tests.

Expected: PASS.

---

### Task 7: Verification and Commit

**Files:**

- All touched implementation and test files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run packages/ui/test/workbenchGroupStore.test.ts packages/ui/test/workbenchDragDrop.test.ts packages/ui/test/v4PaneLayoutStore.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run mandatory project checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both PASS. If `ConversationHeader.tsx` user change causes an unrelated focused test failure, do not revert it; report separately.

- [ ] **Step 3: Inspect git status**

Run: `git status --short`

Expected: only intended files staged/modified plus any pre-existing user change left unstaged.

- [ ] **Step 4: Commit implementation**

Commit message:

```bash
git commit -m "feat: add session workbench groups"
```

---

## Self-Review

- Spec coverage: Tasks cover directional drop zones, cross-workspace session scope, duplicate guard, 4-pane limit, group click restore, renderer-local persistence, and mobile/web-remote gating.
- Placeholder scan: No TBD/TODO steps; each code-facing task has concrete interfaces and expected commands.
- Type consistency: `PaneSplitSide`, `WorkbenchGroup`, `PaneBinding`, and session key definitions are consistent across tasks.
