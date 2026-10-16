# Protocol Schema：V4 对话核心闭环

本文是 [10-protocol-spec.md](./10-protocol-spec.md) 的结构速查，定义 V4 wire v3、conversation topic、输入意图、查重与 fork 的公共形状。字段语义、限额和 guard 以 10 为准；订阅恢复与背压分别见 [04](./04-sync-and-recovery.md) 和 [05](./05-transport-and-backpressure.md)。

## 0. 设计立场

1. UI 只 apply CLI 权威 projection，不从 phase、数组位置或 raw message 推断 queue/fork 状态。
2. 小对象整体替换；rows 只允许封闭的五种 delta；snapshot 永远原子替换。
3. 所有已提交输入共享一个 CLI `CommandInbox` FIFO；UI 只保留 draft 与 optimistic overlay。
4. transport/profile 只能改变中间帧，不能改变 command、queue、row 或最终状态语义。

## 1. Wire v3 握手与可信连接

```ts
interface HelloMessage {
  kind: "hello";
  protocolVersion: 3; // wire version；projection snapshot schema 仍独立版本化
  connectionId: string;
  clientMode: "desktop-continuous" | "web-remote-replayable";
  deliveryProfile: "continuous" | "replayable";
  serverTime: number;
  capabilities: HostCapabilities;
  auth: { userId?: string };
}

interface ClientHello {
  kind: "clientHello";
  protocolVersion: 3;
  clientId: string;
  clientKind?: "desktop" | "web" | "mobileRemote" | "mobileApp"; // 仅遥测/展示
  appVersion: string;
}
```

`connectionId/clientMode/deliveryProfile` 由 host 按 attachment 类型赋值，客户端不能覆盖：桌面（含 SSH/WSL/Docker）=`continuous`，手机 remote/WebSocket=`replayable`。

```ts
interface SubscribeParams {
  topic: string;
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  // 禁止 clientMode / deliveryProfile / connectionId：connection facade 自动注入。
}

interface SubscribeAck {
  subscriptionId: string;
  mode: "snapshot" | "resume";
  logEpoch: string;
}

interface ConversationResyncParams {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}
```

方法名：`v4/conversation/subscribe`、`v4/conversation/unsubscribe`、`v4/conversation/resync`。端口关闭等价于对该 `connectionId` 的所有 subscription 执行 unsubscribe。

subscribe response 只返回 `SubscribeAck`。ACK 写出后，initial snapshot/resume 与在线帧统一使用 owning attachment 的 `TopicWireFrame` notification；禁止在 response 中内嵌 logical snapshot 或 `frames[]`。

## 2. Logical TopicFrame 与 physical TopicWireFrame

```ts
interface TopicFrame<S, D> {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: number;
  payload:
    | { kind: "snapshot"; snapshot: S }
    | { kind: "deltas"; deltas: D[] };
}

type TopicWireFrame<S, D> =
  | {
      wireVersion: 3;
      kind: "complete";
      logicalFrameId: string;
      frame: TopicFrame<S, D>;
    }
  | {
      wireVersion: 3;
      kind: "fragment";
      logicalFrameId: string;
      subscriptionId: string;
      fragmentIndex: number;
      fragmentCount: number;
      logicalBytes: number;
      checksum: { algorithm: "crc32"; value: string };
      dataBase64: string;
    };
```

- 每个 physical JSON/RPC frame 连 envelope 严格 `<=1 MiB`。
- subscriber buffer 在 profile filter + coalesce 后必须同时 `<=500 ops`、`<=max(1 MiB, snapshot 上界)`（见 05 §3）；超限清空并转 resync，下一次只发最新 snapshot。
- snapshot/resume logical frame 可分片，assembly `<=16 MiB`；校验完整后原子 apply，缺片/冲突/超限触发 resync。
- `toSeq <= localSeq` 静默丢弃；gap single-flight resync；resume 再 gap 强制 snapshot。

## 3. ConversationSnapshot 与权威动作

```ts
interface ConversationSnapshot {
  protocolVersion: 1; // projection schema version，与 wire v3 分离
  sessionId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  control: SessionControl;
  availability: SessionActionAvailability;
  inputRouting: InputRouting;
  config: SessionConfigState;
  usage: SessionUsageState;
  queue: QueueState;
  pendingInteractions: PendingInteraction[];
  pendingCommands: CommandStateSummary[];
  backgroundWorks: BackgroundWorkSummary[];
  goal: GoalState | null;
  plan: PlanState | null;
  rows: RowsWindow;
}

type ActionAvailability =
  | { allowed: true }
  | { allowed: false; reasonCode: string };

interface SessionActionAvailability {
  fork: ActionAvailability; // session/global operation lock；目标资格仍看 row.actions.canFork
  compact: ActionAvailability;
  switchModelConfig: ActionAvailability;
  setFollowupMode: ActionAvailability;
  queueEdit: ActionAvailability;
  sendQueuedNow: ActionAvailability;
  resumeGoal: ActionAvailability;
}

interface RowActions {
  canFork?: true;
  canEdit?: true;
  canRetry?: true;
}
```

UI 展示 fork 的条件来自 `availability.fork` 与目标行 `actions.canFork`，禁止从 `control.phase`、assistant 是否位于数组尾部或 raw message type 自行推断。

## 4. ConversationInputIntent：输入全字段守恒

```ts
interface ConversationInputIntent {
  sourceCommandId: string;      // 原始提交 commandId，贯穿所有后续事实
  queueItemId: string;          // admission 时分配，edit/reorder/reserve/drain 均不变
  clientId: string;
  kind: "sendText" | "sendGoalCommand";
  text: string;                 // 原文，不存解析后摘要替代值
  attachments: AttachmentRef[]; // 无附件为 []，避免沿途 undefined 丢字段
  delivery: {
    requested: "auto" | "startNow" | "queue" | "guide";
    admitted: "startNow" | "queue" | "guide";
    fallbackReasonCode?: string;
  };
  order: {
    admissionSeq: number;       // CLI 串行 admission 顺序
    queuePosition?: number;
  };
  steer: {
    state: "notRequested" | "submitting" | "steering" | "guided" | "fellBack";
    reasonCode?: string;
  };
  dispatch: {
    state: "admitted" | "queued" | "reserved" | "promoting" | "drained";
    reservationId?: string;
  };
  admittedAt: number;
}

type QueueItem = ConversationInputIntent & {
  dispatch: ConversationInputIntent["dispatch"] & {
    state: "queued" | "reserved" | "promoting";
  };
};

interface QueueState {
  items: QueueItem[]; // 顺序 = CLI admission/reorder 后的权威 FIFO 顺序
  autoDrain: boolean;
}
```

同一个 intent 贯穿：

```text
CommandInbox admission
  -> QueueItem(sourceCommandId=S, queueItemId=Q)
  -> drain/guided event(sourceCommandId=S, queueItemId=Q)
  -> UserInputRow(sourceCommandId=S, attachments, guided, clientId)
  -> transcript message anchor(sourceCommandId=S)
```

guide 不适用、带附件、compact/verifier busy 时必须保留完整 intent 回退普通 queue。empty/oversize/runtime reject 必须返回 `rejected/failed`，不能先清 UI 再丢 payload。

`editQueueItem` 原地更新，保留 `queueItemId/sourceCommandId/clientId/order/attachments`；只改明确提交的新字段。`sendQueuedNow` 是：

```text
reserve(Q) -> stop barrier -> start/promote(Q) -> remove(Q)
   │                              │
   └─ timeout/failure -> release ─┘（原项、原位、原字段保持）
```

同一 Q 的连续点击或多端竞争只能有一个 reservation owner。

## 5. Row、marker 与持久化锚点

```ts
interface UserInputRow extends RowBase {
  kind: "userInput";
  text: string;
  origin: "realUser" | "backgroundResult" | "goalContinuation" | "mailbox" | "synthetic";
  sourceCommandId?: string; // realUser/guided 必带
  queueItemId?: string;
  clientId?: string;
  guided?: true;
  attachments?: AttachmentRef[];
}

interface TimelineMarkerRow extends RowBase {
  kind: "timelineMarker";
  sourceCommandId?: string; // 用户命令产生的 marker 必带
  marker: TimelineMarker;
}

interface MessageAnchorMetadata {
  sourceCommandId?: string;
  productTurnId?: string;
  orderedMessageIds?: string[];
  boundaryMessageId?: string;
}

interface ChildSessionMetadata {
  parentSessionId: string;
  sourceCommandId: string; // fork duplicate 返回同一个 child
  forkTarget: StableForkTarget;
}
```

QueueItem、drain event、user row、message anchor、用户产生的 marker 与 fork child metadata 必须保留原始 `sourceCommandId`，禁止 promotion/send-now 换成新命令 id。

## 6. Command ACK、查询与 single-flight

```ts
interface CommandKey {
  sessionId: string;
  commandId: string;
}

interface CommandsQueryParams {
  commands: CommandKey[]; // 1..64
}

interface CommandsQueryResult {
  results: Array<{
    key: CommandKey;
    result: CommandAck | "unknown";
  }>;
}
```

每个 key 的查询顺序固定：

```text
in-memory LRU
  -> transcript user/message anchor sourceCommandId
  -> timeline marker sourceCommandId
  -> fork child metadata sourceCommandId
  -> discarded input ledger
  -> unknown
```

discarded 命中返回 `CommandAck{status:"failed", reasonCode:"fault.command.inputDiscardedOnRestart", result:{type:"inputDisposition",delivery}}`，不是 `unknown`。同 key 的 `command execute` 与 `commands/query` 共享 single-flight/互斥入口，查询不能在“已开始执行、尚未写 LRU/transcript”的窗口误报 unknown，也不能触发第二次副作用。

UI pending registry TTL 为 24h：普通文本/goal 保存可重发 payload，敏感 interaction 只保存 digest；QueueItem/guided projection 出现立即删除记录。CLI restart 后 discarded `queue/guide` 静默清账，只有未进入 transcript 的 `startNow` 或 `unknown` 提示用户确认重发；绝不自动恢复或自动重放 discarded input。

## 7. 稳定 assistant fork

```ts
interface StableForkTarget {
  productTurnId: string;
  transcriptTurnId: string;
  orderedMessageIds: string[];
  boundaryMessageId: string;
}

type StableForkGoalBoundary =
  | { kind: "none" }
  | {
      kind: "snapshot";
      target: SessionGoal;
      verificationEntryIds: string[];
    };

resolveStableForkTarget(target: { rowId: number; entityId: string }, baseLogEpoch: string):
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundary;
    }
  | { ok: false; reasonCode:
      | "guard.forkAssistantOnly"
      | "guard.forkTargetNotStable"
      | "guard.forkTargetAmbiguous"
      | "guard.compactOperationLock" };
```

唯一合法目标是 `completedSuccess` product turn 的**最后一段 completed assistant**。新数据以持久化 turn anchor 为准；旧数据只在 message/turn 边界唯一时 fallback。

新数据的最终 assistant anchor 必须在 `TurnComplete` 发布前持久化 raw message segment、boundary 和显式 `goalBoundary`。`goalBoundary` 缺省只表示历史数据；新数据无 goal 必须写 `{ kind: "none" }`，不得用 parent 当前 goal 猜 fork 点状态。`snapshot.verificationEntryIds` 只包含该 transcript boundary 之前已经持久化的 verifier entry。

- primary turn、foreground subagent、goal continuation、goal verifier running 时，可 fork 更早稳定目标。
- compact 仍是全局 operation lock。
- streaming/interrupted/failed partial、中间 assistant 段、user/tool/timeline 一律拒绝。
- running fork 只复制稳定 transcript、fork 点 config、fork 点前 goal；不复制 queue、active/background work、continuation inbox，不 rewind shared workspace，parent 继续 running。
- completed/idle 的既有 workspace checkpoint 行为本轮不扩大。
- 同一 `sourceCommandId` 重试返回同一 child。
- E10/FX08 按逻辑 turn boundary 复制工具块、工具结果后的最终 assistant 和该 turn 已产生的文件事实，不能只按“最后一条 raw assistant message”截断。

## 8. Delta 与最终不变量

```ts
type ConversationDelta =
  | { op: "row.appended"; row: ConversationRow }
  | { op: "row.upserted"; row: ConversationRow }
  | { op: "row.removed"; fromRowId: number }
  | { op: "row.delta"; rowId: number; path: StreamablePath; append: string }
  | { op: "state.updated"; patch: StatePatch };
```

coalesce 不得跨 `row.removed`；`state.updated` 只做 key 级整体替换；stream path 是封闭白名单。任何结构无法安全表达、buffer 超限或 seq 不连续时，都发 snapshot resync，不在 UI 引入补偿 reducer。

最终不变量：每条已提交输入必须且只能处于 `queue / guided row / transcript / explicit rejected|failed|discarded` 之一；任何时刻都不能“UI 已清空，但权威层无记录”。
