# Conversation Timeline Resolver Design

> **状态：已由 [16-timeline-authority-plan.md](./16-timeline-authority-plan.md) 裁决并实施。** 本文保留
> 根因分析、备选结构和迁移建议；当前落地采用 canonical fact normalizer、持久 anchor、
> `entityId/productTurnId` 寻址、`session_input` ledger 与受约束的 timeline placement，并没有把本文
> 所有通用 graph/resolver 设想原样实现。当前事实以 16 的实施状态、02/07 当前规格和代码为准。

## 状态

- 目标：解释 v4 conversation 重构后仍出现消息错位、吞消息、timeline 位置不稳定的根因，并给出一套可落地的权威排序结构设计。
- 范围：conversation session 的可见 transcript、queue drain、compact timeline、goal verify timeline、model change timeline、fork timeline、多段 assistant、background Bash/subagent completion wake。
- 非目标：本文不直接修改实现，不定义最终 UI 样式，不替代 E2E case catalog。后续实现前仍需把接受的语义回写到 case catalog 和 coverage matrix。

## 背景与问题

v4 重构的目标之一是把 conversation 状态收敛到 CLI 虚拟投影，让 UI 不再猜测 runtime 状态。但当前投影仍然更像“事件来了就生成 row”的行生成器，而不是完整的 timeline resolver。结果是 UI 虽然接近无脑渲染，但拿到的 rows 里已经混入了错误归属和错误顺序。

当前最容易混在一起的 4 种顺序：

```text
eventSeq
  事件到达 / 持久化顺序

runtimeTurnId
  runtime loop、trace、provider roundtrip 归属

productTurnId
  用户可见的逻辑轮次，queue drain、model-only continuation、background wake 都可能创建新轮次

visualPlacement
  UI timeline 上应该出现的位置，例如 assistant work 内部、turn tail boundary、下一轮之前的 light boundary
```

这 4 种顺序不能共用一个 `turnId`、`rowId` 或 append order。`event.turnId` 是 runtime 事实，不等于 UI turn 容器；`row.appended` 是传输优化，不等于视觉排序权威。

## 现有语义证据

当前 docs 已经有一些关键裁决，说明 timeline 不能再按固定 turn 模板处理：

- Synthetic user message 的 `role=user` 只表示 provider/store 物理角色，不表示 UI 用户输入。fork、rewind、goal-continuation、goal_state_change、background_task、subagent、compact summary 等必须经 projection policy 分类。
- Fork 只能针对稳定 assistant message；child 复制 fork 点前稳定 transcript 和 session 配置，不复制父 queue、live background bash/subagent、pending background result 或 continuation inbox。
- 同一个逻辑 turn 可以有多段 assistant text row；fork/retry action 只允许出现在最后一段完成态 assistant row。
- `context_compaction` 是 assistant activity，可以出现在 assistant work 内部；`session_fork`、`goal_verification`、model change 是 turn boundary，不进入 assistant history。
- Background Agent/Bash 可以让父 turn 先 completed，后台完成后通过 `<task-notification>` 唤醒 main agent 继续处理。这个 wake 是 model-only trigger，不显示成用户气泡。

这些裁决共同指向一个结构：需要先建立 typed semantic entity，再由 resolver 计算 product turn 和 visual placement。

## 为什么会“吞消息”

多数“吞消息”不是底层事实真的不存在，而是投影后的 UI rows 发生了错误归组、覆盖或隐藏。

```text
Case A: queue drain 仍落在同一个 runtime turn

T1 user Q1
T1 assistant A1
T1 drained user Q2
T1 assistant A2

如果 UI 只把同 turn 最后一条 assistant 当正文，A1 会被折进 history，
用户感觉上一轮 assistant 没渲染。
```

```text
Case B: queue item 被移除，但没有稳定 userInput entity 承接

Q[Q2] -> remove queue item
没有 userInput(sourceCommandId=Q2)

用户看到 queue 消失，transcript 也没有。
```

```text
Case C: boundary marker 没有 anchor/placement

assistant A1 final
goalVerify started event 晚到或 trace turnId 不等于 A1 turnId

如果只能 append 到尾部，marker 会落到错误轮次后面。
```

```text
Case D: 多个 assistant segment 被当作一个 latest assistant 模板

assistant A1.1 before tool
tool result
assistant A1.2 final

如果投影只保留 latest，或 fork target 绑定早段 raw assistant，
就会丢最终回复、工具结果或文件引用。
```

根因不是 UI 缺 if，而是 CLI 投影没有先完成语义守恒和权威排序。

## 设计目标

1. UI 只消费已解析的权威 timeline，不再基于 `turnId + latestAssistantTextRow` 推断结构。
2. 每个可见用户输入、assistant segment、compact lifecycle、goal verify lifecycle、fork marker、background wake 都有稳定业务身份。
3. `eventSeq` 只作为事实输入顺序，不作为视觉排序权威。
4. `runtimeTurnId` 只表达 runtime trace 归属，不直接决定 product turn。
5. 所有非尾部 placement 由 CLI resolver 处理；append-only delta 表达不了时发送 snapshot resync。
6. desktop continuous 与 web remote replayable 共享同一权威 snapshot 语义，但 delivery profile 只影响中间帧，不改变最终 timeline。

## 分层原则

时间线分层遵循三点：

1. **权威顺序是会话内 aggregate sequence**，不是 timestamp、row append 顺序或 UI 数组位置。
2. **输入生命周期独立于模型执行**。prompt 先 durable admitted，再在 safe boundary promoted 成 transcript message；queue 不依赖 renderer 内存证明自己存在过。
3. **DB 存领域事实，不存 UI 布局**。transcript projection 是领域事实，不是“第几个气泡/哪个卡片/哪条泳道”的 UI schema。

按 id 合并 message/part 的兼容层只属于 legacy client merge，不是排序权威。ZCode 采用 `event_sequence + input ledger + domain projection`，而不是把 UI rows 继续当事实源。

## 总体架构

```text
Raw Event Journal / Persisted Facts
  SessionEvent, message, part, target entry, task notification
        |
        v
Event Normalizer
  把 provider/runtime/legacy 数据归一为语义事件
        |
        v
Semantic Ledger
  维护 typed entities，不直接输出 UI row
        |
        v
Timeline Constraint Graph
  用 cause / anchor / lifecycle / copy / wake 建边
        |
        v
Timeline Resolver
  计算 productTurnId、lane、placement、orderKey、visibility
        |
        v
Materializer
  生成 ResolvedTimelineSnapshot，兼容期可再降级为 rows.window
        |
        v
UI
  无脑渲染 resolved snapshot，不再猜 turn tail 或 hidden message
```

## 最小物理字段与领域语义

本文后续出现的 `sourceCommandId`、`anchorMessageId`、`lifecycleKey`、`visibility` 等，不表示都必须新增成物理列。更推荐的持久化形态是少量稳定物理字段加 typed JSON refs：

```text
session_event / message / part
  id
  session_id
  sequence
  kind/type
  data JSON
```

`data JSON` 里存清楚领域语义：

```json
{
  "refs": {
    "parentMessageId": "msg_user_1",
    "sourceCommandId": "cmd_queue_2",
    "anchorMessageId": "msg_assistant_1",
    "originSessionId": "sess_parent",
    "originMessageId": "msg_parent_assistant"
  },
  "lifecycle": {
    "state": "promoted"
  },
  "visibility": {
    "ui": "visible",
    "provider": "hidden"
  }
}
```

不能把这些语义压缩成一个 `pid`。`pid` 只能表达树状父子关系，但 conversation timeline 至少同时存在以下正交关系：

```text
id
  我是谁

sequence
  我在当前 session 事实流里的权威顺序

parent / response-to
  assistant 回应哪个 user message

cause
  我由哪个 command / queue item / background wake 触发

anchor
  marker 显示上应该锚到哪个 message 或 turn 附近

lifecycle
  command 是 admitted、promoted、completed 还是 failed

origin
  fork/copy 后来自哪个原 session / 原 message

visibility
  UI 可见、仅 provider 可见，还是只影响状态
```

如果强行复用一个 `pid`，字段会在不同场景下分别表示 `response-to`、`display-after`、`caused-by`、`fork-from`、`compact-before`。字段数量少了，但语义被污染，resolver 仍然只能猜。

## 核心实体模型

Semantic Ledger 不以 UI row 为中心，而以业务实体为中心。

```ts
interface TimelineEntityBase {
  entityId: string;
  kind: TimelineEntityKind;
  lifecycleKey?: string;
  cause?: TimelineCause;
  anchor?: TimelineAnchor;
  visibility: "visible" | "modelOnly" | "stateOnly";
  lane: TimelineLane;
  productTurnId?: string;
  orderKey?: TimelineOrderKey;
  sourceCommandId?: string;
  copyPolicy: CopyPolicy;
}
```

建议的实体类型：

| Entity | 说明 |
| --- | --- |
| `UserIntent` | 真实用户输入、queue drain 后的用户输入、model-only continuation、background notification wake |
| `ProductTurn` | 用户可见或 model-only 的逻辑轮次容器 |
| `AssistantSegment` | 一段 assistant role 输出。一个 product turn 可有多个 segment |
| `WorkActivity` | tool、reasoning、subagent、compact 等 assistant work 内活动 |
| `TimelineBoundary` | goalVerify、fork、modelChange 等轮次边界 |
| `QueueItem` | 未来用户意图，不是 transcript |
| `BackgroundWork` | detached Bash/subagent runtime work，归属父 session，不是 queue |

## Lane 与 Placement

timeline 不再只有“用户消息”和“assistant 消息”两类。resolver 先给每个实体分 lane：

```text
queue
  QueueItem，只显示在 queue UI，不进入 transcript

trigger
  visible UserIntent 或 modelOnly UserIntent，创建 product turn

assistantWork
  assistant text / reasoning / tool / subagent / compact activity

turnTailBoundary
  goalVerify / fork，锚定某个 logical turn 的结尾

lightBoundary
  modelChange，作为轻量轮次边界

detachedState
  BackgroundWork 状态，通常由 summary/control surface 展示

stateOnly
  只影响状态，不进入 timeline rows
```

典型 lane rank：

```text
0 lightBoundaryBeforeTurn
1 trigger
2 assistantWork
3 turnTailBoundary
4 detachedState
5 stateOnly
```

`stateOnly` 不能进入 `rows.window`。如果一个 marker 决定不渲染，就不应该作为 hidden row 影响虚拟滚动、turn grouping 或 history 折叠。

## 权威排序

resolver 生成确定性的 `orderKey`：

```ts
interface TimelineOrderKey {
  branchEpoch: number;
  productTurnOrdinal: number;
  laneRank: number;
  entityOrdinal: number;
  lifecycleOrdinal: number;
}
```

排序来源不是 timestamp，也不是 row append 顺序，而是约束图：

```text
cause edge
  queue item -> drained UserIntent
  background work completed -> background wake UserIntent

anchor edge
  AssistantSegment A1 -> goalVerify(targetId, iteration)
  AssistantSegment A1 -> forkCreated/forkNotice

lifecycle edge
  compact started -> compact completed/failed/interrupted
  goalVerify started -> goalVerify completed/cancelled

turn edge
  ProductTurn trigger -> AssistantSegment / WorkActivity

copy edge
  fork source assistant -> child copied graph
```

resolver 对约束图做 deterministic topological placement。相同位置的实体再用 `entityOrdinal` 稳定排序，不能依赖 DB id 字典序。

## 关键语义规则

### Queue Drain

queue 是未来用户意图，不绑定当前 runtime turn。drain 后必须创建新的 product turn。

```text
T1
  user Q1
  assistant A1 final

Q[Q2]

T2
  user Q2
  assistant A2
```

如果 runtime 实现仍在同一个 activeTurn 内完成 roundtrip，projection 也必须拆出新的 `productTurnId`。`runtimeTurnId` 不能直接成为 UI turn。

### 多段 Assistant

一个 product turn 可以包含多个 assistant segment：

```text
T1
  trigger: user Q1
  assistantWork:
    AssistantSegment A1.1
    ToolCall Bash
    ToolResult
    AssistantSegment A1.2 final
```

所有 segment 都必须保留。UI 可以折叠早段，但 resolver 不能覆盖。fork/retry/action target 只挂在最后稳定完成态 assistant segment 上。

### Compact

compact 是 assistant activity，不是用户气泡，也不是强制 turn boundary。

```text
T1
  user Q1
  assistantWork:
    assistant before compact
    compact running
    compact success
    assistant after compact
```

手动 `/compact` 命令是命令入口，不显示为普通 user query。若没有后续 assistant，compact 可以作为独立弱 timeline 显示，但仍不是一个空 user turn。

### Goal Verify

goal verify 是 turn tail boundary。身份以 `targetId + goalIteration` 为主，`verificationId` 只能作为单次 attempt alias。

```text
T1
  user Q1
  assistant A1 final

BM goalVerify(target-1, iteration-1) running -> notSatisfied

T2
  trigger: modelOnly goal continuation
  assistant A2 final

BM goalVerify(target-1, iteration-2) running -> pass
```

goal verify 必须有 anchor：

```text
anchor = anchorAssistantMessageId || anchorTurnId || explicit fallback placement
```

如果 anchor 指向的 turn 已经在窗口中间，且当前 delta 只能 append，则不能硬 append 到尾部，应发 snapshot resync。

### Model Change

model change 是 light boundary，不是 assistant work。用户仅切换草稿模型不污染 transcript；只有下一次 accepted turn 真正使用了新模型，才生成 boundary。

```text
T1 assistant A1

BM modelChange(old -> new)

T2 user Q2
T2 assistant A2 using new model
```

首轮使用某个模型不构成 model change。若产品决定 modelChange 不在 transcript 中可见，则它应为 `stateOnly` 或单独 banner state，不应进入 `rows.window`。

### Fork

fork 应按 graph cut，而不是 DOM row 或当前 latest assistant。

```text
parent:
T1 user Q1
T1 assistant A1 final  <-- fork source
BM goalVerify #1
Q[pending]
BG[background running]
T2 active running

child:
copy graph <= A1 final
copy session config
copy eligible goal state / verifier entries
do not copy queue
do not copy background work
do not copy continuation inbox
do not copy active run fields
```

父 session 追加：

```text
BM forkCreated(childSessionId, anchor=A1)
```

child session 追加：

```text
BM forkNotice(parentSessionId, anchor=A1-copy)
```

Goal fork state 需要复制 fork 点之前的 target 和 verifier timeline，并改写 copied verifier 的 `anchorAssistantMessageId` 到 child message id。不能在 bootstrap/protocol 层用 `setTarget` 重新创建空 target。

fork 的核心不只是复制，而是 **copy by value + provenance**：

```text
parent session S1
  seq 1  U1
  seq 2  A1
  seq 3  U2
  seq 4  A2  <-- fork point

child session S2
  seq 1  fork.created {
           originSessionId: S1,
           originMessageId: A2,
           originSequence: 4
         }
  seq 2  U1' { originMessageId: U1 }
  seq 3  A1' { originMessageId: A1 }
  seq 4  U2' { originMessageId: U2 }
  seq 5  A2' { originMessageId: A2 }
```

因此 fork 后每条 copied message 都有两种身份：

```text
local identity
  child session 内的新 id / 新 sequence
  用于排序、渲染、继续对话、anchor 解析

origin provenance
  parent session / parent message / parent sequence
  只用于追溯来源、展示来源、debug，不参与 child 的 UI placement
```

所有被复制的本地引用都必须 remap 到 child session 的 local id：

```text
parent:
  S1.A2.parentMessageId = S1.U2

child:
  S2.A2'.parentMessageId = S2.U2'
  S2.A2'.originMessageId = S1.A2

错误:
  S2.A2'.parentMessageId = S1.U2
```

这条规则同样适用于 `anchorMessageId`、`sourceCommandId`、goal verifier anchor、compact anchor。若引用对象没有被复制，不能继续作为 child local anchor，只能降级为 `originRef` 或 diagnostics fallback。

### Background Bash / Subagent

background work 是 detached runtime work，不是 queue，也不是普通 user message。

```text
T1
  user Q1
  assistantWork:
    Agent(run_in_background=true)
    tool result: backgrounded
    assistant A1 final
  completed

BackgroundWork BG1 running

BG1 completed
  -> BackgroundWakeCommand

T2
  trigger: modelOnly backgroundNotification(BG1)
  visible user bubble: none
  assistantWork:
    assistant A2 handles <task-notification>
```

用户裁决：background notification 不需要显示成用户气泡。本文将其建模为 `visibility=modelOnly` 的 `UserIntent`，可以创建 product turn，但不生成 visible user row。是否额外显示轻量 system boundary 不在本轮设计内；默认不进入 transcript rows。

background completion 仍通过 runtime command queue 消费，不新增同 session 并发 `executeTurn`。如果 active loop 仍有合法 roundtrip，notification 可以合流；idle 时通过 model-only wake 串行继续。

## Snapshot Contract

最终 UI 最理想消费的是结构化 snapshot，而不是扁平 rows：

```ts
interface ResolvedTimelineSnapshot {
  revision: number;
  branchEpoch: number;
  nodes: TimelineNode[];
  queue: QueueState;
  backgroundWorks: BackgroundWorkSummary[];
  controls: SessionActionAvailability;
}

type TimelineNode =
  | ResolvedTurnNode
  | ResolvedBoundaryNode
  | ResolvedMaintenanceNode;

interface ResolvedTurnNode {
  productTurnId: string;
  trigger?: ResolvedTrigger;
  assistantSegments: ResolvedAssistantSegment[];
  workActivities: ResolvedWorkActivity[];
  tailBoundaries: ResolvedBoundaryNode[];
}
```

兼容期可以继续 materialize 成 `rows.window`，但 rows 必须带上 resolver 结果：

```text
entityId
productTurnId
lane
placement
anchor
orderKey
visibility
lifecycleKey
sourceCommandId
```

UI 可以临时沿用现有组件，但不再自己从 `turnId + latestAssistantTextRow` 推断逻辑结构。

## Delta 与 Resync

现有 append-only delta 可以保留，但语义必须收紧：

```text
尾部新增
  row.appended

生命周期状态更新
  row.upserted

分支删除
  row.removed

文本增量
  row.delta

非尾部插入 / 重排 / late placement 修正
  snapshot.resync
```

不要让客户端用 `row.upserted` 模拟移动，因为现有 apply 只按 rowId 替换，不改变位置。只要 resolver 发现一个可见 entity 的 `orderKey` 位于已发送窗口中间，就应该发 snapshot resync 或进入新的 snapshot epoch。

## 守恒不变量

resolver 每次生成 snapshot 后必须运行守恒检查。失败时不要把坏 snapshot 发给 UI，应记录 error，并在开发环境下暴露诊断。

```text
输入守恒
  每个 visible inputId 必须在 QueueItem 或 UserIntent row 中二选一。
  不能两边都没有，不能两边都有。

assistant 守恒
  每个 assistantMessageId 必须对应一个 AssistantSegment。
  后来的 assistant 不能覆盖前一个 assistant。

compact 守恒
  每个 compact operationId/inputId 对应一个 WorkActivity。
  started/success/failed/interrupted 更新同一实体。

goal verify 守恒
  同一 targetId + iteration 只有一个 boundary entity。
  verificationId 是 alias，不是 UI 主身份。

fork 守恒
  fork source 必须是稳定 assistant segment。
  child 不能包含 parent queue、live background work、pending background result、continuation inbox、active run fields。

background 守恒
  每个 completed background notification 要么 pending wake，要么已生成 modelOnly wake turn。
  不生成 visible user bubble。

渲染守恒
  visible entity 必须有 renderer。
  stateOnly entity 不得进入 timeline rows。
  hidden/modelOnly trigger 不得影响 visible user turn count。
```

## 真实持久化结构

2026-07-07 只读检查本机真实持久化数据后，确认 conversation 相关数据不是单一数据库事实源，而是三层：

```text
UI v4 virtual projection
  <- zcode protocol snapshot/live
    <- CLI transcript store: ~/.zcode/cli/db/db.sqlite
       - session
       - message(id, session_id, time_created, time_updated, data JSON, sequence)
       - part(id, message_id, session_id, time_created, time_updated, data JSON, sequence)
       - session_entry(...)

App metadata store: ~/Library/Application Support/ai.z.zcode/zcode.db
  - sessions / workspaces / follow_up_queue / session_notifications
  - 不存完整 transcript

Task list/search index: ~/.zcode/v2/tasks-index.sqlite
  - tasks / task_groups / searchable_text
  - 只服务列表、分组、搜索，不应作为消息顺序真相源
```

真实 CLI DB 才是会话正文权威库。本次检查到的规模：

| Store | Count / Schema fact |
| --- | --- |
| `session` | 2,989 rows |
| `message` | 26,942 rows，`data` 为 JSON，物理列已有 `sequence` |
| `part` | 96,112 rows，`data` 为 JSON，物理列已有 `sequence` |
| `session_entry` | 1,402 rows，主要为 `target_completion_verification` 和 `runtime/bash_shell_selection` |
| app `follow_up_queue` | 当前 0 rows，结构为 `session_id + position + payload`，不是 transcript 顺序源 |

`message` / `part` 的 repository 读取顺序当前是：

```text
message:
  order by sequence is null, sequence, time_created, rowid

part:
  order by message_id, sequence is null, sequence, time_created, id
```

这说明代码已经把 `sequence` 作为新数据主排序字段，并为缺失 `sequence` 的数据保留 fallback。

## 真实数据暴露的风险

当前不是“数据库完全没有排序字段”，而是排序字段和语义锚点都不够可靠。

```text
0014_message_part_sequence migration
  applied at 2026-06-29 06:50:36 EDT

NULL sequence rows observed after migration
  message.sequence null: 1,690 rows
  part.sequence null:    5,933 rows
  affected sessions:       331
  range: 2026-06-29 07:50:30 EDT -> 2026-07-07 09:01:35 EDT
```

因此 NULL `sequence` 不是纯老数据包袱。当前或近期仍有写入、导入、修复脚本、raw SQL 或其他未定位旁路绕过了统一 `saveMessage` / `savePart` 写法，或者以旧 SQL 直接写入。已核实的 fork 主路径若走 `persistMessage` / `persistPart` / session-store repository，不应再被当作 NULL sequence 的默认嫌疑；后续应继续用日志和 DB invariant 找到真实旁路。

语义字段覆盖也明显不足：

| Field / fact | Count |
| --- | ---: |
| `message.data.semantics` | 569 / 26,942 |
| `message.data.anchor` | 432 / 26,942 |
| `message.data.anchor.turnId` | 425 / 26,942 |
| `part.type = timeline` | 45 / 96,112 |
| timeline `anchorMessageId` | 21 / 45 |
| timeline `anchorTurnId` | 10 / 45 |

timeline 类型分布：

| `timelineType` | Count |
| --- | ---: |
| `model_change` | 24 |
| `goal_verification` | 10 |
| `session_fork` | 6 |
| `context_compaction` | 5 |

这解释了 goal verify、fork、compact 等 marker 为什么容易漂：真实数据里很多 marker 没有足够 anchor，resolver 若只按 append 位置、timestamp 或当前 turn 推断，就会在冷恢复、late event、fork copy、queue drain 后出现错位。

## 持久化字段与数据库关系

本文不要求把所有 resolver 字段都直接变成数据库列。正确分层应是：

1. `~/.zcode/cli/db/db.sqlite` 的 `session/message/part/session_entry` 是 conversation transcript 的权威事实源。
2. app `zcode.db` 只存 app 元数据、通知、renderer-local queue，不作为 transcript 顺序源。
3. `tasks-index.sqlite` 只存任务列表、搜索、分组，不作为 transcript 顺序源。
4. 新写入 `message` / `part` 必须通过统一 repository，保证 `sequence` 非空且同 session / message 内稳定单调。
5. 新写入 timeline part 时必须记录 anchor 和 semantic fields，例如 `anchorMessageId`、`anchorTurnId`、`lifecycleKey`、`visibility`、`timelineType`。
6. 新写入用户意图、queue drain、background wake 时必须保留 `sourceCommandId` / `cause` / `origin` / `turnId`，否则 UI 无法区分真实用户输入、队列消费、model-only wake。
7. CLI cold resume 必须从 persisted facts 重新喂给同一个 resolver，而不是另写一套 hydration 顺序逻辑。
8. materialized snapshot 可以缓存 `entityId/productTurnId/orderKey`，但缓存不是事实源。

数据库是否需要加物理列，要按风险分层处理：

```text
必须先修
  所有未来 message / part 写入都带 sequence。
  没有 sequence 的历史/异常数据在读取时必须可推导，不得丢弃。

建议新增或等价实现
  session_command / session_input 账本。
  至少表达 command/input admitted -> promoted -> cancelled/failed 的 durable 生命周期。
  可以是独立表，也可以是 session_event 里的 command.* events；
  但不能只存在 renderer-local queue 或 runtime 内存里。

建议补强 JSON contract
  semantics / anchor / sourceCommandId / cause / visibility / lifecycleKey。
  这些字段是 resolver 语义锚点，适合增量写入 JSON，保持老数据兼容。

暂不优先加物理列
  productTurnId / orderKey / lane / placement。
  这些是 resolver 输出，不是原始事实。可以缓存，但不应成为唯一事实。
```

推荐的最小持久化边界：

```text
event_sequence 或 session_sequence
  session_id
  next_sequence

session_command / session_input
  id
  session_id
  kind
  delivery_kind
  client_mode
  payload_json
  admitted_sequence
  promoted_sequence
  promoted_message_id
  status
  time_created
  time_updated

message / part
  sequence 非空
  data JSON 带 typed refs / semantics
```

如果已有统一 allocator 能保证所有 transcript facts 使用同一套 session 内单调 sequence，可以不新增 `session_sequence` 表；否则应新增或等价实现一个 allocator，避免 message、part、session_entry、command 各自生成不可比较的顺序。

根因不是简单“数据库少一个排序字段”。真实问题是：`sequence` 已存在但覆盖不完整，语义锚点覆盖率也低；因此 projection snapshot 必须成为权威 resolver，不能让 UI 或 hydration 从 row 顺序、role、turnId 里反推。

## 测试与验收分层

先用 L1/L2 稳住 resolver，再挑代表性 E2E。旧 E2E 不要求一次性全绿，但每个 accepted case 必须有明确 setup/action/assert。

```text
L1: Semantic Ledger / Resolver golden
  输入事件序列 -> typed entities -> resolved orderKey/nodes

L2: Materializer / profile convergence
  continuous/replayable 最终 snapshot 一致
  late placement 触发 resync

L3: UI render unit
  UI 只按 resolved nodes 渲染，不重新猜 turn tail

L4: E2E representative
  queue drain 两轮 assistant 都可见
  compact 不产生用户气泡，不切碎 assistant work
  goal verify 按 anchor 落 turn tail
  modelChange 不污染首轮和草稿切换
  fork graph cut 不复制 queue/background
  merged assistant fork 只允许最后稳定 segment
  background completion model-only wake 不显示用户气泡
```

## 迁移建议

1. 在 docs 中裁决并冻结 `eventSeq/runtimeTurn/productTurn/visualPlacement` 四层边界。
2. 先审计所有 `message` / `part` 写入路径，禁止绕过 session-store repository；修复后新增 DB invariant，避免迁移后继续制造 NULL `sequence`。
3. 对现有 NULL `sequence` 做兼容 backfill 或读取期稳定推导。读取期推导不能改变历史事实，但必须保证同一 session 多次 hydrate 得到同一顺序。
4. 新增或等价实现 `session_command` / `session_input`，把 queued prompt、background wake、resume input 的 admitted/promoted 生命周期持久化。
5. 为新写入的 v4 facts 补齐 `semantics`、`anchor`、`sourceCommandId`、`cause`、`origin`、`visibility`、`lifecycleKey`。老数据缺字段时由 resolver 推导，不做破坏性强迁移。
6. 为 fork copied message 生成 child local id / local sequence，并 remap child 内部 refs；parent id 只能进入 `origin*` provenance。
7. 为 v4 row/snapshot 增加 `entityId/productTurnId/lane/placement/anchor/visibility/lifecycleKey/orderKey`。
8. 新增 Semantic Ledger 和 Timeline Resolver，先只覆盖 queue、assistant segment、compact、goalVerify、fork、modelChange、background wake。
9. materializer 继续输出旧 rows 形态，但 rows 来自 resolved graph；任何无法归组的 visible message/part 必须进入 diagnostics fallback row，不允许静默丢弃。
10. UI render units 改为消费 resolver 结果，逐步删除 `turnId + latest assistant` 的推断逻辑。
11. cold resume、desktop continuous、web remote replayable 全部走同一个 resolver。
12. 对守恒失败加服务层日志和开发态诊断，避免坏 snapshot 静默进入 UI。

## 需要后续单独裁决的问题

1. Background notification 是否需要轻量 system boundary。当前裁决：不显示成用户气泡，默认不进入 transcript rows。
2. modelChange 最终是 timeline row 还是 SessionPane/banner state。无论选择哪种，都不能以 hidden row 形式污染 rows.window。
3. goal verifying 是否继续作为 compact/fork 的 lock。当前较新的 case catalog 表达为不产生独立 validating lock，但 formal-proof 和部分实现仍是旧语义，需要单独回写裁决。
4. append-only delta 是否扩展 `row.inserted/row.moved`。本文建议不扩展，非尾部变化统一 snapshot resync，降低客户端错误面。

## 结论

要彻底解决消息顺序和吞消息，不能继续把 CLI projection 当作“row append reducer”。CLI 需要成为真正的 timeline authority：

```text
事实归一
  raw events -> typed semantic entities

顺序归一
  constraint graph -> productTurnId / lane / orderKey

显示归一
  resolved snapshot -> UI 无脑渲染

守恒归一
  输入、assistant、compact、goal、fork、background 全部有 invariant
```

只有做到这一层，UI 才能真的不猜、不补、不吞。
