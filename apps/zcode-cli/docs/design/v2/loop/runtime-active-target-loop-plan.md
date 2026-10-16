# Goal Continue Loop Runtime 收敛计划

> 本计划是一个小范围重构计划，不是 background/subagent 机制重写。执行时逐 phase 推进；每个 phase 开始前先重新 review 本文件和当前工作区 diff；每个 phase 必须先补测试、确认失败、实现、确认通过，再进入下一 phase。不要创建 git commit，除非用户在当前任务里明确要求。

**Goal:** 把当前已经存在、但散落在两处的 goal continue loop 收回 `AgentRuntime`：`bootstrap/input-facade.ts` 不再维护普通 prompt 后的 `continueActiveTargetTurns()` while loop，`core/runtime-command-queue.ts` 不再维护 task-notification 后的 `continueTargetAfterTaskNotification()` while loop。

**Architecture:** runtime 拥有一个统一的 active target continuation driver。普通 user prompt、background `task-notification`、以及 `/goal` 创建目标后的首次 continuation 都只触发这个 driver；driver 根据当前事实读取 active target、runtime command queue、running background projection、verifier config，不新增持久 deferred 状态。

**Tech Stack:** TypeScript, `AgentRuntime`, `RuntimeCommandQueue`, bootstrap input facade, session target, Vitest.

---

## 全局约束

- 只以本计划和当前实现为准，不参考其他分支。
- 这是小范围重构：只迁移已有 loop 的归属，不新增 background/subagent 能力。
- 不修改 subagent 创建、执行、自动后台化、完成通知写入。
- 不修改 background task output 展示和读取。
- 不修改 active target completion verification 的判定语义。
- 不修改 steer 语义；steer 仍只服务 active turn 内部输入，不触发 post-turn goal loop。
- 不新增全局 `deferredGoalVerification`、timer、polling、retry、fake-notified 状态。
- 不把 desktop/mobile 外部 command queue 语义收敛到本次重构。
- 不新增 provider-visible 文案。
- 不在新代码标识符、注释、测试名、用户可见文案里引入外部产品专有关键字。
- 不自动提交 commit。

---

## 当前问题

同一套“turn 完成后是否继续 active goal”的策略现在写在两处：

1. 普通 user prompt：
   - 文件：`apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`
   - 当前逻辑：`runPromptTurn()` 调 `deps.runtime.executeTurn(...)` 后，再由 bootstrap 本地 `continueActiveTargetTurns()` while loop 继续跑 active target。

2. background task notification：
   - 文件：`apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
   - 当前逻辑：`task-notification` command 跑完 notification turn 后，手写 `continueTargetAfterTaskNotification()` while loop 继续跑 active target。

这两个 loop 的职责本质相同：在一个 turn 完成后，按当前事实判断是否需要 verifier 或 continuation。它们分裂在 bootstrap 和 core runtime 两个层里，导致 task-notification 成为特殊路径，也让后续 queue-aware 让位、verifier disabled、running background defer 这类规则容易重复或分叉。

---

## 目标形态

runtime 内部提供统一 driver：

```ts
continueActiveTargetLoop({
  abortSignal,
  inputId,
  traceContext,
  trigger,
  verifyBeforeFirstContinue,
})
```

调用入口：

- 普通 user prompt command 完成后，由 runtime command 执行侧调用 driver。
- background `task-notification` command 完成后，由 runtime command 执行侧调用同一个 driver。
- `/goal` 创建目标后的首次 continuation，由 bootstrap 的 `continueActiveTarget` API 请求 runtime 入列；queue 消费该 command 时调用同一个 driver。

关键语义：

- 普通 prompt 后：`trigger: "user-prompt"`，`verifyBeforeFirstContinue: true`。
- task-notification 后：`trigger: "task-notification"`，`verifyBeforeFirstContinue: true`。
- `/goal` 首次 continuation：`trigger: "manual"`，`verifyBeforeFirstContinue: false`，保留创建目标后直接开跑的旧语义，但必须先进入 runtime command queue。
- 自动 post-command driver 每轮 continuation 前检查 `runtimeCommandQueue.hasPending()`；有 pending command 时立即停止本轮 loop，让 queue drain。
- queued manual driver 消费自己的 queue slot 后可以启动首轮 continuation；首轮之后若有 pending command，则停止本轮 loop，让 queue drain。
- driver 不保存“之前 defer 过”的全局状态；background completion notification 本身就是下一次触发源。
- task-notification 且 verifier disabled 时，不把 notification 解释成“无条件继续 active goal”。

实现边界：

- `input-facade.ts` 只负责用户输入边界：input history、attachments、custom command prompt、event subscription。
- goal continue while loop 不再存在于 bootstrap 层。
- `runtime-command-queue.ts` 不再有 task-notification 专用 goal while loop。
- `continueActiveTargetIfIdle(...)` 保留为已有 single-shot runtime API；新的 manual loop public API 入列 `target-continuation-loop` command，command drain 内部复用 `executeTargetContinuationCommand(...)`，避免 post-command driver 把自己重新排进 queue。

---

## 文件范围

### 必改文件

- `apps/zcode-cli/packages/core/src/runtime/types.ts`
- `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`
- `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`
- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
- `apps/zcode-cli/docs/design/v2/session-target.md`

### 不改文件

- `apps/zcode-cli/packages/core/src/subagent/runner.ts`
- `apps/zcode-cli/packages/core/src/subagent/completion-notification.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts`
- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`

---

## Phase 0: 基线核对

**目标：** 不改代码，确认当前工作区和当前实现。

**Checklist:**

- [x] 查看工作区状态。

```bash
git status --short
git diff --name-status
git diff --cached --name-status
```

通过标准：

- staged、unstaged、untracked 文件边界清楚。
- 没有创建 commit。

- [x] 核对当前两个 loop。

```bash
rg -n "continueActiveTargetTurns|continueTargetAfterTaskNotification|hasPendingTaskNotificationCommand|executeTargetContinuationCommand|continueActiveTargetIfIdle|runtimeCommandQueue" \
  apps/zcode-cli/packages/core/src \
  apps/zcode-cli/packages/bootstrap/src
```

通过标准：

- `continueActiveTargetTurns` 位于 `input-facade.ts`。
- `continueTargetAfterTaskNotification` 和 `hasPendingTaskNotificationCommand` 位于 `runtime-command-queue.ts`。
- `executeTargetContinuationCommand` 位于 `target.ts`。
- `continueActiveTargetIfIdle` 仍作为 single-shot API 存在。

- [x] 确认已有 background-running defer 修复仍在。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "continues active goals without verification while background tasks are running|defers goal completion verification while background tasks are still running"
```

通过标准：

- 两个测试通过。
- `target.ts` 中 running background defer 只在 `verifyBeforeContinue === true` 时触发。

---

## Phase 1: 抽取 Runtime-Owned Driver

**目标：** 在 runtime 内抽取统一 active target loop，暂不迁移调用方。

**修改文件：**

- `apps/zcode-cli/packages/core/src/runtime/types.ts`
- `apps/zcode-cli/packages/core/src/runtime/command-queue.ts`
- `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/index.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts`
- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**新增类型：**

```ts
export type ActiveTargetLoopTrigger =
  | "manual"
  | "user-prompt"
  | "task-notification";

export interface ContinueActiveTargetLoopOptions {
  abortSignal?: AbortSignal;
  inputId?: string;
  traceContext?: TraceContext;
  trigger: ActiveTargetLoopTrigger;
  verifyBeforeFirstContinue?: boolean;
}
```

**新增 runtime method：**

```ts
continueActiveTargetLoop(
  options: ContinueActiveTargetLoopOptions,
): Promise<TurnResult | null>;
```

**实现要求：**

- public method 实现放在 `apps/zcode-cli/packages/core/src/runtime/methods/target-continuation-loop.ts`，负责入列 `target-continuation-loop` command。
- internal driver `runActiveTargetContinuationLoop(...)` 放在同一文件，queue 消费 command 或 post-command hook 时调用。
- 自动 post-command driver 每轮开始前先检查 `this.runtimeCommandQueue.hasPending()`。
- queued manual driver 首轮不因 queue pending 让位，首轮之后按 pending queue 让位。
- 使用 `executeTargetContinuationCommand.call(this, ...)` 执行单轮 verifier/continuation。
- 不调用 `continueActiveTargetIfIdle(...)`。
- 首轮 `verifyBeforeContinue` 来自 `verifyBeforeFirstContinue === true`。
- 每次 continuation 成功后，下一轮 `verifyBeforeContinue = true`。
- `trigger === "task-notification"` 且 verifier disabled 时直接返回，不做 direct continuation。

**Checklist:**

- [x] 添加测试：`runs the runtime-owned active target loop until verification stops it`。

测试要点：

- 创建 active target。
- 第一次 verifier 返回 `passed: false` 和非空 `nextAction`。
- driver 执行一次 continuation turn。
- 第二次 verifier 返回 `passed: true`。
- 请求顺序为 `["verifier-fail", "continuation", "verifier-pass"]`。
- 返回值是 continuation turn 的 `TurnResult`。

- [x] 运行新增测试，确认失败。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "runs the runtime-owned active target loop until verification stops it"
```

失败标准：

- `continueActiveTargetLoop` 不存在或未暴露。

- [x] 在 `types.ts` 添加 `ActiveTargetLoopTrigger` 和 `ContinueActiveTargetLoopOptions`。
- [x] 在 `command-queue.ts` 添加 `target-continuation-loop` runtime command。
- [x] 在 `internal-methods.ts` 添加 `continueActiveTargetLoop(...)`。
- [x] 在 `agent-runtime.ts` 添加 public method declaration。
- [x] 在 `target-continuation-loop.ts` 实现 `continueActiveTargetLoop(...)`。
- [x] 在 `methods/index.ts` 安装 `continueActiveTargetLoop(...)`。
- [x] 运行 Phase 1 测试。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "runs the runtime-owned active target loop until verification stops it"
```

通过标准：

- 测试通过。
- `continueActiveTargetLoop(...)` 内没有调用 `continueActiveTargetIfIdle(...)`。
- `continueActiveTargetIfIdle(...)` 仍然保留。

---

## Phase 2: Prompt Command 接入 Driver，移除 Bootstrap Loop

**目标：** 普通 user prompt command 完成后由 runtime command 执行侧调用 driver；`input-facade.ts` 不再自己 while loop。

**修改文件：**

- `apps/zcode-cli/packages/core/src/runtime/types.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
- `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`
- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**接口调整：**

给 prompt command 增加 post-turn driver 选项，避免所有裸 `runtime.executeTurn(...)` 调用都被扩大成自动 goal continuation：

```ts
export interface ExecuteTurnOptions {
  ...
  continueActiveTargetAfterTurn?: boolean;
}
```

runtime command 执行侧语义：

```ts
const result = await this.executeTurnCommand(
  command.input,
  command.attachments,
  command.options,
);
const continuationResult =
  command.options?.continueActiveTargetAfterTurn === true
    ? await this.continueActiveTargetLoop({
        abortSignal: command.options.abortSignal,
        inputId: command.options.inputId,
        traceContext: command.options.traceContext ?? command.traceContext,
        trigger: "user-prompt",
        verifyBeforeFirstContinue: true,
      })
    : null;
command.resolve(continuationResult ?? result);
```

bootstrap 语义：

- `runPromptTurn()` 只调用 `deps.runtime.executeTurn(...)`。
- `runPromptTurn()` 给 `executeTurn(...)` 传 `continueActiveTargetAfterTurn: true`。
- `input-facade.ts` 删除 `continueActiveTargetTurns(...)`。
- `continueActiveTarget` API 改为调用 `runtime.continueActiveTargetLoop(...)`，且 `verifyBeforeFirstContinue: false`。

**Checklist:**

- [x] 添加 core 测试：`prompt command can run post-turn active target loop when requested`。

测试要点：

- 创建 active target。
- 调用 `runtime.executeTurn("finish target", undefined, { continueActiveTargetAfterTurn: true })`。
- 第一次请求是 user prompt。
- verifier 返回 `passed: false` 和非空 `nextAction`。
- continuation 请求执行一次。
- 第二次 verifier 返回 `passed: true`。
- `executeTurn(...)` resolve 为 continuation result。

- [x] 添加 core 测试：`plain executeTurn does not run post-turn active target loop without opt-in`。

测试要点：

- 创建 active target。
- 调用 `runtime.executeTurn("plain prompt")`，不传 `continueActiveTargetAfterTurn`。
- 断言只有 prompt request，没有 verifier 或 continuation request。

- [x] 添加 core 测试：`prompt post-turn active target loop propagates continuation errors`。

测试要点：

- 创建 active target。
- prompt turn 成功完成。
- verifier 返回 `passed: false` 和非空 `nextAction`。
- continuation request 抛错。
- `executeTurn(...)` 不吞掉错误，最终以既有 `Turn execution failed` 包装错误 reject，底层 cause 保留 continuation error。

- [x] 添加 core 测试：`manual active target loop starts without first verification`。

测试要点：

- 创建 active target。
- 调用 `runtime.continueActiveTargetLoop({ trigger: "manual", verifyBeforeFirstContinue: false })`。
- 断言首个 request 是 continuation，不先跑 verifier。
- continuation 后下一轮再按既有策略跑 verifier。

- [x] 添加 core 测试：`manual active target loop queues behind an active prompt turn`。

测试要点：

- 创建 active target。
- 启动一个阻塞中的普通 prompt turn。
- 调用 `runtime.continueActiveTargetLoop({ trigger: "manual", verifyBeforeFirstContinue: false })`。
- 断言 manual loop 不会在 active prompt 期间提前 settle。
- prompt 完成后，queue 消费 manual continuation command 并启动首轮 continuation。

- [x] 运行 Phase 2 新增 core 测试，确认前两个失败。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "prompt command can run post-turn active target loop when requested|plain executeTurn does not run post-turn active target loop without opt-in|manual active target loop starts without first verification|manual active target loop queues behind an active prompt turn"
```

失败标准：

- `continueActiveTargetAfterTurn` 尚未生效。
- `runRuntimeCommand` prompt 分支尚未调用 driver。

- [x] 在 `ExecuteTurnOptions` 添加 `continueActiveTargetAfterTurn?: boolean`。
- [x] 确认 `PromptRuntimeCommand` 继续复用 `ExecuteTurnOptions`，不额外复制字段。
- [x] 修改 `continueActiveTargetLoop(...)` public API：只负责入列 `target-continuation-loop` command。
- [x] 修改 `runtime-command-queue.ts`：消费 `target-continuation-loop` command 时调用 internal driver。
- [x] 修改 `runtime-command-queue.ts` 的 prompt 分支：`executeTurnCommand(...)` 后按 `continueActiveTargetAfterTurn` 调 driver，并用 `continuationResult ?? result` resolve。
- [x] 修改 `input-facade.ts`：删除 `continueActiveTargetTurns(...)`。
- [x] 修改 `input-facade.ts`：`runPromptTurn()` 给 `executeTurn(...)` 传 `continueActiveTargetAfterTurn: true`。
- [x] 修改 `input-facade.ts`：`continueActiveTarget` 调用 `runtime.continueActiveTargetLoop({ trigger: "manual", verifyBeforeFirstContinue: false })`。
- [x] 确认 steer 路径不传 `continueActiveTargetAfterTurn`，也不调用 `continueActiveTargetLoop(...)`。

```bash
rg -n "continueActiveTargetTurns|continueActiveTargetAfterTurn|continueActiveTargetLoop|steerTurn" apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts
```

通过标准：

- `continueActiveTargetTurns` 没有结果。
- `continueActiveTargetAfterTurn` 只在 `runPromptTurn()` 的 `executeTurn(...)` options 中出现。
- `continueActiveTargetLoop` 只在 `continueActiveTarget` API 中出现。
- steer 分支没有 post-turn driver 调用。

- [x] 运行 Phase 2 测试。

```bash
cd apps/zcode-cli
./node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts -t "prompt command can run post-turn active target loop when requested|plain executeTurn does not run post-turn active target loop without opt-in|manual active target loop starts without first verification|manual active target loop queues behind an active prompt turn|continues an active target when idle and accounts usage"
./node_modules/.bin/vitest run packages/bootstrap/tests/session-persistence.test.ts -t "submitPrompt|routes sendInput\\(auto\\) into the active turn queue"
```

通过标准：

- runtime prompt command opt-in 后执行 post-turn driver。
- 裸 `runtime.executeTurn(...)` 不被扩大行为。
- `/goal` manual continuation 仍直接启动，不先 verifier。
- input-facade 不再持有 while loop。
- steer 路径不触发 post-turn driver。

---

## Phase 3: Task Notification Command 接入同一个 Driver

**目标：** task-notification command 完成 notification turn 后调用同一个 runtime driver，删除专用 while loop。

**修改文件：**

- `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**实现要求：**

在 task-notification 分支里：

```ts
await this.executeTurnCommand(command.text, undefined, {
  inputSource: "background_task",
  inputVisibility: "model-only",
  recordedInputMessageId: messageId,
  skipInputRecord: true,
  skipUserPromptSubmitHooks: true,
  traceContext: command.traceContext,
});
await this.continueActiveTargetLoop({
  traceContext: command.traceContext,
  trigger: "task-notification",
  verifyBeforeFirstContinue: true,
});
```

删除：

- `hasPendingTaskNotificationCommand(...)`
- `continueTargetAfterTaskNotification(...)`
- `runtime-command-queue.ts` 对 `executeTargetContinuationCommand` 的 import

**Checklist:**

- [x] 添加测试：`task notification trigger yields to queued runtime commands before another target iteration`。

测试要点：

- 创建 active target。
- enqueue background `task-notification`。
- notification turn 后 verifier 返回 `passed: false`。
- continuation turn 开始后阻塞。
- continuation 阻塞期间 enqueue 普通 user prompt。
- continuation 完成后，driver 看到 `runtimeCommandQueue.hasPending()`，停止第二轮 verifier。
- 请求顺序为 `["notification", "verifier-fail", "continuation", "prompt"]`。

- [x] 添加测试：`task notification trigger does not continue active target when verification is disabled`。

测试要点：

- runtime config 设置 `targetCompletionVerification: { enabled: false }`。
- 创建 active target。
- enqueue background `task-notification`。
- 断言只出现 notification request。
- 断言没有 verifier request。
- 断言没有 continuation request。

- [x] 运行新增测试，确认失败。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "task notification trigger yields to queued runtime commands before another target iteration|task notification trigger does not continue active target when verification is disabled"
```

失败标准：

- 当前 task-notification 专用 loop 没有整体 queue-aware 让位。
- verifier disabled 时 notification 后出现 direct continuation。

- [x] 修改 `runtime-command-queue.ts`，删除专用 task-notification goal loop。
- [x] 修改 task-notification 分支，notification turn 后调用 `this.continueActiveTargetLoop(...)`。
- [x] 运行 Phase 3 测试。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "task notification trigger yields to queued runtime commands before another target iteration|task notification trigger does not continue active target when verification is disabled|runs pending background notifications before goal completion verification|continues the post-notification goal loop until verification stops it"
```

通过标准：

- `runtime-command-queue.ts` 不再有 task-notification 专用 while loop。
- task-notification 和 user prompt 复用同一个 runtime-owned driver。
- queued prompt 不被 notification follow-up 抢跑。
- verifier disabled 时 notification 不启动 direct continuation。

---

## Phase 4: 边界测试补齐

**目标：** 覆盖 no active target、running background defer、queue-aware prompt opt-in 的边界。

**修改文件：**

- `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Checklist:**

- [x] 添加测试：`task notification without active target only sends the notification turn`。

测试要点：

- 不设置 active target。
- enqueue background `task-notification`。
- 断言只有一次 model request。
- 断言 request 内容包含 notification。

- [x] 添加测试：`task notification target loop defers verification while another background task is running`。

测试要点：

- 先 append 一个 running `BackgroundTaskStarted` event。
- 创建 active target。
- enqueue completed `task-notification`。
- 断言只有 notification request。
- 断言没有 verifier request。
- 断言没有 continuation request。

- [x] 添加测试：`post-turn active target loop yields when a prompt is already queued`。

测试要点：

- 第一个 prompt command opt-in post-turn driver。
- 第一个 prompt 执行时 enqueue 第二个 prompt。
- 第一个 prompt 完成后 driver 看到 queue pending，不启动 verifier。
- 第二个 prompt 先执行。

- [x] 运行 Phase 4 测试。

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "task notification without active target only sends the notification turn|task notification target loop defers verification while another background task is running|post-turn active target loop yields when a prompt is already queued|defers goal completion verification while background tasks are still running"
```

通过标准：

- 无 active target 不额外请求模型。
- running background defer 仍只影响 verifier。
- prompt post-turn driver 尊重 queue pending。
- 没有新增 deferred state。

---

## Phase 5: 文档、清理、整体验证

**目标：** 更新 spec，清理旧名称，运行 focused verification。

**修改文件：**

- `apps/zcode-cli/docs/design/v2/session-target.md`
- 本计划列出的实现和测试文件。

**Checklist:**

- [x] 更新 `apps/zcode-cli/docs/design/v2/session-target.md`，加入以下语义：

```md
Active target post-turn continuation is owned by the runtime.
Bootstrap can request the runtime to run the post-turn active target loop for accepted user prompts, but bootstrap does not own the loop.
Background task notifications reuse the same runtime-owned active target loop after their model-only notification turn completes.
The loop reads current runtime/session facts each iteration and stops before continuation when the runtime command queue already has pending work.
```

- [x] 搜索旧 loop 名称。

```bash
rg -n "continueActiveTargetTurns|continueTargetAfterTaskNotification|hasPendingTaskNotificationCommand|backgroundEnabled" \
  apps/zcode-cli/packages/core \
  apps/zcode-cli/packages/bootstrap \
  apps/zcode-cli/docs
```

通过标准：

- `continueActiveTargetTurns` 没有结果。
- `continueTargetAfterTaskNotification` 没有结果。
- `hasPendingTaskNotificationCommand` 没有结果。
- `backgroundEnabled` 没有结果。

- [x] 搜索本次 diff 是否新增外部产品专有关键字明文。

```bash
git diff -- apps/zcode-cli/packages/core/src apps/zcode-cli/packages/bootstrap/src apps/zcode-cli/packages/core/tests apps/zcode-cli/packages/bootstrap/tests apps/zcode-cli/docs/design/v2/loop/runtime-active-target-loop-plan.md \
  | perl -ne 'BEGIN { @blocked = map { pack("H*", $_) } ("434c41554445", "436c61756465", "636c61756465") } for $word (@blocked) { if (index($_, $word) >= 0) { print; $found = 1 } } END { exit($found ? 1 : 0) }'
```

通过标准：

- 命令没有输出。
- exit code 为 0。

- [x] 运行 focused tests。

```bash
cd apps/zcode-cli
./node_modules/.bin/vitest run packages/core/tests/runtime-tool-loop.test.ts
./node_modules/.bin/vitest run packages/core/tests/runtime-command-queue.test.ts packages/core/tests/runtime-cancel.test.ts packages/core/tests/runtime-compact.test.ts
./node_modules/.bin/vitest run packages/bootstrap/tests/session-persistence.test.ts -t "submitPrompt|routes sendInput\(auto\) into the active turn queue"
```

通过标准：

- 上述 focused tests 全部通过。
- `packages/bootstrap/tests/session-persistence.test.ts` 全量运行当前仍有 provider-visible prompt fixture 类既有失败；这不是本次 runtime-owned loop 改动的通过标准。

- [x] 运行类型检查和 lint。

```bash
cd apps/zcode-cli
pnpm --filter @zcode/core typecheck
pnpm --filter @zcode/bootstrap typecheck
pnpm --filter @zcode/core lint
pnpm --filter @zcode/bootstrap lint
```

通过标准：

- `@zcode/core` / `@zcode/bootstrap` typecheck 通过。
- full lint 当前仍被仓库既有 `max-lines` 规则阻塞；本次改动文件的 focused lint 除 `max-lines` 外没有新增问题。

- [x] 运行 diff hygiene。

```bash
git diff --check
git status --short
```

通过标准：

- `git diff --check` 通过。
- 工作区只包含预期文件。
- 没有创建 commit。

---

## 最终验收清单

- [x] runtime 拥有唯一的 active target continue while loop。
- [x] `input-facade.ts` 不再包含 `continueActiveTargetTurns(...)`。
- [x] `runtime-command-queue.ts` 不再包含 `continueTargetAfterTaskNotification(...)`。
- [x] 普通 user prompt 通过 runtime command opt-in 触发 post-turn driver。
- [x] 裸 `runtime.executeTurn(...)` 不传 opt-in 时不自动触发 goal loop。
- [x] `/goal` 创建目标后的首次 continuation 走 `continueActiveTargetLoop(...)` 入列，queue 消费后首轮不 verifier。
- [x] task-notification 复用同一个 `continueActiveTargetLoop(...)`。
- [x] driver 每轮 continuation 前尊重 `runtimeCommandQueue.hasPending()`。
- [x] task-notification 且 verifier disabled 时不 direct continuation。
- [x] running background task 仍 defer verifier，不阻断 verifier disabled 的 manual continuation。
- [x] steer active turn 路径不触发 post-turn driver。
- [x] 没有新增全局 deferred 状态、timer、polling、retry、fake-notified 兜底。
- [x] focused tests、typecheck、lint、diff check 完成。
- [x] 没有创建 commit。
