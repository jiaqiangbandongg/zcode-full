# WSL Active Run Lifecycle Review Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正窗口级 WSL Host Pool 把 `sendPrompt` ACK 误当作运行结束的问题，并让 workspace 释放同步回收 Host 侧的 task 元数据和动态事件订阅。

**Architecture:** `IZCodeTaskService` 暴露由 `ZCodeTaskIndexSyncer.onSessionReadyEvent` 驱动的 task-ready 动态事件；Host 以 workspace/task 为唯一 active-run 真相源，在 ready 或启动失败时结束计数，Host 总数由该 tracker 聚合。workspace runtime 释放成功后，Host 同步删除该 workspace 的 task meta、ready 监听和动态事件订阅，重新 attach 时可重新建立订阅。

**Tech Stack:** TypeScript、Vitest、Electron UtilityProcess、`@zcode/rpc` dynamic event、ZCode task index syncer。

## Global Constraints

- 先更新并遵守 `docs/superpowers/specs/2026-07-20-window-scoped-wsl-host-pooling-design.md` 中的 Active Run 权威边界。
- workspace 身份统一使用 `resolveWorkspaceKey({ workspaceIdentity, workspacePath })`；文件执行仍使用 `workspacePath`。
- 桌面端继续使用 `desktop-continuous`；本次不改变手机端 `web-remote-replayable` 的 snapshot/gap/queue 语义。
- 修复原因和关键时序注释使用中文。
- 完成前必须执行 `pnpm typecheck`、`pnpm lint` 和受影响单测。

---

### Task 1: 暴露 task ready 权威事件

**Files:**
- Modify: `packages/services/src/session/zcodeTaskService.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
- Test: `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

**Interfaces:**
- Consumes: `ZCodeTaskIndexSyncer.onSessionReadyEvent`，事件原因是 `prompt_completed | prompt_failed`。
- Produces: `ZCodeTaskReadyOutcome` 和 `IZCodeTaskService.onDynamicTaskReady(taskId): Event<ZCodeTaskReadyOutcome>`。

- [x] **Step 1: 写失败测试**

  在 adapter 测试中订阅 `service.onDynamicTaskReady(taskId)`，分别注入 `prompt_completed`、`prompt_failed` 和其他 task 的 ready 事件，断言只收到目标 task 的两个事件。

- [x] **Step 2: 验证测试先失败**

  Run: `pnpm vitest run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

  Expected: FAIL，提示 `onDynamicTaskReady` 不存在。

- [x] **Step 3: 实现最小接口和 adapter 映射**

  ```ts
  export interface ZCodeTaskReadyOutcome {
    taskId: string;
    reason: "prompt_completed" | "prompt_failed";
  }

  onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome> {
    return Event.filter(
      Event.map(taskIndexSyncer.onSessionReadyEvent, (event) => ({
        taskId: event.target.taskId,
        reason: event.reason,
      })),
      (event) => event.taskId === taskId,
    );
  }
  ```

- [x] **Step 4: 验证服务测试通过**

  Run: `pnpm vitest run packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

  Expected: PASS。

### Task 2: 以 ready 驱动唯一 active-run tracker

**Files:**
- Modify: `packages/desktop/src/host/hostWorkspaceTaskTracker.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Test: `packages/desktop/test/hostWorkspaceTaskTracker.test.ts`

**Interfaces:**
- Consumes: `onDynamicTaskReady(taskId)` 和 task meta 中的 `workspacePath/workspaceIdentity`。
- Produces: `begin(taskId, context)`、`finish(taskId, context)`、`getRunningTaskCount(context)`、`getTotalRunningTaskCount()`、`clearWorkspace(context)`；同一 workspace/task 重复 begin 幂等。

- [x] **Step 1: 写 ACK-before-ready、重复 begin、跨 workspace 聚合和 clear 的失败测试**

  测试在 begin 后不调用 finish（模拟只收到 ACK），断言 workspace 仍为 1；随后模拟 ready 才降为 0。再断言相同 task 重复 begin 不增量、两个 workspace 总数正确、clear 仅移除目标 workspace。

- [x] **Step 2: 验证 tracker 测试先失败**

  Run: `pnpm vitest run packages/desktop/test/hostWorkspaceTaskTracker.test.ts`

  Expected: FAIL，提示新签名或聚合 API 不存在。

- [x] **Step 3: 实现 task-keyed tracker 并接入 Host**

  `sendPrompt` 前先建立 ready 监听并 begin；ACK 不结束计数，ready 或 `sendPrompt` reject 才 finish。删除独立 `runningPromptCount`，`AgentRunningTaskCountChanged` 由 `tracker.getTotalRunningTaskCount()` 派生。

  ```text
  sendPrompt start -> subscribe ready -> begin(workspace, task) -> remote ACK
                                  |                         |
                                  |                         +-- 保持 active
                                  +-> prompt_completed/failed -> finish -> Main 可释放 workspace
  ```

- [x] **Step 4: 验证 tracker 和 Host 类型检查通过**

  Run: `pnpm vitest run packages/desktop/test/hostWorkspaceTaskTracker.test.ts`

  Expected: PASS。

### Task 3: workspace release 清理 Host proxy 状态

**Files:**
- Create: `packages/desktop/src/host/hostRemoteWorkspaceProxyState.ts`
- Modify: `packages/desktop/src/host/index.ts`
- Test: `packages/desktop/test/hostRemoteWorkspaceProxyState.test.ts`

**Interfaces:**
- Consumes: `releaseWorkspacePreparation(context)` 成功结果和 `resolveWorkspaceKey(context)`。
- Produces: workspace-keyed subscription disposable map，以及 release 后清理 task meta、ready subscription、tracker entry 和动态 workspace 订阅的行为。

- [x] **Step 1: 写释放和重新 attach 的失败测试**

  抽取可单测的 workspace proxy-state registry；注册 task meta、workspace 订阅和 active ready 监听后 release，断言三类引用均清空，随后重新订阅同一 workspace 能成功。

- [x] **Step 2: 验证测试先失败**

  Run: `pnpm vitest run packages/desktop/test/hostRemoteWorkspaceProxyState.test.ts`

  Expected: FAIL，提示 registry/clear API 不存在。

- [x] **Step 3: 实现 release 清理**

  仅在底层 `releaseWorkspacePreparation` 成功后清理；订阅容器由 `Set` 改为 `Map<workspaceKey, Disposable>`，清理时调用 `dispose()` 后删除，避免 shared Host 生命周期内累积监听。

- [x] **Step 4: 运行完整验证**

  Run:

  ```powershell
  pnpm vitest run packages/desktop/test/hostWorkspaceTaskTracker.test.ts packages/desktop/test/hostRemoteWorkspaceProxyState.test.ts packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts
  pnpm typecheck
  pnpm lint
  ```

  Expected: 全部 exit code 0。

- [x] **Step 5: 提交**

  ```powershell
  git add docs/superpowers/plans/2026-07-20-wsl-active-run-lifecycle-review-fix.md packages/services/src/session/zcodeTaskService.ts packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts packages/desktop/src/host/hostWorkspaceTaskTracker.ts packages/desktop/src/host/hostRemoteWorkspaceProxyState.ts packages/desktop/src/host/index.ts packages/desktop/test/hostWorkspaceTaskTracker.test.ts packages/desktop/test/hostRemoteWorkspaceProxyState.test.ts
  git commit -m "fix(remote): track WSL active runs until ready"
  ```
