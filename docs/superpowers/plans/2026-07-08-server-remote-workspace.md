# Server Remote Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a Desktop remote workspace target that connects to an already running ZCode HTTP/WebSocket server and manages its workspace with the existing App UI.

**Architecture:** Extend the shared remote target model with `kind: "server"`, then route Desktop remote session creation through the existing utility host process. The host process uses a Node WebSocket connector to the server `/ws` ChannelServer, wraps it as `RemoteServiceAccess`, exposes it through the existing MessagePort path, and keeps Desktop as `desktop-continuous`.

**Tech Stack:** TypeScript, Electron utilityProcess, `ws`, `@zcode/rpc` `SocketProtocol`, `@zcode/client` `RemoteServiceAccess`, existing `ServiceCollection` and Remote Connection dialog.

## Global Constraints

- Spec lives in `docs/remote/server-remote-workspace-connection.md` and must stay aligned with implementation.
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` remains the identity rule.
- Server remote must not start a local or nested remote Agent runtime.
- Desktop server remote uses `deliveryKind = continuous`; mobile `/remote` remains `web-remote-replayable`.
- UI changes must follow `DESIGN.md`, support light/dark themes, i18n, desktop and mobile-web-safe responsive layout.
- Run `pnpm typecheck` and `pnpm lint` before final completion.

---

### Task 1: Shared Server Target Contract

**Files:**
- Modify: `packages/shared/src/remoteTarget.ts`
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/shared/src/platform.ts`
- Modify: `packages/shared/src/remote-workspace-identity.ts`
- Test: `packages/shared/test/serverRemoteTarget.test.ts`

**Interfaces:**
- Produces: `ServerConnectOptions`, `ServerRemoteTargetSnapshot`, `buildServerRemoteWorkspaceIdentity(params)`, `parseRemoteWorkspaceIdentity()` support for `server`.
- Consumes: existing `remoteTargetSchema`, `remoteTargetSchema` users.

- [x] **Step 1: Write failing tests**

Create `packages/shared/test/serverRemoteTarget.test.ts` covering schema acceptance, snapshot typing helper behavior through runtime schemas, and server identity parse/build.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/shared/test/serverRemoteTarget.test.ts`
Expected: FAIL because `server` target and identity builder do not exist.

- [x] **Step 3: Implement shared types and schemas**

Add `ServerConnectOptions`, include it in `RemoteTarget`, add `serverConnectOptionsSchema`, include it in `remoteTargetSchema`, add server snapshot type, update `OpenInEditorRemoteTarget` only if needed by type exhaustiveness, and update remote identity parser/build helper.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run packages/shared/test/serverRemoteTarget.test.ts`
Expected: PASS.

### Task 2: HTTP Server Bootstrap Info

**Files:**
- Modify: `packages/server/src/http.ts`
- Test: `packages/server/test/serverInfoHttp.test.ts`

**Interfaces:**
- Produces: `GET /api/server-info` with `{ serverId, version, protocolVersion, authRequired, workspaces }`.
- Consumes: remote server connector in Task 3.

- [x] **Step 1: Write failing test**

Add a server HTTP test that creates `createHttpServer(...)`, fetches `/api/server-info`, and asserts stable fields exist.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/server/test/serverInfoHttp.test.ts`
Expected: FAIL with 404.

- [x] **Step 3: Implement endpoint**

Add `app.get("/api/server-info", ...)` returning a minimal JSON body. Use a deterministic server id derived from host/user/home path or a generated process-local fallback only if no stable source exists. Keep workspaces empty for MVP.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run packages/server/test/serverInfoHttp.test.ts`
Expected: PASS.

### Task 3: Desktop Host Server Connector

**Files:**
- Create: `packages/desktop/src/host/serverRemoteConnection.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Test: `packages/desktop/test/serverRemoteConnection.test.ts`

**Interfaces:**
- Consumes: `RemoteTarget` kind `server`, server `/api/server-info`, server `/ws`.
- Produces: `connectServerRemote(target, onDidClose)` returning `{ services, dispose, serverInfo }`.

- [x] **Step 1: Write failing connector tests**

Test URL normalization (`http -> ws`, `https -> wss`, explicit `/ws` preserved), Authorization header redaction boundary, and that a mock WebSocket ChannelServer can answer a proxied service call.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/desktop/test/serverRemoteConnection.test.ts`
Expected: FAIL because module is missing.

- [x] **Step 3: Implement connector**

Use `ws`, `SocketProtocol`, `ChannelClient`, and `RemoteServiceAccess`. Add a Node `ISocket` wrapper mirroring `packages/server/src/http.ts`. Fetch `/api/server-info` before WS. Pass bearer token if `target.token` exists. Dispose WS on host dispose.

- [x] **Step 4: Wire host**

In `packages/desktop/src/host/index.ts`, when `InitRemoteWorkspace` has `target.kind === "server"`, call `connectServerRemote()` instead of `setupRemoteConnection()`. Use a server-specific service collection strategy that treats remote workspace services as authoritative for runtime/workspace services while keeping local Desktop platform-only services local where existing service contracts require local implementation.

- [x] **Step 5: Run GREEN**

Run: `pnpm vitest run packages/desktop/test/serverRemoteConnection.test.ts`
Expected: PASS.

### Task 4: Desktop Remote Session Lifecycle

**Files:**
- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`
- Test: `packages/desktop/test/serverRemoteSessionManager.test.ts`

**Interfaces:**
- Consumes: shared `RemoteTarget` kind `server`.
- Produces: server target labels, target equality, duplicate detection, remote session creation without remote asset deployment assumptions.

- [x] **Step 1: Write failing tests**

Assert server targets compare by normalized URL and workspace context, process label is sanitized from hostname/name, and `InitRemoteWorkspace` accepts server target.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/desktop/test/serverRemoteSessionManager.test.ts`
Expected: FAIL because server branch is missing.

- [x] **Step 3: Implement lifecycle support**

Add server branches in `getRemoteTargetProcessSuffix()`, `isSameRemoteTarget()`, logging labels, and host init typing. Keep `taskRealtime` as Desktop continuous/relay_bridge behavior equivalent to non-WSL remote unless tests show it should be omitted.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run packages/desktop/test/serverRemoteSessionManager.test.ts`
Expected: PASS.

### Task 5: UI Remote Connection Dialog

**Files:**
- Modify: `packages/ui/src/lib/remoteConnectionWizard.ts`
- Modify: `packages/ui/src/RemoteConnectionDialogContent.tsx`
- Modify: `packages/ui/src/RemoteConnectionFields.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Test: `packages/ui/test/remoteConnectionWizard.test.ts`
- Test: update nearby remote connection rendering tests if snapshots/types require it.

**Interfaces:**
- Produces: `Server` option in remote kind step and `buildRemoteTarget()` output `{ kind: "server", url, token?, workspacePath?, name? }`.
- Consumes: shared `RemoteTarget` kind `server`.

- [x] **Step 1: Write failing wizard tests**

Test server URL required, invalid URL rejected, valid URL trims and returns server target, token remains optional.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/ui/test/remoteConnectionWizard.test.ts`
Expected: FAIL because server fields do not exist.

- [x] **Step 3: Implement UI state and fields**

Add compact Server form fields using existing input/button primitives and i18n strings. Keep cards/panels consistent with `DESIGN.md`; no raw colors.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run packages/ui/test/remoteConnectionWizard.test.ts`
Expected: PASS.

### Task 6: Persistence and Reconnect

**Files:**
- Modify: `packages/shared/src/validationAppSettings.ts`
- Modify: `packages/ui/src/root/reconnectRemoteWorkspaceHistoryEntry.ts`
- Modify: `packages/ui/src/root/useRemoteWorkspaceHistory.ts`
- Modify: `packages/ui/src/remote-connection/sshHistorySuggestions.ts` or create server equivalent only if needed.
- Test: `packages/ui/test/useRemoteWorkspaceHistory.test.ts`

**Interfaces:**
- Consumes: `ServerRemoteTargetSnapshot`.
- Produces: persisted server target history and reconnect using stored target and workspace identity.

- [x] **Step 1: Write failing persistence tests**

Add a remote workspace entry with `target.kind = "server"` and assert reconnect passes the target through unchanged and workspace identity is preserved.

- [x] **Step 2: Run RED**

Run: `pnpm vitest run packages/ui/test/useRemoteWorkspaceHistory.test.ts --runInBand`
Expected: FAIL because schemas/types reject server target.

- [x] **Step 3: Implement persistence support**

Add server target snapshot schema and update formatting helpers so history/reconnect labels do not assume SSH/WSL/Docker only.

- [x] **Step 4: Run GREEN**

Run: `pnpm vitest run packages/ui/test/useRemoteWorkspaceHistory.test.ts --runInBand`
Expected: PASS.

### Task 7: Full Verification and Commit

**Files:**
- Modify: docs/spec if implementation changed decisions.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: committed feature branch.

- [x] **Step 1: Run focused tests**

Run all tests introduced or modified in Tasks 1-6.

- [x] **Step 2: Run required repository checks**

Run: `pnpm typecheck` and `pnpm lint`.

- [x] **Step 3: Inspect diff**

Run: `git diff --stat` and `git diff --check`.

- [x] **Step 4: Commit**

Commit with Conventional Commit message, for example `feat: add server remote workspace target`.
