# Windows CUA Phase 0+1 Development Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** 在 Windows 本地桌面 Host 中按需启动 `C:\Users\dev\zcode-cua` 源码构建出的独立 Node Helper，让官方 `zcode-cua` plugin 获得随机 named pipe、token 和 authority，并在记事本完成 UIA 观察、点击和输入闭环。

**Architecture:** 保留 macOS 现有 `Host -> Helper -> broker -> MCP plugin` 分层。Windows 新增源码开发专用 Helper 入口和 Host lifecycle adapter；Helper 使用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 运行，自动加载源码树的 `build/Release/ax_native.node`。ZCode Host 只负责源码根校验、子进程生命周期、健康检查和凭据注入；UIA、输入与 Windows system surface 仍归 `zcode-cua`。本计划不增加 tool、不修改 tool schema、不接入 SSH/WSL/Docker，也不做 WGC、完整指针或产品打包。

**Tech Stack:** TypeScript 5/6、Node.js 24、Electron utility process、Vitest 4、Node `child_process.fork`、Windows named pipe、N-API/node-addon-api、C++/UI Automation、pnpm 10。

**Global Constraints:**

- 设计依据是 `docs/superpowers/specs/2026-07-28-windows-cua-development-runtime-design.md`，范围只覆盖 Phase 0 和 Phase 1。
- Windows runtime 只允许本地 desktop Host；`desktop-attached-remote`、SSH、WSL、Docker、Web remote 均不得创建 Helper。
- macOS 继续使用现有 `createProductCuaHelperHost()`、Helper.app、TCC、签名和安装器，行为不得改变。
- Linux standalone in-process 路径不得改变。
- token 只能通过受控子进程环境传递，禁止出现在 argv、ready 消息、错误文本和日志中。
- Helper 通过健康检查前不发布 broker tuple；重启必须 mint 新 pipe/token，authority 在同一 Host 生命周期内稳定。
- 所有文件和进程 I/O 使用异步 API；生产日志使用 `createServiceLogger("cua-product-helper")`，协议逐条输出仅允许 `debug`。
- 不修改 `packages/ui`；因此本里程碑不触碰 Windows 设置页和权限引导。
- 每个功能提交使用 Conventional Commits；两个仓库分别提交，不把跨仓库改动混成一个 commit。

---

## File Structure Map

### `C:\Users\dev\zcode-cua`

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/build.mjs`
- Modify: `src/broker/server/index.ts`
- Modify: `src/broker/server/nodeSystemSurface.ts`
- Add: `src/broker/server/windowsSystemSurface.ts`
- Add: `src/broker/server/windowsDevHelperMain.ts`
- Add: `src/windows-helper.ts`
- Add: `test/broker/windowsSystemSurface.test.ts`
- Add: `test/windowsDevHelperMain.test.ts`
- Modify: `test/broker/helpers/tempSocket.ts`
- Modify: `test/broker/fakes/fakeBrokerServer.ts`
- Modify: `test/broker-client.claim.test.ts`
- Modify: `test/broker-client.refresh-marker.test.ts`
- Modify: `test/standalone/helper-launch/fakes.ts`
- Modify: `test/mock-broker-e2e.test.ts`
- Modify: `test/standalone/helper-launch/discovery.test.ts`
- Modify: `test/standalone/helper-launch/ownerLock.test.ts`
- Modify: `test/standalone/helper-launch/launcher.test.ts`
- Modify: `test/standalone/cli-launch.test.ts`
- Modify: `test/broker/broker.peerCheck.parity.test.ts`
- Modify: `test/broker/m3/rotation.selfHeal.test.ts`
- Modify: `test/lib/06-resize-jpeg.test.ts`
- Modify: `docs/KNOWN-ISSUES.md`
- Modify: `docs/platforms.md`

### `C:\Users\dev\z-code`

- Modify: `docs/superpowers/specs/2026-07-28-windows-cua-development-runtime-design.md`
- Modify: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`
- Add: `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts`
- Add: `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts`
- Modify: `packages/services/src/cua-permission-broker/index.ts`
- Modify: `packages/services/src/node.ts`
- Add: `packages/services/test/windowsCuaDevRuntime.test.ts`
- Add: `packages/services/test/windowsCuaDevHelperHost.test.ts`
- Add: `packages/services/test/windowsCuaDevHelper.integration.test.ts`
- Modify: `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`
- Modify: `packages/services/test/cuaPermissionBrokerServiceDispose.test.ts`
- Add: `docs/cua/windows-source-development.md`

---

### Task 1: Lock the Windows test and native-build baseline

**Files:**

- Modify: `C:\Users\dev\zcode-cua\package.json`
- Modify: `C:\Users\dev\zcode-cua\pnpm-lock.yaml`
- Modify: Windows-invalid test files listed in the file map
- Modify: `C:\Users\dev\zcode-cua\docs\KNOWN-ISSUES.md`

**Step 1: Record the current failing baseline**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm typecheck
pnpm lint
pnpm test -- --reporter=verbose
pnpm rebuild:native
```

Expected before the fix:

- `typecheck` passes.
- `lint` fails because `oxlint` is not declared.
- tests fail where POSIX paths, mode bits or Unix sockets are assumed on Windows.
- `rebuild:native` fails until the Visual Studio C++ Desktop workload is installed.

Retain the exact native-build error in the task notes. Do not let the best-effort `install` script count as native-build evidence.

**Step 2: Make the native toolchain an explicit prerequisite**

Use `vswhere.exe` to detect an installation containing:

```text
Microsoft.VisualStudio.Component.VC.Tools.x86.x64
Microsoft.VisualStudio.Component.Windows11SDK.26100
```

If absent, install the Visual Studio Build Tools “Desktop development with C++” workload, then rerun:

```powershell
pnpm rebuild:native
Test-Path .\build\Release\ax_native.node
```

Expected: native rebuild exits `0`; the final command prints `True`.

**Step 3: Repair the lint dependency**

Add `oxlint` to `devDependencies` at the version used by ZCode (`^1.57.0`), run `pnpm install`, and verify:

```powershell
pnpm lint
```

Expected: exit `0`.

**Step 4: Write the Windows-portable test helper first**

Change `test/broker/helpers/tempSocket.ts` so live broker tests use:

```text
win32 -> \\.\pipe\zcode-cua-test-<random>
other -> <fresh tmpdir>/broker.sock
```

Use the same helper from every test that creates a live listener:

- `test/broker-client.claim.test.ts`
- `test/broker-client.refresh-marker.test.ts`
- `test/broker/fakes/fakeBrokerServer.ts`
- `test/standalone/helper-launch/fakes.ts`
- `test/mock-broker-e2e.test.ts`

Run:

```powershell
pnpm exec vitest run test/broker-client.claim.test.ts test/standalone/helper-launch/connection.test.ts test/standalone/helper-launch/orchestrator.test.ts test/mock-broker-e2e.test.ts
```

Expected: no `listen EACCES` and no timeout caused by an unbound fake broker.

**Step 5: Separate POSIX contracts from cross-platform contracts**

Apply these rules:

- Path-building assertions use `join()` or inject `path.posix` when the test is explicitly checking a macOS/POSIX contract.
- `0600`/`0700`, uid ownership and symlink-permission assertions use `describe.skipIf(process.platform === "win32")`.
- Existing `test/broker/broker.peerCheck.win32.test.ts` remains the Windows named-pipe security contract; do not weaken production `peer-check.ts` to satisfy POSIX tests.
- Windows tests assert token authentication and pipe namespace; POSIX tests continue to assert mode/uid.
- `test/lib/06-resize-jpeg.test.ts` resolves fixtures relative to `import.meta.url`, never a developer’s `/Users/...` path.

Run:

```powershell
pnpm exec vitest run test/standalone/helper-launch/discovery.test.ts test/standalone/helper-launch/ownerLock.test.ts test/standalone/helper-launch/launcher.test.ts test/standalone/cli-launch.test.ts test/broker/broker.peerCheck.parity.test.ts test/broker/broker.peerCheck.win32.test.ts test/broker/m3/rotation.selfHeal.test.ts test/lib/06-resize-jpeg.test.ts
```

Expected: pass, with only explicitly named POSIX-only cases skipped on Windows.

**Step 6: Run the complete repository gate**

Run:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all commands exit `0`. `pnpm test` may contain intentional platform skips, but no failures or unhandled errors.

**Step 7: Document the corrected baseline**

Update `docs/KNOWN-ISSUES.md` with:

- Windows native prerequisites;
- strict rebuild command;
- distinction between named-pipe tests and POSIX socket permission tests;
- current full-suite counts from the successful run.

**Step 8: Commit**

```powershell
git add package.json pnpm-lock.yaml test docs/KNOWN-ISSUES.md
git diff --cached --check
git commit -m "test(windows): establish CUA development baseline"
```

---

### Task 2: Add a fail-closed Windows system surface

**Files:**

- Add: `C:\Users\dev\zcode-cua\src\broker\server\windowsSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\index.ts`
- Add: `C:\Users\dev\zcode-cua\test\broker\windowsSystemSurface.test.ts`

**Step 1: Write failing tests**

Cover:

1. `createNodeSystemSurface({ platform: "win32" })` dispatches to the Windows factory.
2. `captureScreenPng` and `captureWindowPng` return `null` in Phase 1 and never invoke macOS commands.
3. clipboard reads return `""`; writes are a no-op until a native clipboard adapter exists.
4. `resolveApplicationBundleId` returns `null`.
5. `openApplication({ name: "notepad.exe", activate: false })` invokes an injected async runner with an argv array and returns `{ pid, name, bundleId: null, active: false }`.
6. missing name/bundle identity and failed launch reject with a stable error.

Run:

```powershell
pnpm exec vitest run test/broker/windowsSystemSurface.test.ts
```

Expected: fail because the Windows factory does not exist and `win32` currently falls into the macOS branch.

**Step 2: Implement the minimal surface**

Create `createWindowsNodeSystemSurface()` with an injected `openRunner`. The default runner uses `child_process.spawn()` without a shell, returns the child PID, calls `unref()`, and never invokes PowerShell.

Keep capture and clipboard explicitly fail-closed for Phase 1. Do not add BitBlt, PowerShell screenshot code or WGC placeholders that claim success.

Update `createNodeSystemSurface()` to dispatch:

```text
linux -> createLinuxNodeSystemSurface
win32 -> createWindowsNodeSystemSurface
darwin -> existing macOS implementation
```

**Step 3: Verify**

Run:

```powershell
pnpm exec vitest run test/broker/windowsSystemSurface.test.ts
pnpm typecheck
pnpm lint
```

Expected: pass.

**Step 4: Commit**

```powershell
git add src/broker/server/windowsSystemSurface.ts src/broker/server/nodeSystemSurface.ts src/broker/server/index.ts test/broker/windowsSystemSurface.test.ts
git diff --cached --check
git commit -m "feat(windows): add CUA system surface"
```

---

### Task 3: Build an independent Windows development Helper entry

**Files:**

- Add: `C:\Users\dev\zcode-cua\src\broker\server\windowsDevHelperMain.ts`
- Add: `C:\Users\dev\zcode-cua\src\windows-helper.ts`
- Modify: `C:\Users\dev\zcode-cua\scripts\build.mjs`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\index.ts`
- Add: `C:\Users\dev\zcode-cua\test\windowsDevHelperMain.test.ts`
- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`

**Step 1: Write failing parser and lifecycle tests**

The versioned Host/Helper control protocol is:

```json
{"protocol":"zcode-cua-windows-dev/v1","type":"ready","socketPath":"\\\\.\\pipe\\...","pid":123}
{"protocol":"zcode-cua-windows-dev/v1","type":"shutdown"}
```

Cover:

1. only `win32` is accepted;
2. `--socket` must be a Windows named pipe;
3. `--parent-pid` must be a positive integer;
4. token is required from `ZCODE_CUA_PERMISSION_BROKER_TOKEN`;
5. `--token` is rejected and token text never appears in errors/messages;
6. native addon and system surface are injected into `runHelper`;
7. ready is sent only after broker bind;
8. IPC shutdown, parent disconnect, `SIGINT` and `SIGTERM` share one idempotent async stop;
9. parent-liveness loss stops the broker and exits;
10. startup failure emits a sanitized v1 error message and exits non-zero.

Run:

```powershell
pnpm exec vitest run test/windowsDevHelperMain.test.ts
```

Expected: fail because the entry does not exist.

**Step 2: Implement the platform-specific composition root**

`windowsDevHelperMain.ts` must:

- validate args and env with a runtime schema;
- call `loadRealNativeAddon({ platform: "win32" })`;
- call `createNodeSystemSurface({ platform: "win32" })`;
- call the existing platform-neutral `runHelper()`;
- pass the bearer token only as `authToken`;
- use `startLauncherLivenessWatchdog()` for the parent PID;
- stop accepting new broker work before process exit;
- emit no per-request logs and no credential values.

Do not call macOS `helperMain.main()`: that path requires token files, code-signature checks, TCC permission modes and `/usr/bin/ps`.

**Step 3: Add the executable bundle**

Add an esbuild entry:

```text
src/windows-helper.ts -> dist/windows-helper.js
```

Use Node 24 target and the same externals as the existing bundles. Add a shebang so the file can also be run directly with Node during diagnostics.

Run:

```powershell
pnpm build
Test-Path .\dist\windows-helper.js
node .\dist\windows-helper.js --socket invalid --parent-pid $PID
```

Expected:

- build exits `0`;
- file exists;
- invalid pipe exits non-zero with a sanitized diagnostic.

**Step 4: Run a read-only native smoke**

Start the entry with a random pipe/token, connect using `probeHelperHealth`, call `broker_info`, then stop it through the v1 shutdown message. Assert:

- helper PID differs from the caller PID;
- health reports ready;
- `broker_info.pid` equals the child PID;
- child exits and the pipe no longer accepts connections.

This smoke is implemented in the test with the real addon and guarded by:

```text
process.platform === "win32" && build/Release/ax_native.node exists
```

The Phase 0 gate guarantees the guard is true on the development machine.

**Step 5: Document and verify**

Update `docs/platforms.md` to distinguish:

- Windows Phase 1 source Helper: UIA + click + keyboard, no pixels;
- Phase 2: WGC and remaining pointer operations.

Run:

```powershell
pnpm exec vitest run test/windowsDevHelperMain.test.ts test/broker/windowsSystemSurface.test.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all exit `0`.

**Step 6: Commit**

```powershell
git add src scripts/build.mjs test/windowsDevHelperMain.test.ts docs/platforms.md
git diff --cached --check
git commit -m "feat(windows): add source Computer Use Helper entry"
```

---

### Task 4: Resolve and validate the ZCode Windows development runtime

**Files:**

- Modify: `C:\Users\dev\z-code\docs\superpowers\specs\2026-07-28-windows-cua-development-runtime-design.md`
- Modify: `C:\Users\dev\z-code\apps\zcode-cli\docs\design\v2\tool\00-tool-change-chain.md`
- Add: `C:\Users\dev\z-code\packages\services\src\cua-permission-broker\windowsCuaDevRuntime.ts`
- Add: `C:\Users\dev\z-code\packages\services\test\windowsCuaDevRuntime.test.ts`

**Step 1: Close the spec’s accepted open item**

Update the design status to “已确认” and resolve the Node choice:

```text
command = process.execPath
env.ELECTRON_RUN_AS_NODE = "1"
```

Reason: desktop Host already uses this pattern for zcode-agent; CLI/test hosts naturally have `process.execPath` pointing to Node. The addon is N-API and is rebuilt on the target Windows machine.

Update the tool change chain before implementation. Record that the existing 30 tools, schemas, side-effect annotations and delivery-state semantics are unchanged; only the Windows backend admission/execution route becomes available.

**Step 2: Write failing resolver tests**

Cover:

1. only `platform="win32"` accepts `ZCODE_CUA_DEV_ROOT`;
2. empty, relative or nonexistent roots fail with a structured reason;
3. `package.json.name` must equal `@zcode/zcode-cua`;
4. `dist/windows-helper.js` and `build/Release/ax_native.node` must both be files;
5. resolved command is `process.execPath`;
6. child env includes `ELECTRON_RUN_AS_NODE=1` but no broker token yet;
7. all filesystem checks are async;
8. diagnostics name the missing artifact but do not include unrelated environment values.

Run:

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts
```

Expected: fail because the resolver does not exist.

**Step 3: Implement the resolver**

Expose:

```ts
export interface WindowsCuaDevRuntime {
  root: string;
  entryPath: string;
  addonPath: string;
  command: string;
  commandEnv: Record<string, string>;
}

export async function resolveWindowsCuaDevRuntime(
  options?: WindowsCuaDevRuntimeResolveOptions,
): Promise<WindowsCuaDevRuntime>;
```

The default root comes only from `ZCODE_CUA_DEV_ROOT`. Do not search sibling directories or silently fall back to a macOS Helper path.

**Step 4: Verify and commit**

Run:

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts
pnpm typecheck
pnpm lint
```

Expected: pass.

```powershell
git add docs/superpowers/specs/2026-07-28-windows-cua-development-runtime-design.md apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts packages/services/test/windowsCuaDevRuntime.test.ts
git diff --cached --check
git commit -m "docs(cua): finalize Windows runtime contract"
```

---

### Task 5: Implement the Windows Helper lifecycle host

**Files:**

- Add: `C:\Users\dev\z-code\packages\services\src\cua-permission-broker\windowsCuaDevHelperHost.ts`
- Modify: `C:\Users\dev\z-code\packages\services\src\cua-permission-broker\index.ts`
- Add: `C:\Users\dev\z-code\packages\services\test\windowsCuaDevHelperHost.test.ts`

**Step 1: Write failing lifecycle tests**

Use an injected child-process adapter and health probe. Cover:

1. concurrent `start()` calls share one fork;
2. fork command is `runtime.command`, entry is `runtime.entryPath`, cwd is `runtime.root`;
3. argv includes pipe and parent PID but never token;
4. child env contains token, `ZCODE_CUA_HELPER_ADDON=runtime.addonPath` and `ELECTRON_RUN_AS_NODE=1`;
5. only a valid v1 ready message for the minted pipe is accepted;
6. health must pass before `start()` returns a handle;
7. handle contains random pipe/token, Host-stable authority, entry path and child PID;
8. startup error, early child exit, malformed message and health timeout all reject, stop the child and publish no handle;
9. `restart()` stops H1, mints a different pipe/token, starts H2 and keeps authority stable;
10. `restartAfterCurrentStart()` serializes behind a pending start;
11. `restartAfterCurrentStartPreservingTransport()` invokes `beforeFreshStart` before fork and returns `reused:false`;
12. `stop()` sends the v1 shutdown message, waits a bounded interval, then kills only the exact child if it has not exited;
13. late ready/exit events after stop cannot resurrect `running`;
14. logs include generation/PID/error class but never token.

Run:

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevHelperHost.test.ts
```

Expected: fail because the host does not exist.

**Step 2: Define the minimal common Host contract**

Use the existing `CuaProductHelperHost` resolver contract and add the two lifecycle capabilities ZCode owns:

```ts
export type ManagedCuaProductHelperHost = CuaProductHelperHost & {
  stop(): Promise<void>;
  checkHealth(timeoutMs?: number): Promise<unknown>;
};
```

Do not require macOS-only `queryPermissionStatus()` or `queryScreenCaptureProbe()` on the Windows class.

**Step 3: Implement lifecycle and credential ownership**

Implementation requirements:

- production on Windows calls `mintBrokerSocketPath()` and `mintBrokerToken()` per generation; unit tests inject deterministic mint functions instead of faking `process.platform`;
- authority minted once per Host object;
- `child_process.fork()` wrapped in an injectable adapter;
- runtime schema validation for every child message;
- bounded startup and shutdown timers, both `unref()` where safe;
- actual health uses `probeHelperHealth`;
- unexpected child exit leaves the generation observable as unhealthy until resolver recovery, matching the existing liveness watchdog contract;
- stop/restart prevents late async completion from writing a new handle;
- service logs use `createServiceLogger`, never `console`.

**Step 4: Verify**

Run:

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevHelperHost.test.ts packages/services/test/cuaPermissionBrokerProductMcpResolver.test.ts packages/services/test/cuaPermissionBrokerHelperLivenessWatchdog.test.ts
pnpm typecheck
pnpm lint
```

Expected: pass.

**Step 5: Commit**

```powershell
git add packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts packages/services/src/cua-permission-broker/index.ts packages/services/test/windowsCuaDevHelperHost.test.ts
git diff --cached --check
git commit -m "feat(cua): manage Windows development Helper"
```

---

### Task 6: Wire Windows admission and broker credentials into ZCode

**Files:**

- Modify: `C:\Users\dev\z-code\packages\services\src\node.ts`
- Modify: `C:\Users\dev\z-code\packages\services\test\cuaPermissionBrokerProductAgentEnv.test.ts`
- Modify: `C:\Users\dev\z-code\packages\services\test\cuaPermissionBrokerServiceDispose.test.ts`

**Step 1: Write failing admission tests**

Add cases proving:

1. macOS feature admission remains unchanged;
2. Windows is admitted only when the internal CUA feature is enabled and `ZCODE_CUA_DEV_ROOT` is non-empty;
3. Linux remains disabled in this product Host path;
4. `isDesktopAttachedRemote=true` prevents Windows Host creation;
5. an injected resolver prevents duplicate Host creation;
6. an invalid Windows runtime yields `BROKER_UNAVAILABLE`, not empty env and not macOS fallback;
7. a healthy Windows host injects socket/token/authority into only the official CUA plugin path;
8. disposing services waits for the Windows Host stop;
9. remote workspace identity does not cause any local Helper start.

Run:

```powershell
pnpm exec vitest run packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts
```

Expected: fail on Windows admission/host factory cases.

**Step 2: Generalize the default helper type without weakening macOS**

Change the default helper record to hold:

```ts
host: ManagedCuaProductHelperHost;
macPermissionHost?: CuaHelperHost;
```

Factory behavior:

```text
darwin -> existing createProductCuaHelperHost(), assigned to both fields
win32 -> createWindowsCuaDevHelperHost(), no macPermissionHost
other -> undefined
```

Only run `reapOrphanedHelpers()` on darwin. Windows cleanup is child ownership + parent PID watchdog.

**Step 3: Preserve macOS permission-service boundaries**

`getStatus()` and permission onboarding continue to use `macPermissionHost` and remain unavailable on Windows. `getHelperStatus()` may report the Windows development Helper’s running state, but must not claim macOS permissions are available.

No UI changes are part of this task.

**Step 4: Verify focused and regression suites**

Run:

```powershell
pnpm exec vitest run packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts packages/services/test/cuaPermissionService.test.ts packages/services/test/cuaPermissionBrokerHelperHost.test.ts packages/services/test/cuaPermissionBrokerProductMcpResolver.test.ts
pnpm typecheck
pnpm lint
```

Expected: pass.

**Step 5: Commit**

```powershell
git add packages/services/src/node.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts
git diff --cached --check
git commit -m "feat(cua): enable Windows source Helper"
```

---

### Task 7: Prove the real source Helper and official plugin boundary

**Files:**

- Add: `C:\Users\dev\z-code\packages\services\test\windowsCuaDevHelper.integration.test.ts`
- Add: `C:\Users\dev\z-code\docs\cua\windows-source-development.md`

**Step 1: Write the opt-in real integration test**

The test runs only when all are true:

```text
process.platform === "win32"
ZCODE_CUA_DEV_ROOT is set
dist/windows-helper.js exists
build/Release/ax_native.node exists
```

It must:

1. construct the real Windows Host;
2. start the real child;
3. verify health and `broker_info`;
4. call the read-only `list_apps` broker method and receive an array;
5. call `buildCuaProductHelperAgentEnv()` and assert all three official env values;
6. assert the token is absent from the child command line and captured logs;
7. stop the Host and prove the child exits.

Run:

```powershell
$env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
```

Expected: pass with the real named pipe and addon.

**Step 2: Verify official plugin fail-closed behavior**

Run the existing plugin tests with:

```powershell
pnpm --filter @zcode/zcode-cua-plugin test
```

Expected:

- no broker credentials -> zero usable CUA tools / explicit unavailable result;
- valid Host-injected credentials -> official server config retained;
- no test accepts a token from user-authored plugin config.

Do not update the plugin dependency or tool surface in this milestone unless an actual failing protocol incompatibility proves it is required.

**Step 3: Write the development runbook**

`docs/cua/windows-source-development.md` must include:

```powershell
cd C:\Users\dev\zcode-cua
pnpm install
pnpm rebuild:native
pnpm build
pnpm test

cd C:\Users\dev\z-code
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
pnpm dev:desktop:prod
```

Also document:

- official `zcode-cua` plugin must be enabled;
- source changes require rebuilding `zcode-cua`, while ZCode product packaging is not required;
- expected process tree and named-pipe shape;
- log locations and token-redaction rule;
- Windows lock screen/Session 0 fail-closed behavior;
- Phase 1 limitation: AX tree present, screenshots absent;
- clean shutdown check.

**Step 4: Verify and commit**

Run:

```powershell
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
pnpm typecheck
pnpm lint
```

Expected: pass.

```powershell
git add packages/services/test/windowsCuaDevHelper.integration.test.ts docs/cua/windows-source-development.md
git diff --cached --check
git commit -m "test(cua): verify Windows source runtime"
```

---

### Task 8: Run the Notepad live acceptance and final gates

**Files:**

- No new implementation file by default.
- If runtime evidence exposes a bug, first add a focused failing test in the owning repository, then make the smallest fix and add a Chinese comment explaining the root cause.

**Step 1: Start from clean builds**

Run:

```powershell
cd C:\Users\dev\zcode-cua
pnpm rebuild:native
pnpm build
pnpm typecheck
pnpm lint
pnpm test

cd C:\Users\dev\z-code
pnpm typecheck
pnpm lint
pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts packages/services/test/windowsCuaDevHelperHost.test.ts packages/services/test/windowsCuaDevHelper.integration.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts
```

Expected: every command exits `0`.

**Step 2: Start ZCode source development**

```powershell
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
pnpm dev:desktop:prod
```

Confirm before invoking a CUA task:

- no Helper is created for remote hosts;
- local official plugin admission creates at most one Helper generation;
- process command line has entry/pipe/parent PID and no token;
- pipe is random under `\\.\pipe\zcode-cua-helper-*`.

**Step 3: Execute the Notepad scenario**

Use one ZCode task to:

1. call `list_apps`;
2. open `notepad.exe` without shell;
3. obtain the Notepad app/window and UIA state;
4. select the editor by element target;
5. click the editor;
6. type `ZCode Windows CUA Phase 1`;
7. re-observe and verify the text through UIA;
8. press `Ctrl+A`, type replacement text, and verify again.

Acceptance:

- element targeting is preferred over raw coordinates;
- click/type return refreshed state;
- no screenshot is required in Phase 1;
- no action is automatically replayed after an ambiguous post-send failure.

**Step 4: Exercise recovery and teardown**

While ZCode remains open:

1. end the Helper process;
2. wait for liveness recovery;
3. verify the next official CUA admission receives a new pipe/token and the same Host authority;
4. close ZCode;
5. confirm no Windows Helper child remains and the old pipe cannot be connected.

Expected: no orphan Helper and no stale credential reuse.

**Step 5: Inspect runtime evidence**

Check service logs and task rollout:

- startup, ready, health, restart and stop lifecycle are present at `info`/`warn`;
- per-request broker details are `debug` only;
- no bearer token appears;
- no macOS command, Helper.app, TCC, SSH, WSL or Docker path is attempted.

If the first live attempt fails, collect the actual service log, child stderr, process tree and broker error before changing code.

**Step 6: Run repository-wide mandatory gates**

In `C:\Users\dev\z-code`:

```powershell
pnpm typecheck
pnpm lint
pnpm test:unit:affected
```

In `C:\Users\dev\zcode-cua`:

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Expected: all exit `0`.

**Step 7: Review commit history and working trees**

Run:

```powershell
git -C C:\Users\dev\z-code status --short
git -C C:\Users\dev\zcode-cua status --short
git -C C:\Users\dev\z-code log --oneline -5
git -C C:\Users\dev\zcode-cua log --oneline -5
```

Expected: both worktrees clean; each task has an independently reviewable Conventional Commit.

Do not tag, publish, push a release, build a signed package or close Phase 2/3 in this plan.

---

## Completion Criteria

- `zcode-cua` builds `dist/windows-helper.js` and `build/Release/ax_native.node` on Windows.
- ZCode local Host starts exactly one on-demand Windows Helper using `process.execPath`.
- Helper receives token only through controlled env and publishes credentials only after health passes.
- Official plugin obtains pipe/token/authority; attacker-authored or unbrokered CUA configs remain fail-closed.
- Notepad UIA observe/click/type/re-observe succeeds without screenshots.
- Helper restart rotates pipe/token; Host authority stays stable.
- ZCode exit leaves no Helper child.
- macOS and Linux focused regression suites pass.
- ZCode `pnpm typecheck` and `pnpm lint` pass.
- `zcode-cua` typecheck, lint, full test and build pass on Windows.
- WGC, scroll/drag/move/down/up, UIA worker isolation and product packaging remain explicitly deferred to separate Phase 2/3 plans.
