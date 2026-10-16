# Window-scoped WSL Host Pooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WSL workspaces in the same Electron window, distro, and Linux user share one Remote Host and `zcode-server`, while releasing unused workspace runtimes and deterministically disposing the pool after a 60-second idle TTL or immediately during owner teardown.

**Architecture:** Desktop Main owns a window-scoped WSL pool and keeps logical `remoteSessionId` attachments separate from the shared Host process. The Host exposes its existing remote service collection on multiple ports, accepts workspace-release control messages, and reports workspace task activity so Main never expires a pool with a running task. WSL remains `desktop-continuous`; Docker remains dedicated and SSH keeps its existing pool policy.

**Tech Stack:** TypeScript, Electron UtilityProcess/MessagePort, Zod internal message schemas, Vitest fake timers, pnpm/oxlint.

## Global Constraints

- Pool identity is `(windowWebContentsId, normalized requested distro/default sentinel, normalized requested user/default sentinel)` for the current implementation; one key may own at most one live Host.
- Each logical workspace retains its own `remoteSessionId`, `attachmentId`, `workspacePath`, and optional `workspaceIdentity`.
- All workspace isolation uses `workspaceIdentity?.trim() || workspacePath`; filesystem execution continues to use `workspacePath`.
- WSL desktop attachments remain `desktop-continuous` and must not register `relay_bridge`.
- Pool idle TTL is exactly `60_000` ms; real window close, App quit, and update shutdown bypass it.
- A running workspace task prevents workspace runtime release and pool expiry; owner teardown may force bounded shutdown.
- No `wsl --terminate`, `wsl --shutdown`, process-name scanning, or Docker pooling.
- Every behavior change follows test-first RED → GREEN → refactor.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Define shared WSL Host lifecycle messages

**Files:**
- Modify: `packages/shared/src/channels.ts`
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`
- Test: `packages/shared/test/validation.test.ts`

**Interfaces:**
- Produces: `HostMessageTypes.InitRemoteWslHost` with a WSL target and no initial service port.
- Produces: `HostMessageTypes.ReleaseRemoteWorkspace` carrying `workspacePath` and optional `workspaceIdentity`.
- Produces: `HostResponseTypes.WorkspaceRunningTaskCountChanged` carrying workspace context and a non-negative count.

- [ ] **Step 1: Write failing schema tests**

Add assertions that `hostMessageSchema` accepts:

```ts
{
  type: HostMessageTypes.InitRemoteWslHost,
  target: { kind: "wsl", distro: "Ubuntu", user: "zcode" },
  remoteAssets,
}
```

and:

```ts
{
  type: HostMessageTypes.ReleaseRemoteWorkspace,
  workspacePath: "/work/a",
  workspaceIdentity: "remote:wsl:a",
}
```

Add a response-schema assertion for:

```ts
{
  type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
  workspacePath: "/work/a",
  workspaceIdentity: "remote:wsl:a",
  runningTaskCount: 0,
}
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `pnpm vitest run packages/shared/test/validation.test.ts`

Expected: FAIL because the three message constants/schemas do not exist.

- [ ] **Step 3: Add strict schemas and Host init typing**

Add distinct message constants and Zod schemas. Extend `HostInitMessage` with:

```ts
{
  type: typeof HostMessageTypes.InitRemoteWslHost;
  target: Extract<RemoteTarget, { kind: "wsl" }>;
  remoteAssets: RemoteAssetDirs;
  hostId?: string;
  deliveryKind?: TaskRealtimeHostDeliveryKind;
}
```

Do not widen `InitRemoteSshHost` to WSL; the two modes have different realtime behavior.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run: `pnpm vitest run packages/shared/test/validation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/shared/src/channels.ts packages/shared/src/validation.ts packages/shared/test/validation.test.ts packages/desktop/src/main/desktopHostProcess.ts
git commit -m "feat(remote): define shared WSL host lifecycle messages"
```

### Task 2: Implement real workspace runtime release and task activity reporting

**Files:**
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/desktop/src/main/desktopHostProcess.ts`
- Test: `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`
- Test: `packages/desktop/test/desktopHostProcess.test.ts`

**Interfaces:**
- Consumes: `ReleaseRemoteWorkspace` and `WorkspaceRunningTaskCountChanged` from Task 1.
- Produces: `releaseWorkspacePreparation(params): Promise<void>` delegating to `IZCodeAgentService.disposeWorkspace()`.
- Produces: optional `onWorkspaceRunningTaskCountChanged(process, event)` callback from `spawnHostProcess` dependencies.

- [ ] **Step 1: Write a failing adapter test**

Construct the adapter with a mocked `zcodeAgentService.disposeWorkspace` and call:

```ts
await service.releaseWorkspacePreparation({
  workspacePath: "/work/a",
  workspaceIdentity: "remote:wsl:a",
  provider: "zcode",
});
```

Assert one call with normalized workspace path/identity and no provider field.

- [ ] **Step 2: Run the adapter test and verify RED**

Run the narrow existing adapter test file that contains `releaseWorkspacePreparation`; if no focused file exists, run:

`pnpm vitest run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts -t "releases workspace preparation"`

Expected: FAIL because the current method is an empty operation.

- [ ] **Step 3: Implement adapter release**

Implement:

```ts
async releaseWorkspacePreparation(params): Promise<void> {
  // 修复原因：只关闭 workspace UI 不会自动释放预热 Agent；共享 WSL Host 下 Host 仍会继续存活。
  await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
}
```

- [ ] **Step 4: Add failing Host control/report tests**

Test that `ReleaseRemoteWorkspace` calls the active `IZCodeTaskService.releaseWorkspacePreparation` and that a workspace activity response is forwarded through the optional Main callback with the originating process.

- [ ] **Step 5: Implement Host release and Main callback wiring**

In Host, reject release before services are ready, otherwise await the task service method and log one lifecycle result. Extend the reporting task-service proxy to maintain counts by the remembered task's workspace context and post `WorkspaceRunningTaskCountChanged` on 0→1 and 1→0 transitions. In `desktopHostProcess.ts`, parse that response and call:

```ts
onWorkspaceRunningTaskCountChanged?.(child, {
  workspacePath,
  workspaceIdentity,
  runningTaskCount,
});
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```sh
pnpm vitest run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts -t "releases workspace preparation"
pnpm vitest run packages/desktop/test/desktopHostProcess.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts packages/desktop/src/host/index.ts packages/desktop/src/main/desktopHostProcess.ts packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts packages/desktop/test/desktopHostProcess.test.ts
git commit -m "fix(remote): release inactive workspace runtimes"
```

### Task 3: Add a tested WSL pool state machine

**Files:**
- Create: `packages/desktop/src/main/remoteWslHostPool.ts`
- Create: `packages/desktop/test/remoteWslHostPool.test.ts`

**Interfaces:**
- Produces: `WSL_HOST_IDLE_TTL_MS = 60_000`.
- Produces: `buildWslHostPoolKey(windowWebContentsId, target)`.
- Produces: `createRemoteWslHostPool({ disposeHost, hasRunningWorkspace })` with `get`, `setConnecting`, `markReady`, `retain`, `release`, `handleWorkspaceTaskCount`, `disposeWindow`, and `disposeAll`.

- [ ] **Step 1: Write failing pure state-machine tests**

Use fake timers to cover:

```ts
expect(buildWslHostPoolKey(7, { kind: "wsl", distro: " Ubuntu ", user: " dev " }))
  .toBe("7\0wsl:v1:Ubuntu\0dev");
```

Then assert one entry is reused, last release schedules exactly 60 seconds, retain cancels the timer, a running workspace prevents disposal, transition to zero tasks starts a fresh 60-second TTL, and stale generation timers do nothing.

- [ ] **Step 2: Run pool tests and verify RED**

Run: `pnpm vitest run packages/desktop/test/remoteWslHostPool.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal pool**

The pool owns one timer and one dispose Promise per entry. Every timer closure captures entry identity and generation, then verifies the map still points at both before disposal. `disposeWindow` and `disposeAll` clear timers and bypass TTL.

- [ ] **Step 4: Run pool tests and verify GREEN**

Run: `pnpm vitest run packages/desktop/test/remoteWslHostPool.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add packages/desktop/src/main/remoteWslHostPool.ts packages/desktop/test/remoteWslHostPool.test.ts
git commit -m "feat(remote): add window-scoped WSL host pool"
```

### Task 4: Route WSL logical sessions through the shared Host

**Files:**
- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/desktop/src/host/taskRealtimeBridge.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Test: `packages/desktop/test/desktopRemoteSessions.test.ts`
- Test: `packages/desktop/test/taskRealtimeBridge.test.ts`

**Interfaces:**
- Consumes: pool from Task 3 and messages from Tasks 1–2.
- Produces: WSL tracked host kind `{ kind: "shared-wsl"; entry; attachmentId }`.
- Produces: manager method `handleWorkspaceRunningTaskCountChanged(process, context, count)`.

- [ ] **Step 1: Write failing WSL sharing tests**

Add tests proving:

- Two same-window/same-target WSL connects spawn one Host with `InitRemoteWslHost`.
- After `Connected`, each gets a distinct `AttachServicePort` using `desktop-continuous`.
- No WSL `taskRealtime.deliveryKind = "relay_bridge"` is registered.
- Closing one logical session detaches only it.
- Closing the final session starts TTL rather than immediate Host disposal.
- Task count 1 cancels/prevents TTL; count 0 starts a fresh TTL.
- Real window dispose and App shutdown bypass TTL and dispose once.
- Different window, distro, or user creates a different Host.
- Docker remains `InitRemoteWorkspace` dedicated.

- [ ] **Step 2: Run manager tests and verify RED**

Run: `pnpm vitest run packages/desktop/test/desktopRemoteSessions.test.ts`

Expected: FAIL because WSL still uses the dedicated path.

- [ ] **Step 3: Initialize shared WSL Host without an initial port**

Make Host accept `InitRemoteWslHost` wherever `InitRemoteSshHost` currently means “shared remote workspace Host without initial port”. Keep task realtime bridge creation disabled for WSL desktop.

- [ ] **Step 4: Wire WSL pool into session manager**

On WSL connect, get/create the pool Host, wait on its readiness, attach a unique port, and track context. On detach, queue `ReleaseRemoteWorkspace` only when no logical/mobile owner remains and no running task is reported. Pool release installs TTL. Main's task-count callback cancels or restarts TTL and flushes pending workspace release when count reaches zero.

- [ ] **Step 5: Preserve owner teardown and stale callback protection**

Window dispose, App shutdown and update shutdown clear WSL pool timers, reject pending waiters, dedupe process identities, and reuse `disposeHostProcessAndWait`. Every ready/exit/timer continuation compare-and-deletes the same entry.

- [ ] **Step 6: Run desktop tests and verify GREEN**

Run:

```sh
pnpm vitest run packages/desktop/test/desktopRemoteSessions.test.ts
pnpm vitest run packages/desktop/test/taskRealtimeBridge.test.ts
pnpm vitest run packages/desktop/test/desktopHostProcess.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/desktop/src/main/desktopRemoteSessions.ts packages/desktop/src/host/index.ts packages/desktop/src/host/taskRealtimeBridge.ts packages/desktop/src/main/index.ts packages/desktop/test/desktopRemoteSessions.test.ts packages/desktop/test/taskRealtimeBridge.test.ts packages/desktop/test/desktopHostProcess.test.ts
git commit -m "feat(remote): share WSL hosts across workspaces"
```

### Task 5: Bound WSL discovery and deployment concurrency

**Files:**
- Modify: `packages/server/src/remote/wsl-detect.ts`
- Modify: `packages/server/src/remote/deploy.ts`
- Modify: `packages/server/src/remote/remoteAssetInstaller.ts`
- Create: `packages/server/test/wslDetect.test.ts`
- Test: `packages/server/test/remoteAssetInstaller.test.ts`

**Interfaces:**
- Produces: 5-second rejected-promise-safe discovery cache with explicit invalidation.
- Produces: unique staging path per asset installation and install-root lock with version recheck.

- [ ] **Step 1: Write failing discovery single-flight tests**

Inject a clock/command runner, call availability/list discovery concurrently, and assert one underlying command. Advance 5 seconds and assert a new command. Reject once and assert the next call retries rather than reusing a rejected Promise.

- [ ] **Step 2: Run discovery tests and verify RED**

Run: `pnpm vitest run packages/server/test/wslDetect.test.ts`

Expected: FAIL because discovery is currently per-call.

- [ ] **Step 3: Implement the 5-second cache**

Cache only status and distro list. Clear cache on rejection and expose an invalidation function for explicit UI refresh/connection failure. Do not globally cache resolved user or `$HOME`.

- [ ] **Step 4: Write failing installer race tests**

Run two installers against one remote path and assert staging paths differ, only the lock owner uploads, and the waiter rechecks installed version after acquiring the lock. Assert a failed install removes only its own staging path.

- [ ] **Step 5: Implement unique staging and scoped lock**

Use an owner token in the staging suffix, an atomic lock directory under the install root, bounded stale-lock recovery, lock-internal version recheck, and exact-path cleanup. Keep the existing fast version-match skip.

- [ ] **Step 6: Run server tests and verify GREEN**

Run:

```sh
pnpm vitest run packages/server/test/wslDetect.test.ts
pnpm vitest run packages/server/test/remoteAssetInstaller.test.ts
pnpm vitest run packages/server/test/wslBackend.test.ts packages/server/test/remoteConnect.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/server/src/remote/wsl-detect.ts packages/server/src/remote/deploy.ts packages/server/src/remote/remoteAssetInstaller.ts packages/server/test/wslDetect.test.ts packages/server/test/remoteAssetInstaller.test.ts
git commit -m "perf(remote): deduplicate WSL discovery and deployment"
```

### Task 6: Verify the full lifecycle and record evidence

**Files:**
- Modify: `docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md`
- Create: `docs/testing/wsl-host-pooling-runtime-evidence.md`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: automated verification and a real Windows + WSL PID/RSS evidence table.

- [ ] **Step 1: Run all focused tests**

```sh
pnpm vitest run packages/shared/test/validation.test.ts
pnpm vitest run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts -t "releases workspace preparation"
pnpm vitest run packages/desktop/test/remoteWslHostPool.test.ts packages/desktop/test/desktopRemoteSessions.test.ts packages/desktop/test/desktopHostProcess.test.ts packages/desktop/test/taskRealtimeBridge.test.ts
pnpm vitest run packages/server/test/wslDetect.test.ts packages/server/test/remoteAssetInstaller.test.ts packages/server/test/wslBackend.test.ts packages/server/test/remoteConnect.test.ts
```

Expected: PASS with zero failed tests.

- [ ] **Step 2: Run mechanical verification**

```sh
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0; existing warnings are recorded separately from new errors.

- [ ] **Step 3: Run real Windows + WSL checks**

Open 1, then 3, then 5 same-distro/user workspaces. Record timestamp, Windows Host PID, `wsl.exe` PID, WSL `zcode-server` PID, Agent PIDs, RSS, first-connect time, and later-attach times. Verify one Host/server, per-workspace Agents only as needed, individual workspace release, 60-second idle expiry, TTL reuse, App-exit override, and no effect on a control user process.

- [ ] **Step 4: Record evidence and update spec status**

Write exact commands, sampled PID tables, observed deadlines, environment versions, failures/limitations, and whether Docker remained dedicated. Do not claim a runtime case that was not executed.

- [ ] **Step 5: Commit**

```sh
git add docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md docs/testing/wsl-host-pooling-runtime-evidence.md
git commit -m "test(remote): document WSL host pool runtime evidence"
```
