# Feedback Base Service Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep feedback submission available when an SSH workspace session is connecting or disconnected by wiring `FeedbackHost` to the renderer's base feedback service.

**Architecture:** `Root` remains the authority for the startup/base `IServiceAccessor` and passes its `feedbackService` explicitly through `RootWorkspaceContent` into `App`. Workspace-scoped services continue to drive file, task, terminal, Git, Agent, and session behavior; the disconnected remote proxy remains unchanged.

**Tech Stack:** TypeScript, React, Vitest, Electron renderer service accessors.

## Global Constraints

- Update the spec before implementation; the approved design is `docs/superpowers/specs/2026-07-12-feedback-base-service-boundary-design.md`.
- Do not modify the `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` proxy or allow remote workspace calls to fall back to local file/task services.
- Preserve desktop `desktop-continuous` and mobile `web-remote-replayable` boundaries.
- Keep Web remote feedback unsupported; pass through the feedback service already supplied by the Web root accessor.
- Preserve macOS, Windows, Linux, light/dark themes, and internationalization behavior; this change introduces no visual or copy changes.
- Bug-cause comments must be written in Chinese.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Lock the feedback service wiring with a regression test

**Files:**
- Create: `packages/ui/test/feedbackBaseServiceBoundary.test.ts`

**Interfaces:**
- Consumes: `RootProps.services: IServiceAccessor`, `RootWorkspaceContent`, `App`, and `FeedbackHost`.
- Produces: a source-level boundary guard that fails until the base feedback service is passed independently of workspace-scoped services.

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(path, "utf8");
}

describe("feedback base service boundary", () => {
  it("keeps feedback on the base service when workspace services are disconnected", () => {
    const rootSource = readSource("packages/ui/src/Root.tsx");
    const rootWorkspaceContentSource = readSource(
      "packages/ui/src/root/RootWorkspaceContent.tsx",
    );
    const appSource = readSource("packages/ui/src/App.tsx");

    expect(rootSource).toContain(
      "baseFeedbackService={services.feedbackService}",
    );
    expect(rootWorkspaceContentSource).toContain(
      "baseFeedbackService={baseFeedbackService}",
    );
    expect(appSource).toContain(
      "<FeedbackHost feedbackService={baseFeedbackService} platform={platform} />",
    );
    expect(appSource).not.toContain(
      "<FeedbackHost feedbackService={services?.feedbackService} platform={platform} />",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the current bug**

Run: `pnpm exec vitest run packages/ui/test/feedbackBaseServiceBoundary.test.ts --reporter=dot`

Expected: FAIL because `Root` does not yet pass `baseFeedbackService` and `App` still renders `FeedbackHost` with `services?.feedbackService`.

### Task 2: Explicitly inject the base feedback service

**Files:**
- Modify: `packages/ui/src/app-shell/types.ts`
- Modify: `packages/ui/src/root/RootWorkspaceContent.tsx`
- Modify: `packages/ui/src/Root.tsx`
- Modify: `packages/ui/src/App.tsx`
- Test: `packages/ui/test/feedbackBaseServiceBoundary.test.ts`

**Interfaces:**
- Consumes: `IFeedbackService` from `@zcode/services` and `RootProps.services.feedbackService`.
- Produces: required `AppProps.baseFeedbackService: IFeedbackService`; `WorkspaceShellLayoutProps` excludes that application-level dependency.

- [ ] **Step 1: Add the typed application-level dependency**

Change the service type import and props in `packages/ui/src/app-shell/types.ts`:

```ts
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";

export interface AppProps {
  services: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
}

export interface WorkspaceShellLayoutProps extends Omit<AppProps, "baseFeedbackService"> {
}
```

Insert `baseFeedbackService` immediately after `services`. Replace only the `extends AppProps` clause on `WorkspaceShellLayoutProps`; do not copy or remove its current members.

- [ ] **Step 2: Thread the dependency through `RootWorkspaceContent`**

Update the type import, prop declaration, destructuring, and `StableWorkspaceApp` invocation in `packages/ui/src/root/RootWorkspaceContent.tsx`:

```ts
import type { IFeedbackService, IServiceAccessor } from "@zcode/services";

interface RootWorkspaceContentProps {
  workspaceScopedServices: IServiceAccessor;
  baseFeedbackService: IFeedbackService;
}

export function RootWorkspaceContent({
  workspaceScopedServices,
  baseFeedbackService,
}: RootWorkspaceContentProps) {
}

<StableWorkspaceApp
  services={workspaceScopedServices}
  baseFeedbackService={baseFeedbackService}
/>
```

Add the interface member after `workspaceScopedServices`, add the destructured parameter after the same field, and add the JSX prop immediately after `services`. Preserve all other current parameters and JSX props.

- [ ] **Step 3: Pass the startup/base service from `Root`**

Add the prop at the existing `RootWorkspaceContent` call in `packages/ui/src/Root.tsx`:

```tsx
<RootWorkspaceContent
  workspaceScopedServices={workspaceScopedServices}
  baseFeedbackService={services.feedbackService}
/>
```

Insert the new prop immediately after `workspaceScopedServices`; preserve the remaining call-site props.

- [ ] **Step 4: Make `FeedbackHost` use only the explicit base dependency**

Update `App` destructuring and the feedback host in `packages/ui/src/App.tsx`:

```tsx
export function App({
  services,
  baseFeedbackService,
}: AppProps) {
  return (
    <>
      {/* Bugfix: 反馈是应用级能力，必须固定走本机 base host；SSH session 连接中或断开时，
          workspace-scoped services 会切成断连代理，不能让反馈提交跟随远程 session 失效。 */}
      <FeedbackHost feedbackService={baseFeedbackService} platform={platform} />
    </>
  );
}
```

Add the destructured prop after `services`. Replace the current one-line `FeedbackHost` expression with the Chinese cause comment and the new expression; preserve the surrounding command center and workspace shell JSX.

- [ ] **Step 5: Run the focused test to verify it passes**

Run: `pnpm exec vitest run packages/ui/test/feedbackBaseServiceBoundary.test.ts --reporter=dot`

Expected: PASS with 1 test passed.

- [ ] **Step 6: Run related feedback and workspace service tests**

Run: `pnpm exec vitest run packages/ui/test/feedbackSubmitForm.test.ts packages/ui/test/feedbackCenter.test.ts packages/ui/test/useWorkspaceServices.test.ts --reporter=dot`

Expected: PASS with no failures. This verifies existing feedback submission behavior and confirms the remote disconnected proxy remains protected.

- [ ] **Step 7: Commit the implementation**

```bash
git add packages/ui/src/app-shell/types.ts packages/ui/src/root/RootWorkspaceContent.tsx packages/ui/src/Root.tsx packages/ui/src/App.tsx packages/ui/test/feedbackBaseServiceBoundary.test.ts
git commit -m "fix(feedback): keep submissions on base service"
```

### Task 3: Complete repository verification

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: the implementation commit from Task 2.
- Produces: fresh test, typecheck, lint, and diff evidence for handoff.

- [ ] **Step 1: Run the focused regression test again**

Run: `pnpm exec vitest run packages/ui/test/feedbackBaseServiceBoundary.test.ts --reporter=dot`

Expected: PASS with 1 test passed.

- [ ] **Step 2: Run TypeScript project checks**

Run: `pnpm typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`

Expected: exit code 0 with no lint errors.

- [ ] **Step 4: Inspect the final change set**

Run: `git status --short && git log -3 --oneline && git show --stat --oneline HEAD`

Expected: clean worktree; the latest implementation commit contains only the four UI source files and the regression test, while the preceding documentation commits contain the approved spec and this plan.
