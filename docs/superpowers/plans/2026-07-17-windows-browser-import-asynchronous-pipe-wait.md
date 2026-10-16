# Windows Browser Import Asynchronous Pipe Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows Chrome App-Bound Cookie 导入在 controller 握手前因同步服务端管道调用异步等待 API 而必然失败的问题。

**Architecture:** 保留 broker → elevated controller → `LocalSystem` service 的现有进程与身份边界，只把 `CreatePipeServer` 创建的服务端命名管道切换为 `PipeOptions.Asynchronous`，使现有 `BeginWaitForConnection` / `EndWaitForConnection` 有界等待合法工作。客户端继续同步连接，ACL、超时、精确 PID、映像路径和一次性 token 校验全部保持不变。

**Tech Stack:** C#/.NET Framework `System.IO.Pipes`、TypeScript、Vitest、pnpm

## Global Constraints

- 所有通过 `BeginWaitForConnection` / `EndWaitForConnection` 实现有界等待的服务端命名管道必须用 `PipeOptions.Asynchronous` 创建；客户端连接保持同步。
- 不得扩大 pipe ACL、删除超时、放宽 PID/映像路径/token 校验，或改变 broker → controller → `LocalSystem` service 的身份边界。
- 失败原因只留在本地安全日志；UI、IPC 和公共错误码保持不变。
- 不得读取、记录或提交真实 Cookie、Chrome 主密钥、pipe/token、PID 或 helper 原始 stdout。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`；若遇到已知无关基线失败，记录完整命令、失败文件和本次受影响范围的补充校验结果。

---

### Task 1: 用 source contract 复现同步/异步模式不匹配

**Files:**
- Modify: `packages/desktop/test/windowsChromeAppBoundKey.test.ts`
- Test: `packages/desktop/test/windowsChromeAppBoundKey.test.ts`

**Interfaces:**
- Consumes: `Program.cs` 中的 `CreatePipeServer`、`ConnectPipeClient` 和 `WaitForConnection` 源码。
- Produces: BS-030 native source contract，锁定服务端 `PipeOptions.Asynchronous`、客户端 `PipeOptions.None` 和现有异步等待调用。

- [ ] **Step 1: 写入会失败的回归测试**

在 `windowsChromeAppBoundKey` describe 中加入：

```ts
it("服务端命名管道以异步模式创建以支持有界等待", async () => {
  const source = await readFile(
    join(import.meta.dirname, "../native/windows-browser-import-helper/Program.cs"),
    "utf8",
  );
  const serverStart = source.indexOf("private static NamedPipeServerStream CreatePipeServer");
  const clientStart = source.indexOf("private static NamedPipeClientStream ConnectPipeClient");

  expect(serverStart).toBeGreaterThanOrEqual(0);
  expect(clientStart).toBeGreaterThan(serverStart);
  const serverSource = source.slice(serverStart, clientStart);
  expect(serverSource).toContain("PipeOptions.Asynchronous");
  expect(serverSource).not.toContain("PipeOptions.None");
  expect(source).toContain(
    '".", pipeName, PipeDirection.InOut, PipeOptions.None, TokenImpersonationLevel.Impersonation',
  );
  expect(source).toContain("pipe.BeginWaitForConnection(null, null)");
});
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsChromeAppBoundKey.test.ts
```

Expected: 新增测试在 `expect(serverSource).toContain("PipeOptions.Asynchronous")` 失败；其余现有测试通过。该失败必须来自当前 `CreatePipeServer` 使用 `PipeOptions.None`，不能是路径、语法或 fixture 错误。

### Task 2: 最小化修复服务端管道打开模式

**Files:**
- Modify: `packages/desktop/native/windows-browser-import-helper/Program.cs:1054-1062`
- Test: `packages/desktop/test/windowsChromeAppBoundKey.test.ts`

**Interfaces:**
- Consumes: Task 1 的 BS-030 source contract。
- Produces: 仍由 `CreatePipeServer(string, bool, bool)` 返回的异步服务端 `NamedPipeServerStream`；方法签名和调用方不变。

- [ ] **Step 1: 写入最小实现和中文根因注释**

只替换服务端构造参数：

```csharp
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            // Bugfix 原因：WaitForConnection 使用 Begin/End 异步等待实现硬超时；同步管道会在
            // controller/service 接入前直接抛 InvalidOperationException，导致 Cookie 解密从未开始。
            PipeOptions.Asynchronous,
            4096,
            4096,
            security);
```

不得修改 `ConnectPipeClient` 的 `PipeOptions.None`，不得改 ACL、`PipeTimeoutMs`、`VerifyPipeClient` 或 token 读写。

- [ ] **Step 2: 运行定向测试并确认 GREEN**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsChromeAppBoundKey.test.ts
```

Expected: 14 tests passed；BS-030 测试证明服务端异步、客户端同步、`BeginWaitForConnection` 保留。

- [ ] **Step 3: 编译 Windows helper**

Run:

```powershell
pnpm --filter @zcode/desktop prepare:browser-import-helper
```

Expected: 输出 `[browser-import-helper] built ...zcode-browser-import-helper.exe`，C# 注释和 `PipeOptions.Asynchronous` 能被当前 Roslyn/.NET Framework 编译链接受。

- [ ] **Step 4: 更新验证状态**

将 `docs/browser-use/2026-07-13-browser-settings-spec.md` 的 BS-030 覆盖状态从：

```markdown
source contract 待补；签名实机待复验
```

改为：

```markdown
source contract automated；helper compiled；签名实机待复验
```

在同一文档的 Windows 实机证据段补充：最新签名包记录 `controller_handshake_failed`；同构 .NET 运行时探针确认 `PipeOptions.None` 调用 `BeginWaitForConnection` 抛出 “Pipe is not opened in asynchronous mode”；工作区 helper 修复已编译，真实 Cookie 和主密钥未进入日志，仍需下一签名包 smoke。

### Task 3: 机械验证、清理与交付

**Files:**
- Delete: `.tmp-controller-lifecycle-probe.ps1`
- Delete: `.tmp-controller-lifecycle-probe-result.txt`
- Delete: `.tmp-cross-account-path-probe.ps1`
- Delete: `.tmp-cross-account-path-probe-result.txt`
- Delete: `.tmp-cross-account-pipe-probe.ps1`
- Delete: `.tmp-cross-account-pipe-probe-result.txt`
- Delete: `.tmp-cross-account-pipe-probe-result.txt.client`
- Verify: repository-wide TypeScript and lint targets

**Interfaces:**
- Consumes: Tasks 1-2 的测试、helper 源码和更新后的 BS-030 状态。
- Produces: 无临时探针、可审查的 bugfix commit 和已推送分支。

- [ ] **Step 1: 运行受影响范围类型检查**

Run:

```powershell
pnpm exec tsc -p packages/desktop/tsconfig.host.json --noEmit
```

Expected: PASS。

- [ ] **Step 2: 运行仓库强制 typecheck**

Run:

```powershell
pnpm typecheck
```

Expected: PASS；若仍命中当前仓库已存在的 E2E `expect` 直接依赖缺失，只记录具体文件，并以 Step 1 和定向测试证明本次 desktop host/test 范围。

- [ ] **Step 3: 运行仓库强制 lint**

Run:

```powershell
pnpm lint
```

Expected: 0 errors；已有 warning 必须与本次改动无关，新增文件不得产生 warning。

- [ ] **Step 4: 复跑定向测试与编译并检查 diff**

Run:

```powershell
pnpm exec vitest run packages/desktop/test/windowsChromeAppBoundKey.test.ts
pnpm --filter @zcode/desktop prepare:browser-import-helper
git diff --check
git status --short
```

Expected: 14 tests passed；helper built；`git diff --check` 通过；状态只包含计划、测试、`Program.cs` 和 spec 状态更新。

- [ ] **Step 5: 清理临时运行时探针**

用 `apply_patch` 删除三个 `.ps1`，并在确认路径均位于 `C:\Users\dev\z-code` 后删除四个 `.txt` 结果文件。再次运行 `git status --short`，不得残留 `.tmp-*`。

- [ ] **Step 6: 提交实现**

Run:

```powershell
git add -- packages/desktop/test/windowsChromeAppBoundKey.test.ts packages/desktop/native/windows-browser-import-helper/Program.cs docs/browser-use/2026-07-13-browser-settings-spec.md docs/superpowers/plans/2026-07-17-windows-browser-import-asynchronous-pipe-wait.md
git commit -m "fix(desktop): open browser import server pipes asynchronously"
```

Expected: Conventional Commit 成功；临时探针和无关文件未暂存。

- [ ] **Step 7: 推送当前分支**

Run:

```powershell
git push origin feat/browser-use-web-app
```

Expected: `origin/feat/browser-use-web-app` 更新到实现提交；如果 pre-push 只命中已记录的无关基线失败，先报告具体证据，不自行绕过 hook。
