# Bash Background Auto-Background Narrow Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 撤掉这轮 Bash background 中新增的 generic `runBackgroundable` 抽象，把 Bash timeout auto-background 收回 Bash 专属路径，并复用已有 background notification / wake / runtime command queue。

**Architecture:** 保留现有 `ExecutionPort.run()`、`ExecutionPort.start()`、`getBackgroundTask()`、`cancelBackgroundTask()` 作为公共 execution 边界；新增能力只作为 Bash handler 与 Node execution adapter 之间的窄结构化 capability，不扩展公共 `ExecutionPort`。Bash auto-background 只负责“同一个前台进程超时后转后台任务”，完成后仍通过 `BackgroundTaskTracker` 走现有 task-notification、runtime wake、runtime command queue 和 post-turn goal driver。

**Tech Stack:** TypeScript, Vitest, pnpm, `@zcode/contracts`, `@zcode/adapters`, `@zcode/core`, current workspace source only.

## Global Constraints

- 只参考当前工作区源码和 `docs/bash-background-parity.md`；不参考其它分支。
- 不自动提交；本计划和执行过程都不包含 `git commit`，除非用户在当前任务里明确要求。
- 不新增 generic foreground-promotion API；禁止继续扩展 `ExecutionPort.runBackgroundable`、`BackgroundableExecutionRunOptions`、`BackgroundableExecutionRunResult`。
- 不把 Bash auto-background 的内部落盘细节暴露为调用方可见的 `persistOutput: "always"` 语义。
- 不新增 feature flag、兜底 timer、poller 特殊策略或手动 background 操作入口。
- 新增代码、测试名、注释、provider-visible 文案只使用本地语义命名，不引入外部产品名。
- 每个 phase 开始前先重新阅读本 plan 的当前 phase，执行 `git status --short`，确认没有用户新改动被覆盖。
- 每个 phase 完成后必须跑本 phase 的指定单测和类型检查；失败时停在当前 phase，不进入下一 phase。

---

## Current Refactor Target

当前工作区里 Bash background WIP 已经实现了大部分 notification/wake/queue 能力，但 auto-background 入口过宽：

- `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts` 新增了 `runBackgroundable`、`waitForBackgroundTask`、`BackgroundableExecution*` 类型。
- `apps/zcode-cli/packages/adapters/src/exec/index.ts` 在 `NodeExecutionAdapter.runBackgroundable()` 内做 foreground completion 和 timeout promotion。
- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts` 通过 `executionPort.runBackgroundable()` 调用 auto-background，并强制 `persistOutput: "always"`。
- `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts` 已经能发 Bash `local_bash` task notification，并且可以用 direct waiter 避免 Bash poller。

目标形态：

- 公共 `ExecutionPort` 不再出现 `runBackgroundable` / `BackgroundableExecution*`。
- Bash handler 只通过 Bash 专属 capability 调用 auto-background，例如 `runBashWithAutoBackground(request, options)`。
- 这个 capability 不是 generic execution contract，只服务 Bash handler；其它调用方继续用 `run()` 或 `start()`。
- Bash auto-background 继续复用现有 `BackgroundTaskTracker`、`formatTaskNotification({ taskType: "local_bash" })`、`enqueueBackgroundTaskNotification`、runtime command queue。

## File Structure

- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
  - 移除 generic auto-background 类型和接口方法。
  - 保留已有 `BackgroundExecutionStartResult`、`BackgroundExecutionSnapshot`、`ExecutionPort.start/getBackgroundTask/cancelBackgroundTask`。

- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
  - 删除 `NodeExecutionAdapter.runBackgroundable()`。
  - 新增窄方法 `runBashWithAutoBackground(request, options)`，只处理 Bash timeout promotion。
  - 保留 class 上的 `waitForBackgroundTask(taskId, options?)` 作为内部结构化 capability，但不放回公共 `ExecutionPort`。
  - 把 foreground artifact cleanup 限定在 Bash auto-background 内部强制落盘场景，不能破坏普通 `run()` 的 `persistOutput` 语义。

- Create: `apps/zcode-cli/packages/core/src/tool/handlers/bash-auto-background.ts`
  - 放 Bash handler 使用的窄类型、type guard 和 wrapper。
  - 让 `bash.ts` 不直接写 structural cast。

- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - 移除 `createAutoBackgroundExecutionRequest()` 和 `restoreForegroundOutputPersistence()`。
  - 改为调用 `runBashWithOptionalAutoBackground()`。
  - 保留 explicit `run_in_background` 走 `executionPort.start()`。

- Modify: `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
  - 把 direct waiter 的类型判断改为本文件内部 structural capability，不依赖 `ExecutionPort["waitForBackgroundTask"]`。
  - Bash direct waiter 存在时继续不用 poller；不存在时保留原 `getBackgroundTask()` fallback。

- Modify: tests
  - `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
  - `apps/zcode-cli/packages/core/tests/bash-run-conformance.test.ts`
  - `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

- Modify: docs
  - `docs/bash-background-parity.md`
  - Keep this plan as execution checklist: `docs/superpowers/plans/2026-07-01-bash-background-refactor.md`

---

## Phase 0: Baseline And Target Behavior Recheck

**Purpose:** 在动代码前重新确认当前 diff 和目标 Bash background 行为，避免按过期结论继续 patch。

**Files:** no code changes in this phase.

**Checklist**

- [ ] **Step 0.1: Confirm dirty worktree**

Run:

```bash
git status --short
```

Expected:

- 能看到当前 Bash background WIP 文件。
- 如果出现本 plan 外的新文件或用户新改动，先停下来读 diff。

- [ ] **Step 0.2: Confirm generic abstraction is current WIP, not HEAD baseline**

Run:

```bash
git show HEAD:apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts | rg -n "runBackgroundable|BackgroundableExecution|waitForBackgroundTask|BackgroundExecution" -C 2
```

Expected:

- 只能看到 `BackgroundExecution*`、`start()`、`getBackgroundTask()`、`cancelBackgroundTask()`。
- 不应看到 `runBackgroundable` 或 `BackgroundableExecution*`。

- [ ] **Step 0.3: Confirm current WIP references to remove or narrow**

Run:

```bash
rg -n "runBackgroundable|BackgroundableExecution|autoBackgroundOnTimeout|waitForBackgroundTask" apps/zcode-cli/packages docs/bash-background-parity.md
```

Expected:

- 列出当前 WIP 中待重构引用。
- 后续 phase 完成后，`runBackgroundable|BackgroundableExecution|autoBackgroundOnTimeout` 在 `apps/zcode-cli/packages` 下应为 0。

- [ ] **Step 0.4: Recheck target Bash background facts**

Run:

```bash
rg -n "assistantAutoBackgrounded|backgroundTaskId|persistedOutputPath|run_in_background|TaskOutput" apps/zcode-cli/packages/contracts/src/tools/bash.ts docs/bash-background-parity.md
```

Expected:

- Bash output schema includes `backgroundTaskId`, `backgroundedByUser`, `assistantAutoBackgrounded`, `persistedOutputPath`.
- Bash auto-background call path is Bash tool owned, not generic public execution contract.
- Task output path is task-owned and model is notified with task output path after backgrounding.

**Phase 0 Pass Criteria**

- Current abstraction source and target behavior are re-confirmed.
- No code changed.

---

## Phase 1: Test Desired Narrow Boundary First

**Purpose:** 先把测试从 generic API 改到 Bash 专属 capability，形成重构目标的失败测试。

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/bash-run-conformance.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`

**Interfaces:**

- Produces expected method name: `runBashWithAutoBackground(request: ExecutionRequest, options?: ExecutionRunOptions): Promise<BashAutoBackgroundRunResult>`
- Produces expected direct waiter shape: `waitForBackgroundTask(taskId: string, options?: { signal?: AbortSignal }): Promise<BackgroundExecutionSnapshot | undefined>`

**Checklist**

- [ ] **Step 1.1: Replace adapter test entrypoint**

In `apps/zcode-cli/packages/adapters/tests/exec.test.ts`, rename auto-background tests so they call `runBashWithAutoBackground` instead of `runBackgroundable`.

Use this structural helper in the test file:

```ts
type BashAutoBackgroundCapableAdapter = NodeExecutionAdapter & {
  runBashWithAutoBackground?: (
    request: ExecutionRequest,
    options?: ExecutionRunOptions,
  ) => Promise<
    | { kind: "completed"; result: ExecutionResult }
    | {
        assistantAutoBackgrounded: true;
        kind: "backgrounded";
        task: BackgroundExecutionStartResult;
      }
  >;
  waitForBackgroundTask?: (
    taskId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<BackgroundExecutionSnapshot | undefined>;
};
```

Add one explicit boundary assertion near the first auto-background adapter test:

```ts
expect("runBackgroundable" in adapter).toBe(false);
expect(typeof capable.runBashWithAutoBackground).toBe("function");
```

- [ ] **Step 1.2: Replace Bash handler conformance fake**

In `apps/zcode-cli/packages/core/tests/bash-run-conformance.test.ts`, change the fake execution port test from `runBackgroundableCalled` to `runBashWithAutoBackgroundCalled`.

The fake method should return:

```ts
async runBashWithAutoBackground() {
  runBashWithAutoBackgroundCalled = true;
  return {
    assistantAutoBackgrounded: true,
    kind: "backgrounded" as const,
    task: {
      outputPath: "/tmp/zcode-bash-output.log",
      startedAt: new Date(),
      status: "running" as const,
      taskId: "exec_auto_background",
    },
  };
}
```

Expected assertion:

```ts
expect(runBashWithAutoBackgroundCalled).toBe(true);
expect(output.status).toBe("backgrounded");
expect(output.assistantAutoBackgrounded).toBe(true);
```

- [ ] **Step 1.3: Add no-generic-contract regression**

In `apps/zcode-cli/packages/core/tests/tool-contracts.test.ts`, add a runtime shape check that Bash provider schema still exposes background result fields but does not rely on execution-port generic promotion.

Use this expectation style:

```ts
expect(BashOutputJsonSchema.properties).toHaveProperty("backgroundTaskId");
expect(BashOutputJsonSchema.properties).toHaveProperty("assistantAutoBackgrounded");
expect(BashInputJsonSchema.properties).toHaveProperty("run_in_background");
```

Do not assert any provider-visible field for `runBackgroundable`; it must remain implementation-only and absent from tool schema.

- [ ] **Step 1.4: Run focused tests and confirm failure**

Run:

```bash
../../node_modules/.bin/vitest run packages/adapters/tests/exec.test.ts -t "auto-background|foreground results foreground|persisted output"
../../node_modules/.bin/vitest run packages/core/tests/bash-run-conformance.test.ts -t "auto-backgrounds eligible foreground commands"
```

Expected:

- Fails because `NodeExecutionAdapter.runBashWithAutoBackground` does not exist yet.
- Fails because `bashHandler` still calls `runBackgroundable`.

**Phase 1 Pass Criteria**

- Tests encode the desired narrow API.
- Failure reason is missing/old API only, not unrelated behavior.

---

## Phase 2: Remove Generic Public ExecutionPort Surface

**Purpose:** 从公共 contracts 移除 generic foreground-promotion API，先把边界收窄。

**Files:**

- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
- Modify imports in `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Modify imports in affected tests

**Checklist**

- [ ] **Step 2.1: Remove generic types from contracts**

Delete these declarations from `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`:

```ts
export interface BackgroundableExecutionRunOptions extends ExecutionRunOptions {
  autoBackgroundOnTimeout?: {
    taskId?: string;
    enabled: boolean;
  };
}

export type BackgroundableExecutionRunResult = ...
```

- [ ] **Step 2.2: Remove generic methods from `ExecutionPort`**

Remove these optional methods from `ExecutionPort`:

```ts
waitForBackgroundTask?(
  taskId: string,
  options?: { signal?: AbortSignal },
): Promise<BackgroundExecutionSnapshot | undefined>;
runBackgroundable?(
  request: ExecutionRequest,
  options?: BackgroundableExecutionRunOptions,
): Promise<BackgroundableExecutionRunResult>;
```

Keep:

```ts
start?(
  request: ExecutionRequest,
  options?: ExecutionRunOptions,
): Promise<BackgroundExecutionStartResult>;
getBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
cancelBackgroundTask?(taskId: string): Promise<BackgroundExecutionSnapshot | undefined>;
```

- [ ] **Step 2.3: Remove stale imports**

In `apps/zcode-cli/packages/adapters/src/exec/index.ts`, remove imports of:

```ts
BackgroundableExecutionRunOptions,
BackgroundableExecutionRunResult,
```

- [ ] **Step 2.4: Typecheck contracts**

Run:

```bash
cd apps/zcode-cli/packages/contracts && ../../../../node_modules/.bin/tsc --noEmit
```

Expected:

- PASS.

**Phase 2 Pass Criteria**

- `ExecutionPort` no longer exposes generic auto-background.
- Contracts typecheck passes.

---

## Phase 3: Add Bash-Specific Auto-Background Capability In NodeExecutionAdapter

**Purpose:** 保留同进程 timeout promotion 能力，但把它限定为 Bash 专属 adapter capability。

**Files:**

- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Modify: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

**Interfaces:**

Add local adapter-only types near the existing background task types in `index.ts`:

```ts
interface BashAutoBackgroundRunOptions extends ExecutionRunOptions {}

type BashAutoBackgroundRunResult =
  | {
      kind: "completed";
      result: ExecutionResult;
    }
  | {
      assistantAutoBackgrounded: true;
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };
```

Add class method:

```ts
async runBashWithAutoBackground(
  request: ExecutionRequest,
  options: BashAutoBackgroundRunOptions = {},
): Promise<BashAutoBackgroundRunResult>
```

**Checklist**

- [ ] **Step 3.1: Rename and narrow method**

In `NodeExecutionAdapter`, replace `runBackgroundable()` with `runBashWithAutoBackground()`.

Required semantic changes:

- Remove `autoBackgroundOnTimeout` options object.
- Use `request.timeoutMs ?? DEFAULT_TIMEOUT_MS` as the auto-background threshold.
- If threshold is `<= 0`, return `{ kind: "completed", result: await this.run(request, options) }`.
- Generate task id internally with `exec_${crypto.randomUUID()}`.
- Do not accept caller-supplied task id.

- [ ] **Step 3.2: Keep forced persistence internal**

Inside `runBashWithAutoBackground()`, create an internal run request:

```ts
const originalPersistOutput = request.outputLimit?.persistOutput ?? "none";
const runRequest: ExecutionRequest = {
  ...request,
  timeoutMs: 0,
  outputLimit: {
    ...request.outputLimit,
    persistOutput: "always",
  },
};
```

This internal `persistOutput: "always"` must not be created in `bash.ts`.

- [ ] **Step 3.3: Normalize foreground completion**

Replace `cleanupAutoBackgroundForegroundArtifacts()` with a narrower helper:

```ts
private normalizeBashAutoBackgroundForegroundResult(
  result: ExecutionResult,
  paths: ExecutionOutputPaths,
  originalPersistOutput: OutputPersistenceMode,
): ExecutionResult
```

Required behavior:

- If `originalPersistOutput === "always"`, return `result` unchanged.
- If `originalPersistOutput === "on_truncate"`, preserve artifact metadata only for streams where `stream.truncated === true`; delete internal non-truncated output files.
- If `originalPersistOutput === "none"`, delete internal output files and remove artifact metadata from both streams unless the stream is truncated by existing output-limit semantics.

- [ ] **Step 3.4: Keep output-limit kill only after promotion**

Preserve the current fixed behavior:

```ts
let backgrounded = false;
let persistedLimitReached = false;

const backgroundRunOptions: InternalExecutionRunOptions = {
  ...options,
  signal: controller.signal,
  onPersistedLimit: () => {
    persistedLimitReached = true;
  },
  onEvent: (event) => {
    this.updateBackgroundTaskRecordFromEvent(record, event);
    return options.onEvent?.(event);
  },
  shouldStopOnPersistedLimit: () => backgrounded,
};
```

When timeout promotion wins:

```ts
backgrounded = true;
this.backgroundTasks.set(taskId, record);
if (persistedLimitReached) {
  controller.abort("output_limit");
}
```

- [ ] **Step 3.5: Keep direct waiter off public contract**

Keep this method on `NodeExecutionAdapter`:

```ts
async waitForBackgroundTask(
  taskId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BackgroundExecutionSnapshot | undefined>
```

Do not re-add it to `ExecutionPort`.

- [ ] **Step 3.6: Run adapter tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/adapters/tests/exec.test.ts -t "auto-background|foreground results foreground|persisted output"
```

Expected:

- PASS.
- Fast foreground command does not leave hidden artifact files when original request did not ask for persistence.
- Auto-backgrounded command can be waited through `waitForBackgroundTask`.

**Phase 3 Pass Criteria**

- Adapter supports Bash auto-background without `runBackgroundable`.
- Adapter tests pass.
- `rg -n "runBackgroundable|BackgroundableExecution|autoBackgroundOnTimeout" apps/zcode-cli/packages/adapters apps/zcode-cli/packages/contracts` returns no matches.

---

## Phase 4: Move Bash Handler To Narrow Helper

**Purpose:** 让 Bash handler 使用 Bash 专属 capability，并删除 handler 里的 forced persistence patch。

**Files:**

- Create: `apps/zcode-cli/packages/core/src/tool/handlers/bash-auto-background.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Modify: `apps/zcode-cli/packages/core/tests/bash-run-conformance.test.ts`

**Interfaces:**

Create `apps/zcode-cli/packages/core/src/tool/handlers/bash-auto-background.ts`:

```ts
import type {
  BackgroundExecutionSnapshot,
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export type BashAutoBackgroundRunResult =
  | {
      kind: "completed";
      result: ExecutionResult;
    }
  | {
      assistantAutoBackgrounded: true;
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface BashAutoBackgroundExecutionPort extends ExecutionPort {
  runBashWithAutoBackground(
    request: ExecutionRequest,
    options?: ExecutionRunOptions,
  ): Promise<BashAutoBackgroundRunResult>;
  waitForBackgroundTask?(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundExecutionSnapshot | undefined>;
}

export function supportsBashAutoBackground(
  executionPort: ExecutionPort,
): executionPort is BashAutoBackgroundExecutionPort {
  return typeof (executionPort as Partial<BashAutoBackgroundExecutionPort>)
    .runBashWithAutoBackground === "function";
}

export async function runBashWithOptionalAutoBackground(input: {
  eligible: boolean;
  executionPort: ExecutionPort;
  options: ExecutionRunOptions;
  request: ExecutionRequest;
}): Promise<BashAutoBackgroundRunResult> {
  if (input.eligible && supportsBashAutoBackground(input.executionPort)) {
    return await input.executionPort.runBashWithAutoBackground(input.request, input.options);
  }
  return {
    kind: "completed",
    result: await input.executionPort.run(input.request, input.options),
  };
}
```

**Checklist**

- [ ] **Step 4.1: Add helper file**

Create `bash-auto-background.ts` exactly for the narrow Bash capability and wrapper. Do not export this from contracts.

- [ ] **Step 4.2: Update `bash.ts` call site**

Replace the current runResult block with:

```ts
const runResult = await runBashWithOptionalAutoBackground({
  eligible: isBashAutoBackgroundEligible(parsed),
  executionPort,
  options: runOptions,
  request,
});
```

- [ ] **Step 4.3: Delete handler-level forced persistence helpers**

Remove from `bash.ts`:

```ts
function createAutoBackgroundExecutionRequest(...)
function restoreForegroundOutputPersistence(...)
```

Also remove any now-unused imports:

```ts
type ExecutionResult
```

- [ ] **Step 4.4: Run Bash conformance tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/bash-run-conformance.test.ts -t "auto-backgrounds eligible foreground commands|conformance"
```

Expected:

- PASS for the auto-background focused test.
- Existing conformance cases remain unchanged.

**Phase 4 Pass Criteria**

- Bash handler no longer references `runBackgroundable`.
- Bash handler no longer mutates request persistence for auto-background.
- Focused Bash tests pass.

---

## Phase 5: Keep Bash Notification On Existing Background Pipeline

**Purpose:** 继续复用已有的 background notification / wake / runtime command queue，不新增 Bash 专用 wake 机制。

**Files:**

- Modify: `apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**

In `background-tasks.ts`, define a local structural waiter type:

```ts
type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};
```

Add helper:

```ts
function getBackgroundTaskWaiter(
  executionPort: ExecutionPort | undefined,
): BackgroundTaskWaiter | undefined {
  const candidate = executionPort as Partial<BackgroundTaskWaiter> | undefined;
  return typeof candidate?.waitForBackgroundTask === "function"
    ? (candidate as BackgroundTaskWaiter)
    : undefined;
}
```

**Checklist**

- [ ] **Step 5.1: Remove dependency on `ExecutionPort["waitForBackgroundTask"]`**

Change the `BackgroundTaskSnapshot` type so it no longer references `ExecutionPort["waitForBackgroundTask"]`.

Keep this union:

```ts
type BackgroundTaskSnapshot =
  | Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot;
```

- [ ] **Step 5.2: Update Bash direct waiter path**

Replace:

```ts
return toolCall.name === "Bash" && Boolean(this.deps.executionPort?.waitForBackgroundTask);
```

with:

```ts
return toolCall.name === "Bash" && Boolean(getBackgroundTaskWaiter(this.deps.executionPort));
```

Replace the waiter call with:

```ts
return getBackgroundTaskWaiter(this.deps.executionPort)?.waitForBackgroundTask(taskId);
```

- [ ] **Step 5.3: Keep fallback poller only as capability fallback**

Do not remove the existing `getBackgroundTask()` polling fallback in this phase; it remains for execution ports that cannot provide direct waiter. Bash on `NodeExecutionAdapter` should use direct waiter and therefore not poll.

- [ ] **Step 5.4: Verify notification enqueue path**

Keep `maybeEnqueueBackgroundTaskNotification()` unchanged except for type fallout. It must still call:

```ts
this.deps.enqueueBackgroundTaskNotification({ text, traceContext });
```

The text must still come from:

```ts
formatTaskNotification({
  taskType: "local_bash",
  ...
});
```

- [ ] **Step 5.5: Run runtime loop tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts -t "background Bash|direct execution wait|stale Bash|task-notification|goal|notification"
```

Expected:

- PASS.
- Started emit failure does not keep stale tracker.
- Bash completion notification is enqueued after direct wait.
- Runtime command queue consumes task notification as a normal queued command.

**Phase 5 Pass Criteria**

- Bash direct wait works without public `ExecutionPort.waitForBackgroundTask`.
- Notification path remains unified with existing background mechanism.
- Runtime loop focused tests pass.

---

## Phase 6: Remove Generic References And Update Docs

**Purpose:** 清掉多轮 patch 留下的概念债，确保文档描述的是最终实现，而不是过期抽象。

**Files:**

- Modify: `docs/bash-background-parity.md`
- Modify: `docs/superpowers/plans/2026-07-01-bash-background-parity.md` only if it contains now-dangerous implementation guidance
- Keep: `docs/superpowers/plans/2026-07-01-bash-background-refactor.md`

**Checklist**

- [ ] **Step 6.1: Update feature doc wording**

In `docs/bash-background-parity.md`, describe the final architecture as:

```md
Bash timeout auto-background is implemented as a Bash-owned execution path.
It reuses existing background task events, task notification enqueue, runtime wake,
and runtime command queue. It does not expose a generic foreground-promotion method
on ExecutionPort.
```

Use Chinese if the rest of the file is Chinese; keep wording short.

- [ ] **Step 6.2: Remove stale generic guidance**

Run:

```bash
rg -n "runBackgroundable|BackgroundableExecution|autoBackgroundOnTimeout|persistOutput: \"always\"" apps/zcode-cli/packages docs/bash-background-parity.md
```

Expected:

- No matches for `runBackgroundable`, `BackgroundableExecution`, `autoBackgroundOnTimeout`.
- `persistOutput: "always"` may still appear in existing explicit background tests or adapter internals for current output persistence semantics, but not in Bash handler auto-background policy.

- [ ] **Step 6.3: Check naming stays local**

Run:

```bash
node opensource/tools/check-competitor-terms.mjs apps/zcode-cli/packages/core/src/tool/handlers/bash.ts apps/zcode-cli/packages/core/src/tool/handlers/bash-auto-background.ts apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts docs/bash-background-parity.md
```

Expected:

- Reports 0 findings.

**Phase 6 Pass Criteria**

- Docs match final code boundary.
- No generic auto-background API names remain in source packages.
- Touched Bash/background files only use local naming.

---

## Phase 7: Full Verification

**Purpose:** 证明这次重构没有破坏现有 Bash、background、notification、contracts、typecheck 和 lint。

**Files:** no intended code changes.

**Checklist**

- [ ] **Step 7.1: Adapter tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/adapters/tests/exec.test.ts
```

Expected:

- PASS with existing skips only.

- [ ] **Step 7.2: Core Bash and tool tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/bash-run-conformance.test.ts packages/core/tests/tool-contracts.test.ts
```

Expected:

- PASS with existing skips only.

- [ ] **Step 7.3: Runtime background tests**

Run:

```bash
../../node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts -t "background Bash|direct execution wait|stale Bash|task-notification|goal|notification"
```

Expected:

- PASS.

- [ ] **Step 7.4: Package typechecks**

Run:

```bash
cd apps/zcode-cli/packages/contracts && ../../../../node_modules/.bin/tsc --noEmit
cd ../adapters && ../../../../node_modules/.bin/tsc --noEmit
cd ../core && ../../../../node_modules/.bin/tsc --noEmit
```

Expected:

- All PASS.

- [ ] **Step 7.5: Repo checks**

Run from repo root:

```bash
pnpm lint
pnpm typecheck
git diff --check
```

Expected:

- `pnpm lint`: exit 0; existing warnings are acceptable if not introduced by this refactor.
- `pnpm typecheck`: exit 0.
- `git diff --check`: no whitespace errors.

- [ ] **Step 7.6: Final source scan**

Run:

```bash
rg -n "runBackgroundable|BackgroundableExecution|autoBackgroundOnTimeout" apps/zcode-cli/packages
node opensource/tools/check-competitor-terms.mjs apps/zcode-cli/packages/core/src/tool/handlers/bash.ts apps/zcode-cli/packages/core/src/tool/handlers/bash-auto-background.ts apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts docs/bash-background-parity.md
```

Expected:

- First command: no matches.
- Second command: reports 0 findings.

**Phase 7 Pass Criteria**

- All focused tests pass.
- Package typechecks pass.
- Repo lint/typecheck pass.
- Generic auto-background API is gone from source packages.

---

## Definition Of Done

- [ ] `ExecutionPort` public contract is back to existing execution/background primitives only.
- [ ] Bash auto-background works through `runBashWithAutoBackground()` narrow structural capability, not generic `runBackgroundable()`.
- [ ] Bash handler does not force `persistOutput: "always"` at call site.
- [ ] Fast foreground Bash completion preserves normal foreground output semantics and does not leak hidden artifacts.
- [ ] Auto-backgrounded Bash completion emits existing background task events and enqueues existing `local_bash` task notification.
- [ ] Runtime wake and continuation are handled by the existing runtime command queue path.
- [ ] Existing explicit `run_in_background` behavior still uses `executionPort.start()`.
- [ ] No new manual background controls, feature flags, fallback wake timers, or separate Bash notification queue were introduced.
- [ ] All Phase 7 verification commands pass.
