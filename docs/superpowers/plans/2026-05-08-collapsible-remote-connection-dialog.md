# Collapsible Remote connection Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the SSH/Docker remote connection wizard be minimized without cancelling the ongoing connection, and expose a connecting indicator from both the chat sidebar and open-workspace page.

**Architecture:** Keep the remote connection wizard mounted at the `RootInner` layer so navigation between chat and `ProjectSelector` does not destroy wizard state. Add explicit minimize/resume semantics to `SSHDialog`, and pass a derived `remoteConnectionInProgress` flag to the sidebar and project selector buttons.

**Tech Stack:** React 19, Zustand tab store, Vitest, TypeScript, Tailwind semantic tokens, existing `Dialog` and `Button` primitives.

---

### Task 1: Add Pure State Semantics Test

**Files:**
- Create: `packages/ui/src/lib/remoteConnectionDialogState.ts`
- Test: `packages/ui/test/remoteConnectionDialogState.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  getRemoteConnectionDialogResumeStep,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
  type RemoteConnectionDialogSnapshot,
} from "../src/lib/remoteConnectionDialogState.js";

const baseSnapshot: RemoteConnectionDialogSnapshot = {
  currentStep: "kind",
  loading: false,
  connectedSessionId: null,
};

describe("remoteConnectionDialogState", () => {
  it("keeps minimized connecting flow active and resumes the connecting step", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: true,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(false);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("connecting");
  });

  it("keeps connected directory selection active after minimizing", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "directory",
      connectedSessionId: "session-1",
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(true);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(false);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("directory");
  });

  it("resets idle or failed flow when opened again", () => {
    const snapshot: RemoteConnectionDialogSnapshot = {
      ...baseSnapshot,
      currentStep: "connecting",
      loading: false,
      connectedSessionId: null,
    };

    expect(isRemoteConnectionFlowActive(snapshot)).toBe(false);
    expect(shouldResetRemoteConnectionOnOpen(snapshot)).toBe(true);
    expect(getRemoteConnectionDialogResumeStep(snapshot)).toBe("kind");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/remoteConnectionDialogState.test.ts`
Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement helper**

```ts
import type { RemoteWizardStep } from "@/RemoteConnectionWizardChrome.js";

export interface RemoteConnectionDialogSnapshot {
  currentStep: RemoteWizardStep;
  loading: boolean;
  connectedSessionId: string | null;
}

export function isRemoteConnectionFlowActive(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return snapshot.loading || Boolean(snapshot.connectedSessionId);
}

export function shouldResetRemoteConnectionOnOpen(
  snapshot: RemoteConnectionDialogSnapshot,
): boolean {
  return !isRemoteConnectionFlowActive(snapshot);
}

export function getRemoteConnectionDialogResumeStep(
  snapshot: RemoteConnectionDialogSnapshot,
): RemoteWizardStep {
  if (isRemoteConnectionFlowActive(snapshot)) {
    return snapshot.currentStep;
  }
  return "kind";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/test/remoteConnectionDialogState.test.ts`
Expected: PASS.

### Task 2: Make SSHDialog Minimize-Aware

**Files:**
- Modify: `packages/ui/src/SSHDialog.tsx`
- Modify: `packages/ui/src/RemoteConnectionWizardChrome.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

- [ ] Add `onFlowActiveChange?: (active: boolean) => void`, `minimizeOnly?: boolean`, and controlled `open` support for the global instance.
- [ ] Replace open-trigger reset logic with `shouldResetRemoteConnectionOnOpen` so active flows resume their current step.
- [ ] Add a minimize button in the header when the flow is active. Minimize calls `applyOpenState(false)` only and does not call `closeDialog()`.
- [ ] Keep close button behavior unchanged: it asks for confirmation and cancels/cleans up if confirmed.
- [ ] Add Chinese comments beside the minimize/close split explaining the bug cause and fix.

### Task 3: Mount One Global Dialog From Root

**Files:**
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/ui/src/root/RootWorkspaceContent.tsx`
- Modify: `packages/ui/src/app-shell/types.ts`
- Modify: `packages/ui/src/App.tsx`
- Modify: `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`

- [ ] Hold `remoteConnectionDialogOpen` and `remoteConnectionInProgress` in `RootInner`.
- [ ] Render one hidden-trigger `SSHDialog` in `RootShell`, passing root handlers.
- [ ] Pass `openRemoteConnectionDialog` and `remoteConnectionInProgress` through workspace props.
- [ ] Ensure ProjectSelector also receives these props.

### Task 4: Add Entry Indicators

**Files:**
- Modify: `packages/ui/src/ProjectSelector.tsx`
- Modify: `packages/ui/src/WorkspaceSidebar.tsx`

- [ ] Replace the ProjectSelector inline `SSHDialog` with a button that opens the global dialog.
- [ ] Add a spinner and `projectSelector.remoteConnecting` text to ProjectSelector remote button while active.
- [ ] Add the same indicator to the sidebar `workspace.openWorkspace` button while active.
- [ ] Use semantic text tokens and existing button density.

### Task 5: Docs and Verification

**Files:**
- Create: `docs/collapsible-remote-connection-dialog.md`

- [ ] Document the global mounting decision, minimize semantics, and two indicator locations.
- [ ] Run `pnpm vitest run packages/ui/test/remoteConnectionDialogState.test.ts`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
