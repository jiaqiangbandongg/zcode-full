# Docker Container Select Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Docker running containers when the Docker container dropdown opens and align the chooser UI with the project's Popover + Command dropdown pattern.

**Architecture:** Keep Docker API access in `useRemoteConnectionForm`. Add a small helper for Docker option loading, then pass a refresh callback through `SSHDialog` -> `RemoteConnectionSettingsStep` -> `RemoteConnectionFields`. `RemoteConnectionFields` reacts to Popover open state and renders Docker container choices with Command rows. The dropdown selection and manual container input stay as separate state values; connection target creation prefers manual input when it is non-empty.

**Tech Stack:** React, TypeScript, Vitest, existing UI Popover and Command primitives.

---

### Task 1: Tests

**Files:**
- Create: `packages/ui/test/remoteConnectionDockerOptions.test.ts`
- Modify: `packages/ui/test/remoteConnectionFieldsDockerRefresh.test.ts`

- [ ] **Step 1: Write helper tests**

Cover Docker available, Docker unavailable, API failure cases, and selected-container reconciliation for the helper that loads runtime Docker options.

- [ ] **Step 2: Write Select-open test**

Mock `@/components/ui/popover.js`, render `RemoteConnectionFields` in Docker mode, and assert the refresh callback runs only when `onOpenChange(true)` is invoked.

- [ ] **Step 3: Run red tests**

Run: `pnpm exec vitest run packages/ui/test/remoteConnectionDockerOptions.test.ts packages/ui/test/remoteConnectionFieldsDockerRefresh.test.ts`

Expected: fail because the helper module and select-open callback are not implemented yet.

### Task 2: Implementation

**Files:**
- Create: `packages/ui/src/lib/remoteConnectionDockerOptions.ts`
- Modify: `packages/ui/src/hooks/useRemoteConnectionForm.ts`
- Modify: `packages/ui/src/RemoteConnectionFields.tsx`
- Modify: `packages/ui/src/RemoteConnectionDialogContent.tsx`
- Modify: `packages/ui/src/SSHDialog.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

- [ ] **Step 1: Add Docker option loader**

Create a helper that calls `isDockerAvailable()`, conditionally calls `listDockerContainers()`, and returns `{ dockerAvailable, dockerContainers, error }`.

- [ ] **Step 2: Add refresh callback in hook**

Use the helper from `useRemoteConnectionForm`, guard concurrent refreshes with a ref, clear stale selected containers after successful refreshes, and preserve existing containers on dropdown refresh failure.

- [ ] **Step 3: Wire callback through UI props**

Pass `refreshDockerContainers` from `SSHDialog` through `RemoteConnectionSettingsStep` to `RemoteConnectionFields`.

- [ ] **Step 4: Refresh on Popover open**

Set Docker Popover `onOpenChange` to call the refresh callback only for `true`.

- [ ] **Step 5: Render loading and empty states**

Use a spinner row while `runtimeOptionsLoading` is true. When the refreshed container list is empty, show a short grey localized hint that no running containers were detected.

- [ ] **Step 6: Restore independent manual Docker input**

Render a separate manual `Container` input below the chooser for incomplete Docker lists or unavailable Docker detection. Do not sync it with dropdown selection. Use manual input for connection when non-empty, otherwise use the dropdown selection.

### Task 3: Verification

**Files:**
- All modified files.

- [ ] **Step 1: Run targeted tests**

Run: `pnpm exec vitest run packages/ui/test/remoteConnectionDockerOptions.test.ts packages/ui/test/remoteConnectionFieldsDockerRefresh.test.ts`

- [ ] **Step 2: Run required checks**

Run: `pnpm typecheck`

Run: `pnpm lint`

- [ ] **Step 3: Commit**

Commit with Conventional Commits, for example: `fix(ui): refresh docker containers when opening selector`.
