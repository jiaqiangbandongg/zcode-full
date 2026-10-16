# Mobile Remote Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show disconnected SSH workspaces in the mobile Web remote-control task home and let the phone trigger the same reconnect path as the desktop sidebar.

**Architecture:** Desktop renderer remains the owner of remote reconnect because it already owns credentials, remote session registration, provider sync, and tab mutation. The mobile page sends a relay app payload to desktop main; main forwards the reconnect request to the renderer and returns the renderer result to mobile. Workspace list sync includes disconnected remote tabs with explicit connection state so mobile can render reconnect affordances without attempting a bridge.

**Tech Stack:** TypeScript, React, Electron IPC, existing Web remote-control relay app payloads, Zustand stores, Vitest.

---

### Task 1: Shared Protocol And Validation

**Files:**
- Modify: `packages/shared/src/web-remote-control.ts`
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/shared/src/platform.ts`
- Modify: `packages/shared/src/channels.ts`
- Test: `packages/shared/test/webRemoteControl.test.ts`

- [ ] Add failing shared tests for `connectionState`, reconnect request, reconnect response, and renderer IPC payload schemas.
- [ ] Add `connectionState?: "connected" | "disconnected" | "reconnecting"` and `lastConnectionError?: string` to `WebRemoteControlWorkspaceTarget`.
- [ ] Add relay payloads `workspace-reconnect-request` and `workspace-reconnect-response`.
- [ ] Add platform IPC types for main-to-renderer reconnect request/result.
- [ ] Run the shared tests and confirm they pass.

### Task 2: Desktop Renderer Reconnect Bridge

**Files:**
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/renderer/src/main.tsx`
- Modify: `packages/ui/src/root/useRemoteWorkspaceHistory.ts`
- Modify: `packages/ui/src/root/useRootPlatformEffects.ts`
- Test: `packages/ui/test/useRemoteWorkspaceHistory.test.ts`

- [ ] Add failing UI tests that a Web remote reconnect request calls the existing reconnect helper without forcing desktop activation or toast.
- [ ] Expose `onWebRemoteControlReconnectWorkspace` on `IPlatformService` and preload.
- [ ] In Root, register the platform callback and call `handleReconnectRemoteWorkspace(workspaceKey, { activateWorkspaceBeforeReconnect: false, showErrorToast: false })`.
- [ ] Sync disconnected remote tabs to Web remote workspace list, including `connectionState` and error state.
- [ ] Run focused UI tests and confirm they pass.

### Task 3: Desktop Main Relay Routing

**Files:**
- Modify: `packages/desktop/src/main/webRemoteControlManager.ts`
- Modify: `packages/desktop/src/main/desktopMainIpcPlatform.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`

- [ ] Add failing manager tests for forwarding `workspace-reconnect-request` to renderer and returning success/error payloads.
- [ ] Add manager dependency `reconnectWorkspace(windowId, workspaceKey)`.
- [ ] Handle `workspace-reconnect-request` by forwarding to renderer and responding with `workspace-reconnect-response`.
- [ ] Ensure connected-only bridge filtering remains unchanged: disconnected remote workspaces can list/reconnect but cannot bridge until reconnect succeeds.
- [ ] Run focused desktop tests and confirm they pass.

### Task 4: Mobile Task Home UI And Switcher

**Files:**
- Modify: `packages/web/src/main.tsx`
- Modify: `packages/ui/src/root/types.ts`
- Modify: `packages/ui/src/WebRemoteControlMobileTaskHome.tsx`
- Modify: `packages/ui/src/lib/webRemoteControlMobileTaskHome.ts`
- Test: `packages/ui/test/webRemoteControlMobileTaskHome.test.tsx` or nearest existing task-home tests

- [ ] Add failing UI/model tests that disconnected SSH workspaces render in the mobile list with a reconnect button and do not attempt bridge when opening a task before reconnect.
- [ ] Add `reconnectWorkspace(workspaceKey)` to the mobile switcher API.
- [ ] Implement mobile relay requester for reconnect request/response.
- [ ] Render reconnect button with loading/error states using existing Button variants and i18n strings.
- [ ] Run focused UI/web tests and confirm they pass.

### Task 5: Verification

**Files:**
- Modify docs only if behavior needs a short implementation note under `docs/web-remote-control/`.

- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Run focused tests for shared, desktop manager, and UI task home.
- [ ] Summarize changed files and remaining limitations.
