# WSL Lifecycle Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 deploy lock release 增加 deadline，并用 workspace generation/ACK 消除 pooled WSL workspace 快速重连与旧 release 的竞态。

**Architecture:** deploy lock 只收口本次 owner stream，5 秒未 close 即销毁流并返回可诊断错误；不直接 dispose backend。WSL Main/Host 增加 acquire/release generation 协议，Main 只有在 Host 确认旧 release 已失效或完成后才 attach 新 RPC port。

**Tech Stack:** TypeScript、Electron UtilityProcess postMessage、Zod runtime schema、Vitest、真实 Windows + WSL。

## Global Constraints

- 所有 workspace 隔离使用 `workspaceIdentity?.trim() || workspacePath`。
- desktop attachment 保持 `desktop-continuous`，手机 attachment 保持 `web-remote-replayable`。
- Docker/Server 保持 dedicated，SSH pool 行为不变。
- app quit/window close/update install 仍绕过 60 秒 TTL 并回收完整 Host。
- 执行 `pnpm typecheck` 与 `pnpm lint`。

---

### Task 1: Deploy lock release deadline

**Files:**

- Modify: `packages/server/src/remote/remoteDeployLock.ts`
- Modify: `packages/server/src/remote/deploy.ts`
- Test: `packages/server/test/remoteDeployLock.test.ts`
- Test: `packages/server/test/remoteDeploy.test.ts`

**Interfaces:**

- `AcquireRemoteDeployLockOptions.releaseTimeoutMs?: number`，默认 `5_000`。
- `RemoteDeployLockHandle.release()` 在 deadline 内 resolve/reject；timeout 错误包含 owner 与 deadline。

- [x] 写 close 永不触发的失败测试，断言 deadline 后 reject 且 stdin/stdout/stderr 被 destroy。
- [x] 运行 `pnpm vitest run packages/server/test/remoteDeployLock.test.ts`，确认 RED 为 release Promise 未 settle。
- [x] 实现有界 close wait 和 owner stream best-effort destroy；重复 release 继续幂等。
- [x] 增加 deploy/release 双失败测试，用 `AggregateError` 保留两个错误。
- [x] 运行两份定向测试并确认 GREEN。

### Task 2: Workspace generation/ACK protocol

**Files:**

- Modify: `packages/shared/src/channels.ts`
- Modify: `packages/shared/src/validation.ts`
- Modify: `packages/shared/test/validation.test.ts`
- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Test: `packages/desktop/test/desktopRemoteSessions.test.ts`
- Test: host lifecycle test selected by repository search

**Interfaces:**

- Main → Host `AcquireRemoteWorkspace { requestId, generation, workspacePath, workspaceIdentity? }`。
- Main → Host `ReleaseRemoteWorkspace` 增加正整数 `generation`。
- Host → Main `RemoteWorkspaceAcquired { requestId, generation, workspacePath, workspaceIdentity?, ok, error? }`。

- [x] 先扩展 schema 测试，确认新消息在 schema 未实现时 RED。
- [x] 写 close → release pending → reopen 测试，断言 ACK 前不发送 AttachServicePort。
- [x] 写 stale generation/pending release Host 测试，断言 acquire 使旧 pending release 失效；in-flight release 完成后才 ACK。
- [x] 实现 Main generation、10 秒 ACK waiter、Host generation state 与串行 release。
- [x] 验证 Host exit/cancel/app shutdown reject waiter，mobile owner 使用绑定 session generation。
- [x] 运行 shared/desktop/host 定向测试并确认 GREEN。

### Task 3: Documentation, self-review, and runtime verification

**Files:**

- Modify: `docs/architecture/zcode-code-architecture-overview.md`
- Modify: `docs/wsl-remote-workspace-design.md`
- Modify: `docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md`

- [x] 自审状态所有权、消息乱序、重复 release/acquire、Host exit、timeout 与 app shutdown。
- [x] 自审补充修复 Acquire ACK 失败/超时后的 pending connect 残留，避免窗口清理重复释放 pool owner。
- [x] 自审 SSH/Docker/Server、desktop continuous/mobile replayable、workspaceIdentity 边界。
- [x] 运行所有定向测试、`pnpm typecheck`、`pnpm lint`。
- [x] 真实 Ubuntu/WSL 验证 lock release deadline 正常路径和 workspace close/reopen PID/日志时序。
- [ ] 提交 Conventional Commit，推送当前分支并核对远端 hash。

### Task 4: Acquire 后 attachment 失败的事务补偿

**Files:**

- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Test: `packages/desktop/test/desktopRemoteSessions.test.ts`

- [x] 写 desktop acquire ACK 成功、renderer port 转移失败的测试；断言 RED 为缺少 `ReleaseRemoteWorkspace`。
- [x] 补充 ACK 成功后 pending connect 被取消的竞态测试，确保不 attach 且补偿 release。
- [x] 在调用方记录 acquired generation，attachment 失败时补偿释放 workspace runtime，再释放 pool owner。
- [x] 将 mobile workspace generation 校验提前到 MessageChannel 创建与 Host port 转移前。
- [x] 运行定向测试、typecheck、lint，并自审 attachment 异常、取消竞态与 mobile port 转移顺序。

### Task 5: Canonical WSL pool identity 与 deploy-lock acquire deadline

**Files:**

- Modify: `packages/server/src/remote/wsl-backend.ts`
- Modify: `packages/server/src/remote/remoteDeployLock.ts`
- Modify: `packages/server/src/remote/deploy.ts`
- Create: `packages/desktop/src/main/desktopWslTargetResolver.ts`
- Modify: `packages/desktop/src/main/desktopRemoteSessions.ts`
- Test: `packages/desktop/test/desktopRemoteSessions.test.ts`
- Test: `packages/desktop/test/desktopWslTargetResolver.test.ts`
- Test: `packages/server/test/remoteDeployLock.test.ts`
- Test: `packages/server/test/wslBackend.test.ts`

- [x] 写 default/explicit 等价 target 并发连接测试，断言 RED 为 resolver 未调用且 spawn 两个 WSL Host。
- [x] 写 lock acquire marker 永不出现的 deadline 测试，断言 RED 为 Promise 不 settle。
- [x] 实现可注入 canonical WSL resolver，resolved target 后才进入 pool，并在 await 后重检 teardown。
- [x] WSL resolver 返回列表 canonical distro 与 `id -un` 实际 user，失败 Promise 不固化。
- [x] acquire deadline 默认 120 秒并由 DeployOptions 透传；超时只销毁 waiter owned stream。
- [x] 运行定向测试、typecheck、lint，复审 platform/lifecycle。
- [x] 真实 WSL 曾短暂返回 `CreateVm/HCS/0x800705aa`；环境恢复后复验 default/explicit 均解析为 `Ubuntu/dev`。
- [x] 提交并推送。

## 2026-07-21 运行态证据

- 环境：Windows + WSL2 Ubuntu，Desktop 版本 `3.4.0`，远端 server `3.4.0`。
- 清理历史孤儿基线：旧 `zcode-server` PID `1160`（运行约 7 小时）被精确终止，随后确认无 server 进程。
- 首次连接：session `ee2d9a74-a9f0-4ef5-a019-bf9c811aca41` 成功；WSL `zcode-server` PID `1156`，Windows pooled Host PID `15120`，launcher PID `24620`。
- 快速重连：关闭旧 session 后 `1.6ms` 发起同 workspace 重连，`77.1ms` 成功得到 session `d4a7de35-f4db-45c8-994f-e23efa23a506`；WSL server 仍为 PID `1156`，未启动第二份 server。
- 整窗关闭：通过 CDP 关闭唯一窗口后，不等待 60 秒 TTL，Electron main PID `25820` 与 WSL server PID `1156` 均在 4 秒内消失。
- deploy lock 正常收口：连接与重连后 `~/.zcode/.deploy.lock` 不存在；未观察到 lock-holder 残留。
- canonical identity：直接运行 `WSLBackend.resolveIdentity()` 得到 `Ubuntu/dev`；并发解析 default target 与
  显式 `{ distro: "ubuntu", user: "dev" }` 均返回 `{ distro: "Ubuntu", user: "dev" }`，`equal=true`。

## Task 6：pending WSL owner 幂等释放

- [x] 两个 logical connection 共享同一 Host，其中一个停留在 acquire 并按 requestId 取消；RED 捕获 `attach-error:idle-timeout` 误销毁。
- [x] pending owner 的 cancel/acquire error/connect error/attach error 统一走幂等 release。
- [x] 定向测试、typecheck、lint、自审、提交并推送。

## Task 7：WSL spawn lifecycle gate

- [x] 预热 resolved identity 后让 availability discovery pending，dispose 完成后恢复 discovery；RED 证明旧逻辑仍会 spawn。
- [x] `exec()` 在最终同步 spawn 前重新检查 disposed，保证 barrier 后不再登记新 child。
- [x] 定向测试、typecheck、lint、自审、提交并推送。

## Task 8：abandoned WSL acquire generation 补偿释放

- [x] timeout/cancel 测试断言立即发送同 generation Release；晚到成功 ACK 再次补偿且永不 attach，先观察 RED。
- [x] pending connect 保存 context/generation，以幂等 helper 收口本地放弃路径；unmatched 成功 ACK 执行安全补偿。
- [x] pending Host reject 统一复用 owner release helper。
- [x] 定向测试、typecheck、lint、自审、提交并推送。

## Task 9：合并目标分支的 manifest deadline 与 GLM SHA 身份

- [x] 确认当前分支缺失 `manifestRequestTimeoutMs` 完整透传和 GLM artifact SHA 决策链。
- [x] 合入最新 `origin/main`，保留 deploy-lock acquire/release deadline 与锁内复查。
- [x] 单次 deploy 固定 fresh manifest，将同一 SHA 快照透传到 GLM 决策与 release cache。
- [x] 运行 manifest timeout、同版本不同 SHA、deploy lock 定向回归。
- [x] 运行 typecheck、lint、diff check，并反向对照 `origin/main` 远程部署能力。
- [x] 独立代码审查未发现 Critical/High/Medium，提交并推送。
