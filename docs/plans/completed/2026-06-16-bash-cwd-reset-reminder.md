# Bash cwd reset reminder 实现计划

> **给执行 agent 的要求：** 实现时逐项执行本计划。每一步都用 checkbox 跟踪；执行代码变更前先补测试。推荐使用 `superpowers:executing-plans` 按任务执行。除非用户明确要求，不要自动 commit。

**目标：** 实现 Bash 主线程 cwd drift 处理：foreground Bash 成功执行后，如果最终 cwd 仍在项目边界内，就持久化 cwd；如果最终 cwd 漂到项目外，就把 runtime cwd reset 回项目根目录，并在 Bash provider-visible result 中追加 `Shell cwd was reset to <root>`。

**架构：** 不引入长驻 shell，也不新增全局 system-reminder。继续使用现有 `ExecutionResult.resolvedCwd` 捕获通道，在 Bash handler 内增加一个小的 cwd policy 层，集中决定是否更新 cwd、是否 reset、是否追加 Bash stderr 文案。其它工具、hooks、background Bash、failed Bash、timeout Bash 不消费该 policy。

**技术栈：** TypeScript、Vitest、`@zcode/contracts`、`@zcode/core`、现有 `ExecutionPort` cwd capture。

## 执行状态

已按当前实现复核完成。最终实现与原计划有两处有意收窄：

- 不再支持通过环境变量维持项目工作目录的额外分支（`maintainProjectWorkingDir`）；当前只实现 main foreground Bash cwd drift 行为。
- 不新增 runtime 级 subagent reset 测试；subagent 行为已在 Bash handler/policy 层覆盖，避免为了单个分支扩张 runtime harness。

2026-06-16 验证结果：

- `pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts tests/runtime-tool-loop.test.ts tests/bash-result-mapping.test.ts --reporter=dot` 通过，129 tests passed。
- `pnpm --filter @zcode/adapters exec vitest run tests/exec.test.ts --reporter=dot` 通过，52 tests passed / 2 skipped。
- `pnpm --filter @zcode/core typecheck` 通过。
- `pnpm --filter @zcode/adapters typecheck` 通过。
- `pnpm lint` 通过，0 errors / 66 warnings。
- `pnpm typecheck` 仍失败在仓库级历史 `@zcode/shared` export/type 问题；失败文件不在本次 Bash reset 实现面内。

---

## 目标行为

- 只有主线程（非 subagent）Bash 会改变会话 cwd；subagent Bash 不改变 cwd。
- 主线程 Bash 成功后检查最终 cwd 是否离开原始项目边界；离开时 reset 回原始 cwd，并把
  `<原 stderr 去首尾空白>\nShell cwd was reset to <root>` 作为 Bash result 的 stderr 暴露给 provider。
- reset 文案只出现在 Bash tool result 的 stderr 中，不是独立 system-reminder；模型 effort 等其他设置不影响该行为。

## 实现前 ZCode 状态

- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - foreground Bash 会设置 `captureCwdAfterSuccess: true`。
  - 成功且 `exitCode === 0` 时直接 `setWorkingDirectory(result.resolvedCwd)`。
  - 目前不会判断 `resolvedCwd` 是否离开 `workspaceRoot`，也不会追加 `Shell cwd was reset to ...`。
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
  - `workingDirectory` 可被 Bash 更新。
  - `workspaceRoot` 保持 session 初始工作区边界。
- `apps/zcode-cli/packages/core/src/tool/types.ts`
  - `ToolExecutionContext` 目前没有能区分主线程和 subagent 的 scope。

## 设计边界

- 只在 Bash handler 消费 `resolvedCwd`。executor、serializer、其它 tool 不做 cwd 推断。
- 只处理 foreground Bash；background Bash 继续不捕获、不更新 cwd。
- 只处理 `status === "completed"` 且 `exitCode === 0` 的结果；failed、timed out、cancelled 不触发 reset reminder。
- 只把 `taskType === "subagent_child"` 视为 subagent 分支。其它 runtime 先保持主线程语义，避免把 workflow / fork 的行为一起改掉。
- 不把 `resolvedCwd` 字段本身序列化给 provider；provider 只能看到 `Shell cwd was reset to <root>` 文案。
- `workspaceRoot` / session identity / persisted message `path.root` 不随 Bash `cd` 漂移。
- 路径包含判断必须兼容 macOS、Linux、Windows；不能用字符串 `startsWith`。

## 文件规划

- 修改：`apps/zcode-cli/docs/bash-cwd-persistence-plan.md`
  - 更新旧边界：provider-visible Bash output 会在 reset 场景追加 reset stderr。
- 修改：Bash conformance 矩阵（已删除，Bash 行为以 `apps/zcode-cli/docs/design/v2/tool/04-bash.md` 为准）
  - 更新 cwd reset case，标记为 production Bash handler 行为。
- 修改：`apps/zcode-cli/packages/core/src/tool/types.ts`
  - 增加窄 scope：`ToolRuntimeScope = "main" | "subagent"`。
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/types.ts`
  - 给 executor options/deps 增加 `runtimeScope`。
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
  - executor 默认 scope 为 `"main"`。
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
  - 把 scope 放入 `ToolExecutionContext`。
- 修改：`apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
  - `taskType === "subagent_child"` 时传 `runtimeScope: "subagent"`，其它场景传 `"main"`。
- 新增：`apps/zcode-cli/packages/core/src/tool/handlers/bash-cwd-policy.ts`
  - 集中实现 cwd update/reset/reminder 决策。
- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - 用 policy 替换直接 `setWorkingDirectory(result.resolvedCwd)`。
  - 在 `toBashOutput` 中通过参数追加 reset stderr。
- 修改：`apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
  - 增加 handler 层 cwd reset / subagent / env / Windows path 覆盖。
- 修改：`apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - 增加 runtime 端两次 Bash 调用的 cwd reset 回归。

---

## Task 1：先更新 spec 文档

**文件：**

- 修改：`apps/zcode-cli/docs/bash-cwd-persistence-plan.md`
- 修改：Bash conformance 矩阵（已删除，Bash 行为以 `apps/zcode-cli/docs/design/v2/tool/04-bash.md` 为准）

- [x] **Step 1：更新 cwd persistence 文档中的 provider-visible 边界**

在 `apps/zcode-cli/docs/bash-cwd-persistence-plan.md` 中把旧的“provider-visible Bash output 不变化”改成：

```md
### Provider-visible cwd reset

旧计划只实现了 Bash cwd persistence，没有实现 cwd reset reminder。现在边界更新为：main-thread foreground Bash 成功执行后，如果最终 cwd 离开 session project boundary，runtime 必须 reset 回 session root，并通过 Bash stderr 追加 `Shell cwd was reset to <root>`。

这不是独立 `<system-reminder>`，也不是 serializer 层拼出来的消息；它属于 Bash tool result 的 provider-visible content。`resolvedCwd` 仍然是内部字段，不允许直接进入 provider-visible output。
```

- [x] **Step 2：更新 conformance matrix 的 cwd reset 行**

在 Bash conformance 矩阵（已删除，Bash 行为以 `apps/zcode-cli/docs/design/v2/tool/04-bash.md` 为准） 中把 cwd reset case 更新为：

```md
| 20 | real shell execution | `commands that leave cwd outside the project append a shell reset message` | 命令 `cd /tmp` 离开项目 cwd 后，provider-visible result 附加 cwd reset 提示。 | planned | 在 Bash result stderr 中追加 `Shell cwd was reset to <root>`，不是单独 system-reminder。 | 在 Bash handler 消费 `resolvedCwd` 时执行 cwd policy：main foreground success 出界 reset 到 workspaceRoot 并追加 stderr；subagent/background/failed/timeout 不触发。 |
```

- [x] **Step 3：检查文档 diff**

运行：

```bash
git diff -- apps/zcode-cli/docs/bash-cwd-persistence-plan.md
```

预期：只有文档语义更新，没有代码改动。

---

## Task 2：给 tool context 增加最小 runtime scope

**文件：**

- 修改：`apps/zcode-cli/packages/core/src/tool/types.ts`
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- 修改：`apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- 修改：`apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`

- [x] **Step 1：在 tool context 里新增可选 scope**

在 `apps/zcode-cli/packages/core/src/tool/types.ts` 中增加：

```ts
export type ToolRuntimeScope = "main" | "subagent";
```

在 `ToolExecutionContext` 中增加可选字段：

```ts
  runtimeScope?: ToolRuntimeScope;
```

保持可选是为了减少无关测试和手写 context 的改动面；Bash policy 会把缺省值视为 `"main"`。

- [x] **Step 2：executor types 增加 scope**

在 `apps/zcode-cli/packages/core/src/tool/executor/types.ts` 中把 import 改为包含 `ToolRuntimeScope`：

```ts
import type {
  ExecutableToolCall,
  ReadFileStateMap,
  ToolBatchEvent,
  ToolExecutionResult,
  ToolRuntimeScope,
} from "../types.js";
```

在 `ToolExecutorOptions` 中增加：

```ts
  runtimeScope?: ToolRuntimeScope;
```

在 `ToolExecutorDeps` 中增加：

```ts
  runtimeScope: ToolRuntimeScope;
```

- [x] **Step 3：executor 默认 main**

在 `apps/zcode-cli/packages/core/src/tool/executor/impl.ts` 构造 `this.deps` 时增加：

```ts
      runtimeScope: options.runtimeScope ?? "main",
```

- [x] **Step 4：call-runner 传入 context**

在 `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts` 构造 `ToolExecutionContext` 时增加：

```ts
      runtimeScope: deps.runtimeScope,
```

- [x] **Step 5：AgentRuntime 映射 subagent scope**

在 `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 的 `createToolExecutor({...})` 参数中增加：

```ts
        runtimeScope: this.config.taskType === "subagent_child" ? "subagent" : "main",
```

这里不要用 `parentSessionId` 泛化判断。subagent 分支需要明确的子 agent 身份，ZCode 当前最贴近的明确语义是 `taskType === "subagent_child"`。

- [x] **Step 6：运行窄 type/test 验证**

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

预期：如果失败，应只剩测试 helper 需要补 `runtimeScope` 的类型问题；不应该出现其它工具行为变化。

---

## Task 3：新增 Bash cwd policy helper

**文件：**

- 新增：`apps/zcode-cli/packages/core/src/tool/handlers/bash-cwd-policy.ts`
- 修改：`apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

- [x] **Step 1：创建 helper 文件**

新增 `apps/zcode-cli/packages/core/src/tool/handlers/bash-cwd-policy.ts`：

```ts
import path from "node:path";
import type { ExecutionResult } from "@zcode/contracts";
import type { ToolRuntimeScope } from "../types.js";

export interface BashCwdPolicyInput {
  resolvedCwd: string | undefined;
  status: ExecutionResult["status"];
  exitCode: number | undefined;
  workspaceRoot: string;
  runtimeScope?: ToolRuntimeScope;
  maintainProjectWorkingDir?: boolean;
}

export interface BashCwdPolicyDecision {
  nextWorkingDirectory?: string;
  stderrSuffix?: string;
}

export function decideBashCwdPolicy(input: BashCwdPolicyInput): BashCwdPolicyDecision {
  if (input.status !== "completed") return {};
  if (input.exitCode !== 0) return {};
  if (!input.resolvedCwd) return {};
  if ((input.runtimeScope ?? "main") !== "main") return {};

  const workspaceRoot = normalizeCwdBoundary(input.workspaceRoot, choosePathApi(input.workspaceRoot));
  const resolvedCwd = normalizeCwdBoundary(
    input.resolvedCwd,
    choosePathApi(input.resolvedCwd, input.workspaceRoot),
  );

  if (input.maintainProjectWorkingDir) {
    return { nextWorkingDirectory: workspaceRoot };
  }

  if (isInsideOrSamePath(resolvedCwd, workspaceRoot)) {
    return { nextWorkingDirectory: resolvedCwd };
  }

  return {
    nextWorkingDirectory: workspaceRoot,
    stderrSuffix: `Shell cwd was reset to ${workspaceRoot}`,
  };
}

function isInsideOrSamePath(child: string, parent: string): boolean {
  const pathApi = choosePathApi(child, parent);
  const normalizedChild = normalizeCwdBoundary(child, pathApi);
  const normalizedParent = normalizeCwdBoundary(parent, pathApi);
  const relativePath = pathApi.relative(normalizedParent, normalizedChild);
  return relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath));
}

function choosePathApi(...values: string[]): typeof path.posix | typeof path.win32 {
  return values.some(looksLikeWindowsPath) ? path.win32 : path.posix;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function normalizeCwdBoundary(
  value: string,
  pathApi: typeof path.posix | typeof path.win32,
): string {
  let normalized = pathApi.normalize(value);
  if (pathApi === path.posix) {
    normalized = normalized
      .replace(/^\/private\/var\//, "/var/")
      .replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
  }
  return pathApi === path.win32 ? normalized.toLowerCase() : normalized;
}
```

- [x] **Step 2：补 helper 级测试入口**

如果 `bash-handler.test.ts` 里不适合直接测试 helper，可在同文件新增 `describe("Bash cwd policy", ...)`。覆盖这四个基础 case：

```ts
describe("Bash cwd policy", () => {
  it("keeps cwd when resolved cwd stays inside workspace", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/repo/subdir",
        workspaceRoot: "/repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "/repo/subdir" });
  });

  it("resets cwd and returns provider-visible stderr suffix when resolved cwd leaves workspace", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/outside",
        workspaceRoot: "/repo",
        runtimeScope: "main",
      }),
    ).toEqual({
      nextWorkingDirectory: "/repo",
      stderrSuffix: "Shell cwd was reset to /repo",
    });
  });

  it("does not update cwd for subagent scope", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/outside",
        workspaceRoot: "/repo",
        runtimeScope: "subagent",
      }),
    ).toEqual({});
  });

  it("handles Windows path containment case-insensitively", () => {
    expect(
      decideBashCwdPolicy({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "C:\\Repo\\Subdir",
        workspaceRoot: "c:\\repo",
        runtimeScope: "main",
      }),
    ).toEqual({ nextWorkingDirectory: "c:\\repo\\subdir" });
  });
});
```

- [x] **Step 3：运行测试确认先失败**（事后过账：实现已落地，未重新做 red-run；最终 green 验证见 Task 8）

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

预期：在 helper/import 尚未接入或断言不匹配时失败。失败必须来自 cwd policy 相关测试。

---

## Task 4：Bash handler 消费 policy

**文件：**

- 修改：`apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`

- [x] **Step 1：引入 policy**

在 `bash.ts` 顶部增加：

```ts
import { decideBashCwdPolicy } from "./bash-cwd-policy.js";
```

- [x] **Step 2：替换直接 setWorkingDirectory**（最终实现不包含维持项目工作目录的环境变量分支）

把当前逻辑：

```ts
  if (result.status === "completed" && result.exitCode === 0 && result.resolvedCwd) {
    // 修复原因：不复用 shell 进程，但成功 Bash 需要把最终 cwd 写回会话。
    await context.setWorkingDirectory?.(result.resolvedCwd);
  }
  return toBashOutput(result, parsed, context);
```

替换成：

```ts
  const cwdDecision = decideBashCwdPolicy({
    status: result.status,
    exitCode: result.exitCode,
    resolvedCwd: result.resolvedCwd,
    workspaceRoot: context.workspaceRoot,
    runtimeScope: context.runtimeScope,
  });
  if (cwdDecision.nextWorkingDirectory) {
    // 修复原因：主线程 Bash 成功后保留项目内 cwd；
    // 离开项目边界时 reset 回原始工作区，并把 reset 文案放进 Bash stderr。
    await context.setWorkingDirectory?.(cwdDecision.nextWorkingDirectory);
  }
  return toBashOutput(result, parsed, context, {
    stderrSuffix: cwdDecision.stderrSuffix,
  });
```

- [x] **Step 3：给 toBashOutput 增加 options**

把签名改为：

```ts
async function toBashOutput(
  result: ExecutionResult,
  input: BashInput,
  context: ToolExecutionContext,
  options: { stderrSuffix?: string } = {},
): Promise<BashOutput> {
```

把 stderr 构造改为：

```ts
  const stderr = appendStderrSuffix(result.stderr.text || result.error?.message || "", options.stderrSuffix);
```

在文件底部增加：

```ts
function appendStderrSuffix(stderr: string, suffix: string | undefined): string {
  if (!suffix) return stderr;
  return [stderr.trim(), suffix].filter(Boolean).join("\n");
}
```

- [x] **Step 4：运行 Bash handler 测试**

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

预期：cwd policy 单测和原有 Bash handler 测试通过；如果 `resolvedCwd` privacy 测试失败，需要按 Task 5 更新断言。

---

## Task 5：补齐 Bash handler 行为测试

**文件：**

- 修改：`apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

- [x] **Step 1：更新项目内 cwd persistence 测试**

现有 `"updates session cwd from successful foreground Bash execution"` 保持语义，只需要确保 `resolvedCwd` 在 workspace 内：

```ts
const nextCwd = resolve(projectRoot, "nested");
```

预期仍然是：

```ts
expect(observedCwd).toBe(nextCwd);
expect(content).not.toContain("Shell cwd was reset");
```

- [x] **Step 2：新增离开 workspace 的 reset 测试**

新增：

```ts
it("resets main Bash cwd to workspace root and exposes reset stderr when final cwd leaves workspace", async () => {
  const outsideCwd = resolve("/tmp/zcode-outside");
  let observedCwd: string | undefined;
  const executionPort: ExecutionPort = {
    async run() {
      return executionResult({
        status: "completed",
        exitCode: 0,
        resolvedCwd: outsideCwd,
        stdout: "done\n",
      });
    },
  };

  const output = (await bashHandler(
    { command: "cd /tmp/zcode-outside && echo done" } satisfies BashInput,
    contextWith(executionPort, {
      workingDirectory: projectRoot,
      workspaceRoot: projectRoot,
      setWorkingDirectory: (cwd) => {
        observedCwd = cwd;
      },
    }),
  )) as BashOutput;

  expect(observedCwd).toBe(projectRoot);
  expect(output.stderr).toBe(`Shell cwd was reset to ${projectRoot}`);
  expect(bashToolEntry.formatModelContent?.(output)).toBe(
    `done\nShell cwd was reset to ${projectRoot}`,
  );
  expect(JSON.stringify(output)).not.toContain("resolvedCwd");
  expect(JSON.stringify(output)).not.toContain(outsideCwd);
});
```

- [x] **Step 3：新增 subagent 不追加 reset 测试**

新增：

```ts
it("does not reset or expose cwd reminder for subagent Bash scope", async () => {
  let observedCwd: string | undefined;
  const executionPort: ExecutionPort = {
    async run() {
      return executionResult({
        status: "completed",
        exitCode: 0,
        resolvedCwd: "/tmp/subagent-outside",
        stdout: "child\n",
      });
    },
  };

  const output = (await bashHandler(
    { command: "cd /tmp/subagent-outside && echo child" } satisfies BashInput,
    contextWith(executionPort, {
      runtimeScope: "subagent",
      setWorkingDirectory: (cwd) => {
        observedCwd = cwd;
      },
    }),
  )) as BashOutput;

  expect(observedCwd).toBeUndefined();
  expect(output.stderr).toBe("");
  expect(bashToolEntry.formatModelContent?.(output)).toBe("child");
});
```

`contextWith` options 需要补：

```ts
    runtimeScope?: ToolExecutionContext["runtimeScope"];
```

返回值里补：

```ts
    runtimeScope: options.runtimeScope,
```

- [x] **Step 4：更新旧 privacy 测试**

旧测试 `"does not expose resolved cwd in provider-visible Bash content"` 如果使用 `/tmp/secret-cwd`，现在它会触发 reset reminder。改成 workspace 内路径：

```ts
const secretCwd = resolve(projectRoot, "secret-cwd");
```

断言仍然保持：

```ts
expect(JSON.stringify(output)).not.toContain("resolvedCwd");
expect(JSON.stringify(content)).not.toContain("resolvedCwd");
```

不要再断言 provider-visible content 不含任何 cwd 字符串，因为 reset 场景下本来就会暴露 root。

- [x] **Step 5：运行 handler 测试**

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts
```

预期：所有 Bash handler 测试通过。

---

## Task 6：补 runtime loop 回归

**文件：**

- 修改：`apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

- [x] **Step 1：保留已有项目内 cwd persistence 测试**

现有 `"persists successful foreground Bash cwd across tool calls"` 应继续通过：第一次 Bash resolved 到 workspace 内目录，第二次 Bash 的 `request.cwd` 应是该子目录。

- [x] **Step 2：新增离开 workspace 后 reset 回 root 的 runtime 测试**

新增测试：

```ts
it("resets Bash cwd to workspace root after a successful command leaves the workspace", async () => {
  const sessionId = createSessionId("runtime-bash-cwd-reset-reminder");
  const workspaceRoot = await mkdtemp(join(tmpdir(), "zcode-bash-root-"));
  const outsideCwd = await mkdtemp(join(tmpdir(), "zcode-bash-outside-"));
  const requests: ExecutionRequest[] = [];

  const executionPort: ExecutionPort = {
    async run(request) {
      requests.push(request);
      if (requests.length === 1) {
        return executionResult({
          status: "completed",
          exitCode: 0,
          stdout: "left\n",
          resolvedCwd: outsideCwd,
        });
      }
      return executionResult({
        status: "completed",
        exitCode: 0,
        stdout: "root\n",
      });
    },
  };

  const runtime = createRuntimeForToolLoop(
    {
      sessionId,
      mode: "yolo",
      workingDirectory: workspaceRoot,
      executionPort,
    },
  );

  await runOneTurnWithToolCalls(runtime, [
    {
      id: "tool_1",
      name: "Bash",
      input: { command: "cd /tmp && echo left" },
    },
    {
      id: "tool_2",
      name: "Bash",
      input: { command: "pwd" },
    },
  ]);

  expect(requests[0]?.cwd).toBe(workspaceRoot);
  expect(requests[1]?.cwd).toBe(workspaceRoot);
  expect(providerVisibleToolResultFor("tool_1")).toContain(
    `Shell cwd was reset to ${workspaceRoot}`,
  );
});
```

测试里的 helper 名称以当前文件已有工具为准；不要新造一套 runtime harness。

- [x] **Step 3：新增 subagent scope 不 reset 的窄测试**（按计划说明选择不扩张 runtime harness；handler/policy 层已覆盖）

如果当前 runtime test harness 能方便创建 `taskType: "subagent_child"`，增加一条测试确认 subagent runtime 不调用 reset reminder。若 harness 成本高，不要为了这条测试重构 runtime；保留 handler 级覆盖即可。

- [x] **Step 4：运行 runtime tests**

运行：

```bash
pnpm --filter @zcode/core test -- runtime-tool-loop.test.ts
```

预期：cwd persistence 旧测试通过，新 reset 测试通过。

---

## Task 7：检查 provider-visible 内容

**文件：**

- 修改：`apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- 可选修改：`apps/zcode-cli/packages/core/tests/bash-result-mapping.test.ts`

- [x] **Step 1：确认成功普通输出 shape**

新增或复用断言：

```ts
expect(bashToolEntry.formatModelContent?.({
  stdout: "ok\n",
  stderr: `Shell cwd was reset to ${projectRoot}`,
  interrupted: false,
  status: "completed",
  exitCode: 0,
} satisfies BashOutput)).toBe(`ok\nShell cwd was reset to ${projectRoot}`);
```

- [x] **Step 2：确认 failed/timeout 不追加 reset**

已有 failed/timed_out 测试需要补 provider-visible 断言：

```ts
expect(bashToolEntry.formatModelContent?.(output)).not.toContain("Shell cwd was reset");
```

- [x] **Step 3：确认 image 分支不被 cwd reset 扩大**（本次未新增 image cwd reset 行为；已有 image short-circuit 覆盖继续通过）

如果 stdout 是 image 且 cwd 出界，image 分支会 short-circuit。ZCode 当前 image 行为已经单独处理过；本次不要顺手改 image behavior。只验证普通 text Bash reset reminder，不新增 image cwd reset 行为。

- [x] **Step 4：运行相关测试**

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts bash-result-mapping.test.ts
```

预期：provider-visible text 符合上述 cwd reset 语义；没有新的 image / error output 变化。

---

## Task 8：完整验证和风险检查

**文件：**

- 不新增代码文件。
- 只运行验证命令和检查 diff。

- [x] **Step 1：检查 diff 范围**

运行：

```bash
git diff --stat
git diff -- apps/zcode-cli/packages/core/src/tool/handlers/bash.ts apps/zcode-cli/packages/core/src/tool/handlers/bash-cwd-policy.ts apps/zcode-cli/packages/core/src/tool/types.ts apps/zcode-cli/packages/core/src/tool/executor/types.ts apps/zcode-cli/packages/core/src/tool/executor/impl.ts apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts
```

预期：

- Bash handler 不再直接 set `resolvedCwd`。
- cwd reset policy 集中在 `bash-cwd-policy.ts`。
- executor 只透传 `runtimeScope`，不改变其它 tool。
- runtime 只把 `subagent_child` 映射为 `"subagent"`。

- [x] **Step 2：运行包级测试**

运行：

```bash
pnpm --filter @zcode/core test -- bash-handler.test.ts runtime-tool-loop.test.ts bash-result-mapping.test.ts
```

预期：通过。

- [x] **Step 3：运行 adapter cwd capture 测试，确认 executor 层没被破坏**

运行：

```bash
pnpm --filter @zcode/adapters test -- exec.test.ts
```

预期：已有 `captureCwdAfterSuccess` 行为仍通过；background 不捕获 cwd。

- [x] **Step 4：运行 typecheck/lint**（root `pnpm typecheck` 仍有无关历史失败，见执行状态）

运行：

```bash
pnpm --filter @zcode/core typecheck
pnpm typecheck
pnpm lint
```

预期：通过。如果 root `pnpm lint` 暴露无关历史问题，记录具体失败文件和是否与本次 diff 相关，不要顺手修无关模块。

- [x] **Step 5：可选 real-world session 验证**（已通过 `sess_3894adde-75bc-4be3-bde2-977020725c69` 覆盖；本次未重新跑）

用现有 `apps/zcode-cli/real-world-test-prompt` 下的 Bash prompt 跑一轮包含以下串行命令的 session：

```md
请串行执行以下 Bash tool call，不要做验证总结：

1. `pwd`
2. `mkdir -p /tmp/zcode-cwd-reset-check && cd /tmp/zcode-cwd-reset-check && pwd`
3. `pwd`
4. `cd "$PWD" && pwd`
```

执行后再用 prompt-trajectory 转 anthropic 轨迹，检查：

- 第 2 条 provider-visible result 包含 `Shell cwd was reset to <workspaceRoot>`。
- 第 3 条 Bash request cwd 回到 workspace root。
- 没有出现 `resolvedCwd` 字段泄漏。

## 不做的事

- 不实现长驻 shell 子进程。
- 不持久化 env / alias / function。
- 不新增全局 `SystemReminderSource`。
- 不让 serializer 根据 cwd 自动拼消息。
- 不让 hooks / configured commands / generic `mode: "shell"` 自动捕获 cwd。
- 不把 workflow/fork 统一当成 subagent；除非后续单独明确其子 agent 身份语义。
- 不自动 commit。

## 验收标准

- main foreground Bash 成功进入 workspace 内目录：下一次 Bash 从该目录执行；provider-visible output 不出现 reset reminder。
- main foreground Bash 成功进入 workspace 外目录：runtime cwd reset 到 workspace root；provider-visible Bash result 包含 `Shell cwd was reset to <workspaceRoot>`。
- subagent Bash、background Bash、failed Bash、timeout Bash 不触发 cwd reset reminder。
- `resolvedCwd` 仍然不进入 provider-visible content。
- Windows 风格路径大小写、盘符、反斜杠 containment 判断正确。
- macOS `/private/tmp`、`/private/var` alias 不导致误判。
- symlink workspace 下，`pwd -P` 返回的物理 child path 仍被识别为项目内 cwd，不误追加 reset。
- hooks/plugin shell command、generic `ExecutionPort` shell request、background Bash、subagent Bash、其它文件类 tools 不会自动消费 cwd policy。
- `pnpm --filter @zcode/core test -- bash-handler.test.ts runtime-tool-loop.test.ts bash-result-mapping.test.ts` 通过。
- `pnpm --filter @zcode/adapters test -- exec.test.ts` 通过。
- `pnpm typecheck` 和 `pnpm lint` 通过，或仅剩明确无关的历史失败并有记录。
