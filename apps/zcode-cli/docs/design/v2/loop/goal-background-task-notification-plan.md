# Goal Background Task Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not create git commits unless the user explicitly asks in the current task.

**Goal:** 明确 goal / background task 语义：goal completion verification 必须等当前 session 内所有 running background work settle，并且每条 `<task-notification>` 都先作为 model-only synthetic user input 进入模型后，才允许 goal verification。

**Architecture:** 继续复用当前 `AgentRuntime` 实例级 runtime command queue，不重写 subagent 体系。`target-continuation` 在 command 执行时检查 session projection 中的 running background task；`task-notification` command 在完成自己的 model turn 后，按队列状态决定是否触发 post-notification goal loop。

**Tech Stack:** TypeScript, `AgentRuntime`, runtime command queue, session event projection, Vitest.

## Global Constraints

- 只以本计划和当前实现为准，不参考其他分支。
- 不引入新后台轮询、timer、retry 或 fake-notified 兜底。
- 不重写 subagent 体系；本次只修复 goal verification 与 background notification 的协作边界。
- 不在代码标识符、注释、测试名、用户可见文案中引入外部产品关键字；命名使用本地语义。
- 不自动提交 commit。
- 每个 phase 必须先补测试并看到预期失败，再写实现，再跑通过标准，之后才能进入下一个 phase。

---

## Reference Behavior

- goal evaluation 入口读取 task registry；如果存在未完成的 local agent / workflow / bash background work，就移除本次 Stop hook evaluation 并 defer，不跑 verifier。
- background task settle 后通过 `task-notification` 唤醒 main；notification 本身先进入模型上下文。
- 多个 background task 同时/连续完成时，main 应先消费已排队的 notifications；goal verification 只应在没有 running background task、也没有 pending task-notification command 时启动。

## File Map

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
  - 增加 goal continuation 的 background defer 判断。
  - 导出一个小 helper 给 runtime command queue 复用，避免 queue 文件直接理解 projection 细节。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
  - `task-notification` command 完成自己的 model turn 后，触发 post-notification goal loop。
  - 如果 queue 中仍有 pending `task-notification`，本次 post check 直接跳过。
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`
  - 覆盖 running background task defer verifier。
  - 覆盖多个 pending task-notification 先全部送进模型，之后才 goal verification。
- Modify: `apps/zcode-cli/docs/design/v2/session-target.md`
  - 补一小段规格，说明 active goal 遇到 background work 的 defer 语义。

## Phase 1: Running Background Task Defers Goal Verification

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/target.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Produces:
  - `hasRunningBackgroundTaskForGoalContinuation(this: AgentRuntimeInternal): Promise<boolean>`
  - `executeTargetContinuationCommand(...)` 在 verifier 前调用该 helper。
- Consumes:
  - `this.rebuildProjection()`
  - `projection.backgroundTasks[].status`

**Checklist:**

- [ ] **Step 1: Write failing test for running background defer**

Add this test near existing target continuation tests in `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`:

```ts
  it("defers goal completion verification while background tasks are still running", async () => {
    const sessionId = createSessionId("runtime-target-defers-running-background");
    const eventStore = createTestSessionEventStore();
    const sessionStore = new RecordingSessionStore();
    const requests: any[] = [];

    await eventStore.append(
      createSessionEvent(SessionEventType.BackgroundTaskStarted, sessionId, {
        cancellable: true,
        command: "npm run test",
        startedAt: new Date(0),
        status: "running",
        taskId: "bg_goal_running",
        terminalId: "bg_goal_running",
        toolCallId: "tool_bg_goal_running",
        toolName: "Bash",
      }),
    );

    const runtime = new AgentRuntime(
      sessionId,
      { mode: "build", workingDirectory: "/tmp/zcode-runtime-target-bg-defer" },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            requests.push(request);
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "unexpected verifier request",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore,
      },
    );

    await runtime.ensureSessionPersistedForExternalActivity("/goal Wait for background");
    await sessionStore.setTarget({
      objective: "Wait for background output before verification",
      sessionID: sessionId,
    });

    await expect(
      runtime.continueActiveTargetIfIdle({ verifyBeforeContinue: true }),
    ).resolves.toBeNull();

    expect(requests).toEqual([]);
  });
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "defers goal completion verification while background tasks are still running"
```

Expected before implementation: fail because one verifier model request is made.

- [ ] **Step 3: Add background defer helper in `target.ts`**

Add below `targetContinuationCandidateForCommand(...)`:

```ts
export async function hasRunningBackgroundTaskForGoalContinuation(
  this: AgentRuntimeInternal,
): Promise<boolean> {
  const projection = await this.rebuildProjection();
  return projection.backgroundTasks.some((task) => task.status === "running");
}
```

- [ ] **Step 4: Call helper before verifier**

In `executeTargetContinuationCommand(...)`, immediately after `if (!target) return null;`, add:

```ts
  if (await hasRunningBackgroundTaskForGoalContinuation.call(this)) {
    this.logger?.info("Goal continuation deferred while background tasks are running", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.deferred_background_running",
      module: "core.runtime",
      status: "waiting",
      targetId: target.targetID,
    });
    return null;
  }
```

- [ ] **Step 5: Run Phase 1 tests**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "defers goal completion verification while background tasks are still running"
```

Expected after implementation: pass.

**Phase 1 Pass Standard:**

- [ ] No verifier model request is emitted while any background task is `running`.
- [ ] `continueActiveTargetIfIdle({ verifyBeforeContinue: true })` resolves `null` instead of hanging or requeueing.
- [ ] No timer, polling, retry, or synthetic notification is introduced.

## Phase 2: Task Notification Wakes Goal Verification After Notifications Drain

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`

**Interfaces:**
- Consumes:
  - `executeTargetContinuationCommand.call(this, { traceContext, verifyBeforeContinue: true })`
  - `this.runtimeCommandQueue.snapshot()`
- Produces:
  - `hasPendingTaskNotificationCommand(this: AgentRuntimeInternal): boolean`
  - `continueTargetAfterTaskNotification(this: AgentRuntimeInternal, command: RuntimeCommand): Promise<void>`

**Checklist:**

- [ ] **Step 1: Write failing test for notification order before verifier**

Add this test near the existing `"queues background notifications behind target completion verification"` test in `apps/zcode-cli/packages/core/tests/runtime-tool-loop.test.ts`:

```ts
  it("runs pending background notifications before goal completion verification", async () => {
    const sessionId = createSessionId("runtime-target-notification-before-verifier");
    const eventStore = createTestSessionEventStore();
    const sessionStore = new RecordingSessionStore();
    const requestOrder: string[] = [];
    let verifierCount = 0;

    const runtime = new AgentRuntime(
      sessionId,
      { mode: "build", workingDirectory: "/tmp/zcode-runtime-target-notification-order" },
      {
        eventStore,
        modelAdapter: {
          async generateText(request: any) {
            const latestText = providerContentToText(
              request.messages.at(-1)?.content,
            );
            if (latestText.includes("<task-id>bg-notification-1</task-id>")) {
              requestOrder.push("notification-1");
              return {
                finishReason: "stop",
                model: request.model,
                providerMetadata: undefined,
                text: "processed notification 1",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (latestText.includes("<task-id>bg-notification-2</task-id>")) {
              requestOrder.push("notification-2");
              return {
                finishReason: "stop",
                model: request.model,
                providerMetadata: undefined,
                text: "processed notification 2",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (latestText.includes("Verify whether the active session goal")) {
              verifierCount++;
              if (verifierCount === 1) {
                requestOrder.push("verifier-fail");
                return {
                  finishReason: "stop",
                  model: request.model,
                  providerMetadata: undefined,
                  text: JSON.stringify({
                    nextAction: "Continue after both background notifications.",
                    passed: false,
                    reason: "The background results are now available.",
                  }),
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                };
              }
              requestOrder.push("verifier-pass");
              return {
                finishReason: "stop",
                model: request.model,
                providerMetadata: undefined,
                text: JSON.stringify({
                  nextAction: "",
                  passed: true,
                  reason: "The goal is complete after the continuation.",
                }),
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            requestOrder.push("continuation");
            return {
              finishReason: "stop",
              model: request.model,
              providerMetadata: undefined,
              text: "continued target after notifications",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore,
      },
    );

    await runtime.ensureSessionPersistedForExternalActivity("/goal Wait for notifications");
    await sessionStore.setTarget({
      objective: "Use both background notifications before verification",
      sessionID: sessionId,
    });

    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification><task-id>bg-notification-1</task-id><status>completed</status></task-notification>",
      traceContext: { sessionId, traceId: "trace_bg_notification_1" },
    });
    runtime.enqueueBackgroundTaskNotification({
      text: "<task-notification><task-id>bg-notification-2</task-id><status>completed</status></task-notification>",
      traceContext: { sessionId, traceId: "trace_bg_notification_2" },
    });

    await waitForCondition(() => requestOrder.includes("continuation"));

    expect(requestOrder).toEqual([
      "notification-1",
      "notification-2",
      "verifier-fail",
      "continuation",
      "verifier-pass",
    ]);
  });
```

- [ ] **Step 2: Run failing test**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "runs pending background notifications before goal completion verification"
```

Expected before implementation: fail because no verifier/continuation runs after notification commands, or verifier order is not guaranteed.

- [ ] **Step 3: Add pending-notification helper in `runtime-command-queue.ts`**

Add below `hasActiveOrQueuedTurnWork(...)`:

```ts
function hasPendingTaskNotificationCommand(this: AgentRuntimeInternal): boolean {
  return this.runtimeCommandQueue
    .snapshot()
    .some((candidate) => candidate.mode === "task-notification");
}
```

- [ ] **Step 4: Add post-notification goal continuation helper**

Add below `hasPendingTaskNotificationCommand(...)`:

```ts
async function continueTargetAfterTaskNotification(
  this: AgentRuntimeInternal,
  command: RuntimeCommand,
): Promise<void> {
  try {
    while (!hasPendingTaskNotificationCommand.call(this)) {
      const result = await executeTargetContinuationCommand.call(this, {
        traceContext: command.traceContext,
        verifyBeforeContinue: true,
      });
      if (!result) return;
    }
  } catch (error) {
    this.logger?.warn("Goal continuation after background notification failed", {
      ...traceContextToLogContext(command.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.continuation.after_background_notification_failed",
      module: "core.runtime",
    });
  }
}
```

- [ ] **Step 5: Invoke helper after notification model turn**

In the `command.mode === "task-notification"` branch, after `await this.executeTurnCommand(...)`, add:

```ts
      await continueTargetAfterTaskNotification.call(this, command);
```

The resulting branch should keep this order:

```ts
    if (command.mode === "task-notification") {
      const messageId = await persistBackgroundTaskNotificationCommand.call(
        this,
        command,
      );
      await this.executeTurnCommand(command.text, undefined, {
        inputSource: "background_task",
        inputVisibility: "model-only",
        recordedInputMessageId: messageId,
        skipInputRecord: true,
        skipUserPromptSubmitHooks: true,
        traceContext: command.traceContext,
      });
      await continueTargetAfterTaskNotification.call(this, command);
      return;
    }
```

- [ ] **Step 6: Run Phase 2 test**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "runs pending background notifications before goal completion verification"
```

Expected after implementation: pass.

**Phase 2 Pass Standard:**

- [ ] A task notification is sent to the model as `inputSource: "background_task"` before any goal verifier runs.
- [ ] If another `task-notification` command is already pending, the current notification does not start verifier.
- [ ] Once pending notifications are drained, post-notification goal loop can run verifier/continuation until verification stops it.
- [ ] If a background task is still `running`, Phase 1 helper still defers verifier.

## Phase 3: Document Runtime Semantics

**Files:**
- Modify: `apps/zcode-cli/docs/design/v2/session-target.md`

**Interfaces:**
- Consumes:
  - Phase 1 behavior: running background task defers verifier.
  - Phase 2 behavior: notification turn is consumed before verifier.
- Produces:
  - A concise spec paragraph for future maintainers.

**Checklist:**

- [ ] **Step 1: Update session target spec**

Add this paragraph under the goal continuation / completion verification section in `apps/zcode-cli/docs/design/v2/session-target.md`:

```md
When an active goal exists and the session has running background tasks, goal completion verification is deferred. Background task completion notifications are model-only synthetic user inputs and must be delivered to the model before the verifier decides whether the goal is complete. If multiple notifications are pending, the runtime drains those notifications first and only starts goal verification after no pending task notification remains and no background task is still running.
```

- [ ] **Step 2: Review doc wording**

Check:

```bash
rg -n "running background tasks|task notification|completion verification" apps/zcode-cli/docs/design/v2/session-target.md
```

Expected: the new paragraph is present once and does not mention external product names.

**Phase 3 Pass Standard:**

- [ ] Spec documents exactly the behavior implemented in Phase 1 and Phase 2.
- [ ] No external product keyword is introduced into the spec wording.

## Phase 4: Regression Verification

**Files:**
- Test-only commands; no source edits unless a test failure identifies a real bug.

**Checklist:**

- [ ] **Step 1: Run focused runtime tests**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/runtime-tool-loop.test.ts -t "background Bash|target continuation|target completion verification|background notifications"
```

Expected: all selected tests pass.

- [ ] **Step 2: Run background subagent tests**

Run:

```bash
cd apps/zcode-cli/packages/core
./node_modules/.bin/vitest run tests/subagent-background.test.ts tests/runtime-command-queue.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
cd apps/zcode-cli/packages/core
../../../../node_modules/.bin/tsc --noEmit
```

Expected: command exits 0.

- [ ] **Step 4: Run whitespace check**

Run from repo root:

```bash
git diff --check
```

Expected: command exits 0.

**Phase 4 Pass Standard:**

- [ ] Focused tests pass.
- [ ] Background subagent and command queue tests pass.
- [ ] Typecheck passes.
- [ ] `git diff --check` passes.

## Final Review Checklist

- [ ] No commit was created.
- [ ] `task-notification` still persists as model-only synthetic user input with `source: "background_task"`.
- [ ] `task-notification` still skips user prompt submit hooks.
- [ ] Goal verifier does not run while any projected background task is `running`.
- [ ] Goal verifier does not run before already queued task notifications are consumed.
- [ ] No new timer, polling loop, retry, or fallback queue was added.
- [ ] No code/test/doc naming uses external product keywords.
- [ ] The only runtime behavior change is goal continuation timing after background work.
