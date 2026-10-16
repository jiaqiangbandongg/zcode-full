# zcode-cli background subagent 修复计划

## 目标

本计划只基于当前 worktree，不参考其他分支。目标不是重新实现 subagent，而是在现有 `Agent` / profile loader / child runtime / `RuntimeTaskRegistry` 基础上修复 background subagent 的完成唤醒问题，并补齐 foreground subagent 超时自动转后台的核心机制。

期望行为：

- `Agent(run_in_background=true)` 返回 `async_launched` 后，main agent 可以正常 finish/idle。
- background subagent 完成后，父 runtime 自动触发一次 model-only turn，把 `<task-notification>` 作为 `background_task` synthetic user input 注入 provider request，让 main agent 继续处理结果。
- 如果 completion 发生时父 turn 仍 active，则继续复用 active turn 的 pre-request drain，不重复注入。
- foreground subagent 在配置开启后按 120000ms 阈值自动转后台；默认保持关闭，只由配置开关启用。

## 非目标

这些能力当前已经存在或不属于本轮修复，不放进 P0：

- 重新实现 `Agent` tool 或 Claude Code 兼容的 `Task` alias。
- 重新实现 profile loader、用户/项目 `.zcode/agents` Markdown 加载、插件 agent 加载。
- 把 `Explore` 设为默认 agent。当前省略 `subagent_type` 时默认 `general-purpose`；`Explore` 只是 specialized built-in。
- 重新实现 `general-purpose` / `Explore` built-in profile、child runtime 创建、artifact 写入、`SendMessage`。
- teammate、swarm、workflow、worktree isolation、model-facing `TaskCreate` / `TaskList` / `TaskUpdate`。
- 进程重启后恢复正在运行的 background subagent，或持久化未消费 notification outbox；本轮 queued command 仍是进程内运行态，不是 durable outbox。

P1 再考虑：

- `background_tasks` control request / Ctrl+B 等 UI 或 SDK 入口。
- `TaskStop` / `TaskOutput` 兼容面。

## 当前实现快照

### Agent 和 profile

- `apps/zcode-cli/packages/core/src/tool/handlers/agent.ts` 中 `parsed.subagent_type ?? AgentType.GeneralPurpose`，省略时默认 `general-purpose`。
- `apps/zcode-cli/packages/core/src/subagent/profile.ts` 中 `DEFAULT_SUBAGENT_TYPE = GENERAL_PURPOSE_AGENT_TYPE`，`normalizeAgentProfiles()` 先注册 built-in `general-purpose`，再注册 built-in `Explore`，最后覆盖用户/项目/插件 profile。
- `apps/zcode-cli/packages/bootstrap/src/subagents.ts` 已加载用户级 `~/.zcode/agents`、项目级 `.zcode/agents`、插件 `agents/*.md`，并保留 `general-purpose` / `Explore` reserved name。
- `apps/zcode-cli/packages/contracts/src/tools/agent.ts` 已有 `run_in_background`，输出包含 `completed` 和 `async_launched` 两种状态。

### Subagent runner

- `apps/zcode-cli/packages/core/src/subagent/runner.ts` 里的 `createExploreSubagentPort` 名字仍偏旧，但实际是 profile-backed port。
- `launch()` 根据 `runInBackground` 或 profile `background` 决定走 `start()` 还是 `run()`。
- `start()` 已能直接后台启动：注册 `local_agent` task，返回 `async_launched`，子 runtime 异步跑完后调用 `finalizeBackgroundCompletion()` / `finalizeBackgroundFailure()`。
- `run()` 已能前台转后台：注册 `isBackgrounded=false` task 后，把 `runAgentToCompletion()` 和 `RuntimeTaskRegistry.waitForBackgroundRequest(agentId)` 做 race；如果收到 background request，就立即返回 `async_launched`，同一个 child completion promise 继续在后台完成。
- `RuntimeTaskRegistry.requestBackground(id)` 已能把非 terminal task 标成 `isBackgrounded=true` 并 resolve waiters。
- 目前缺的是自动触发 `requestBackground()` 的 timer 和 lifecycle cleanup。

### Parent runtime notification

- `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts` 中 `pendingBackgroundTaskNotifications` 是 `AgentRuntime` 私有内存数组。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 中 `enqueueParentNotification` 只是 `push({ queuedAt, text, traceContext })`。
- `apps/zcode-cli/packages/core/src/runtime/methods/background-notifications.ts` 的 drain 会把 notification 写入 `messageHistory.addUser(...)`，并持久化为 `source: "background_task"`。
- `executeTurn()` 和 `runRegularTurnLoop()` 会在已有 turn/request 前调用 drain，所以“下一次显式用户输入”或“active turn 下一次 model request”能看到 `<task-notification>`。
- 如果父 turn 已 finish/idle，当前没有 queue subscriber / wake scheduler，因此 completion 只停留在内存数组里，不会自动生成下一次父模型请求。
- `ExecuteTurnOptions` 已支持 `inputVisibility: "model-only"` 和 `inputSource: "background_task"`，可以作为 idle wake 的最小实现基座。

### 测试覆盖现状

- `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts` 已覆盖默认 `general-purpose`、background launch、completion 在“后续显式 turn”中被 drain。
- 现有 background 测试会在子任务完成后手动调用 `runtime.executeTurn("continue")`，因此没有覆盖“父 turn 已 idle 后自动 wake”。
- Bash/goal continuation 已有 model-only turn 相关测试，可复用其断言方式验证 `inputVisibility` / `inputSource`。

## 差距和根因

P0 差距：

- **Idle wake 缺失**：当前 queue 只会在已有 turn/request 里 drain；父 main idle 后没有 queued command re-entry 机制。
- **Queue 太裸**：`pendingBackgroundTaskNotifications` 是数组，没有 idempotency、claim、batch、wake scheduled / skipped / drained 的状态和日志。
- **Auto-background timer 缺失**：内部 `requestBackground()` 和 foreground race 已有，但没有受配置开关控制的 120000ms timer，也没有完成/失败/取消时取消 timer 的边界。
- **测试没有卡住形态**：现有测试只验证“后续显式 turn”消费 notification，没有验证 background completion 自动触发父模型请求。
- **Usage 统计需要守住真实值**：当前 runner 已从 child events 聚合 `tool_uses`，但需要补测试覆盖，防止 background metadata / notification 中 `tool_uses` 回到 0。

参考失败形态：

- `sess_bc1e9c8a-80a0-4bda-a927-6fde7ec6dc4c` 的父 turn 已 finish，子 session 后续正常完成并写出 output，但父 session 没有新的 model request，也没有 `background_task` synthetic notice。这符合“completion 入队后无人 wake”的根因。

## 方案

### 1. Runtime 内部 background notification queue

把 `pendingBackgroundTaskNotifications: PendingBackgroundTaskNotification[]` 封装成 runtime 内部 queue API。P0 不引入 SQLite outbox，仍是进程内运行态。

队列设计一开始就按多 runtime task source 预留：本轮优先让 `local_agent` background subagent 跑通；最后一个 phase 再把 `local_bash` 和 `monitor_mcp` 接到同一 queue/wake 设计里。也就是说，API 和幂等字段不要写死 subagent，但前几个 phase 的实现和验收不被 Bash/monitor 拖住。

建议数据形状：

```ts
interface PendingBackgroundTaskNotification {
  id: string;
  taskId?: string;
  toolUseId?: string;
  source: "local_agent" | "local_bash" | "monitor_mcp";
  text: string;
  traceContext: TraceContext;
  queuedAt: Date;
}
```

建议 API：

```ts
enqueueBackgroundTaskNotification(notification): "queued" | "duplicate";
drainBackgroundTaskNotificationsForActiveTurn(traceContext): PendingBackgroundTaskNotification[];
claimBackgroundTaskNotificationsForIdleWake(): PendingBackgroundTaskNotification[];
hasPendingBackgroundTaskNotifications(): boolean;
scheduleBackgroundTaskNotificationWake(reason): void;
```

关键约束：

- 以 `taskId + toolUseId + terminal status` 或 notification `id` 做幂等，避免 completion/failure path 重复入队。
- active turn drain 和 idle wake 都从同一个 queue 消费；idle wake 需要先 claim，再启动 model-only turn，避免 pre-turn drain 再次注入。
- 外层 runtime command drain 每次可用时同步形成队列快照；若下一条可执行 command 是 `task-notification`，一次 claim 快照内全部同优先级 `task-notification`，按 queuedAt/admission 顺序用空行拼成一个 batch input。
- batch 不跨 priority，也不吸收 claim 返回后才入队的 notification；不增加 microtask、debounce 或其它等待窗口。迟到结果留给下一次**合法的 notification drain**：当前 outer batch 若产生 tool continuation，它可以被既有 active-loop drain 合流到同一 turn 的下一次 provider request；若当前 request 直接 terminal，才由下一轮 outer drain claim。
- batch 只覆盖 `task-notification` mode；`prompt`、`target-continuation` 与 `subagent-message` 保持各自消费语义。若同优先级队列以 notification 开头，可以跨过其它 mode 收集同 mode 项；若先选中其它 mode，则先执行该 command。
- 整批只持久化一条 `background_task` / `model-only` synthetic user message；每个 notification ledger 输入独立结算并共同指向该 message，避免 cold hydration 把一批结果重建成多个空 turn。
- 不新增 batch 专用 metadata/schema。若 batch 每个成员都有结构化 `originMeta`，继续复用普通 `BackgroundResultOriginMeta`：`backgroundSource/workId` 取 admission 最早成员作为展示追踪锚点，`title` 按 admission 顺序合成；最多展示前三个 title，剩余项追加 `· +N`。持久化 synthetic message 与 live turn 必须复用同一个合成对象。任一成员缺少结构化 metadata 时不从 `<task-notification>` 文本反向解析，整批保持无 `originMeta` 的兼容路径。
- 如果 claim 后发现 runtime 又 active，必须把 batch 放回队列头或放弃 claim 后重新调度，不能丢 notification。
- notification command 一旦被 claim，就按 at-most-once 调度：provider/model 终态失败或 stop 后不自动把 command 重新入队，避免重复唤醒。与此同时，整批 model-only synthetic input 必须在 query 前完成持久化；因此失败/stop 只结束本次 assistant/model turn，notification 内容仍留在 transcript，后续合法输入会继续携带该上下文。provider adapter 内部的有界 attempt retry 属于同一次 query，不等同于 command 重投。

### 2. Idle wake scheduler

在 `AgentRuntime` 内增加一个轻量 scheduler，而不是新增 app stdio 协议。

触发点：

- `enqueueBackgroundTaskNotification()` 成功入队后调用 `scheduleBackgroundTaskNotificationWake("enqueue")`。
- `finishActiveTurn()` 清掉 active turn 后，如果 queue 仍有 pending，再调用 `scheduleBackgroundTaskNotificationWake("turn_finished")`。这覆盖“notification 到达时父 turn 还 active，但最后一个 model request 已经结束”的竞态。

执行逻辑：

1. 在 scheduler/drain 真正可执行的瞬间同步 claim 当时全部合格 notification，不等待同 tick 后续结果，也不设置 debounce。
2. 如果 `activeTurn` 存在，记录 debug/info 后退出；等待 active drain 或 `finishActiveTurn()` 再调度。
3. 如果没有 pending，no-op。
4. claim pending batch。
5. 调用 `executeTurn(batchText, undefined, { inputVisibility: "model-only", inputSource: "background_task", displayInput: "Background task completed", inputId: "background-task:<first-id>", traceContext })`。
6. 该 turn 的 provider-visible 最新 user 内容就是 `<task-notification>`；UI-facing snapshot 不应新增真实用户气泡。

注意：

- 不额外塞 “continue” / “please continue” 之类真实用户文本。
- 不走 `recordExternalUserPrompt`，避免把 background completion 误记为用户输入。
- wake turn 仍使用现有 model request / tool loop / persistence / event path，这样 main agent 可以继续调用工具或回复用户。

### 3. Completion enqueue 改造

`finalizeBackgroundCompletion()` / `finalizeBackgroundFailure()` 继续负责：

- 写 `metadata.json` / `output.txt` / `task.output` / transcript artifact。
- 更新 `RuntimeTaskRegistry` terminal 状态、`notified: true`、usage。
- 发 `SubagentStopped` / `BackgroundTaskCompleted` 等事件。

但投递 notification 时改为调用 queue API：

- `source: "local_agent"`。
- `id` 使用 task/agent id 加 terminal status，确保幂等。
- `taskId` 使用 `agentId` / backgroundTaskId。
- `toolUseId` 使用 parent tool call id。
- `text` 继续由 `formatTaskNotification()` 生成，保持 user-like `<task-notification>`。

### 4. Foreground subagent auto-background timer

在现有 foreground `run()` 路径补 timer，不重启 child，不改变 `start()` 直接后台路径。

配置建议：

- `AgentRuntimeConfig.subagents.autoBackgroundMs?: number`。
- 默认 `0` 或 `undefined`，即关闭。
- 由 bootstrap 配置映射：开关开启时设置 `120000`；后续如有产品 beta flag 再接同一字段。
- 测试允许直接传短阈值。

生命周期：

- foreground `run()` 注册 task 后，如果 `autoBackgroundMs > 0`，启动 timer。
- timer 到期只调用 `registry.requestBackground(lifecycle.agentId)`。
- completion、failure、abort、手动 background 后都清理 timer。
- timer 触发后前台 race 走现有 `waitForBackgroundRequest()` 分支，返回 `async_launched`，child completion promise 继续后台 finalize。

### 5. 日志和排查面

日志使用 runtime/core logger：

- `info`：notification queued、idle wake started/completed、auto-background triggered。这些是低频生命周期事件。
- `debug`：wake skipped because active/no pending、duplicate ignored、batch size 等排查细节。
- `warn`：wake turn 启动失败、claim 后需要 requeue、timer 触发但 task 不存在或已 terminal。

不要把每个 streaming chunk / tool delta 打成 info。

## 实施步骤

1. **重构 queue 边界**
   - 抽 `PendingBackgroundTaskNotification` 的 id/source/task metadata。
   - 把 `pendingBackgroundTaskNotifications.push/splice` 收敛到 queue API。
   - 先保持 active turn drain 行为不变，用测试证明显式后续 turn 仍能看到 notification。

2. **补 idle wake**
   - 在 enqueue 和 `finishActiveTurn()` 后调度 wake。
   - wake 通过 `executeTurn(..., { inputVisibility: "model-only", inputSource: "background_task" })` 进入现有 loop。
   - 补竞态保护：active 时不 wake、pending 被 active drain 后 no-op、claim 后活跃冲突可 requeue。

3. **补 auto-background**
   - 加 `subagents.autoBackgroundMs` 配置字段。
   - foreground `run()` 注册/清理 timer。
   - timer 只调用 `RuntimeTaskRegistry.requestBackground()`，复用现有 foreground-to-background race。

4. **补 usage 防回归**
   - 保证 background completion 的 `totalToolUseCount`、event payload、metadata、`<usage><tool_uses>` 来自 child runtime 真实事件聚合。
   - 对“child 有多次 tool result，background notification usage 不为 0”加单测。

5. **补测试**
   - idle wake：启动 `Agent(run_in_background=true)`，父 turn finish 后释放 child，断言自动出现第 3/4 次父模型请求且包含 `<task-notification>`。
   - active drain：completion 发生在 active turn 中，断言同一 turn 下一次 request 消费 notification，且 idle scheduler no-op。
   - no duplicate：同一 completion 重复 enqueue 只注入一次。
   - model-only persistence：持久化 message `source === "background_task"`、`visibility === "model-only"`，UI 不出现真实用户气泡。
   - auto-background：fake timer / 短阈值触发 foreground Agent 返回 `async_launched`，child completion 后 notification wake。
   - 默认关闭：未配置 `autoBackgroundMs` 时 foreground Agent 不自动后台化。

6. **最后 phase：统一其他 background runtime task**
   - 目标是在 subagent background 路径稳定后，再把 `local_bash` / `monitor_mcp` 纳入同一 queue/wake 机制。
   - `local_bash` 当前已有 `BackgroundTaskTracker` completion enqueue 基础；这个 phase 先让它复用新的 claim / idle wake / 幂等队列，不急着改 provider-visible XML shape。
   - `monitor_mcp` 需要先确认当前 runtime task 来源和 completion 入口；只有入口明确后再接入同一 source metadata。
   - 该 phase 的设计约束是：queue API、source metadata、dedupe key、wake scheduler 从一开始就能承载 `local_agent` / `local_bash` / `monitor_mcp`，但 implementation order 仍以 `local_agent` 为先。
   - Bash / monitor 的 provider-visible XML shape 全面收敛作为该 phase 内的后续小节评估，不阻塞前面 subagent background 验收。

## 验收标准

- `Agent(run_in_background=true)` 的父 turn 可以先成功 finish；子任务完成后不需要用户再输入，父 runtime 会自动发起一个 model-only continuation request。
- 自动 wake 的 provider-visible request 中存在 user-role `<task-notification>`，不含 `<system-reminder>` 包裹，不含额外真实用户文本。
- session store 中能看到 `source: "background_task"` 的 synthetic notice；UI-facing projection 不把它渲染成用户手发消息。
- foreground subagent 仅在配置开启时超时转后台；默认行为不变。
- auto-background 后返回的 tool result 仍是 `async_launched`，完成后走同一 completion notification/wake path。
- `general-purpose` 仍是默认 agent，`Explore` 不变成默认。
- `pnpm lint` 和 `pnpm typecheck` 通过；如有环境既有失败，需要在提交说明中写明具体失败文件和原因。

## 风险

- **重入风险**：wake turn 不能在 active turn 未结束时启动，否则会破坏 turn 状态机。必须以 `activeTurn` 和 `finishActiveTurn()` 双重 guard 控制。
- **重复注入风险**：active drain 和 idle wake 共用 queue 后，claim/drain 必须是原子语义。
- **用户输入污染风险**：background wake 不能走普通 user prompt 持久化路径，也不能生成真实用户气泡。
- **重试/丢失边界风险**：只允许同一 query 内部的 provider attempt 有界重试；terminal failure/stop 不重新 enqueue 已 claim command，但必须保留 query 前已持久化的 batch input，并验证后续请求既不会丢内容也不会重复注入。
- **移动端/remote 风险**：本轮只动 zcode-cli runtime 内部；如果后续把 app/service idle wake 接到远控链路，必须另开 spec 说明 desktop continuous 与 web-remote replayable 边界。
