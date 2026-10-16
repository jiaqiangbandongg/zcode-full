# Bash Cwd Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Bash cwd 持久化语义：Bash tool 每次仍启动新 shell 进程，但成功命令结束后捕获最终 `pwd -P` 并写回当前 runtime 的 `workingDirectory`，让下一次 Bash/tool call 从更新后的 cwd 执行。

**Architecture:** 不引入长驻 shell 子进程，也不持久化 env / alias / function。只为 Bash foreground execution 增加一个内部 cwd capture 通道：execution adapter 在命令成功后写 cwd file，`ExecutionResult` 带回 `resolvedCwd`，Bash handler 通过 tool context 的窄 setter 更新 runtime cwd。若 main-thread foreground Bash 成功后 cwd 离开 session project boundary，则 reset 回 session root，并通过 Bash stderr 追加 `Shell cwd was reset to <root>`。

**Persistence boundary:** 本计划只更新当前 `AgentRuntime` 实例的 `workingDirectory`。暂不把 Bash `cd` 后的 cwd 写回 `SessionInfo.directory/path`：`directory` 目前还承担 session 列表和 `--continue` 发现过滤，`path` 承担 workspace/display/fork 归属语义；让它们跟随工具内 `cd` 漂移会改变 session 发现和工作区归属行为，影响面超过本计划的 Bash provider-visible 目标。`workspaceRoot` / `projectID` / persisted message `path.root` 都保持 context 初始化时的稳定工作区身份；只有执行语义里的 `workingDirectory` / message `path.cwd` 可以跟随 Bash `cd` 变化。

**Tech Stack:** TypeScript, Vitest, `@zcode/contracts`, `@zcode/adapters` NodeExecutionAdapter, `@zcode/core` Bash handler / ToolExecutor / AgentRuntime。

---

## 背景和基线

当前 zcode Bash prompt 声明 "Working directory persists between calls"，但生产路径没有把 Bash 执行后的 cwd 写回 runtime：

- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` 只把 `context.workingDirectory` 放进 `ExecutionRequest.cwd`。
- `apps/zcode-cli/packages/adapters/src/exec/index.ts` 执行完成后只返回 stdout/stderr/exit/status，没有返回最终 cwd。
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` 只读取 `deps.getWorkingDirectory()`，没有 `setWorkingDirectory()` 通道。
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 持有 `this.workingDirectory`，但 Bash tool 无法更新它。

目标行为不是复用同一个 shell 进程：每次 Bash call 都 spawn 新 shell，但 command wrapper 会追加：

```bash
eval <user command> && pwd -P > <cwdFile>
```

命令结束后主进程读取 `cwdFile`，如果 cwd 变化则更新内部 shell cwd。下一次 Bash call 仍然启动新 shell，只是 `cwd` 参数使用上一次记录的 cwd。

### Provider-visible cwd reset

旧计划只实现了 Bash cwd persistence，没有实现越界 cwd reset 提示。现在边界更新为：main-thread foreground Bash 成功执行后，如果最终 cwd 离开 session project boundary，runtime 必须 reset 回 session root，并通过 Bash stderr 追加 `Shell cwd was reset to <root>`。

这不是独立 `<system-reminder>`，也不是 serializer 层拼出来的消息；它属于 Bash tool result 的 provider-visible content。`resolvedCwd` 仍然是内部字段，不允许直接进入 provider-visible output。

## 非目标

- 不实现 shell provider 选择逻辑，本计划不处理 `/bin/sh` vs bash/zsh。
- 不实现 timeout auto-background。
- 不改变非 cwd reset 场景的 provider-visible `tool_result` content。
- 不让 hooks/plugin configured command 自动捕获 cwd。
- 不让 background Bash 更新 cwd。
- 不持久化 shell env、alias、function、shell option。
- 不把 Bash `cd` 写回 session store；恢复/继续语义需要单独设计，不能让 workspace 归属字段随工具内 cwd 漂移。

## 副作用隔离约束

这次实现必须把行为收敛在 Bash foreground execution 内，禁止把 cwd 持久化扩散成 generic shell / generic tool 行为。

- 对 Bash tool 的 foreground 调用，cwd capture 必须是默认开启行为；这是本次要实现的 Bash 语义。
- 对 generic execution adapter / generic `mode: "shell"` request，`captureCwdAfterSuccess` 必须默认关闭；现阶段只有 `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` 可以为 foreground Bash 显式设置它。
- `apps/zcode-cli/packages/core/src/hooks/configured-runner.ts` 里的 configured hooks 继续走原有 `mode: "shell"`，不得设置 `captureCwdAfterSuccess`，不得更新 runtime cwd。
- `NodeExecutionAdapter` 不得把所有 `mode: "shell"` 默认包 cwd wrapper；只有 request 显式带 `captureCwdAfterSuccess: true` 时才包。
- cwd capture file 使用系统临时目录，不能复用 persisted output 目录，避免输出目录不可写时改变 Bash 执行成功率。
- `setWorkingDirectory` 只作为 Bash handler 消费 `result.resolvedCwd` 的内部通道；executor 不做“看到 output 里有 cwd 就自动更新”的 generic 推断。
- Bash `cd` 只更新当前 runtime 的 `workingDirectory`；`workspaceRoot` 保持 context 初始化时的工作区边界，避免后续 Read/Edit/Glob/Agent 等工具把 workspace 归属随 cwd 漂移。
- `resolvedCwd` 不得写入 `BashOutput`，不得进入 `formatBashModelContent`、tool result serializer、history persistence 的 provider-visible content；只有真正 reset 时可以暴露 `Shell cwd was reset to <root>` 文案。
- Bash failed / timed_out / cancelled / spawn_error / backgrounded 都不得更新 cwd。
- Bash tool metadata 当前 `concurrentSafe: false`，本实现不改变并发调度语义；如果未来允许并行 Bash，再单独设计 cwd update ordering。
- Windows 也必须支持 cwd capture，但实现要使用 `cmd.exe` 兼容语法，不能把 POSIX wrapper 套到 Windows shell 上。第一版只覆盖默认 `cmd.exe` / `ComSpec` 路径；如果未来 Bash tool 支持显式 PowerShell shell，再单独补 PowerShell wrapper。

## 文件职责

- `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
  - 扩展 execution request/result 的内部 cwd capture contract。
- `apps/zcode-cli/packages/adapters/src/exec/index.ts`
  - 在 NodeExecutionAdapter 里调用 cwd capture plan，并把 `resolvedCwd` 回填到 result。
- `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
  - 封装 Bash cwd wrapper 生成、cwd file 读取、realpath 校验和临时文件清理。
- `apps/zcode-cli/packages/core/src/tool/types.ts`
  - 在 `ToolExecutionContext` 增加可选 cwd setter。
- `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
  - 在 executor options/deps 增加可选 `setWorkingDirectory`。
- `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
  - 把 cwd setter 注入 tool context。
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
  - 提供 setter，把合法 cwd 写入当前 runtime 实例；同时保留稳定 `workspaceRoot`，供 project identity 和 message root 使用。
- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - Bash foreground request 开启 cwd capture，成功后消费 `result.resolvedCwd`。
- `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
  - 覆盖 adapter 层 cwd capture。
- `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
  - 覆盖 Bash handler 是否调用 cwd setter。
- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - 覆盖 runtime 级跨 Bash call cwd 持久化。

## Task 1: 扩展 Execution Contract

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`

- [ ] **Step 1: 写 contract 字段**

在 `ExecutionRequest` 增加：

```ts
  /**
   * Internal state capture. Defaults to false and must only be enabled by the
   * Bash tool for foreground executions. This must not be used for hooks or
   * generic shell commands.
   */
  captureCwdAfterSuccess?: boolean;
```

在 `ExecutionResult` 增加：

```ts
  /**
   * Final real cwd captured after a successful command. This is internal runtime
   * state and must not be serialized into provider-visible tool output.
   */
  resolvedCwd?: string;
```

- [ ] **Step 2: 跑 contract typecheck**

Run:

```bash
pnpm --filter @zcode/contracts typecheck
```

Expected: PASS。

## Task 2: Adapter 捕获成功命令的最终 cwd

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Add: `apps/zcode-cli/packages/adapters/src/exec/cwd-capture.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

- [ ] **Step 1: 先写失败测试：成功 shell command 返回 resolvedCwd**

在 `exec.test.ts` 增加测试，使用临时目录和真实 `NodeExecutionAdapter`：

```ts
it("captures final cwd for successful foreground shell commands when requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-"));
  const child = join(root, "child");
  await mkdir(child);

  try {
    const adapter = new NodeExecutionAdapter();
    const result = await adapter.run({
      command: {
        mode: "shell",
        command: `cd ${JSON.stringify(child)}`,
      },
      cwd: root,
      captureCwdAfterSuccess: true,
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.resolvedCwd).toBe(await realpath(child));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 写默认 shell request 不捕获 cwd 的测试**

这个测试保证 generic `mode: "shell"` 行为不变，避免影响 hooks 或其它未来 shell caller：

```ts
it("does not capture cwd for generic shell commands by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-default-"));
  const child = join(root, "child");
  await mkdir(child);

  try {
    const adapter = new NodeExecutionAdapter();
    const result = await adapter.run({
      command: {
        mode: "shell",
        command: `cd ${JSON.stringify(child)}`,
      },
      cwd: root,
    });

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.resolvedCwd).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

需要补充 imports：

```ts
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 3: 写失败命令不更新 cwd 的测试**

```ts
it("does not capture cwd when the shell command exits non-zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-exec-cwd-fail-"));
  const child = join(root, "child");
  await mkdir(child);

  try {
    const adapter = new NodeExecutionAdapter();
    const result = await adapter.run({
      command: {
        mode: "shell",
        command: `cd ${JSON.stringify(child)}; false`,
      },
      cwd: root,
      captureCwdAfterSuccess: true,
    });

    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(1);
    expect(result.resolvedCwd).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: 写 Windows 不启用 POSIX cwd capture 的测试**

这个测试避免第一版改动 Windows shell 行为：

```ts
it("does not wrap Windows shell commands for POSIX cwd capture", () => {
  const resolved = resolveExecutionCommand(
    {
      mode: "shell",
      command: "cd C:\\repo",
    },
    {
      env: {
        COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      },
      platform: "win32",
    },
  );

  expect(resolved).toEqual({
    args: [],
    file: "cd C:\\repo",
    shell: "C:\\Windows\\System32\\cmd.exe",
  });
});
```

如果最终把 wrapper helper 独立导出为可测函数，则改为直接断言 Windows `createSpawnPlan(...).cwdFilePath === undefined`。

- [ ] **Step 5: 跑测试确认失败**

Run:

```bash
pnpm --filter @zcode/adapters test -- tests/exec.test.ts
```

Expected: FAIL，失败原因是 `resolvedCwd` 还没有实现。

- [ ] **Step 6: 实现 cwd wrapper**

在 `NodeExecutionAdapter.spawnChild()` 之前构造 cwd capture plan，不直接改写 request。cwd capture 细节放在 `src/exec/cwd-capture.ts`，避免继续膨胀 `index.ts`。

```ts
interface CwdCapturePlan {
  command: ExecutionCommand;
  cwdFilePath?: string;
}
```

新增 helper 行为：

```ts
function createCwdCapturePlan(
  request: ExecutionRequest,
  platform: NodeJS.Platform,
): CwdCapturePlan {
  if (
    request.captureCwdAfterSuccess !== true ||
    request.command.mode !== "shell" ||
    platform === "win32"
  ) {
    return { command: request.command };
  }

  const cwdCaptureDir = tmpdir();
  mkdirSync(cwdCaptureDir, { recursive: true });
  const cwdFilePath = join(cwdCaptureDir, `zcode-${crypto.randomUUID()}-cwd`);
  const wrappedCommand = `${request.command.command}\n__zcode_status=$?\nif [ "$__zcode_status" -eq 0 ]; then pwd -P > ${shellQuote(cwdFilePath)}; fi\nexit "$__zcode_status"`;

  return {
    command: {
      ...request.command,
      command: wrappedCommand,
    },
    cwdFilePath,
  };
}
```

增加 `shellQuote(value: string)`，只用于 POSIX cwd file path：

```ts
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
```

中文注释要写在 wrapper 附近：

```ts
// 修复原因：Bash prompt 声明 cwd 跨调用保留，但执行后从未写回 runtime cwd。
// 每次 Bash 仍启动新 shell；成功后只把最终 pwd -P 写回主进程，不能持久化 env/alias/function。
// 默认 shell、hooks、background command 不走这个分支，避免改变其它执行面。
```

- [ ] **Step 7: 把 cwdFilePath 回填到 result**

在 `run()` 中保存 `cwdFilePath`，在 child 完成后读取：

```ts
const resolvedCwd = readCapturedCwd(cwdFilePath);
```

`readCapturedCwd` 要满足：

```ts
function readCapturedCwd(cwdFilePath?: string): string | undefined {
  if (!cwdFilePath) return undefined;
  try {
    const value = readFileSync(cwdFilePath, "utf8").replace(/\r?\n$/u, "");
    if (!value) return undefined;
    const stats = statSync(value);
    if (!stats.isDirectory()) return undefined;
    return realpathSync(value);
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(cwdFilePath);
    } catch {
      // ignore cleanup failure
    }
  }
}
```

同步 fs imports 需要补上 `readFileSync`, `realpathSync`, `statSync`, `unlinkSync`。

- [ ] **Step 8: 跑 adapter 测试**

Run:

```bash
pnpm --filter @zcode/adapters test -- tests/exec.test.ts
```

Expected: PASS。

## Task 3: Tool Context 增加 cwd setter

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`

- [ ] **Step 1: 扩展类型**

在 `ToolExecutionContext` 增加：

```ts
  setWorkingDirectory?: (cwd: string) => void | Promise<void>;
```

在 `ToolExecutorOptions` 和 `ToolExecutorDeps` 增加：

```ts
  setWorkingDirectory?: (cwd: string) => void | Promise<void>;
```

注意：不要在 executor 中根据任意 tool output 自动调用该 setter。调用点只允许出现在 Bash handler。

- [ ] **Step 2: call-runner 注入 context**

在构造 `context` 时加入：

```ts
      setWorkingDirectory: deps.setWorkingDirectory,
```

- [ ] **Step 3: runtime 提供 setter**

在 `AgentRuntime` 创建 tool executor deps 的位置加入：

```ts
        setWorkingDirectory: (cwd) => {
          this.workingDirectory = cwd;
        },
```

中文注释写在 setter 旁边：

```ts
        // Bash 成功执行后会回写 cwd；只更新当前 runtime 实例，避免污染父 agent 或其他 session。
```

- [ ] **Step 4: 跑 core typecheck**

Run:

```bash
pnpm --filter @zcode/core typecheck
```

Expected: PASS。

## Task 4: Bash Handler 消费 resolvedCwd

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

- [ ] **Step 1: 先写 handler 测试：foreground 成功更新 cwd**

在 `bash-handler.test.ts` 增加：

```ts
it("updates session cwd from successful foreground Bash execution", async () => {
  const nextCwd = resolve("/tmp/zcode-next-cwd");
  let observedCwd: string | undefined;
  let capturedRequest: ExecutionRequest | undefined;
  const executionPort: ExecutionPort = {
    async run(request) {
      capturedRequest = request;
      return executionResult({
        status: "completed",
        exitCode: 0,
        resolvedCwd: nextCwd,
      });
    },
  };

  await bashHandler(
    { command: "cd /tmp/zcode-next-cwd" } satisfies BashInput,
    contextWith(executionPort, {
      setWorkingDirectory: (cwd) => {
        observedCwd = cwd;
      },
    }),
  );

  expect(capturedRequest?.captureCwdAfterSuccess).toBe(true);
  expect(observedCwd).toBe(nextCwd);
});
```

`contextWith` helper 需要支持 `setWorkingDirectory` override。

- [ ] **Step 2: 写 background 不更新 cwd 的测试**

```ts
it("does not capture or update cwd for background Bash execution", async () => {
  let observedCwd: string | undefined;
  let capturedRequest: ExecutionRequest | undefined;
  const executionPort: ExecutionPort = {
    async run() {
      throw new Error("run should not be used for background execution");
    },
    async start(request) {
      capturedRequest = request;
      return {
        taskId: "exec_bg",
        status: "running",
        startedAt: new Date(),
      };
    },
  };

  await bashHandler(
    { command: "cd /tmp", run_in_background: true } satisfies BashInput,
    contextWith(executionPort, {
      setWorkingDirectory: (cwd) => {
        observedCwd = cwd;
      },
    }),
  );

  expect(capturedRequest?.captureCwdAfterSuccess).toBeUndefined();
  expect(observedCwd).toBeUndefined();
});
```

- [ ] **Step 3: 写 failed / timed_out 不更新 cwd 的测试**

```ts
it.each([
  ["failed", executionResult({ status: "failed", exitCode: 1, resolvedCwd: "/tmp/ignored" })],
  ["timed_out", executionResult({ status: "timed_out", timedOut: true, resolvedCwd: "/tmp/ignored" })],
])("does not update cwd for %s Bash results", async (_name, result) => {
  let observedCwd: string | undefined;
  const executionPort: ExecutionPort = {
    async run() {
      return result;
    },
  };

  await bashHandler(
    { command: "cd /tmp && false" } satisfies BashInput,
    contextWith(executionPort, {
      setWorkingDirectory: (cwd) => {
        observedCwd = cwd;
      },
    }),
  );

  expect(observedCwd).toBeUndefined();
});
```

- [ ] **Step 4: 跑测试确认失败**

Run:

```bash
pnpm --filter @zcode/core test -- tests/bash-handler.test.ts
```

Expected: FAIL，失败原因是 Bash request 未设置 capture 或未消费 `resolvedCwd`。

- [ ] **Step 5: 实现 Bash handler 更新**

`createExecutionRequest` 中：

```ts
    captureCwdAfterSuccess: input.run_in_background ? undefined : true,
```

`bashHandler` foreground run 后，在 `toBashOutput` 前消费：

```ts
  if (result.status === "completed" && result.exitCode === 0 && result.resolvedCwd) {
    await context.setWorkingDirectory?.(result.resolvedCwd);
  }
```

中文注释：

```ts
  // 修复原因：Bash 不复用 shell 进程，需要把成功 Bash 的最终 cwd 写回会话，后续调用才从新 cwd 执行。
  // 这里仅更新内部 runtime cwd，不改变 provider-visible Bash output。
```

- [ ] **Step 6: 跑 handler 测试**

Run:

```bash
pnpm --filter @zcode/core test -- tests/bash-handler.test.ts
```

Expected: PASS。

## Task 5: Runtime 级回归测试

**Files:**
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

- [ ] **Step 1: 写跨 Bash call cwd 持久化测试**

增加 runtime integration 测试，使用 fake execution port 观察第二次 cwd：

```ts
it("persists Bash cwd updates across tool calls in the same runtime", async () => {
  const root = resolve("/tmp/zcode-runtime-cwd-root");
  const child = resolve(root, "child");
  const observedCwds: string[] = [];
  const executionPort: ExecutionPort = {
    async run(request) {
      observedCwds.push(request.cwd ?? "");
      if (observedCwds.length === 1) {
        return executionResult({
          status: "completed",
          exitCode: 0,
          resolvedCwd: child,
        });
      }
      return executionResult({
        status: "completed",
        exitCode: 0,
        stdout: request.cwd ?? "",
      });
    },
  };

  const runtime = createRuntimeForTest({
    executionPort,
    workingDirectory: root,
  });

  await runSingleToolCall(runtime, {
    id: "toolu_cd",
    name: "Bash",
    input: { command: "cd child" },
  });
  await runSingleToolCall(runtime, {
    id: "toolu_pwd",
    name: "Bash",
    input: { command: "pwd" },
  });

  expect(observedCwds).toEqual([root, child]);
});
```

如果现有 `runtime-tool-loop.test.ts` 没有完全相同的 helper，复用该文件已有 runtime factory 和 tool-call 驱动方式，不新增第二套 runtime harness。

- [ ] **Step 2: 跑 runtime 测试**

Run:

```bash
pnpm --filter @zcode/core test -- tests/runtime-tool-loop.test.ts
```

Expected: PASS。

## Task 6: 副作用回归测试

**Files:**
- Test: `apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

- [ ] **Step 1: configured hooks 不设置 cwd capture**

在现有 configured hook 测试附近断言 hook request 没有开启 cwd capture：

```ts
expect(capturedRequest?.captureCwdAfterSuccess).toBeUndefined();
```

如果当前测试没有暴露 `capturedRequest`，只修改该测试的 fake `ExecutionPort.run` 收集 request，不新增第二套 hook harness。

- [ ] **Step 2: Bash provider-visible output 不包含 resolvedCwd**

在 `bash-handler.test.ts` 增加：

```ts
it("does not expose resolved cwd in provider-visible Bash content", async () => {
  const executionPort: ExecutionPort = {
    async run() {
      return executionResult({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/secret-cwd",
        stdout: "ok\n",
      });
    },
  };

  const output = (await bashHandler(
    { command: "cd /tmp/secret-cwd && echo ok" } satisfies BashInput,
    contextWith(executionPort),
  )) as BashOutput;

  const content = bashToolEntry.formatModelContent?.(output);
  expect(content).toBe("ok");
  expect(JSON.stringify(output)).not.toContain("resolvedCwd");
  expect(JSON.stringify(content)).not.toContain("secret-cwd");
});
```

- [ ] **Step 3: Bash contract metadata 不改变并发语义**

在 `tool-contracts.test.ts` 中确认：

```ts
expect(bashToolEntry.metadata.concurrentSafe).toBe(false);
```

这个断言防止 cwd 持久化上线时顺手把 Bash 并发语义打开，造成 cwd update ordering 风险。

- [ ] **Step 4: 跑副作用回归测试**

Run:

```bash
pnpm --filter @zcode/core test -- tests/tool-executor-trace.test.ts tests/bash-handler.test.ts tests/tool-contracts.test.ts
```

Expected: PASS。

## Task 7: 验证和回归范围

- [ ] **Step 1: 跑 focused tests**

Run:

```bash
pnpm --filter @zcode/contracts typecheck
pnpm --filter @zcode/adapters test -- tests/exec.test.ts
pnpm --filter @zcode/core test -- tests/bash-handler.test.ts
pnpm --filter @zcode/core test -- tests/runtime-tool-loop.test.ts
pnpm --filter @zcode/core test -- tests/tool-executor-trace.test.ts tests/tool-contracts.test.ts
```

Expected: all PASS。

- [ ] **Step 2: 跑 touched package typecheck/lint**

Run:

```bash
pnpm --filter @zcode/adapters typecheck
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/adapters lint
pnpm --filter @zcode/core lint
```

Expected: all PASS。

- [ ] **Step 3: 可选真实 smoke**

在 zcode CLI 可运行环境中执行一个最小真实轨迹：

```bash
zcode --prompt "Use Bash to run: mkdir -p /tmp/zcode-cwd-smoke/child && cd /tmp/zcode-cwd-smoke/child. Then use Bash to run: pwd."
```

Expected: 第二个 Bash result 的 stdout 是 `/tmp/zcode-cwd-smoke/child`。

## Shell / cwd 依赖影响梳理

| 依赖方 | 当前依赖 | 本次影响评估 |
| --- | --- | --- |
| Bash foreground | 由 Bash handler 设置 `shellProfile: "posix-bash"` 和 `captureCwdAfterSuccess: true`，成功后消费 `ExecutionResult.resolvedCwd`。 | 受影响且符合预期：main scope 项目内 cwd 持久化；项目外 cwd reset 到 `workspaceRoot` 并追加 reset stderr。 |
| Bash background | Bash handler 走 `executionPort.start`，request 不设置 cwd capture；adapter `start()` 也会移除 capture 字段。 | 不更新 cwd，不追加 reset；background stdout/stderr path 行为保持原状。 |
| subagent Bash | `AgentRuntime` 把 `taskType: "subagent_child"` 映射为 `runtimeScope: "subagent"`。 | 不消费 `resolvedCwd`，不 reset，不追加 provider-visible cwd 文案，subagent 不改变 cwd。 |
| failed / timeout / cancelled / spawn_error Bash | adapter 只在 `status === "completed" && exitCode === 0` 时返回 `resolvedCwd`；policy 也只接受该状态。 | 不更新 cwd，不追加 reset，避免失败命令污染会话 cwd。 |
| configured hooks / plugin command hooks | hooks 直接调用 `ExecutionPort.run({ command: { mode: "shell" } })`，不设置 `shellProfile` 或 `captureCwdAfterSuccess`。 | 不捕获 cwd，不更新 runtime cwd；只会继续使用当前 runtime cwd 作为 hook 执行目录。 |
| generic `ExecutionPort` shell request | contract 默认 `captureCwdAfterSuccess` 为 false，`cwd-capture` 只在显式 true 且 `mode: "shell"` 时生效。 | 默认行为不变；非 Bash caller 不会因为 shell mode 自动持久化 cwd。 |
| Read/Edit/Write/Glob/Grep/Agent/Workflow 等 tool | 通过 `context.workingDirectory` 和稳定 `context.workspaceRoot` 做路径解析或权限边界。 | 只会看到 Bash 成功更新后的执行 cwd；workspace root / project identity 不随 cwd 漂移。 |
| MCP / memory / hooks context / history persistence | 读取 runtime 当前 `workingDirectory`；message `path.root` 使用稳定 `workspaceRoot`。 | message `path.cwd` 可反映 Bash cwd；`path.root`、project id、session discovery 不改变。 |
| symlink workspace | context root 可能是用户传入的 symlink，cwd capture 使用 `pwd -P` / realpath 得到物理路径。 | policy 统一比较逻辑路径和 realpath 等价边界，避免把项目内物理 child 误判成项目外。 |
| Windows shell | foreground cwd capture 使用 cmd-compatible wrapper；cwd policy 在生产路径使用当前 Node 运行平台，不向 `ToolExecutionContext` / executor 透传 platform；Windows path 归一化由共享 tool path normalizer 覆盖 drive-letter、extended drive prefix、Git Bash `/c/...` alias。 | 默认 cmd/ComSpec 路径继续可用；POSIX wrapper 不会套到 Windows shell 上；Windows path 归一化不再由 Bash 单独维护，也不会根据 path 字符串反推平台；helper 单测可显式传入 `win32` 覆盖 Windows 分支。 |

## 风险清单

| 风险 | 控制方式 |
| --- | --- |
| 失败命令也改变 cwd | wrapper 只在 exit code 0 时写 cwd file。 |
| provider-visible output 变化 | `resolvedCwd` 只在内部 context setter 消费，不进入 `BashOutput`；只有 main foreground 成功离开项目边界时追加 reset stderr。 |
| background command 改变 session cwd | background request 不设置 `captureCwdAfterSuccess`，handler 不消费 cwd。 |
| hooks/plugin 被影响 | 只由 Bash handler 开启 capture；generic `mode: "shell"` 默认行为不变。 |
| 其它 tool 误用 setter | executor 不自动调用 setter；只有 Bash handler 消费 `resolvedCwd`。 |
| provider-visible 内容泄漏 cwd | `resolvedCwd` 不进入 `BashOutput`；增加 formatter/serializer 回归测试。 |
| 并发 Bash 更新顺序不确定 | 保持 Bash `concurrentSafe: false`，本计划不改变调度语义。 |
| cwd file 泄漏 | adapter 读取后 `finally` 删除；读取失败也删除。 |
| subagent 污染 main runtime cwd | setter 只更新当前 runtime 实例。 |
| Windows 行为偏移 | 默认 `cmd.exe` / `ComSpec` shell 已使用 cmd-compatible wrapper 捕获 cwd；PowerShell / Git Bash shell provider 仍作为后续独立范围。 |

## 完成标准

- Bash foreground 成功执行 `cd` 后，同一 runtime 后续 tool call 使用新 cwd。
- Bash failed / timeout / cancelled / background 不更新 cwd。
- main foreground Bash 成功离开 workspace boundary 时，provider-visible Bash result 追加 `Shell cwd was reset to <root>`；其它 cwd 场景不新增文案。
- hooks/configured shell command 不受影响。
- 非 Bash tools 和 generic `mode: "shell"` request 默认行为不变。
- Bash `concurrentSafe` 保持 `false`。
- Focused tests 和 touched package typecheck/lint 全部通过。
