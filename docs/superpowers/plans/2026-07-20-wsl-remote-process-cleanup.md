# WSL Remote Process Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real window close, application quit, and update installation deterministically release all ZCode-owned Remote Hosts and WSL server/Agent processes without terminating the WSL distro.

**Architecture:** Desktop Main will use the remote session manager as the lifecycle authority and wait for all unique Local/Remote Hosts through one idempotent shutdown barrier. Host and remote stdio shutdown become bounded phase machines that always attempt Agent cleanup, while WSL tracks only the child processes it created. A strict owner registry provides safe cleanup for newly created, provably orphaned ZCode Agent processes.

**Tech Stack:** TypeScript, Electron UtilityProcess, Node.js child_process/stdio, Vitest, Zustand-independent Desktop Main/Host services.

**Execution scope note (2026-07-20):** 用户确认的产品边界是“真实关闭（非托盘隐藏）与更新安装时销毁”。
本次实现 Task 1-3 和文档/验证；Task 4 的跨启动 owner registry/reaper 不属于该触发边界，且会扩大到全局
进程检查，因此暂不引入。当前 fallback 只回收 `WSLBackend` 本实例明确创建的 child，不按进程名扫描。

## Global Constraints

- Never call `wsl --terminate` or `wsl --shutdown`.
- Do not destroy runtimes for minimize, tray hide, renderer reload, or mobile bridge disconnect.
- Desktop local/SSH/WSL/Docker attachments remain `desktop-continuous`; mobile remains `web-remote-replayable`.
- Mobile `/remote` must continue attaching to an existing Host and must never start an independent runtime.
- Preserve `workspaceKey = workspaceIdentity?.trim() || workspacePath`, `remoteSessionId`, owner/lease, and CommandInbox semantics.
- All lifecycle APIs must be idempotent and reuse an in-flight/result Promise.
- Comments explaining bug causes are written in Chinese.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Application-Level Remote Host Shutdown Barrier

**Files:**
- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/test/desktopRemoteSessions.test.ts`
- Modify: `packages/desktop/test/desktopHostProcess.test.ts`

**Interfaces:**
- Consumes: existing `disposeHostProcessAndWait(child, label, timers, logger, options)`.
- Produces: `disposeAllAndWaitForAppShutdown(reason: string): Promise<void>` on the remote session manager.

- [ ] **Step 1: Write failing manager tests**

Add tests that create one dedicated WSL session, one shared SSH Host, one pending SSH connect, and one Bot runtime, then assert application shutdown:

```ts
const shutdown = manager.disposeAllAndWaitForAppShutdown("app-before-quit");
expect(disposeHostProcessAndWait).toHaveBeenCalledTimes(3);
expect(disposeHostProcessAndWait).toHaveBeenCalledWith(
  wslChild,
  expect.stringContaining("app-before-quit"),
);
await shutdown;
```

Add a second call assertion proving the same in-flight Promise is reused and Host processes are deduplicated.

- [ ] **Step 2: Run tests and verify RED**

Run:

```sh
pnpm exec vitest run packages/desktop/test/desktopRemoteSessions.test.ts
```

Expected: FAIL because `disposeAllAndWaitForAppShutdown` and the async disposer injection do not exist.

- [ ] **Step 3: Implement the manager barrier**

Extend manager options with:

```ts
disposeHostProcessAndWait: (
  child: ElectronUtilityProcess,
  label: string,
) => Promise<void>;
```

Implement a single-flight function that rejects pending connects, snapshots unique dedicated/shared/Bot processes, clears lifecycle maps before awaiting, and runs all disposals in parallel:

```ts
let appShutdownInFlight: Promise<void> | null = null;
let appShutdownStarted = false;

function disposeAllAndWaitForAppShutdown(reason: string): Promise<void> {
  if (appShutdownInFlight) return appShutdownInFlight;
  appShutdownStarted = true;
  const hosts = collectUniqueRemoteHostProcessesAndClearState(reason);
  appShutdownInFlight = Promise.all(
    hosts.map(({ process, label }) => options.disposeHostProcessAndWait(process, label)),
  ).then(() => undefined);
  return appShutdownInFlight;
}
```

Creation APIs must reject after `appShutdownStarted`.

- [ ] **Step 4: Wire app quit and update install**

In `index.ts`, inject `disposeHostProcessAndWait` into the manager. Change both `prepareAppQuit` and `prepareWindowsProcessesForUpdateInstall` to await Local Host cleanup and `remoteSessionManager.disposeAllAndWaitForAppShutdown(reason)` in parallel. Preserve existing per-window `closed` disposal.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```sh
pnpm exec vitest run packages/desktop/test/desktopRemoteSessions.test.ts packages/desktop/test/desktopHostProcess.test.ts packages/desktop/test/desktopWindowLifecycle.test.ts packages/desktop/test/e2eProcessCleanup.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/desktop/src/main/desktopRemoteSessions.ts packages/desktop/src/main/index.ts packages/desktop/test/desktopRemoteSessions.test.ts packages/desktop/test/desktopHostProcess.test.ts
git commit -m "fix(desktop): await remote hosts during shutdown"
```

### Task 2: Bounded Host and Remote Server Cleanup Phases

**Files:**
- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/server/src/stdio-lifecycle.ts`
- Modify: `packages/server/test/stdioLifecycle.test.ts`
- Create: `packages/desktop/src/host/hostShutdownPhases.ts`
- Create: `packages/desktop/test/hostShutdownPhases.test.ts`

**Interfaces:**
- Produces: `runHostShutdownPhases(phases, options): Promise<HostShutdownResult>`.
- Consumes later: `RemoteConnection.disposeAndWait()` from Task 3; until then the remote phase may wrap synchronous `dispose()`.

- [ ] **Step 1: Write failing stdio lifecycle test**

Add a fake-timer test where `stopRpc` never resolves and verify `dispose` is still called after the RPC phase deadline:

```ts
stdin.emit("end");
await vi.advanceTimersByTimeAsync(1_000);
expect(dispose).toHaveBeenCalledTimes(1);
await vi.advanceTimersByTimeAsync(3_500);
expect(exit).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Run the server test and verify RED**

```sh
pnpm exec vitest run packages/server/test/stdioLifecycle.test.ts
```

Expected: FAIL because current total `Promise.race` skips `dispose` while `stopRpc` is pending.

- [ ] **Step 3: Give each stdio phase an independent deadline**

Replace the single total race with a reusable bounded phase runner:

```ts
await runBoundedPhase("rpc-stop", stopRpc, rpcStopTimeoutMs);
await runBoundedPhase("service-dispose", dispose, serviceDisposeTimeoutMs);
exit(requestedExitCode);
```

Timeout/error marks exit code 1 and logs the exact phase, but never skips the next phase.

- [ ] **Step 4: Write Host phase tests**

Cover service cleanup failure followed by remote cleanup, repeated shutdown calls, and cleanup timeout returning a non-zero result.

- [ ] **Step 5: Implement and wire Host phases**

Create the focused helper and make `disposeHostResources` call it. Change `disconnect` to:

```ts
process.once("disconnect", () => {
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});
```

Keep `exit` synchronous best-effort only.

- [ ] **Step 6: Run focused tests and verify GREEN**

```sh
pnpm exec vitest run packages/server/test/stdioLifecycle.test.ts packages/desktop/test/hostShutdownPhases.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```sh
git add packages/server/src/stdio-lifecycle.ts packages/server/test/stdioLifecycle.test.ts packages/desktop/src/host/index.ts packages/desktop/src/host/hostShutdownPhases.ts packages/desktop/test/hostShutdownPhases.test.ts
git commit -m "fix(remote): bound every shutdown cleanup phase"
```

### Task 3: Awaitable RemoteConnection and WSL Child Ownership

**Files:**
- Modify: `packages/server/src/remote/backend.ts`
- Modify: `packages/server/src/remote/connect.ts`
- Modify: `packages/server/src/remote/wsl-backend.ts`
- Modify: `packages/server/src/remote/docker-backend.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Modify: `packages/server/test/remoteConnect.test.ts`
- Modify: `packages/server/test/wslBackend.test.ts`

**Interfaces:**
- Produces: `RemoteConnection.disposeAndWait(): Promise<void>`.
- Produces: optional `IRemoteBackend.disposeAndWait?(): Promise<void>` while retaining synchronous `dispose()` compatibility.

- [ ] **Step 1: Write failing connection tests**

Assert `disposeAndWait` closes stdin immediately, waits for `stream.onClose`, falls back to backend cleanup after a fake-timer deadline, and returns the same Promise on repeated calls. Add a connect failure test asserting backend dispose when detect/deploy/handshake throws.

- [ ] **Step 2: Write failing WSL child tests**

Extend the spawn mock child with `kill`, `exit`, and `close`. Assert:

```ts
const stream = await backend.exec("sleep 60");
const disposal = backend.disposeAndWait?.();
expect(child.kill).not.toHaveBeenCalled();
child.emit("close", 0);
await disposal;
```

Add timeout coverage proving only children spawned by that backend are killed and no WSL terminate/shutdown args are issued.

- [ ] **Step 3: Run tests and verify RED**

```sh
pnpm exec vitest run packages/server/test/remoteConnect.test.ts packages/server/test/wslBackend.test.ts
```

Expected: FAIL because async cleanup and child ownership do not exist.

- [ ] **Step 4: Implement RemoteConnection single-flight**

`dispose()` starts the same cleanup Promise; `disposeAndWait()` returns it. Cleanup stops client/protocol/socket first, waits for stream close with an injected/default grace period, then invokes backend fallback cleanup. Wrap connection setup in `try/catch` so failed setup disposes the backend.

- [ ] **Step 5: Track WSL children**

Keep a `Set<ChildProcess>` for active `spawn`/`execFile` calls, unregister on terminal events, reject new commands after disposal, and implement bounded wait plus `child.kill()` fallback. Do not call distro-wide WSL commands.

- [ ] **Step 6: Wire Host await**

Use `await remoteConnection.disposeAndWait()` in the Host remote cleanup phase.

- [ ] **Step 7: Run focused tests and verify GREEN**

```sh
pnpm exec vitest run packages/server/test/remoteConnect.test.ts packages/server/test/wslBackend.test.ts packages/server/test/dockerBackend.test.ts packages/desktop/test/hostShutdownPhases.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```sh
git add packages/server/src/remote packages/server/test packages/desktop/src/host/index.ts packages/desktop/test/hostShutdownPhases.test.ts
git commit -m "fix(remote): await WSL server process shutdown"
```

### Task 4: Safe WSL Owner Registry and Orphan Reaper

**Files:**
- Create: `packages/services/src/zcode-agent/remoteAgentOwnerRegistry.ts`
- Create: `packages/services/test/remoteAgentOwnerRegistry.test.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/server/src/remote/connect.ts`
- Modify: `packages/server/src/entry-stdio.ts`

**Interfaces:**
- Produces: `RemoteAgentOwnerRegistry` with `registerAgent`, `unregisterAgent`, `reapDeadOwners`, and `dispose`.
- Consumes: `ZCODE_REMOTE_OWNER_ID`, `ZCODE_REMOTE_OWNER_KIND`, and an owner registry root under `$HOME/.zcode/server/owners`.

- [ ] **Step 1: Write failing registry tests**

Use a temporary directory and injected process inspector/terminator. Cover exact ownerId + PID start-time + executable match, PID reuse, corrupt registry, environment mismatch, normal unregister, and legacy unowned process skip.

- [ ] **Step 2: Run test and verify RED**

```sh
pnpm exec vitest run packages/services/test/remoteAgentOwnerRegistry.test.ts
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement strict registry**

Persist owner records atomically with schema version, ownerId, server PID/start time, Agent PID/start time, and expected executable root. Reap only when the server owner is dead/reused and every Agent identity check still matches. Never match by process name alone.

- [ ] **Step 4: Integrate owner environment and process callbacks**

Generate the ownerId in `connectRemote`, inject it into the remote server command, initialize the registry only for `desktop-attached-remote`, and register/unregister child PIDs in `ZCodeAgentProcessManager`. Normal service disposal removes the owner record.

- [ ] **Step 5: Run registry and process-manager tests**

```sh
pnpm exec vitest run packages/services/test/remoteAgentOwnerRegistry.test.ts packages/services/test/zcodeAgentProcessManager.test.ts packages/server/test/remoteConnect.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```sh
git add packages/services/src/zcode-agent packages/services/src/node.ts packages/services/test packages/server/src/remote/connect.ts packages/server/src/entry-stdio.ts packages/server/test
git commit -m "fix(remote): reap owned orphan agents safely"
```

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `docs/wsl-remote-workspace-design.md`
- Modify: `docs/architecture/zcode-code-architecture-overview.md`
- Modify: `docs/web-remote-control/web-remote-control-architecture.md`
- Modify: `docs/web-remote-control/task-realtime-sync.md`

**Interfaces:**
- Documents the final lifecycle and verification evidence; no new runtime interface.

- [ ] **Step 1: Update current-fact documentation**

Document app/update shutdown barriers, WSL child ownership, owner reaping, and explicit non-teardown events. State that mobile attachment disconnect never destroys the shared Host and that distro termination is forbidden.

- [ ] **Step 2: Run all focused suites**

```sh
pnpm exec vitest run packages/desktop/test/desktopRemoteSessions.test.ts packages/desktop/test/desktopHostProcess.test.ts packages/desktop/test/desktopWindowLifecycle.test.ts packages/desktop/test/e2eProcessCleanup.test.ts packages/desktop/test/hostShutdownPhases.test.ts packages/server/test/stdioLifecycle.test.ts packages/server/test/remoteConnect.test.ts packages/server/test/wslBackend.test.ts packages/server/test/dockerBackend.test.ts packages/services/test/remoteAgentOwnerRegistry.test.ts packages/services/test/zcodeAgentProcessManager.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Run mechanical gates**

```sh
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0.

- [ ] **Step 4: Perform runtime WSL verification**

Record before/after PID evidence for tray hide, real window close, app quit, and update preparation. Confirm ZCode Host/server/Agent exit while `wsl.exe -l -v` may continue showing the distro as Running.

- [ ] **Step 5: Commit**

```sh
git add docs packages
git commit -m "docs(remote): record deterministic WSL cleanup"
```

- [ ] **Step 6: Request code review and address findings**

Review the complete branch diff against the design spec, rerun affected tests after any correction, and leave the worktree clean.
