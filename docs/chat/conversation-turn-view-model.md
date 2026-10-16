# Conversation Turn View Model

## 背景

聊天区不能再把真实消息、用户命令、runtime-only 输入和 timeline lifecycle 都压进同一条
`ChatMessage[]` 事实流。UI 需要先按 turn 事务归一化，再生成渲染行。

## 领域模型

`Conversation` 由多个 `Turn` 组成。一个 turn 是一次被主 session 接受并进入 CLI/runtime 的
conversation transaction，而不是单独的 user message、assistant message，也不是 UI 数组里的第 N
组消息。

turn 的权威身份是 CLI/runtime 产生的 `turnId`。UI 展示用的 `turnOrdinal` / 历史兼容字段
`turnIndex` 只能表达“第几轮”，不能作为新协议里的 mutation target、timeline anchor 或恢复事实源。
fork、edit、rewind、file summary、timeline placement 等需要稳定身份的能力，应优先使用
`messageId`、`turnId`、`anchorTurnId` 或 `anchorMessageId`。

```ts
interface ConversationView {
  turns: TurnView[];
  rows: ConversationRenderRow[];
  lineageEvents: ConversationLineageEvent[];
}

interface TurnView {
  turnId: string;
  ordinal: number; // display only
  origin:
    | "user_prompt"
    | "queue_drain"
    | "turn_steer"
    | "goal_continuation"
    | "background_result"
    | "manual_compact";
  status: "running" | "settling" | "completed" | "interrupted" | "failed";
  visibleInputs: ConversationInput[];
  // 同一 product turn 内，原始输入与每条 accepted steer 分别开启一个视觉工作段。
  // 这不是 turn 边界；command target、fork/retry 仍锚定 product turn 的最终正文。
  workSegments: TurnWorkSegmentView[];
  modelOnlyInputs: RuntimeInput[];
  workLog: WorkLogItem[];
  assistantOutput?: AssistantOutput;
  postTurnEvents: PostTurnEvent[];
  actionTargets: TurnActionTargets;
}

interface TurnWorkSegmentView {
  segmentId: string;
  triggerInputId?: string;
  startedAt: number;
  endedAt?: number;
  activeMs?: number;
}
```

`status=settling` 表示主 assistant 输出已经完成，但这个 turn 的 completion-blocking post work 还没有
收口，例如 goal verifier、goal continuation 前置判断或其它 foreground active work。此时 UI 不应再显示
assistant 正在输出，但 session 仍可能 `sessionEnded=false`，停止按钮仍由 session control projection
决定是否可用。

```text
turn t1
|-- visibleInputs[]
|-- assistantOutput completed
`-- postTurnEvents[]
    `-- goal verify running

session control:
  sessionEnded = false
  canStop = true
  stopTargetKind = goalVerifier
```

## Row Projection

UI 渲染 conversation 时应消费 `rows[]`，而不是直接对 flat `ChatMessage[]` 做 role + 数组位置分组。
`rows[]` 是产品渲染行索引：它可以引用 transcript message、timeline event、workLog item 或 lineage event，
但它本身不是 provider message。

```ts
type ConversationRowPlacement =
  | "inside_turn_input"
  | "inside_turn_assistant"
  | "inside_turn_worklog"
  | "after_turn"
  | "session_lineage";

interface ConversationRenderRow {
  rowId: string;
  turnId?: string;
  placement: ConversationRowPlacement;
  kind:
    | "input"
    | "assistant_output"
    | "tool"
    | "compact"
    | "goal_verification"
    | "fork"
    | "model_change"
    | "background_result";
  messageIds?: string[];
  timelineEventId?: string;
  workItemId?: string;
  anchorMessageId?: string;
  order: number;
}
```

示例：

```text
ConversationView
|-- turns
|   |-- t1 origin=user_prompt
|   `-- t2 origin=background_result
|
`-- rows
    |-- row:t1:input:user-msg-1             inside_turn_input
    |-- row:t1:assistant:assistant-msg-2    inside_turn_assistant
    |-- row:t1:compact:compact-op-1         inside_turn_worklog
    |-- row:t1:goal:target-a:1              after_turn
    |-- row:t2:input:bg-result-1            inside_turn_input
    `-- row:t2:assistant:assistant-msg-9    inside_turn_assistant
```

新数据不允许 UI 用“最近一条 assistant”“最近一条 user”“`Math.floor(index / 2)`”决定 row 归属。旧数据缺少
anchor 时可以由兼容层生成 fallback row，但 fallback 必须标记为 compatibility recovery，不能作为新协议事实。

## 用户输入规则

所有用户显式提交的命令都是 conversation event。命令的状态副作用不能替代用户输入本身。

- 首次 `/goal <objective>`：落一条 visible user query，并设置 goal。
- replace `/goal <objective>`：同样落一条 visible user query，并更新 goal。
- queued `/goal <objective>`：作为 queue item 保留；真正消费时落 visible user query 并更新 goal。
- goal continuation reminder：属于 runtime `modelOnlyInputs`，不得渲染成用户气泡。
- turn steering accepted：属于当前 turn 的 `visibleInputs`，显示为当前 turn 的用户补充。
- 每条 turn steering accepted 同时开启新的 visual work segment；前一 segment 在注入边界收口，但两段仍共享同一 `turnId` / `productTurnId`。
- turn steering rejected 或 fallback queue：属于未来 turn 的 pending input，不提前写进当前 turn。
- background result 回到 main session：属于新的 `origin=background_result` turn；provider 侧可表现为
  `role=user`，但产品层必须保留 `humanAuthored=false` 和 background source，不开放普通用户 edit 语义。

## Timeline 分类

timeline 不是业务数据的父节点，也不应伪装成普通 assistant message。它是 render row 的定位信息和
产品 lifecycle event。每条 timeline row 必须声明稳定身份、折叠策略、placement 和 anchor。

```ts
type TimelineFoldPolicy = "worklog" | "never";

interface TimelineRenderRow {
  key: string;
  timelineEventId: string;
  placement: "inside_turn_worklog" | "after_turn" | "session_lineage";
  foldPolicy: TimelineFoldPolicy;
  anchor:
    | { type: "inside_turn"; turnId: string }
    | { type: "after_turn"; turnId: string; assistantMessageId?: string }
    | { type: "after_message"; messageId: string }
    | { type: "session_start" };
}
```

| Timeline | placement | foldPolicy | 说明 |
| --- | --- | --- | --- |
| context compact | `inside_turn_worklog` | `worklog` 或 running 时可见 | assistant worklog，不切 turn |
| goal verification | `after_turn` | `never` | 被验证 turn 的 post-turn 裁判事件 |
| session fork | `session_lineage` | `never` | conversation lineage event，不属于 assistant worklog |
| model change | `session_lineage` 或 `after_turn` | `never` | 取决于是否锚定某个 turn；新数据必须显式 placement |

### Compact

上下文压缩是 assistant turn 的中间过程，属于 `workLog`：

- auto compact completed 可以被“已工作 xxx”折叠。
- running / retrying compact 需要保持可见，避免用户看不到当前状态。
- compact row 的稳定身份优先使用 `operationId`，本地 optimistic 与 agent lifecycle 用
  `inputId` / `operationId` 合并。

### Goal Verify

goal verify 是 assistant 输出后的裁判事件，属于 `postTurnEvents`：

- 必须在被验证的 assistant 输出之后出现。
- 不得进入“已工作 xxx”折叠。
- UI row key 必须是 `goal:${targetId}:iteration:${goalIteration}`。
- `verificationId` 是 verifier attempt id，只能用于 attempts 明细，不能作为 row key。
- 同一 `targetId + goalIteration` 的 started / completed / failed / cancelled 必须更新同一条 row。
- verifier 明确返回 `passed: false` 时显示未通过；verifier JSON 解析失败属于裁判链路故障，
  默认 fail-open 为 `passed: true`，但 reason 必须保留格式错误原因，便于排查。

### Fork

fork 是 conversation lineage event，不属于 assistant worklog：

- 不得被“已工作 xxx”折叠。
- 有 `targetMessageId` 时可跳回父会话源消息。
- 只有 `parentSessionId` 的旧数据只能恢复不可跳转 fallback row。

## 历史恢复

新数据应提供强 anchor：

- message: `turnId` 或可由 projection 明确归属到某个 `turnId`
- timeline: `timelineEventId`、`anchorTurnId`，可选 `anchorMessageId`
- goal verify: `anchorTurnId`，可选 `anchorAssistantMessageId`
- fork: `targetMessageId`，可选当前会话 `anchorTurnId`

旧数据没有 anchor 时，UI 可以使用时间和最近 assistant 作为 fallback，但 fallback 只能用于兼容老历史，
不能作为新数据的事实来源。

## 强不变量

- `turnId` 是 CLI/runtime 权威身份；`turnIndex` / `ordinal` 只能用于展示。
- 新协议里的 history target 优先使用 `messageId` 或 `turnId`；只有兼容旧数据时才 fallback 到 `turnIndex`。
- timeline placement 必须来自 projection；UI 禁止用数组下标或最近消息推断 timeline 位置。
- 一条 row 只能有一个明确 placement；同一个 timeline identity 的 started/completed/failed/cancelled 更新必须落到同一 row。
- background work 不阻塞当前 turn completion；background result 回 main 后开启新的 foreground turn。

## 多端边界

本模型不改变 task realtime 所有权：

- 桌面端仍走 `desktop-continuous` direct realtime。
- 手机 Web 远控仍走 `web-remote-replayable` snapshot / gap 恢复。
- relay 和 main process 不拥有 session、stream、queue、snapshot 或 timeline 业务状态。
