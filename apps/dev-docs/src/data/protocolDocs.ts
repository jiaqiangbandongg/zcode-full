/* eslint-disable max-lines -- 开发文档的数据字典需要完整列出迁移结构、字段含义和概念关系，集中维护方便校对。 */
export type ConceptKind = "id" | "state" | "protocol" | "runtime" | "compat";

export interface Concept {
  id: string;
  name: string;
  kind: ConceptKind;
  summary: string;
  lifecycle: string;
  owner: string;
  source: string;
  aliases?: string[];
  related: string[];
}

export interface FieldDoc {
  name: string;
  type: string;
  required: "required" | "optional" | "legacy";
  meaning: string;
  owner: string;
  source: string;
  conceptIds: string[];
  oldName?: string;
  notes?: string;
}

export interface StructureDoc {
  id: string;
  title: string;
  path: string;
  purpose: string;
  oldShape?: string;
  newShape: string;
  migration: string;
  fields: FieldDoc[];
}

export interface FlowStep {
  id: string;
  title: string;
  actor: string;
  detail: string;
  conceptIds: string[];
}

export type StdioTrafficDirection = "app-to-agent" | "agent-to-app" | "agent-stderr";

export type StdioTrafficKind = "request" | "response" | "notification" | "stderr";

export interface StdioTrafficFrame {
  id: string;
  timestamp: string;
  direction: StdioTrafficDirection;
  kind: StdioTrafficKind;
  method?: string;
  messageId?: string;
  sessionId?: string;
  inputId?: string;
  summary: string;
  bytes: number;
  latencyMs?: number;
  linkedId?: string;
  raw: string;
}

export interface StdioTrafficLogField {
  name: string;
  type: string;
  meaning: string;
}

export interface StdioTrafficReadStep {
  id: string;
  title: string;
  command: string;
  detail: string;
}

export const concepts: Concept[] = [
  {
    id: "sessionId",
    name: "sessionId",
    kind: "id",
    summary: "Agent server 生成的会话主键，ZCode Protocol 里的核心实体 ID。",
    lifecycle:
      "由 `session/create` 创建；`session/resume` 复用；会随 snapshot、event、message、part 全程回传。",
    owner: "agent server",
    source: "apps/zcode-cli/packages/contracts/src/interfaces/shared.ts#createSessionId",
    aliases: ["legacy acpSessionId"],
    related: ["taskId", "traceId", "turnId", "messageId"],
  },
  {
    id: "taskId",
    name: "taskId",
    kind: "id",
    summary: "App/UI 任务列表里的产品层 ID。ZCode Agent 路径迁移后应等同或映射到 sessionId。",
    lifecycle:
      "UI task 列表、缓存、导航和本地持久化使用；进入 ZCode Protocol 时必须找到对应 sessionId。",
    owner: "app/ui",
    source: "packages/shared/src/zcode-task-types.ts#ZCodeTaskMeta",
    related: ["sessionId", "workspaceKey", "activeInputId"],
  },
  {
    id: "traceId",
    name: "traceId",
    kind: "id",
    summary: "观测链路 ID，用于日志、事件 envelope、调试面板和跨模块追踪，不再表示一次用户输入。",
    lifecycle:
      "当前 agent server 在创建 session record 时用 UUID 生成 root trace；之后事件 envelope 带同一观测 trace。",
    owner: "agent runtime / protocol server",
    source:
      "apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts#createProtocolTraceId",
    aliases: ["protocol trace", "envelope.traceId"],
    related: ["inputId", "sessionId", "eventEnvelope"],
  },
  {
    id: "inputId",
    name: "inputId",
    kind: "id",
    summary: "每次用户提交输入的归属 ID，用于发送、排队、stop、终态事件收口和 UI stale 判断。",
    lifecycle:
      "UI 在每次直接发送、首发、队列 drain 时创建；通过 `session/send.inputId` 传给 agent；agent 在 turn 事件 payload 里原样回带。",
    owner: "app/ui creates, agent echoes",
    source: "packages/shared/src/zcode-task-types.ts#createInputId",
    aliases: ["clientMessageId 的新名", "per-input id"],
    related: ["activeInputId", "pendingInputId", "traceId"],
  },
  {
    id: "activeInputId",
    name: "activeInputId",
    kind: "runtime",
    summary: "UI store 里当前正在运行的 inputId，用来保护 stop、立即发送和迟到终态事件。",
    lifecycle:
      "直接发送或队列 drain 开始时写入；收到匹配 inputId 的 completed/failed 后清理或被下一轮覆盖。",
    owner: "renderer store",
    source: "packages/ui/src/store/zcodeSessionStoreTypes.ts#TaskRuntimeState",
    aliases: ["activeRunId 的新名"],
    related: ["inputId", "taskRuntimeState", "taskStreamMirrorBatch"],
  },
  {
    id: "clientMessageId",
    name: "clientMessageId",
    kind: "compat",
    summary: "旧字段名，过去承载 UI 每次 prompt 的相关性 ID；已统一改名为 inputId。",
    lifecycle: "旧协议字段；新 ZCode Protocol schema 不再接受它，继续发送会触发 Invalid params。",
    owner: "deprecated",
    source: "dae26032: packages/shared/src/zcode-protocol/index.ts",
    related: ["inputId", "sessionSend"],
  },
  {
    id: "activeRunId",
    name: "activeRunId",
    kind: "compat",
    summary: "旧 UI store 字段名，语义不是观测 trace，而是当前输入归属；已改为 activeInputId。",
    lifecycle:
      "旧 renderer runtime 字段；新代码只在少数 replayable/mirror legacy 字段里保留 runId 名称。",
    owner: "deprecated",
    source: "dae26032: packages/ui/src/store/zcodeSessionStoreTypes.ts",
    related: ["activeInputId", "taskRuntimeState"],
  },
  {
    id: "pendingInputId",
    name: "pendingInputId",
    kind: "id",
    summary: "Agent-side turn steering 队列里的等待项 ID，不等同于 UI inputId。",
    lifecycle:
      "运行中追加输入被 agent 接收为 steer queue 时生成；drained/discarded/rejected 事件回带。",
    owner: "agent runtime",
    source:
      "apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts#PendingSteerInputInfo",
    related: ["inputId", "turnId", "turnSteerQueued"],
  },
  {
    id: "turnId",
    name: "turnId",
    kind: "id",
    summary: "Agent core 中一次 turn 的主键；一个 inputId 通常启动或归属到一个 turnId。",
    lifecycle: "agent runtime 在 turn 启动时创建；所有 turn 内事件可携带。",
    owner: "agent runtime",
    source: "apps/zcode-cli/packages/contracts/src/interfaces/shared.ts#createTurnId",
    related: ["sessionId", "inputId", "messageId"],
  },
  {
    id: "messageId",
    name: "messageId",
    kind: "id",
    summary: "消息主键，标识 user/assistant message。",
    lifecycle: "消息创建时生成；message upsert/remove、part、snapshot 都围绕它组织。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeMessageInfo",
    related: ["partId", "sessionId", "turnId"],
  },
  {
    id: "partId",
    name: "partId",
    kind: "id",
    summary: "消息内部 part 的主键，用于 text、reasoning、tool、patch、compaction 等细粒度更新。",
    lifecycle: "part.started/upserted/delta/remove 时使用。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeMessagePart",
    related: ["messageId", "toolCallId"],
  },
  {
    id: "toolCallId",
    name: "toolCallId",
    kind: "id",
    summary: "工具调用主键，用于工具状态、权限请求和 active tool projection。",
    lifecycle: "工具 scheduled/started/progress/result/error 流程中保持稳定。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeActiveToolCall",
    related: ["partId", "permissionRequest"],
  },
  {
    id: "permissionRequest",
    name: "permission request",
    kind: "protocol",
    summary: "Agent 请求用户批准工具调用或风险操作的阻塞交互。",
    lifecycle:
      "server 发起 `interaction/requestPermission`；host 路由给 owner client；结果通过 permission.resolved 回到 session。",
    owner: "agent server + host owner routing",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodePermissionRequestParamsSchema",
    related: ["toolCallId", "deliveryKind", "sessionId"],
  },
  {
    id: "turnSteerQueued",
    name: "turn.steerQueued",
    kind: "protocol",
    summary: "运行中追加输入被 agent-side queue 接收后的事件。",
    lifecycle:
      "UI 在 busy 时提交输入；agent 返回 pendingInputId，并在 drained/discarded/rejected 中更新状态。",
    owner: "agent runtime",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeTurnSteerQueuedEventPayloadSchema",
    related: ["pendingInputId", "turnId", "inputId"],
  },
  {
    id: "eventSeq",
    name: "eventSeq / seq",
    kind: "protocol",
    summary: "Session 事件日志的单调递增序号，是 replayable 恢复和 gap 检测的水位。",
    lifecycle:
      "每个 session 独立递增；desktop continuous 可实时消费，web remote replayable 必须用 afterSeq 补齐。",
    owner: "agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeEventEnvelopeSchema",
    aliases: ["seq"],
    related: ["deliveryKind", "eventEnvelope"],
  },
  {
    id: "deliveryKind",
    name: "deliveryKind",
    kind: "protocol",
    summary: "区分桌面实时链路和手机远控可恢复链路。",
    lifecycle:
      "`session/read`、`session/subscribe` 和事件 envelope 可携带；影响 snapshot/replay 行为。",
    owner: "host / protocol client",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeDeliveryKindSchema",
    related: ["eventSeq", "taskStreamMirrorBatch"],
  },
  {
    id: "workspaceKey",
    name: "workspaceKey",
    kind: "state",
    summary: "workspace 身份隔离 key，优先使用 workspaceIdentity，缺省回退 workspacePath。",
    lifecycle: "用于 tab、缓存、队列、持久化、远程历史匹配等身份/隔离语义。",
    owner: "app/host",
    source: "AGENTS.md Workspace Identity 约束",
    related: ["workspacePath", "workspaceIdentity", "taskId"],
  },
  {
    id: "workspacePath",
    name: "workspacePath",
    kind: "state",
    summary: "真实文件路径，只用于文件读写、命令 cwd、Git 操作和路径展示。",
    lifecycle: "本地 workspace 通常直接使用；远程 workspace 不能只靠它做身份判等。",
    owner: "app/host",
    source: "packages/shared/src/zcode-protocol/index.ts#ZCodeWorkspaceRef",
    related: ["workspaceIdentity", "workspaceKey"],
  },
  {
    id: "workspaceIdentity",
    name: "workspaceIdentity",
    kind: "state",
    summary: "远程 workspace 的稳定身份，表达 authority + canonicalPath。",
    lifecycle: "远程 SSH/WSL/Docker 必须传递；本地允许为空并回退 workspacePath。",
    owner: "app/host",
    source: "AGENTS.md Workspace Identity 约束",
    related: ["workspacePath", "workspaceKey"],
  },
  {
    id: "eventEnvelope",
    name: "ZCode Event Envelope",
    kind: "protocol",
    summary:
      "ZCode Protocol 事件外壳，承载 eventId、sessionId、turnId、seq、traceId、timestamp、deliveryKind。",
    lifecycle: "所有 `session/event` 通知和 `session/events` 读取结果都使用它。",
    owner: "agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeEventEnvelopeSchema",
    related: ["sessionId", "traceId", "eventSeq", "deliveryKind"],
  },
  {
    id: "sessionSend",
    name: "session/send",
    kind: "protocol",
    summary: "提交用户输入的 ZCode Protocol 方法，立即 ACK，不等待整轮模型生成完成。",
    lifecycle: "client 调用后，agent 后台执行 turn，并通过 session.event/state.updated 推送进度。",
    owner: "protocol client -> agent server",
    source: "packages/shared/src/zcode-protocol/index.ts#zcodeSessionSendParamsSchema",
    related: ["sessionId", "inputId", "traceId"],
  },
  {
    id: "taskRuntimeState",
    name: "TaskRuntimeState",
    kind: "runtime",
    summary: "Renderer store 的 task 运行态，只保存 UI 运行需要的 transient 信息。",
    lifecycle: "随 stream、snapshot、queue 和 stop 操作更新；不能作为 server authoritative state。",
    owner: "renderer store",
    source: "packages/ui/src/store/zcodeSessionStoreTypes.ts#TaskRuntimeState",
    related: ["activeInputId", "deliveryKind"],
  },
  {
    id: "taskStreamMirrorBatch",
    name: "TaskStreamMirrorBatch",
    kind: "runtime",
    summary:
      "手机远控 replayable 链路的 stream mirror 批次。字段名 runId 保留兼容，但语义上对应当前 input/mirror run。",
    lifecycle: "host 记录运行中流式 op；web remote 用 batchSeq/fromSeq/toSeq 恢复缺口。",
    owner: "host runtime",
    source: "packages/shared/src/zcode-task-types.ts#TaskStreamMirrorBatch",
    related: ["inputId", "activeInputId", "deliveryKind", "eventSeq"],
  },
];

export const structures: StructureDoc[] = [
  {
    id: "id-migration",
    title: "ID 语义迁移总览",
    path: "跨 UI / host / agent / ZCode Protocol",
    purpose:
      "把观测链路 traceId 和用户输入归属 inputId 拆开，解决 UI 状态收口、stop、队列和协议 schema 不一致。",
    oldShape:
      "traceId 同时承担日志追踪和每次 prompt 的 run/clientMessage 语义；UI 字段叫 activeRunId，协议字段叫 clientMessageId。",
    newShape:
      "traceId 只做观测链路；inputId 做每次用户输入归属；activeInputId 保存当前运行输入；sessionId 仍由 agent server 分配。",
    migration:
      "`clientMessageId -> inputId`，`activeRunId -> activeInputId`，`currentTraceIdRef -> currentInputIdRef`；保留 legacy runId/ownerRunId 字段时要注明它们语义上是 inputId。",
    fields: [
      {
        name: "traceId",
        type: "string / UUID",
        required: "required",
        meaning:
          "观测链路 ID，只用于日志、session event envelope、debug trace，不用于判断当前 prompt 是否完成。",
        owner: "agent runtime",
        source: "createProtocolTraceId / createTraceId",
        conceptIds: ["traceId"],
        notes:
          "旧实现用 `t-${taskId}-${time}-${random}` 且被当成 prompt run id；新实现对齐 agent UUID。",
      },
      {
        name: "inputId",
        type: "string / UUID",
        required: "optional",
        meaning: "每次用户提交输入的相关性 ID。缺省兼容旧事件，但新发送路径都应传。",
        owner: "app/ui creates, agent echoes",
        source: "createInputId",
        conceptIds: ["inputId"],
        oldName: "clientMessageId",
      },
      {
        name: "activeInputId",
        type: "InputId | undefined",
        required: "optional",
        meaning:
          "当前正在执行的输入 ID。迟到 completed/failed 如果不匹配它，不能关闭当前 assistant。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId"],
        oldName: "activeRunId",
      },
      {
        name: "sessionId",
        type: "sess_${uuid}",
        required: "required",
        meaning:
          "ZCode Protocol 会话主键，由 agent server 生成并在 snapshot/event/message 中回传。",
        owner: "agent server",
        source: "createSessionId",
        conceptIds: ["sessionId"],
      },
      {
        name: "taskId",
        type: "string",
        required: "required",
        meaning:
          "App 产品层任务 ID。迁移期仍存在，但 ZCode Agent 路径进入协议时要找到对应 sessionId。",
        owner: "app/ui",
        source: "ZCodeTaskMeta",
        conceptIds: ["taskId", "sessionId"],
      },
    ],
  },
  {
    id: "zcode-session-send",
    title: "ZCodeSessionSendParams",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "`session/send` 的参数结构。它只提交输入并立即 ACK，结果通过事件流返回。",
    oldShape: "{ sessionId, clientMessageId?, content, attachments?, expectedRevision? }",
    newShape: "{ sessionId, inputId?, content, attachments?, expectedRevision? }",
    migration: "协议 schema 已 strict 校验，继续发送 clientMessageId 会 Invalid params。",
    fields: [
      {
        name: "sessionId",
        type: "string",
        required: "required",
        meaning:
          "目标 agent session。不是 UI 临时生成值，必须来自 `session/create` 或 `session/resume`。",
        owner: "agent server",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionId", "sessionSend"],
      },
      {
        name: "inputId",
        type: "string",
        required: "optional",
        meaning: "本次用户输入的相关性 ID；agent 不解析业务含义，只在 turn payload 里原样回带。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["inputId", "sessionSend"],
        oldName: "clientMessageId",
      },
      {
        name: "content",
        type: "string",
        required: "required",
        meaning: "用户提交给 agent 的最终文本，可以已经过技能注入或附件文本化。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
      {
        name: "attachments",
        type: "Record<string, unknown>[]",
        required: "optional",
        meaning: "图片、音频或文件附件的协议投影。普通文件可带 textContent，二进制附件带 base64。",
        owner: "app/ui",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
      {
        name: "expectedRevision",
        type: "number",
        required: "optional",
        meaning: "乐观并发控制的 session stateRevision；不匹配时 server 可拒绝以避免覆盖旧状态。",
        owner: "app/ui + agent server",
        source: "zcodeSessionSendParamsSchema",
        conceptIds: ["sessionSend"],
      },
    ],
  },
  {
    id: "turn-event-payloads",
    title: "Turn Event Payloads",
    path: "packages/shared/src/zcode-protocol/index.ts + apps/zcode-cli/packages/contracts/src/events/session.events.ts",
    purpose:
      "turn.started / steerQueued / completed / failed 用 payload.inputId 把 agent 回流事件归属到某次 UI 输入。",
    oldShape: "turn payloads 使用 clientMessageId。",
    newShape: "turn payloads 使用 inputId；event envelope.traceId 保持观测 trace。",
    migration: "Projection 层读取 payload.inputId，不再把 envelope.traceId 改写成 prompt id。",
    fields: [
      {
        name: "turnNumber",
        type: "number",
        required: "required",
        meaning: "session 内第几轮 turn，主要用于展示和 reducer 投影。",
        owner: "agent runtime",
        source: "TurnStartedPayload",
        conceptIds: ["turnId"],
      },
      {
        name: "input",
        type: "string",
        required: "required",
        meaning: "启动 turn 的用户输入文本或 steer 队列文本。",
        owner: "agent runtime",
        source: "TurnStartedPayload / TurnSteerQueuedPayload",
        conceptIds: ["inputId"],
      },
      {
        name: "inputId",
        type: "string",
        required: "optional",
        meaning: "归属到 UI 这次提交；completed/failed 必须用它判断是否是当前 activeInputId。",
        owner: "agent echoes",
        source: "TurnStartedPayload / TurnCompletePayload / TurnErrorPayload",
        conceptIds: ["inputId", "activeInputId"],
        oldName: "clientMessageId",
      },
      {
        name: "pendingInputId",
        type: "string",
        required: "required",
        meaning: "turn steering 队列项 ID，用于后续 drained/discarded/rejected 对齐。",
        owner: "agent runtime",
        source: "TurnSteerQueuedPayload",
        conceptIds: ["pendingInputId", "turnSteerQueued"],
      },
      {
        name: "targetTurnId",
        type: "string",
        required: "required",
        meaning: "排队输入要注入的目标 active turn。",
        owner: "agent runtime",
        source: "TurnSteerQueuedPayload",
        conceptIds: ["turnId", "pendingInputId"],
      },
      {
        name: "cacheStats",
        type: "{ totalMessages, cachedMessages, lastCacheHit, cacheReadTokens? }",
        required: "optional",
        meaning: "turn.completed 里的缓存统计。新 schema 补齐该字段，避免 strict 校验丢终态事件。",
        owner: "agent runtime",
        source: "zcodeTurnCompletedEventPayloadSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "resultType",
        type: "success | error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls",
        required: "required",
        meaning: "turn 完成原因，UI 用于区分正常完成和预算/工具/执行错误。",
        owner: "agent runtime",
        source: "TurnCompletePayload",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "turnPhase",
        type: "string",
        required: "required",
        meaning: "turn.failed 发生在哪个执行阶段，用于日志和错误展示。",
        owner: "agent runtime",
        source: "TurnErrorPayload",
        conceptIds: ["eventEnvelope"],
      },
    ],
  },
  {
    id: "zcode-stream-event",
    title: "ZCodeStreamEvent / TaskStreamMirrorableEvent",
    path: "packages/shared/src/zcode-task-types.ts",
    purpose: "Host 到 renderer 的实时事件结构。现在同时携带 traceId 和可选 inputId。",
    oldShape: "每个 stream event 只有 traceId；UI 把它当 run id 使用。",
    newShape: "stream event 保留 traceId 做观测，同时新增 inputId 做输入归属。",
    migration:
      "所有可 mirror 的事件统一 `& { inputId?: InputId }`，终态事件优先用 inputId 过滤 stale。",
    fields: [
      {
        name: "type",
        type: "string union",
        required: "required",
        meaning: "事件类型，如 agent_message_chunk、tool_call、task_complete、task_error。",
        owner: "host/runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "taskId",
        type: "string",
        required: "required",
        meaning: "UI task 归属，用于找到对应消息列表、runtime state 和 task cache。",
        owner: "app/host",
        source: "ZCodeStreamEvent",
        conceptIds: ["taskId"],
      },
      {
        name: "traceId",
        type: "TraceId",
        required: "required",
        meaning: "观测 trace。日志、调试、链路排查使用，不再做 prompt 终态收口。",
        owner: "host/runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["traceId"],
      },
      {
        name: "inputId",
        type: "InputId",
        required: "optional",
        meaning: "事件所属用户输入。terminal complete/error 优先用它与 activeInputId 比较。",
        owner: "host/runtime echoes",
        source: "TaskStreamMirrorableEvent & ZCodeStreamEvent",
        conceptIds: ["inputId", "activeInputId"],
      },
      {
        name: "parentToolUseId",
        type: "string | null",
        required: "optional",
        meaning: "子 agent 或工具嵌套关系；null 表示主 agent 正文或主 agent 工具调用。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent / TaskStreamMirrorableEvent",
        conceptIds: ["toolCallId"],
      },
      {
        name: "messageId",
        type: "string",
        required: "optional",
        meaning: "ZCode message upsert 主键；synthetic timeline 消息也用它做稳定更新。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent",
        conceptIds: ["messageId"],
      },
      {
        name: "toolId",
        type: "string",
        required: "optional",
        meaning: "工具调用 ID；tool_call 与 tool_call_update 共享。",
        owner: "agent runtime",
        source: "ZCodeStreamEvent tool update",
        conceptIds: ["toolCallId"],
      },
      {
        name: "stopReason",
        type: "string",
        required: "optional",
        meaning: "task_complete 的结束原因。",
        owner: "agent runtime",
        source: "ZCodeTaskComplete",
        conceptIds: ["inputId"],
      },
      {
        name: "error",
        type: "string",
        required: "optional",
        meaning: "task_error 的可读错误正文；远控恢复依赖它展示失败原因。",
        owner: "agent runtime",
        source: "ZCodeTaskError",
        conceptIds: ["inputId"],
      },
    ],
  },
  {
    id: "task-runtime-state",
    title: "TaskRuntimeState",
    path: "packages/ui/src/store/zcodeSessionStoreTypes.ts",
    purpose: "Renderer 中每个 task 的运行态，驱动输入框状态、停止按钮、使用量和错误展示。",
    oldShape: "{ status, error, provider, usage, apiRetry, activeRunId?, activeRunOwnerClientId? }",
    newShape:
      "{ status, error, provider, usage, apiRetry, activeInputId?, activeInputOwnerClientId? }",
    migration: "字段名从 run 改为 input，明确它是输入归属，不是 trace。",
    fields: [
      {
        name: "status",
        type: "idle | creating | notReady | restoring | ready | streaming | completed | failed",
        required: "required",
        meaning: "task 当前 UI 运行阶段。发送按钮、停止按钮和恢复态都从这里派生。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "error",
        type: "string | null",
        required: "required",
        meaning: "当前运行错误，null 表示没有可展示错误。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "provider",
        type: "ZCodeProvider",
        required: "optional",
        meaning: "该 task 当前绑定的 legacy provider，用于 workspace 级兼容投影和 busy lock。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "usage",
        type: "TaskUsageState | null",
        required: "required",
        meaning: "上下文窗口使用量和费用展示。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "apiRetry",
        type: "ZCodeApiRetryStatus | null",
        required: "required",
        meaning: "模型 API 重试状态，展示网络/限流恢复进度。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["taskRuntimeState"],
      },
      {
        name: "activeInputId",
        type: "InputId | undefined",
        required: "optional",
        meaning: "当前运行输入。stop、立即发送和 terminal 事件收口的核心对齐字段。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId", "inputId"],
        oldName: "activeRunId",
      },
      {
        name: "activeInputOwnerClientId",
        type: "string | undefined",
        required: "optional",
        meaning: "当前输入的 owner client，用于远控 owner/lease 场景下判断命令路由。",
        owner: "renderer store",
        source: "TaskRuntimeState",
        conceptIds: ["activeInputId", "deliveryKind"],
        oldName: "activeRunOwnerClientId",
      },
    ],
  },
  {
    id: "zcode-event-envelope",
    title: "ZCode Event Envelope",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "协议事件外壳。它描述事件日志顺序和观测链路，不描述 UI 输入归属。",
    newShape: "{ eventId, sessionId, turnId?, seq, traceId?, timestamp, deliveryKind? }",
    migration: "Projection 不再把 envelope.traceId 当 input/run；payload.inputId 才是输入归属。",
    fields: [
      {
        name: "eventId",
        type: "string",
        required: "required",
        meaning: "事件唯一 ID，用于日志和去重。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "sessionId",
        type: "string",
        required: "required",
        meaning: "事件所属 session。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["sessionId"],
      },
      {
        name: "turnId",
        type: "string",
        required: "optional",
        meaning: "事件所属 turn。session 级事件可为空。",
        owner: "agent runtime",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["turnId"],
      },
      {
        name: "seq",
        type: "number",
        required: "required",
        meaning: "session 内单调递增事件序号，replayable 恢复以它为水位。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventSeq", "deliveryKind"],
      },
      {
        name: "traceId",
        type: "string",
        required: "optional",
        meaning: "观测 trace。不要用它判断 completed/failed 是否属于当前输入。",
        owner: "agent runtime",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["traceId"],
      },
      {
        name: "timestamp",
        type: "number",
        required: "required",
        meaning: "事件发生时间，毫秒时间戳。",
        owner: "agent server",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "deliveryKind",
        type: "desktop-continuous | web-remote-replayable",
        required: "optional",
        meaning: "事件配送语义。手机远控恢复必须尊重 replayable 边界。",
        owner: "host/protocol client",
        source: "zcodeEventEnvelopeSchema",
        conceptIds: ["deliveryKind"],
      },
    ],
  },
  {
    id: "session-state-snapshot",
    title: "SessionStateSnapshot",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose:
      "`session/create`、`session/read`、`session/subscribe(includeSnapshot)` 返回的完整可恢复视图。",
    newShape: "{ protocol, session, settings, projection, runtime, messages }",
    migration: "server 是核心状态事实源；UI 只保留视觉和本端 transient 状态。",
    fields: [
      {
        name: "protocol",
        type: "{ name: 'ZCode Protocol'; version: 1 }",
        required: "required",
        meaning: "协议名和版本，客户端据此确定 schema。",
        owner: "agent server",
        source: "zcodeSessionStateSnapshotSchema",
        conceptIds: ["eventEnvelope"],
      },
      {
        name: "session",
        type: "ZCodeSessionInfo",
        required: "required",
        meaning:
          "session 基本信息：sessionId、workspace、parent、kind、title、mode、status、model、target、时间戳。",
        owner: "agent server",
        source: "zcodeSessionInfoSchema",
        conceptIds: ["sessionId", "workspaceKey"],
      },
      {
        name: "settings",
        type: "ZCodeSessionSettingsState",
        required: "required",
        meaning: "server-authoritative 模型、思考深度、模式和权限规则状态。",
        owner: "agent server",
        source: "zcodeSessionSettingsStateSchema",
        conceptIds: ["sessionId"],
      },
      {
        name: "projection",
        type: "ZCodeSessionProjection",
        required: "required",
        meaning:
          "运行投影：status、currentTurnId、pendingPermissions、activeToolCalls、target、lastError 等。",
        owner: "agent server",
        source: "zcodeSessionProjectionSchema",
        conceptIds: ["turnId", "toolCallId", "permissionRequest"],
      },
      {
        name: "runtime",
        type: "ZCodeSessionRuntimeState",
        required: "required",
        meaning: "eventSeq、stateRevision、deliveryKind、activeTurnId、pendingRequestIds。",
        owner: "agent server",
        source: "zcodeSessionRuntimeStateSchema",
        conceptIds: ["eventSeq", "deliveryKind", "turnId"],
      },
      {
        name: "messages",
        type: "ZCodeMessageWithParts[]",
        required: "required",
        meaning: "可渲染消息及 part 列表。UI 从这里恢复 transcript。",
        owner: "agent server",
        source: "zcodeMessageWithPartsSchema",
        conceptIds: ["messageId", "partId"],
      },
    ],
  },
  {
    id: "workspace-ref",
    title: "ZCodeWorkspaceRef",
    path: "packages/shared/src/zcode-protocol/index.ts",
    purpose: "协议层 workspace 身份结构，分清执行路径和身份隔离。",
    newShape: "{ workspacePath, workspaceIdentity?, workspaceKey }",
    migration:
      "远程 workspace 必须传 workspaceIdentity；身份/隔离 key 使用 workspaceIdentity || workspacePath。",
    fields: [
      {
        name: "workspacePath",
        type: "string",
        required: "required",
        meaning: "实际文件路径，用于 cwd、文件读写、Git 和展示。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspacePath"],
      },
      {
        name: "workspaceIdentity",
        type: "string",
        required: "optional",
        meaning: "远程 workspace 稳定身份。SSH/WSL/Docker 必传，本地可为空。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspaceIdentity"],
      },
      {
        name: "workspaceKey",
        type: "string",
        required: "required",
        meaning: "身份/隔离语义使用的 key：workspaceIdentity?.trim() || workspacePath。",
        owner: "app/host",
        source: "zcodeWorkspaceRefSchema",
        conceptIds: ["workspaceKey"],
      },
    ],
  },
  {
    id: "mirror-compat",
    title: "Replayable Mirror Legacy Fields",
    path: "packages/shared/src/zcode-task-types.ts + packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts",
    purpose:
      "手机远控 replayable 链路仍有 runId/ownerRunId 等历史命名，但文档必须标明语义是 input 归属。",
    oldShape: "{ runId, ownerRunId, traceId } 都容易被理解成 trace。",
    newShape: "新 UI 边界统一称 inputId；legacy 字段保持兼容并显式转换。",
    migration:
      "调用 `sendTaskPromptWithSessionControl` 时传 inputId；legacy `sendPrompt.traceId` 和 host command `traceId` 仅作为旧路由字段。",
    fields: [
      {
        name: "runId",
        type: "string",
        required: "legacy",
        meaning:
          "TaskStreamMirrorBatch 的兼容字段。实际表示当前 mirror/input run，不是观测 trace。",
        owner: "host runtime",
        source: "TaskStreamMirrorBatch",
        conceptIds: ["taskStreamMirrorBatch", "inputId"],
      },
      {
        name: "ownerRunId",
        type: "string",
        required: "legacy",
        meaning: "远控 owner command 的 stale 防护字段。传入时使用 activeInputId。",
        owner: "host runtime",
        source: "enqueueTaskCommand",
        conceptIds: ["activeInputId", "deliveryKind"],
      },
      {
        name: "command.traceId",
        type: "TraceId",
        required: "legacy",
        meaning:
          "TaskRuntimeCommandBase 的路由字段；当前作为 host command 路由 ID，语义上对应 inputId。",
        owner: "host runtime",
        source: "TaskRuntimeCommandBase",
        conceptIds: ["inputId", "taskStreamMirrorBatch"],
      },
      {
        name: "clientId",
        type: "string",
        required: "optional",
        meaning: "提交队列命令的客户端 ID，用于 owner 路由、展示当前设备和 stale command 防护。",
        owner: "renderer/host",
        source: "TaskRuntimeCommandBase",
        conceptIds: ["deliveryKind"],
      },
      {
        name: "batchSeq/fromSeq/toSeq",
        type: "number",
        required: "required",
        meaning: "mirror 批次和 op 序号范围，用于手机 remote replayable 缺口恢复。",
        owner: "host runtime",
        source: "TaskStreamMirrorBatch",
        conceptIds: ["taskStreamMirrorBatch", "eventSeq"],
      },
    ],
  },
];

export const protocolSurfaces = [
  {
    id: "transport",
    title: "Transport Envelope",
    summary:
      "轻量 JSON-RPC 风格：request 有 id/method/params/trace，notification 有 method/params/trace，response 有 id/result 或 id/error。",
    fields: [
      "id",
      "method",
      "params",
      "trace.traceId",
      "trace.parentId",
      "trace.spanId",
      "trace.traceparent",
    ],
    conceptIds: ["traceId", "eventEnvelope"],
  },
  {
    id: "session-methods",
    title: "Session APIs",
    summary:
      "session/create/resume/read/subscribe/send/stop/fork/compact/rewind/close。协议实体叫 session，不叫 task。",
    fields: ["session/create", "session/read", "session/subscribe", "session/send", "session/stop"],
    conceptIds: ["sessionId", "sessionSend", "eventSeq"],
  },
  {
    id: "state-methods",
    title: "State Mutation APIs",
    summary:
      "会话模型选择、思考深度和模式由 agent server 维护；Provider 配置由 Environment Config 与进程 Registry 管理。",
    fields: [
      "session/setModel",
      "session/setThoughtLevel",
      "session/setMode",
      "workspace/readPresentation",
    ],
    conceptIds: ["sessionId", "workspaceKey"],
  },
  {
    id: "blocking",
    title: "Blocking Interactions",
    summary:
      "权限和用户输入走 server-to-client request，host 负责 owner 路由与 pending request 恢复。",
    fields: ["interaction/requestPermission", "interaction/requestUserInput", "pendingRequestIds"],
    conceptIds: ["permissionRequest", "deliveryKind", "sessionId"],
  },
];

export const flows: FlowStep[] = [
  {
    id: "create-session",
    title: "创建会话",
    actor: "UI -> host -> agent server",
    detail:
      "UI 调用 session/create，传 workspace/mode/model。server 生成 sessionId 和 root traceContext，返回 SessionStateSnapshot。",
    conceptIds: ["sessionId", "traceId", "workspaceKey"],
  },
  {
    id: "send-input",
    title: "提交输入",
    actor: "UI",
    detail:
      "UI 为本次输入生成 inputId，写入 activeInputId，然后调用 session/send({ sessionId, inputId, content })。",
    conceptIds: ["inputId", "activeInputId", "sessionSend"],
  },
  {
    id: "ack-background",
    title: "立即 ACK",
    actor: "agent server",
    detail:
      "session/send 只确认收到输入，不等待模型输出。后台 turn 继续运行，状态变化由 events/state.updated 推送。",
    conceptIds: ["sessionSend", "eventEnvelope"],
  },
  {
    id: "turn-events",
    title: "事件回流",
    actor: "agent runtime -> host -> UI",
    detail:
      "turn.started/completed/failed payload 回带 inputId；event envelope 保留 traceId 和 seq。",
    conceptIds: ["inputId", "traceId", "eventSeq"],
  },
  {
    id: "terminal-guard",
    title: "终态收口",
    actor: "UI projection",
    detail:
      "completed/failed 只有在 event.inputId 匹配 activeInputId 时才能关闭当前 assistant。旧 input 的迟到事件会被忽略。",
    conceptIds: ["activeInputId", "inputId", "taskRuntimeState"],
  },
  {
    id: "remote-replay",
    title: "远控恢复",
    actor: "web remote",
    detail:
      "web-remote-replayable 使用 snapshot + afterSeq + mirror batch 恢复。legacy runId 字段按 inputId 语义处理。",
    conceptIds: ["deliveryKind", "eventSeq", "taskStreamMirrorBatch"],
  },
];

export const stdioTrafficLogFields: StdioTrafficLogField[] = [
  {
    name: "ts",
    type: "ISO timestamp",
    meaning: "proxy 写入磁盘的时间，用于按本机时间排序和定位。",
  },
  {
    name: "workspaceKey",
    type: "string",
    meaning: "身份隔离 key，远程 workspace 使用 workspaceIdentity，本地回退 workspacePath。",
  },
  {
    name: "pid",
    type: "number",
    meaning: "agent 子进程 pid；同一个 workspace 重启后会出现新的 pid 文件。",
  },
  {
    name: "direction",
    type: "app-to-agent | agent-to-app | agent-stderr",
    meaning: "帧方向：写入 stdin、读取 stdout，或 agent stderr 旁路。",
  },
  {
    name: "raw",
    type: "string",
    meaning: "原始行内容。stdout/stdin 必须保持一行 JSON，stderr 可以是普通文本。",
  },
  {
    name: "message",
    type: "object | null",
    meaning: "raw 可解析为 ZCode Protocol 消息时的结构化结果；stderr 或解析失败时为空。",
  },
  {
    name: "parseError",
    type: "string | null",
    meaning: "解析失败原因。proxy 不应因此截断转发，只在查看器里标红。",
  },
];

export const stdioTrafficReadSteps: StdioTrafficReadStep[] = [
  {
    id: "tail-current",
    title: "实时跟随当前文件",
    command: "cat ~/.zcode/v2/dev/stdio-traffic/<workspaceHash>/latest.txt",
    detail: "适合临时排查，按写入顺序看每一行 traffic record。",
  },
  {
    id: "pretty-stdin",
    title: "只看 app 发给 agent",
    command: "jq 'select(.direction == \"app-to-agent\") | .message' < traffic.ndjson",
    detail: "用于确认 session/send、session/stop、permission response 是否真的发出。",
  },
  {
    id: "pair-by-id",
    title: "按 JSON-RPC id 配对",
    command: "jq 'select(.message.id == 7)' < traffic.ndjson",
    detail: "同一个 id 的 request/response 放在一起，能快速看出耗时和结果。",
  },
];

export const stdioTrafficFrames: StdioTrafficFrame[] = [
  {
    id: "frame-001",
    timestamp: "10:42:18.124",
    direction: "app-to-agent",
    kind: "request",
    method: "session/create",
    messageId: "1",
    summary: "创建本地 workspace 会话",
    bytes: 428,
    linkedId: "frame-002",
    raw: `{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/Users/dev/workspace/z-code",
      "workspaceKey": "/Users/dev/workspace/z-code"
    },
    "deliveryKind": "desktop-continuous"
  }
}`,
  },
  {
    id: "frame-002",
    timestamp: "10:42:18.191",
    direction: "agent-to-app",
    kind: "response",
    messageId: "1",
    sessionId: "sess_6b6a",
    summary: "返回 SessionStateSnapshot",
    bytes: 1816,
    latencyMs: 67,
    linkedId: "frame-001",
    raw: `{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_6b6a",
      "status": "ready"
    },
    "runtime": {
      "eventSeq": 0,
      "deliveryKind": "desktop-continuous"
    }
  }
}`,
  },
  {
    id: "frame-003",
    timestamp: "10:42:21.004",
    direction: "app-to-agent",
    kind: "request",
    method: "session/send",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "提交用户输入并立即 ACK",
    bytes: 612,
    linkedId: "frame-004",
    raw: `{
  "id": 2,
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "inp_a31c",
    "content": "看一下 stdio traffic"
  }
}`,
  },
  {
    id: "frame-004",
    timestamp: "10:42:21.011",
    direction: "agent-to-app",
    kind: "response",
    messageId: "2",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "session/send ack，不等待模型完成",
    bytes: 96,
    latencyMs: 7,
    linkedId: "frame-003",
    raw: `{
  "id": 2,
  "result": {
    "accepted": true,
    "inputId": "inp_a31c"
  }
}`,
  },
  {
    id: "frame-005",
    timestamp: "10:42:21.036",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.started 事件，payload 回带 inputId",
    bytes: 744,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 1,
    "traceId": "tr_9f20",
    "payload": {
      "type": "turn.started",
      "inputId": "inp_a31c",
      "turnId": "turn_01"
    }
  }
}`,
  },
  {
    id: "frame-006",
    timestamp: "10:42:21.212",
    direction: "agent-stderr",
    kind: "stderr",
    sessionId: "sess_6b6a",
    summary: "agent stderr 只作为旁路观察，不进入协议解析",
    bytes: 118,
    raw: "[zcode-agent] model provider ready provider=glm model=glm-4.7",
  },
  {
    id: "frame-007",
    timestamp: "10:42:22.842",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "assistant text part delta",
    bytes: 532,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 8,
    "payload": {
      "type": "message.part.delta",
      "inputId": "inp_a31c",
      "delta": "可以，用 traffic inspector 看。"
    }
  }
}`,
  },
  {
    id: "frame-008",
    timestamp: "10:42:24.509",
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId: "inp_a31c",
    summary: "turn.completed，UI 用 inputId 收口",
    bytes: 604,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": 12,
    "payload": {
      "type": "turn.completed",
      "inputId": "inp_a31c",
      "resultType": "success"
    }
  }
}`,
  },
];
