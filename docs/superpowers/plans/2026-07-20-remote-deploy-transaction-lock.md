# Remote Deploy Transaction Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让跨 Host/跨进程的远端部署在同一 install root 内串行执行，并消除目录上传固定归档和最终目录交错替换。

**Architecture:** 新建 remote lock-holder，以远端原子 `mkdir`、UUID owner、30 秒心跳和 600 秒 stale takeover 管理 `${REMOTE_BASE}/.deploy.lock`；`deployServer` 在锁内重新执行部署判断并完成全部组件安装。LocalUpload、RemoteDownload 和开发态目录安装分别使用 owner 唯一 archive/extract staging，失败时只清理自己的路径。

**2026-07-23 SSH 例外：** 桌面端当前只有单窗口，同一窗口与 SSH target 复用 shared SSH host readiness；在不考虑多个客户端部署到同一 SSH install root，并接受断线后旧远端命令可能与重连短暂重叠的产品前提下，桌面 `InitRemoteSshHost` shared-host 调用声明 caller-side serialization 并跳过 remote lock-holder。Dedicated SSH runtime、WSL、Docker 和未显式声明 caller-side serialization 的调用继续执行本计划定义的远端锁。

**Tech Stack:** TypeScript、Vitest、POSIX shell、`IRemoteBackend` stdio。

## Global Constraints

- 除桌面 shared SSH host 明确声明 caller-side serialization 外，锁覆盖完整 `deployServer` transaction，不能缩小到单个 asset installer。
- workspace/distro/user install root 仍为 `~/.zcode/server`，不调用 `wsl --terminate`。
- owner token 必须不可预测；释放和 stale takeover 不使用宽泛 glob。
- 保持 WSL、Docker 以及仍使用锁的 SSH 调用的 POSIX backend 兼容，不依赖 `flock`、GNU `mv -T` 或系统 tar。
- 完成前运行定向测试、`pnpm typecheck` 和 `pnpm lint`。

---

### Task 1: Remote deploy lock-holder

**Files:**
- Create: `packages/server/src/remote/remoteDeployLock.ts`
- Test: `packages/server/test/remoteDeployLock.test.ts`

**Interfaces:**
- Produces: `acquireRemoteDeployLock(backend, options?): Promise<RemoteDeployLockHandle>`。
- Produces: `RemoteDeployLockHandle.release(): Promise<void>`，重复 release 幂等。

- [x] **Step 1: 写失败测试**

  测试 command 含原子 `mkdir`、owner token、30 秒 heartbeat、600 秒 stale 判定和 owner-checked cleanup；用可控 stdio backend 验证 acquired marker 前 Promise 不 resolve、marker 后 resolve、release 写入 owner token 并等待 close。

- [x] **Step 2: 运行测试并确认 RED**

  Run: `pnpm vitest run packages/server/test/remoteDeployLock.test.ts`

  Expected: FAIL，模块或 `acquireRemoteDeployLock` 不存在。

- [x] **Step 3: 实现最小 lock-holder**

  ```ts
  export interface RemoteDeployLockHandle {
    ownerToken: string;
    release(): Promise<void>;
  }

  export async function acquireRemoteDeployLock(
    backend: IRemoteBackend,
    options?: { lockDir?: string; ownerToken?: string },
  ): Promise<RemoteDeployLockHandle>;
  ```

  stdout 只在看到 `zcode-deploy-lock-acquired:<owner>` 后 resolve；stream 提前关闭则 reject。release 写入
  `zcode-deploy-lock-release:<owner>\n` 并结束 stdin，随后等待 lock-holder close。

- [x] **Step 4: 运行测试并确认 GREEN**

  Run: `pnpm vitest run packages/server/test/remoteDeployLock.test.ts`

  Expected: PASS。

### Task 2: Deploy transaction 与 lock 内版本复查

**Files:**
- Modify: `packages/server/src/remote/deploy.ts`
- Test: `packages/server/test/remoteDeploy.test.ts`

**Interfaces:**
- Consumes: `acquireRemoteDeployLock()`。
- Produces: `deployServer()` 在持锁后调用 `checkServerDeployDecision()`，并在所有成功/失败出口 release。

- [x] **Step 1: 写失败测试**

  注入可控 lock backend：第一个部署判断返回需要部署，等待 lock 时模拟另一个 owner 已完成；获得 lock 后第二次判断返回版本匹配，断言没有 upload 且 lock 被释放。再让 installer 失败，断言异常路径仍释放 lock。

- [x] **Step 2: 运行测试并确认 RED**

  Run: `pnpm vitest run packages/server/test/remoteDeploy.test.ts`

  Expected: FAIL，当前部署判断只执行一次或没有 lock-holder 命令。

- [x] **Step 3: 接入完整 transaction**

  `deployServer()` 获取 lock 后再计算 `serverDeployDecision`；`options.force` 保持强制部署语义，普通等待者根据 lock 内复查结果进入 skip/repair 路径；`finally` 无条件 release。

- [x] **Step 4: 运行测试并确认 GREEN**

  Run: `pnpm vitest run packages/server/test/remoteDeploy.test.ts`

  Expected: PASS。

### Task 3: Owner 唯一目录 staging 与清理

**Files:**
- Modify: `packages/server/src/remote/remoteAssetInstaller.ts`
- Modify: `packages/server/src/remote/zcodeAgentDevDeploy.ts`
- Test: `packages/server/test/remoteAssetInstaller.test.ts`
- Test: `packages/server/test/remoteDeploy.test.ts`

**Interfaces:**
- Consumes: deploy-root transaction lock 保证最终目录替换串行。
- Produces: 每次目录部署唯一 `remoteArchivePath`、`extractRoot`、`stagingDir`；失败 cleanup 只引用这些 owner 路径。

- [x] **Step 1: 写失败测试**

  并发调用两次 LocalUpload `installDirectory()`，断言两个 remote tar/extract 路径不同；断言命令包含 owner cleanup trap。开发态目录上传断言不再使用固定 `packages.tar.gz`；RemoteDownload 断言唯一 staging 只在 transaction lock 内执行。

- [x] **Step 2: 运行测试并确认 RED**

  Run: `pnpm vitest run packages/server/test/remoteAssetInstaller.test.ts packages/server/test/remoteDeploy.test.ts`

  Expected: FAIL，LocalUpload 和开发态仍复用固定 tar。

- [x] **Step 3: 实现目录 staging 与失败清理**

  LocalUpload 先上传到 `${remoteDir}.tar.gz-<owner>`，解压到 `${remoteDir}.extract-<owner>`，从其中的 basename
  目录移动到最终位置；shell trap 和上传失败 catch 都只清理这两个路径。开发态采用相同 owner 规则；
  RemoteDownload 保留现有 unique staging，并补明确 transaction-lock 注释和失败 cleanup trap。

- [x] **Step 4: 完整验证并提交**

  Run:

  ```powershell
  pnpm vitest run packages/server/test/remoteDeployLock.test.ts packages/server/test/remoteAssetInstaller.test.ts packages/server/test/remoteDeploy.test.ts
  pnpm typecheck
  pnpm lint
  ```

  Expected: exit code 0；随后提交 `fix(remote): serialize remote asset deployment` 并推送当前分支。
