# Conversation Transcript Storage

> **实现状态：已落地。** `0014_message_part_sequence` / `0015_message_part_sequence_backfill_and_guard`
> 已提供稳定顺序，contracts 已声明 `MessageSemantics` / `TimelinePart`，V4 hydration 已消费 timeline part。
> 下文 Phase 1–5 保留为实施轨迹，不再表示待实现工作。

## 背景

聊天 transcript 的核心模型仍然是：

```text
session -> message -> part
```

这条主线不能再被 `session_entry`、renderer store、text metadata、单独 timeline 表
切开。timeline 是聊天内容流里的一个结构化片段，因此应该是 `part` 的一种：

```text
message.parts[] includes { type: "timeline", ... }
```

但 `timeline` 不能是任意 JSON。它必须由 contracts 和 protocol schema 声明，
运行时写入、snapshot 恢复、UI 渲染都只消费这个强结构。

## 设计原则

| 原则 | 说明 |
| --- | --- |
| timeline 是 part | compact、fork、goal verification、model change 都写成 `part.type="timeline"`。 |
| JSON 不是兜底袋子 | timeline 字段仍在 `part.data` JSON 里，但由 TypeScript 类型和 Zod protocol schema 约束。 |
| role 和产品语义分离 | `message.role` 只表示 provider role；真实用户、model-only reminder、command、timeline 由显式字段声明。 |
| 顺序显式 | message 和 part 的渲染顺序不能依赖 id 字典序。 |
| 老数据可读 | 新版本必须能从 legacy compaction part、fork text metadata、goal session_entry、renderer-only model_change 语义中恢复。 |

## 数据库结构

现有 `message` / `part` 表保留，核心数据仍存 `data` JSON。
本次只对排序和查询稳定性做必要加法。

### message.sequence

```sql
alter table message add column sequence integer;

create index if not exists message_session_sequence_idx
  on message(session_id, sequence, time_created, id);
```

语义：

- `sequence` 是 session 内 message 的稳定渲染顺序。
- 新 message 写入时，在事务内按该 session 的 `max(sequence) + 1` 分配。
- 更新同一 message 时保持原 sequence。
- 老数据 backfill 时按现有顺序固化：`time_created, rowid`。
- 读路径 fallback：`sequence is null, sequence, time_created, rowid`。

### part.sequence

```sql
alter table part add column sequence integer;

create index if not exists part_message_sequence_idx
  on part(message_id, sequence, time_created, id);
create index if not exists part_session_sequence_idx
  on part(session_id, message_id, sequence);
```

语义：

- `sequence` 是 message 内 part 的稳定顺序。
- 新 part 写入时，在事务内按该 message 的 `max(sequence) + 1` 分配。
- 更新同一 part 时保持原 sequence。
- 老数据 backfill 时按旧顺序固化：`message_id, time_created, rowid/id`。
- 读路径 fallback：`sequence is null, sequence, time_created, id`。

## Message 语义

`UserMessageInfo` 和 `AssistantMessageInfo` 增加可选 `semantics` 字段。该字段存入
`message.data`，不是额外表；因为它描述的是 message 自身，不需要跨 message 查询。

```ts
interface MessageSemantics {
  origin: "real_user" | "agent_runtime" | "system" | "migration";
  kind:
    | "user_prompt"
    | "slash_command"
    | "system_reminder"
    | "background_notification"
    | "subagent_notification"
    | "todo_reminder"
    | "rewind_notice"
    | "fork_notice"
    | "timeline_event"
    | "compact_summary"
    | "assistant_response";
  source?: string;
  commandName?: string;
  uiVisibility: "visible" | "hidden" | "debug";
  providerVisibility: "visible" | "hidden";
  transcriptVisibility: "visible" | "hidden";
}
```

兼容期内继续保留旧字段：

- `synthetic`
- `source`
- `visibility`
- text part metadata 中的 `source` / `visibility` / `runtimeMessage`

新写入必须同时写 `semantics`；旧字段只用于 legacy fallback 和降级兼容。

核心映射：

| 数据 | origin | kind | uiVisibility | providerVisibility |
| --- | --- | --- | --- | --- |
| 用户普通输入 | real_user | user_prompt | visible | visible |
| `/goal xxx` 可见命令 | real_user | slash_command | visible | visible |
| `/compact` 操作 | real_user | slash_command | hidden | hidden |
| goal continuation | agent_runtime | system_reminder | hidden | visible |
| background task notification | agent_runtime | background_notification | hidden | visible |
| subagent notification | agent_runtime | subagent_notification | hidden | visible |
| todo reminder | agent_runtime | todo_reminder | hidden | visible |
| timeline carrier | system | timeline_event | visible | hidden |
| compact summary context | agent_runtime | compact_summary | hidden | visible |
| assistant 正文 | agent_runtime | assistant_response | visible | visible |

## Timeline Part

新增 `MessagePart` 类型：

```ts
type TimelinePart =
  | ContextCompactionTimelinePart
  | GoalVerificationTimelinePart
  | SessionForkTimelinePart
  | ModelChangeTimelinePart;

interface TimelinePartBase {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "timeline";
  timelineType:
    | "context_compaction"
    | "goal_verification"
    | "session_fork"
    | "model_change";
  display: "separator" | "worklog";
  status?: string;
  anchorMessageId?: MessageId;
  anchorTurnId?: TurnId;
  time?: {
    start?: number;
    end?: number;
  };
}
```

### ContextCompactionTimelinePart

```ts
interface ContextCompactionTimelinePart extends TimelinePartBase {
  timelineType: "context_compaction";
  operationId: string;
  trigger: "manual" | "auto" | "reactive" | "partial" | "session_memory";
  phase?: "standalone_turn" | "pre_request" | "mid_turn" | "reactive";
  compactReason?: string;
  boundaryId?: string;
  summaryMessageId?: MessageId;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  reason?: string;
}
```

### GoalVerificationTimelinePart

```ts
interface GoalVerificationTimelinePart extends TimelinePartBase {
  timelineType: "goal_verification";
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  verification?: {
    passed: boolean;
    reason: string;
    nextAction?: string | null;
  };
}
```

### SessionForkTimelinePart

```ts
interface SessionForkTimelinePart extends TimelinePartBase {
  timelineType: "session_fork";
  parentSessionId: SessionId;
  targetMessageId: MessageId;
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
```

### ModelChangeTimelinePart

```ts
interface ModelChangeTimelinePart extends TimelinePartBase {
  timelineType: "model_change";
  fromModel?: {
    providerId: string;
    modelId: string;
    variant?: string;
    label?: string;
  };
  toModel: {
    providerId: string;
    modelId: string;
    variant?: string;
    label: string;
  };
}
```

## 写入规则

所有 timeline 都必须挂在一个 message 上。

| 场景 | message | part |
| --- | --- | --- |
| manual compact | synthetic assistant carrier | `timeline/context_compaction` |
| auto compact | 当前或 synthetic assistant carrier，按现有 worklog 语义 | `timeline/context_compaction` |
| fork notice | fork child 中 synthetic user 或 assistant carrier，兼容期保留旧 fork notice | `timeline/session_fork` |
| goal verifier | synthetic assistant carrier，锚定被验证的 assistant | `timeline/goal_verification` |
| model change | 下一次 accepted user input 之前插入 synthetic assistant carrier | `timeline/model_change` |

更新规则：

- started -> completed/failed/interrupted 更新同一个 timeline part。
- `part.id` 是身份，`part.sequence` 是位置，更新时不能改变 sequence。
- 同一语义 timeline 需要稳定 identity：
  - compact：`operationId`
  - goal verification：`targetId + goalIteration`，没有 iteration 时 `verificationId`
  - fork：`parentSessionId + targetMessageId + targetCheckpointId`
  - model change：`task/session + createdAt + requestId`

## 兼容策略

### 新版本读取旧数据

新版本读 session 时做 legacy canonicalization：

1. 如果 message/part sequence 缺失，按旧顺序 fallback，并可后台 backfill。
2. 如果 message semantics 缺失，从旧字段推导：
   `synthetic/source/visibility/part.metadata/runtimeMessage`。
3. legacy compaction part 继续识别，并投影为 `timeline/context_compaction`。
4. legacy fork text metadata 继续识别，并投影为 `timeline/session_fork`。
5. legacy goal verifier `session_entry` 继续识别，并投影为 `timeline/goal_verification`。
6. legacy model change 过去只在 renderer 内存中，不做历史恢复。

legacy fallback 只在读取侧存在；新写入必须写 `timeline` part。

### 降级兼容

如果要求用户升级后再用旧版本打开也不崩，需要一个兼容窗口：

- 兼容期内 compact 继续双写旧 `compaction` part。
- 兼容期内 fork 继续双写旧 synthetic notice metadata。
- 兼容期内 goal verifier 继续写 `session_entry`。
- 老版本不认识 `part.type="timeline"` 时可能无法完整展示新 timeline；这是降级显示损失，不应影响新版本读取。

如果必须保证旧版本完全不遇到 unknown part type，则需要先发布一个“旧版本容忍 unknown part”
的过渡版本，再开始写 `timeline` part。否则只能保证新版本向下读取旧数据，不能保证无限制二进制降级。

## 当前实施边界：先夯实 CLI 和数据结构

第一阶段不改 UI 渲染行为。目标是让 agent/CLI 写出来的数据本身已经完整、
有序、可恢复，UI 后续只需要消费稳定 transcript。

本阶段包含：

1. session-store migration、sequence backfill、读写排序。
2. contracts 和 zcode protocol 增加 `timeline` part 与 message semantics schema。
3. CLI runtime 写入 compact、fork、goal verification、model change timeline。
4. CLI snapshot / protocol mapper 能读写 timeline part。
5. legacy 数据 canonicalization 放在 CLI/shared 读路径，保证老数据可读。

本阶段不包含：

1. 不重写 `packages/ui` 的 timeline projection。
2. 不删除现有 renderer fallback。
3. 不改变当前聊天列表和 divider 的视觉表现。
4. 不强制移除 legacy compaction part、fork text metadata、goal `session_entry`。

完成第一阶段后，UI 仍可继续按旧路径渲染；但新 snapshot 已经携带规范的
`part.type="timeline"`，为第二阶段 UI 切换消费源做好准备。

## 读路径

新 snapshot 构造：

1. 从 `message` 按 `sequence` 读取。
2. 从 `part` 按 `message_id, sequence` 读取。
3. `mapMessagePart` 识别 `type="timeline"` 并直接映射到 protocol。
4. 第一阶段保留现有 UI fallback，不要求 UI 立即消费 timeline part。
5. 第二阶段再让 UI projection 优先从 timeline part 生成 render row。

legacy compaction/session_entry/text metadata fallback 先保留，直到 UI 完成切换并验证。

## 代码落点

| 层 | 文件 |
| --- | --- |
| migration | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` |
| rows/repositories | `apps/zcode-cli/packages/adapters/src/storage/session-store/rows.ts`、`repositories/messages.ts` |
| contracts | `apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts` |
| runtime writes | `apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts`、`compact-persistence.ts`、`session-fork.ts`、`events.ts`、model set path |
| protocol | `packages/shared/src/zcode-protocol/index.ts`、`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts` |
| shared read compatibility | `packages/shared/src/zcode-session-visible-content.ts`、`packages/shared/src/zcodePersistedMessageMerge.ts` |
| V4 transcript hydration | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`、`product-projection.ts` |
| UI projection | `packages/ui/src/v4/conversationProjectionStore.ts`、`packages/ui/src/v4/sessionDataLayer.ts` |

## CLI / 数据层实施轨迹

### Phase 1：稳定排序，不改变业务语义

- 增加 `message.sequence` 和 `part.sequence` migration。
- backfill 老数据顺序。
- repository 写入新 message/part 时分配 sequence，更新已有行时保持 sequence。
- repository 读取改为 sequence 优先，缺失时 fallback 到旧顺序。
- 加 session-store 单测覆盖同毫秒 message/part 的稳定顺序。

### Phase 2：扩展 transcript schema

- contracts 中增加 `MessageSemantics` 和 `TimelinePart` 类型。
- protocol 中增加 `part.type="timeline"` schema。
- message mapper 支持 timeline part 透传。
- reader 对 unknown legacy 字段保持兼容，避免老数据因为缺字段失败。

### Phase 3：统一 CLI timeline 写入 helper

- 在 runtime persistence 层增加 timeline 写入/upsert helper。
- helper 负责创建 synthetic carrier message、分配 part identity、设置 sequence。
- started -> completed/failed/interrupted 只更新同一个 timeline part 的 data/status。
- 所有 timeline payload 通过 contracts 类型创建，不允许业务路径手写散乱 JSON。

### Phase 4：迁移核心业务写入

- compact：写 `timeline/context_compaction`，兼容期继续写旧 `compaction` part。
- fork：fork child session 写 `timeline/session_fork`，兼容期继续写旧 fork notice metadata。
- goal verification：写/upsert `timeline/goal_verification`，兼容期继续写 `session_entry`。
- model change：先记录 pending model change，在下一次 accepted user input 之前写
  `timeline/model_change`；如果用户只是切换后不发送，不污染 transcript。
- synthetic system reminder / command：写 `message.semantics`，兼容期继续保留旧
  `synthetic/source/visibility` 字段。

### Phase 5：CLI snapshot 和恢复验证

- session snapshot 输出规范 timeline part。
- compact recovery 同时识别新 timeline part 和 legacy compaction part。
- goal verification 冷启动优先恢复 timeline part，缺失时 fallback 到 `session_entry`。
- 确认 desktop continuous 和 web remote replayable 都从同一 session snapshot 恢复，
  不把业务 timeline 状态下沉到 relay/main。

### Phase 6：第二阶段 UI 切换准备

- CLI/data 阶段完成后，再单独做 UI projection 切换。
- UI 切换时只改消费源：优先 timeline part，legacy fallback 兜底。
- legacy write 的移除需要再开一个兼容窗口决定。

## 测试要求

必须覆盖：

- 老 DB 没有 sequence：启动后顺序不变。
- 老数据同毫秒 message：sequence/fallback 固化为旧 `rowid` 顺序。
- 老数据同毫秒 part：part 顺序稳定。
- legacy compact part：CLI/shared 读路径可识别，不破坏 snapshot。
- legacy fork notice：CLI/shared 读路径可识别，不破坏 snapshot。
- legacy goal verifier session_entry：CLI/shared 读路径可识别，不破坏 snapshot。
- 新写入 compact/fork/goal/model timeline：snapshot 中都表现为 `part.type="timeline"`。
- desktop continuous 和 web remote replayable 都只从 agent/session snapshot 恢复，不把 timeline 状态下沉到 relay/main。

## 开放问题

- 是否需要完整二进制降级兼容。如果需要，需要先让旧版本容忍 unknown part type。
- model change 的落库时机是否固定为“下一次 accepted user input 之前”。如果改成“切换成功立即落库”，会让单纯试选模型污染历史 timeline。
- compact 的 worklog/boundary 分类是否只影响 UI projection，还是也需要持久化。当前设计持久化 `display`，避免 UI 自行推断。
