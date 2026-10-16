# CLI Agent 执行 Trace：链路、Schema 与埋点接口

> 状态：历史 V2 设计，仅用于追溯；当前实现和开发约束以
> [CLI Agent Telemetry 最终规范](../cli-agent-telemetry.md) 为准。
>
> 本文是 CLI Agent 可观测性的 v2 主规范。已有
> [模型 API 可观测性](./model-api-observability-v1.md) 作为 v1 继续运行；
> `Model Call` / `Model Attempt` 不废弃，而是成为新执行 Trace 的子节点。

## 1. 评审摘要

业务只声明：

1. 正在做什么，例如 `context.compaction`。
2. 以什么业务语义结束，例如 Step 被恢复丢弃。

业务不填写：

```text
uid / device / app version
sessionId / queryId / turnId / stepIndex / parentSpanId
provider / baseURL / model / transport / thinking
token / cache / retry / duration
error code / error message / HTTP status
```

这些信息由 Scope、Adapter、Recorder 和 Error Sanitizer 自动产生。

```text
AgentTelemetryRuntime
├── Scope：Turn / Step / Tool / Compaction / Detached Operation
├── Model Recorder：Logical Call / Physical Attempt
├── Schema Registry：Operation / Outcome / Error / 专属字段
├── AsyncLocalStorage：进程内父子上下文
└── OTel Backend：BatchSpanProcessor -> OTLP -> ARMS
```

关键决策：

- 一个真实 Agent Turn 是一条 Trace，不把 Session 做成长 Trace。
- Step、Tool、Compaction 是 Turn 内 Span。
- Subagent、异步 Sidecar 和 Turn 外模型入口独立成 Trace，用 Link 关联。
- 不提供任意 `track(name, properties)`。
- OTel Span、ARMS SDK 和 Parent ID 不进入业务接口。
- 不逐 Chunk、Delta、Token 或 Tool Progress 建 Span。

### 1.1 当前实现状态

已完成：

- `Turn -> Step -> Tool/Compaction -> Model Call -> Model Attempt` 使用真实 OTel
  Parent/Child 关系。
- Session/Goal 标题、Goal 完成校验、Workspace Generate Text 使用独立 Root；
  Subagent/Workflow Child Turn 使用 Spawn 时捕获的 Link。Detached Operation 在活跃 Scope
  内启动时同样带 Link；跨 Turn 的历史 Link 等待 P1 Link Cache。
- App 可注入 `TelemetryRuntime`/`AgentExecutionTelemetryPort`；Standalone CLI 在存在
  OTLP 环境变量时自行创建一个 `TracerProvider + BatchSpanProcessor`。
- Session、Turn、Query、Actor、Step Index、Provider、Model、Thinking、Token、Cache、
  Retry、耗时和错误由 Facade、Adapter、Recorder 自动补齐。
- Model v1 Record 继续保留，并通过真实 OTel Parent 挂入 v2 执行 Trace；SQLite Usage
  Observability 不改动。
- Error message 统一脱敏并截断，Error code、Provider code/message、HTTP status、
  error phase 和 fingerprint 继续进入 Model Span。
- Active Span、Active Turn 和 Record Queue 均有硬上限；Active Span 具备 30 分钟无活动
  TTL，每个 Turn 最多保留 200 个 Step/Tool/Compaction 明细 Span，溢出只在 Root 汇总。
- Model Call 在开始时捕获父 Scope，terminal 即使脱离原 ALS 上下文也能精确回写仍活跃的
  Turn/Step/Tool 汇总，不会误记到另一个并发调用。
- 新子 Scope 或显式 causation 到来时，必须先刷新当前祖先的活动时间，再清理其他 TTL
  过期 Span；权限等待等长暂停之后恢复执行不能把仍活跃 Turn 误收口成 `abandoned`。
- 导出失败旁路，不影响 Agent。

本次未完成：

- ARMS 仪表盘、告警规则和生产采样策略。
- 30 分钟 Link Cache 以及 enabled/disabled CPU、RSS、网络字节基线。
- Repo Wiki 和模型连通性测试等 CLI 外模型入口。
- 后台 Bash 当前 Tool Span 表示“成功启动后台任务”；后台进程的最终耗时/退出状态仍在
  `BackgroundTask*` 事件中，尚未形成独立的 Linked Span。看后台任务成功率时不能把
  `commandStatus=backgrounded` 当作最终成功。
- `ReadSessionContext` 与 `WebFetch` 的工具内模型请求已进入 ARMS Trace，但尚未写入本地
  `model_usage`，因此当前本地 SQLite 不能作为这两类调用的完整对账账本。
- 历史 RUM/本地 SQLite 仍存在错误正文上报或落盘路径；本轮只保证新 CLI Agent Trace
  不复制 Tool 原始错误，并未改变旧链路的保留与兼容契约。后续应单独统一错误分类、
  脱敏策略、长度和保留周期。

### 1.2 2026-07-27 完整性与隐私加固

本轮评审后，CLI 内执行链路统一按下面的树理解。Tool Span 记录“工具框架执行”，
Bash 子进程状态作为 Tool 的专属字段；两者不能混为一个成功率：

```text
Agent Turn
├── Agent Step
│   ├── Model Call
│   │   └── Model Attempt 1..N
│   └── Tool
│       ├── 工具框架结果：completed / failed / denied / cancelled / abandoned
│       ├── 工具性能：permission / command / filesystem / serialization
│       ├── Bash 命令结果：completed / failed / timed_out / cancelled /
│       │                  spawn_error / backgrounded
│       └── Tool 内 Model Call（WebSearch / WebFetch / ReadSessionContext）
├── Context Compaction
│   └── Model Call -> Model Attempt 1..N
└── Turn 汇总：step / model / tool / compaction / token / cache / retry

Detached Operation（标题、Goal 校验、Workspace Generate）
└── 独立 Root -- Link --> 触发它的 Turn/Tool
```

本轮必须保持的边界：

- 所有已注册工具都按 Registry 中的 canonical tool name 统计次数、耗时和工具框架结果；
  未注册或无法解析的工具名统一进入 `unknown` 桶，避免模型生成的任意工具名形成高基数或携带用户内容。
- Bash 额外统计安全的可执行文件名、命令分类、命令数量、子进程状态、退出码和耗时。
- Bash 可执行文件名只允许来自内置公开命令 Registry；自定义脚本、动态表达式、未知命令
  统一归为 `other`，复合命令统一归为 `compound`。
- ARMS 永不接收 Bash 原始命令、参数、工作目录、stdout/stderr、Tool Input/Output 或
  `commandHash`。`commandHash` 是已有本地诊断字段，不作为远端维度。
- Tool 原始错误文本默认不上传 ARMS，只上传稳定的错误类型、错误码、阶段和脱敏后
  fingerprint。模型 API 错误可上传中心脱敏、单行化、截断后的 message，便于 Provider
  排障。
- 本地 SQLite 已有 `tool_usage.error_message` 属于历史能力；本轮不新增或扩大原始错误
  落盘，后续单独设计本地保留长度、脱敏和迁移策略。
- Trace、RUM 和本地 Usage Store 都是旁路：导出或落盘失败只记受控 warning，不能中断
  Tool Result 持久化、模型续跑或 Turn 主链路。
- Turn 汇总必须区分模型失败/取消、工具失败/拒绝/取消，不能只统计调用总数。
- Model Recorder 遇到进程关闭、30 分钟 idle TTL 或 active-call 容量淘汰时，必须把
  尚无 terminal 的 Logical Call / Physical Attempt 显式收口为 `abandoned`，并记录
  `terminal_missing=true` 与受控原因；它表示观测生命周期不完整，不计入 Provider
  错误率。
- Standalone Telemetry shutdown 必须按 `Model -> Tool/Step/Turn -> Queue -> Exporter`
  顺序收口；仍活跃的 Agent Span 由深到浅标记 `abandoned`，避免退出时留下孤立 Model
  Span。`abandoned` 是观测完整性状态，OTel Status 保持 `UNSET`，单独统计但不污染业务
  失败率。
- 所有字符串 Attribute 在出口前有统一长度上限，避免异常对象、用户自定义 Provider/
  Model/Tool 名称造成单 Span 膨胀。
- 宿主注入的 `ZCODE_TELEMETRY_USER_SUBJECT_ID` 只有符合受控 ID 约束时才可作为
  `user_subject_id`；旧变量 `ZCODE_TELEMETRY_USER_ID_HASH` 已废弃并在子进程环境边界剔除。
  当前 Desktop Host 以 SHA-256 生成稳定假名标识；它是关联键，不是匿名化承诺。
  `deviceMid` 也只接受有界、无空白和路径分隔符的标识符；不合法时降级为缺少设备关联。
- 错误文本除清洗 URL、Header、邮箱、IP 和本地路径外，还必须识别常见裸凭据前缀以及
  ARMS LicenseKey 形态；无法证明安全的错误原文不应进入 Tool Span。
- Provider Base URL 的解析输入、清洗后 route 和 LRU cache 都必须有硬上限；URL
  userinfo/query/fragment 永不进入 Trace。数值 Attribute 只接受有限值，避免单个异常
  Provider 响应拖垮整个 OTLP batch。

性能原则是复用工具已经产生的非枚举 `perf` 元数据：Trace 包装器只读取小对象并映射
固定字段，不重新扫描 Output，不复制命令和输出，也不在调用线程 Flush。Bash 安全命令
名在已有性能归因阶段解析一次；超过 8 KiB 的超长命令不进入 parser，直接降级为
`other` 且省略无法可靠计算的 `commandCount`；解析失败或动态命令同样降级为低基数桶。

## 2. LLM 链路范围

### 2.1 CLI 内链路

| 入口                             | 范围            | v2 Operation                           | Model Call 父节点 |
| -------------------------------- | --------------- | -------------------------------------- | ----------------- |
| Main/Subagent/Workflow 模型 Step | 各自 Turn       | `agent.step`                           | Step              |
| 自动/手动/响应式 Compact         | Turn            | `context.compaction`                   | Compaction        |
| WebSearch                        | Tool            | `tool.web_search`                      | Tool              |
| WebFetch 内容加工                | Tool            | `tool.web_fetch.process`               | Tool              |
| ReadSessionContext 提取          | Tool            | `tool.read_session_context.extract`    | Tool              |
| ReadSessionContext 汇总          | Tool            | `tool.read_session_context.synthesize` | Tool              |
| Session 标题                     | 异步 Sidecar    | `session.title_generation`             | Root + Link       |
| Goal 标题                        | 异步 Sidecar    | `goal.title_generation`                | Root + Link       |
| Goal 完成校验                    | Turn 前阻塞操作 | `goal.completion_verification`         | Root + Link       |
| Git Commit Message               | Workspace 操作  | `workspace.git_commit_message`         | Root              |
| `workspace/generateText`         | Workspace 操作  | 受控 Purpose 映射                      | Root              |

`workspace/generateText` 是明确的 Turn 外协议入口。它应从任意 `querySource` 迁移为受控
`purpose`，由 CLI 映射 Operation。

所有 CLI 生产模型调用最终经过 `AiSdkModelAdapter`。分类优先级：

```text
显式 Operation
  -> 当前 Scope 默认 Operation
  -> legacy querySource Registry
  -> other + unclassified health counter
```

因此漏分类调用不会消失，但 `other` 必须可告警。

### 2.2 已知 CLI 外缺口

| 流量             | 当前事实                              | 决策                                       |
| ---------------- | ------------------------------------- | ------------------------------------------ |
| Repo Wiki        | `packages/services` 直接请求 Provider | P1 迁入 CLI ModelPort 或同一 Port          |
| 模型连通性测试   | Host 发出真实小请求                   | 独立 `admin.model_probe`，不进入 Agent SLO |
| `stream-animate` | 独立实验包                            | 不属于 ZCode Agent 生产 Trace              |

P0 的完成口径是“CLI Agent 全部 LLM 流量”，不是“整个产品全部 LLM 流量”。

## 3. Trace 拓扑

### 3.1 Turn 主树

```text
invoke_agent zcode                         Root / INTERNAL
├── zcode.agent.step                       Step 0 / INTERNAL
│   ├── zcode.model.call                   Logical Call / INTERNAL
│   │   ├── chat <model>                   Attempt 1 / CLIENT / error
│   │   └── chat <model>                   Attempt 2 / CLIENT / ok
│   ├── execute_tool Read                  Tool / INTERNAL
│   └── execute_tool WebFetch              Tool / INTERNAL
│       └── zcode.model.call
│           └── chat <model>
├── zcode.context.compaction               INTERNAL
│   ├── zcode.model.call                   SSE Call / error
│   │   └── chat <model>
│   └── zcode.model.call                   HTTP Fallback / ok
│       └── chat <model>
└── zcode.agent.step                       Step 1
```

- Turn 使用 GenAI `invoke_agent` 语义。
- Tool 使用 `execute_tool` 语义。
- Physical Attempt 才是远程 `CLIENT` Span。
- Logical Call 聚合 SDK Retry，因此是 `INTERNAL`。
- `zcode.span.type` 是稳定查询字段，不要求看板解析 Span 名。

### 3.2 权威边界

```text
command accepted
      |
      | queueWaitMs 只是属性
      v
active turn reserved + turnId allocated
      |
      +--> START Turn
      |      ├── context init / hooks
      |      ├── compaction
      |      └── step 0..N
      |
      +--> TurnComplete / TurnError / cancel
             |
             v
           END Turn
```

Turn 必须覆盖第一条模型请求前的初始化失败。

Step 从 `assistantMessageId` 分配后开始，到模型、工具和恢复决策结束：

```text
START Step
  -> Model Call
  -> zero or more sibling Tools
  -> completed / discarded / cancelled / failed
```

`stepId = assistantMessageId`。`stepIndex` 由 Turn Scope 严格递增分配，禁止从
`iteration`、Tool 数或日志推导。

### 3.3 Parent Policy

| 新节点             | Parent                                               |
| ------------------ | ---------------------------------------------------- |
| Step               | 最近 Turn                                            |
| Tool               | 最近 Step；缺失时回退 Turn并标记 degraded            |
| Compaction         | 最近 Turn，主动跳过 Step/Tool                        |
| Model Call         | Tool > Detached Operation > Compaction > Step > Turn |
| Attempt            | 创建它的 Logical Call                                |
| Detached Operation | Root，只带显式 Link                                  |
| Child Turn         | Root，只带 Spawn 时捕获的 Link                       |

响应式 Compaction 即使在 Step 错误栈中触发，也挂 Turn。因果关系用
`triggeringStepIndex` / `recoveredFromLogicalCallId`，不用错误 Parent 表达。

### 3.4 Link

```text
Parent Turn
└── execute_tool Agent
      +---- Link ----> Child Agent Turn

Parent Turn
      +---- Link ----> Session Title

Previous Turn
      +---- Link ----> Goal Verification
                            +---- Link ----> Continuation Turn
```

原因：

- Background Child 可能晚于 Parent Turn 结束。
- 标题是 Fire-and-forget。
- Goal Verification 发生在下一轮 Turn 之前。
- Foreground/Background Child 使用同一拓扑，避免结构漂移。

Link 在目标 Span 创建时提供。跨 Runtime 只传不可变、可序列化 `TelemetryLink`，
不传 Active Scope 或 Span Handle。

## 4. Schema

### 4.1 唯一位置与分层

```text
apps/zcode-cli/packages/contracts/src/telemetry/
├── agent-execution.ts     v2 Operation、Context、Link、各 Scope 与窄 Port
└── index.ts               既有 v1 Model Call/Attempt 与统一导出入口
```

`@zcode/telemetry` 只放 Scope、Recorder、OTel 映射和 Exporter 实现。
Core/Adapter 只依赖 Contracts，不 import OTel 或 ARMS。

当前先在 `agent-execution.ts` 内聚 v2 schema，避免为了目录形式拆出相互跳转的小文件；
当 Model v1 迁移到 v2 命名时，再按 `common/operations/model-api/ports` 做机械拆分，
但外部统一入口仍保持 `@zcode/contracts/telemetry`。

Schema 使用四层组合，不做一个充满 Optional 字段的巨型接口：

```text
Resource Context
      -> Execution Context
            -> Span Record Base
                  -> Turn / Step / Tool / Compaction / Operation
                  -> Model Call / Attempt
```

```ts
interface TelemetryResourceContext {
  serviceName: string;
  serviceVersion?: string;
  deploymentEnvironment?: string;
  runtimeSurface: RuntimeSurface;
  identity: {
    state: "authenticated" | "anonymous" | "unavailable";
    userIdHash?: string;
    deviceMid?: string;
  };
}

interface ExecutionContextSnapshot {
  executionTraceId?: string; // 现有 CLI/日志 ID，不是 OTel TraceId
  queryId?: string;
  sessionId?: string;
  parentSessionId?: string;
  turnId?: string;
  stepId?: string;
  toolCallId?: string;
  actor: { kind: ActorKind; agentName?: string };
}

interface TelemetrySpanRecordBase<TType, TOutcome> {
  schemaVersion: "2";
  recordId: string;
  type: TType;
  context: ExecutionContextSnapshot;
  operation: OperationName;
  timing: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
  };
  outcome: TOutcome;
  error?: SanitizedTelemetryError;
}
```

Resource 由 Backend 作为 OTel Resource 注入，不要求业务每次构造。

### 4.2 字段所有权

| 字段                      | 生产者                                | 业务行为           |
| ------------------------- | ------------------------------------- | ------------------ |
| Operation                 | Registry / 调用意图                   | 选择常量           |
| Actor                     | Scope                                 | 不填写             |
| Session/Turn/Step/Tool ID | Scope 从领域对象读取                  | 不填写             |
| OTel Trace/Span/Parent    | Backend                               | 不可见             |
| `stepIndex`               | Turn Scope 计数器                     | 不填写             |
| Provider/Model/Endpoint   | Adapter 最终解析结果                  | 不填写             |
| Thinking                  | Model Catalog + 最终 Provider Options | 不填写             |
| Token/Cache/Finish        | Adapter Normalization                 | 不填写             |
| Retry/Transport/TTFT      | Model Runner                          | 不填写             |
| Duration                  | Scope/Recorder                        | 不填写             |
| Outcome                   | 权威生命周期边界                      | 选择合法终态       |
| Error                     | Normalizer/Sanitizer                  | 只传原始 `unknown` |
| Child 汇总                | Scope Registry                        | 不填写             |

要求业务同时填写 `modelId`、`turnId` 或 `durationMs` 的 API 都视为设计失败。

继承规则：

| 层                      | 继承范围                      | 覆盖规则                                              |
| ----------------------- | ----------------------------- | ----------------------------------------------------- |
| Resource                | 进程内所有 Span               | 仅 Bootstrap 可设置，业务不可覆盖                     |
| Turn Execution Context  | Step、Tool、Compaction、Model | 从当前 CLI `TraceContext` 快照，不反向写回            |
| Step/Tool Identity      | 各自子节点                    | Facade 从领域对象提取；更内层调用不可改写             |
| Actor                   | 当前 Agent Turn 全树          | Child Agent 创建自己的 Actor，不继承父 Agent Actor    |
| Operation               | 当前 Scope 内 Model Call      | 显式受控 Intent 可覆盖，跨 Detached/Child Turn 不继承 |
| Provider/Model/Thinking | 当前 Model Call/Attempt       | 永远使用 Adapter 最终实际值，不从父 Span 继承         |
| Error/Outcome           | 当前节点                      | Child Error 不自动改写 Parent Outcome                 |

### 4.3 Operation、Execution Kind、Actor 分开

业务用途和标准 OTel 用途分开：

- `zcode.operation.name`：`context.compaction` 等 ZCode 业务用途。
- `gen_ai.operation.name`：`invoke_agent`、`execute_tool`、`chat`。
- `zcode.execution.kind`：`turn|step|tool|sidecar|standalone_blocking|standalone`。
- `zcode.actor.kind`：`main_agent|subagent|workflow_child|system|tool`。

v2 Operation：

```ts
export const Operation = {
  AgentStep: "agent.step",
  ContextCompaction: "context.compaction",
  SessionTitleGeneration: "session.title_generation",
  GoalTitleGeneration: "goal.title_generation",
  GoalCompletionVerification: "goal.completion_verification",
  WorkspaceGitCommitMessage: "workspace.git_commit_message",
  ToolWebSearch: "tool.web_search",
  ToolWebFetchProcess: "tool.web_fetch.process",
  ToolReadSessionContextExtract: "tool.read_session_context.extract",
  ToolReadSessionContextSynthesize: "tool.read_session_context.synthesize",
  WorkspaceGenerateText: "workspace.generate_text",
  Other: "other",
} as const;
```

旧名字迁移：

| v1                           | v2                             |
| ---------------------------- | ------------------------------ |
| `sidecar.session_title`      | `session.title_generation`     |
| `sidecar.goal_title`         | `goal.title_generation`        |
| `sidecar.goal_verification`  | `goal.completion_verification` |
| `sidecar.git_commit_message` | `workspace.git_commit_message` |
| `tool.web_fetch`             | `tool.web_fetch.process`       |

Exporter 可在兼容窗口双写旧 `zcode.operation`；业务只使用 v2。

### 4.4 Operation 专属字段

禁止任意 `attributes` Map，使用泛型 Map：

```ts
interface OperationDetailMap {
  "agent.step": Record<string, never>;
  "context.compaction": {
    trigger: "manual" | "auto" | "partial" | "reactive" | "session_memory";
    phase: "standalone_turn" | "pre_request" | "mid_turn" | "reactive";
    outerAttempt: number;
    maxAttempts: number;
    triggeringStepIndex?: number;
    recoveredFromLogicalCallId?: string;
  };
  "session.title_generation": {
    trigger: "first_user_input" | "external_input";
  };
  "goal.title_generation": {
    targetId: string;
  };
  "goal.completion_verification": {
    targetId: string;
    goalIteration: number;
  };
  "workspace.git_commit_message": Record<string, never>;
  "workspace.generate_text": Record<string, never>;
  "tool.web_search": Record<string, never>;
  "tool.web_fetch.process": Record<string, never>;
  "tool.read_session_context.extract": {
    chunkIndex?: number;
  };
  "tool.read_session_context.synthesize": {
    chunkCount?: number;
  };
  other: {
    legacyQuerySource?: string;
  };
}
```

```ts
startOperation<O extends OperationName>(
  operation: O,
  details: OperationDetailMap[O],
): OperationScope<O>;
```

这样 Compaction 不能误写 Goal 字段，动态模型名、错误码和 Attempt 序号也不能进入 Operation。

### 4.5 Outcome 和 Error

不同节点有不同合法终态：

```ts
type TurnOutcome = "success" | "failed" | "cancelled" | "abandoned";
type StepOutcome = "completed" | "discarded" | "failed" | "cancelled" | "abandoned";
type ToolOutcome = "completed" | "failed" | "denied" | "cancelled" | "abandoned";
type CompactionOutcome = "completed" | "failed" | "cancelled" | "abandoned";
type ModelOutcome = "completed" | "error" | "cancelled" | "abandoned";
type CancellationReason = "user" | "abort_signal" | "timeout" | "shutdown" | "superseded";
```

映射：

| Outcome                              | OTel Status |
| ------------------------------------ | ----------- |
| `success` / `completed`              | `OK`        |
| `failed` / `error` / `discarded`     | `ERROR`     |
| `cancelled` / `denied` / `abandoned` | `UNSET`     |

Child Error 不自动污染 Turn；Turn 只以权威 Turn terminal 为准。

```ts
interface SanitizedTelemetryError<TPhase extends string = string> {
  code?: string; // ZCode 稳定低基数码
  type: string; // Exception/归一类型
  message?: string; // 脱敏、截断后的运维信息
  phase?: TPhase;
  retryable?: boolean;
  fingerprint?: string;
}
```

Phase 按节点收窄，并统一包含 `unhandled` 作为包装器兜底，例如：

```text
Turn：context_init | hook | compaction | step | finalize | unhandled
Tool：lookup | validation | hook | permission | execute | serialize | unhandled
Model：prepare | connect | response | stream | parse | postprocess | unhandled
```

Model 再带独立 `providerError`：Provider code/message、HTTP status、request ID、retry-after。
调用方只传原始 `unknown`；中心 Sanitizer 移除凭据、Header、URL query、明显路径并限制长度。
默认不上报 Stack、Prompt、Response、Tool Input/Output。

### 4.6 节点字段

Turn：

```text
P0：number / inputSource / resultType
stepCount / modelCallCount / modelAttemptCount / toolCallCount
modelErrorCount / modelCancelledCount
toolErrorCount / toolDeniedCount / toolCancelledCount
compactionCount / retryRecoveredCount
inputTokens / outputTokens / reasoningTokens / cacheReadTokens / cacheWriteTokens

P1：queueWaitMs / primaryProvider / primaryModel / primaryThoughtLevel /
overflowChildCount
```

Root 汇总由 Child 自动累加。`primaryModel` 只取第一个 `agent.step` 的实际模型，
Tool/Compaction/Sidecar 不覆盖。

Step：

```text
P0：stepId / stepIndex / terminalReason
modelCallCount / modelAttemptCount / toolCallCount / toolErrorCount / token totals

P1：finishReason / outputBytes
```

Tool：

```text
公共：callId / name / outcome / outputBytes / outputTruncated
      totalMs / permissionWaitMs
Command detail：runMs / firstOutputMs / noOutputMs / exitCode / timedOut
                outputBytes / commandName / commandCategory / commandCount / status
Filesystem detail：readMs / writeMs / fileCount / totalBytes / maxFileBytes / workspaceKind
Patch detail：matchMs / hunkCount / matchAttempts，并组合 Filesystem detail
P1：permissionDecision
```

领域类型使用“公共生命周期字段 + 判别 detail”，禁止继续使用所有字段都 optional 的
扁平性能袋：

```text
ToolExecutionTelemetry
  ├─ totalMs / permissionWaitMs
  └─ detail（可选；无专属事实的 Tool 不填写）
      ├─ command { command }
      ├─ filesystem { filesystem }
      └─ patch { filesystem, patch }
```

`exitCode` 只属于 Command detail；Read、Write 等非命令工具在类型层无法填写退出码。
远端只保留 `zcode.tool.command.exit_code`，不再输出通用
`zcode.tool.exit_code`。

`Tool outcome` 与 `Command status` 是两套语义。Tool handler 正常返回结构化
`BashOutput` 时，Tool outcome 是 `completed`；即使 Bash 的退出码非零，
Command status 仍会是 `failed`。因此：

- 工具框架可靠性按 `zcode.outcome` 统计。
- Bash 子进程可靠性按 `zcode.tool.command.status` 统计。
- Bash 退出码分布的分母只包含 `command.exitCode` 已知的调用。
- 不得为了让两张成功率图一致而把非零退出改写成 Tool Span Error。

Model Call 与 Attempt：

```text
Call = 一次 generateText/streamText，可含多个 Adapter Retry
Attempt = 一次真实 Provider HTTP/SSE 请求
```

Call 专属：

```text
logicalCallId / callCause / previousLogicalCallId
attemptCount / hadError / recoveredAfterRetry
```

Attempt 专属：

```text
requestId / providerRequestId / attemptNumber / maxAttempts
attemptCause / previousRequestId / retryDelayMs / retryAfterMs
TTFT / streamIdle / streamStall
```

每个 Call/Attempt 还复用 v1 已稳定的模型事实：

```text
providerId / providerKind
providerOrigin / providerRoute / providerEndpointFingerprint
requestedModel / responseModel / reasoning
transport / streaming
inputTokens / outputTokens / reasoningTokens
cacheReadTokens / cacheWriteTokens / cacheObservation
```

`reasoning` 为严格结构：`capability / state / controlType / requestedLevel /
effectiveLevel / effectiveBudgetTokens`。公共 Schema 不出现供应商原生 `thinking`
命名；Adapter 负责从最终 Provider Options 解析。

`providerId` 标识用户配置的 Provider 实例，`providerKind` 标识协议/厂商类型；
`providerRoute` 是清洗后的 Base URL 路径，query 永不保留。Endpoint 清洗、缓存和 SHA-256
指纹继续复用 v1 实现，不在 Trace 层重复计算。

`rid` 只映射 Physical `requestId`，Turn/Step 不设置。

### 4.7 字段命名

内部 TypeScript：

```text
camelCase；Id / Ms / Bytes / Tokens 明确后缀；嵌套领域对象
```

Exporter 才映射外部字段：

```text
标准字段：
gen_ai.operation.name
gen_ai.provider.name
gen_ai.request.model / gen_ai.response.model
gen_ai.conversation.id / gen_ai.agent.name
gen_ai.tool.name / gen_ai.tool.call.id
gen_ai.usage.input_tokens / gen_ai.usage.output_tokens
gen_ai.usage.cache_read.input_tokens
gen_ai.usage.reasoning.output_tokens
server.address
error.type / error.message

ZCode 扩展：
zcode.telemetry.schema_version
zcode.span.type
zcode.operation.name
zcode.execution.kind
zcode.actor.kind
zcode.session_id / zcode.turn_id
zcode.agent.step_id / zcode.agent.step_index
zcode.model.logical_call_id
zcode.model.provider.id / zcode.model.provider.route
zcode.error.code / zcode.error.phase
zcode.tool.command.name / zcode.tool.command.category / zcode.tool.command.status
```

为兼容现有 ARMS 查询，Exporter 可以继续生成只读别名：

```text
uid = userIdHash
sid = sessionId
rid = Physical Attempt requestId
```

三者都由 Resource、Scope 或 Model Runner 产生，业务接口中不存在这些参数。

`userIdHash` 是用于跨设备关联的伪名化标识，不是匿名数据：低熵账号仍可能被字典推断。
`deviceMid/sessionId/turnId/requestId` 也都属于可关联标识符。它们允许上报，但必须依赖
ARMS 侧访问控制、保留周期和审计；禁止把这些字段拼入错误 message 或日志正文。

业务代码不出现 `"zcode.*"` 字符串。Exporter 使用 exhaustive mapping 测试；
OTel 约定升级不要求修改业务调用点。

## 5. 埋点接口

### 5.1 注入和上下文

Bootstrap 创建一个 CLI 级 Runtime，以窄 Port 注入：

```text
AgentRuntime -------> AgentExecutionTelemetryPort
ToolExecutor -------> AgentExecutionTelemetryPort
AiSdkModelAdapter --> ModelTelemetryPort
```

背后共享同一个 Scope Storage 和 TracerProvider。App 只注入 Endpoint、Headers、身份和版本；
Standalone CLI 用同一 Bootstrap 自初始化。

Telemetry 使用独立：

```ts
AsyncLocalStorage<AgentTelemetryScopeContext>;
```

不扩展现有 `TraceContext`，因为后者用于日志、SessionEvent 和协议，可能被复制或序列化；
OTel Scope 只能存在当前 CLI 进程。Remote replay/snapshot/hydration 不携带 Active Span。

Scope Context 只保存不透明 Scope Ref、Scope Kind、祖先和默认 Model Operation。
并行 Tool 分别运行在自己的 `scope.run()` 中，不串上下文。

业务面对的 Facade 和底层 Recorder Port 必须分开：

```text
业务/领域代码
    -> RuntimeTelemetryFacade
         ├── 从当前 TraceContext 读取 sessionId / queryId / turnId
         ├── 从现成 Message / ToolCall 领域对象提取 stepId / toolCallId
         ├── 将领域结果映射为合法 Terminal
         └── 调用 AgentExecutionTelemetryPort
                  -> Scope / Recorder / OTel
```

业务不能 import `AgentExecutionTelemetryPort`。只有 Facade 和 Adapter Integration 可以构造
规范化 ID、父引用和运行时事实。这允许底层 Contracts 保持纯类型，同时避免把
`sessionId`、`turnId`、`provider` 等字段散落到业务调用点。

### 5.2 业务 Facade 与内部 Port

业务 Facade 只暴露中心生命周期：

```ts
interface RuntimeTelemetryFacade {
  turn(): TurnScope;
  step(message: AssistantMessage): StepScope;
  tool(call: ExecutableToolCall): ToolScope;
  compaction(intent: CompactionIntent): CompactionScope;
  detached<O extends DetachedOperationName>(
    operation: O,
    details: OperationDetailMap[O],
    causation?: TelemetryLink,
  ): OperationScope<O>;
  captureLink(): TelemetryLink | undefined;
}
```

这里的 `AssistantMessage`、`ExecutableToolCall` 是调用点本来就持有的领域对象，不是为了
Telemetry 新建的 DTO。Facade 内部 Extractor 负责取 ID；业务不能传一个自由字符串冒充
`stepId` 或 `toolCallId`。

Contracts 中的 Recorder Port 是 Facade 的实现细节：

```ts
interface AgentExecutionTelemetryPort {
  startTurn(input: NormalizedAgentTurnStart): TurnScope;
  startStep(input: NormalizedAgentStepStart): StepScope;
  startTool(input: NormalizedToolStart): ToolScope;
  startCompaction(input: NormalizedOperationStart<"context.compaction">): CompactionScope;
  startDetachedOperation<O extends DetachedOperationName>(
    input: NormalizedDetachedOperationStart<O>,
  ): OperationScope<O>;
}

interface TelemetryScope<TTerminal, TErrorPhase extends string> {
  run<T>(fn: () => T): T;
  end(terminal: TTerminal): void;
  fail(error: unknown, phase: TErrorPhase): void;
  cancel(reason: CancellationReason): void;
  link(): TelemetryLink;
}
```

所有 terminal 方法同步、无抛错、幂等。首个终态生效；重复终态 P0 忽略，P1 增加
Health Counter。
`run()` 负责建立 ALS，并在未处理异常抛出时自动 `fail(error, "unhandled")`；领域层仍在正常
返回时显式选择合法 Terminal。回调正常返回但没有终态时，Scope 先标记 `abandoned`，
避免泄漏 Active Span；对应 Health Counter 同样在 P1 补齐。Noop 与 Enabled 实现保持相同
调用语义。

### 5.3 Turn、Step、Tool

Turn 权威入口：

```ts
const scope = telemetry.turn();

return scope.run(async () => {
  try {
    const result = await executeTurnBody();
    scope.end(turnTerminalFromResult(result));
    return result;
  } catch (error) {
    scope.fail(error, currentTurnPhase());
    throw error;
  }
});
```

Step 只传调用点本来就持有的领域对象：

```ts
const scope = telemetry.step(assistantMessage);

return scope.run(async () => {
  const result = await executeStepBody();
  scope.end(stepTerminalFromResult(result));
  return result;
});
```

Facade 从 Message 提取 `stepId`；底层 `startStep` 自动找 Turn、分配 `stepIndex`。不把
Turn Handle 放进
`RegularTurnLoopState`，也不向 Model/Tool 参数层层透传。

Tool 在 Executor 中心接一次，Handler 零改动：

```ts
const scope = telemetry.tool(canonicalToolCall);

return scope.run(async () => {
  try {
    const result = await executeExistingToolFlow();
    scope.end(toolTerminalFromResult(result));
    return result;
  } catch (error) {
    if (signal?.aborted) {
      scope.cancel("abort_signal");
    } else {
      scope.fail(error, toolErrorPhase(error));
    }
    throw error;
  }
});
```

Permission、Validation、Handler、Serialization、Post Hook 都处于同一个 Scope。
Executor 边界必须显式收口异常和取消，并原样重新抛出业务异常；底层 `run()` 的
`fail("unhandled")` 只作为注入实现遗漏终态时的最后防线，不能替代领域错误阶段分类。

### 5.4 Model Call Intent

当前 Scope 有唯一默认 Operation 时，可以不写：

```ts
await modelPort.streamText({ model, messages, tools });
```

Tool 内有多个 LLM 用途时，只声明用途：

```ts
await modelPort.generateText({
  model,
  messages,
  modelCall: {
    operation: Operation.ToolReadSessionContextExtract,
  },
});
```

公开 `ModelCallIntent` 不包含：

```text
actorKind / IDs / parentKey / spanId
provider / model / thinking
duration / usage / error
```

Adapter Retry 全自动。Core 层 Fallback 使用受控 Call Chain：

```ts
const calls = modelTelemetry.createCallChain({
  operation: Operation.ContextCompaction,
});

await modelPort.streamText({
  ...request,
  modelCall: calls.initial(),
});

await modelPort.generateText({
  ...request,
  modelCall: calls.next({
    cause: "transport_fallback",
    reason: "pre_commit_stream_failure",
  }),
});
```

Call Chain 生成 `logicalCallId` / `previousLogicalCallId`；业务不手工复制 ID。
Cause/Reason 是受控枚举，不接收 Provider 原始消息。

### 5.5 Detached Operation

调度点捕获 Link：

```ts
const causation = telemetry.captureLink();

void schedule(async () => {
  const scope = telemetry.detached(
    Operation.SessionTitleGeneration,
    { trigger: "first_user_input" },
    causation,
  );

  await scope.run(async () => {
    const result = await generateSessionTitle();
    scope.end(titleTerminalFromResult(result));
  });
});
```

Detached API 强制创建 Root，不继承当前 ALS Parent，避免 Fire-and-forget 偶然挂进 Turn。
Subagent/Workflow 也只在 Spawn 边界传一个 `TelemetryLink`。

### 5.6 防错清单

| 风险                          | 防线                            |
| ----------------------------- | ------------------------------- |
| Operation 拼错                | 常量 + literal union            |
| 专属字段写错                  | `OperationDetailMap`            |
| Parent 选错                   | 固定 Parent Policy              |
| UID/Session/Turn 漏填         | Scope/Resource 自动继承         |
| Provider/Model 与真实请求不符 | Adapter 最终值                  |
| Retry 漏记                    | Runner Status 自动 Attempt      |
| Duration 算错                 | Scope 自带时钟                  |
| Error 泄密                    | 中心 Sanitizer                  |
| Span 重复结束                 | 首终态生效                      |
| 新 LLM 漏分类                 | Scope -> legacy -> `other` 告警 |
| replay 重复上报               | 只有执行 CLI 持有 Runtime       |

## 6. Runtime 和 Export

v1 在 Terminal Record 到达时临时创建短 Model Trace。v2 必须创建真实 Active Span：

```text
scope.start
    -> tracer.startSpan
    -> registry[scopeRef] = Span + SpanContext + aggregates

child.start
    -> resolve parent context
    -> tracer.startSpan(parentContext)

scope.end
    -> set typed attributes/status
    -> span.end
    -> retain immutable SpanContext in short Link Cache
```

Parent 在 Child 创建时已经确定，因此不受 5 秒 Batch 或跨 Batch 影响。

Model Adapter 调用开始时解析当前 Scope。现有 `ModelNetworkStatusEvent` 继续提供 Attempt 事实：

```text
model_request_started -> start Call（首次）+ Attempt
retry/failed          -> end Attempt error
next started          -> next Attempt under same Call
terminal              -> end Attempt + Call + 更新父级汇总
```

建议上限：

```text
active turns 256
active spans 2,000
idle TTL 30 min
completed Link cache 30 min
detail children / turn 200
```

Parent 缺失时回退合法祖先；仍缺失则创建 Orphan Root，记录
`zcode.telemetry.parent_resolution=orphan` 和 Health Counter，绝不阻塞业务。

生产只保留一个 `TracerProvider + BatchSpanProcessor + OTLPTraceExporter` 网络 Owner。
现有自定义 Queue 可在迁移期保留 Terminal Fact 兼容，但不再负责构造父子关系，避免双层 Queue。

## 7. 性能、迁移与验收

Hot Path 只允许 ALS/Map 查找、时钟、计数和 Span 内存操作；禁止网络、Flush、历史扫描、
Payload 复制、全量 JSON、重复 URL 清洗和 Stack Capture。

Tool Trace 只映射 `ToolExecutionTelemetry` 各判别 detail 的固定白名单字段。尤其禁止把
`commandHash`、任意 `perf.*` 扩展字段或整个对象摊平成 Attribute；这既控制网络体积，
也避免未来在本地诊断 Schema 中加入的字段被意外上传。

Span 数只随 Turn/Step/Tool/Compaction/Call/Attempt 增长，不随 Token/Chunk 增长。
超过 200 个 Detail Child 后保留 Turn/Step，后续只累加 `overflowChildCount` 并标记截断。

实施顺序：

1. Schema、Operation Registry、Scope/Memory/Noop Backend。
2. Turn/Step/Tool/Compaction + Model Parent。
3. Title、Goal Verification、Workspace Purpose、Subagent/Workflow Link。
4. ARMS 灰度、看板和旧链路对账。
5. Repo Wiki 与 `admin.model_probe` 覆盖。

必须验证：

- 完整 Turn -> Step -> Call -> Attempt 父子关系。
- 并行 Tool 是兄弟，ALS 不串 Scope。
- Compaction 跳过 Step 挂 Turn。
- Detached 只有 Link，没有 Parent。
- Retry、Fallback、Discard、Cancel 和恢复后的 Turn 结果正确。
- 所有已知 CLI LLM 都不是 `other`。
- Prompt、Response、Tool Payload 无法进入 Record 类型。
- ARMS Down/Queue 满不影响 Agent，内存有界。
- Enabled/Disabled CPU、RSS、gzip 字节和请求数有真实基线。

## 8. 实现入口与参考

- Turn：`apps/zcode-cli/packages/core/src/runtime/methods/turn.ts`
- Step：`apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
- Tool：`apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Compaction：`apps/zcode-cli/packages/core/src/runtime/methods/compact-active.ts`
- Title：`apps/zcode-cli/packages/core/src/runtime/methods/title-generation-sidecar.ts`
- Goal Verification：`apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts`
- Workspace Generate：`apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts`
- Model Adapter：`apps/zcode-cli/packages/adapters/src/model/runner.ts`
- Model Status：`apps/zcode-cli/packages/adapters/src/model/runner-status.ts`
- 当前 Schema：`apps/zcode-cli/packages/contracts/src/telemetry/index.ts`
- Agent v2 Schema：
  `apps/zcode-cli/packages/contracts/src/telemetry/agent-execution.ts`
- Runtime Facade：
  `apps/zcode-cli/packages/core/src/telemetry/runtime-telemetry.ts`
- Agent Scope Runtime：
  `apps/zcode-cli/packages/telemetry/src/agent-trace-runtime.ts`
- 当前 Recorder：`apps/zcode-cli/packages/telemetry/src/model-api-recorder.ts`
- 当前 Exporter：`apps/zcode-cli/packages/telemetry/src/otlp-exporter.ts`
- OpenTelemetry Trace API：<https://opentelemetry.io/docs/specs/otel/trace/api/>
- OpenTelemetry GenAI Attributes：<https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/>
- OpenTelemetry GenAI 规范仓库：<https://github.com/open-telemetry/semantic-conventions-genai>
