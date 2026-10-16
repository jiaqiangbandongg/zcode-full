# CLI Agent 模型 API 可观测性设计（历史 V1）

> 状态：已被
> [CLI Agent OpenTelemetry 最终架构规范](../cli-agent-telemetry.md)
> 取代。本文只保留早期决策背景，不再作为字段、接口、隐私或报表实现依据。
>
> 新实现已经删除本文中的 Endpoint/Error Fingerprint、`cache_observation`、
> `had_error/recovered_after_retry` Trace 摘要等设计；请勿据此新增查询或代码。
>
> 后续 Agent 执行主干见
> [CLI Agent Turn Trace 可观测性设计](./turn-trace-observability-v2.md)。本文已有
> `zcode.model.call` / `zcode.model.attempt` 不废弃；它们将从当前短 Trace 迁移为
> Turn / Step / Compaction / Tool 下的子 Span。

## 1. 结论

本功能采用两层设计：

1. 建立通用 `TelemetryRuntime`，只负责队列、批量、限流告警、Flush 和 Exporter 生命周期；P0 全量记录，后续采样由这一层扩展。
2. 在通用运行时之上建立强类型 `ModelApiTelemetry`，专门理解模型调用的 Logical Call、Physical Attempt、Provider、Model、Thought Level、Token、Cache、Retry、Fallback 和错误。

不向业务代码暴露任意属性的 `track(name, properties)`，不让模型领域直接依赖 ARMS SDK。

CLI 是模型调用事实的权威生产者。App 只负责在启动 CLI 时注入 OTLP、运行环境和身份配置；CLI 也支持在 Standalone 场景读取同一套配置并自行初始化。App 现有 RUM 和 CLI 新增 OTel 使用同一阿里云账号/Workspace，但不共用 SDK、Endpoint 或 `service.name`。

短期不删除现有 `plan_request`、`/event/report`、SQLite Usage、UI 性能和本地日志。新链路先双写和对账；长期让 CLI Model API Facts 成为请求级唯一事实源，再逐步替换重复的 `plan_request` 生产链路。

## 2. 目标与非目标

### 2.1 目标

- 覆盖 CLI 内部所有可区分的模型 API 调用，包括主 Agent、Subagent、Workflow Child、Compaction、标题、Goal Verifier、Git Commit 和工具内部模型调用。
- 区分一次模型调用与它下面的物理 Provider 请求、Adapter Retry、流式恢复和 Transport Fallback。
- 统计调用量、物理请求放大率、成功率、取消率、Retry 恢复率、耗时、TTFT、Token 和 Prompt Cache。
- 记录实际 Provider、清洗后的 Endpoint、Model、请求与最终生效的 Thought Level。
- 失败时记录 ZCode 错误码、Provider 错误码、HTTP 状态码、脱敏错误信息、错误阶段、是否可重试和 Provider Request ID。
- 所有记录携带 UID、设备、Session、Turn、Trace、Logical Call 和 Request 等关联 ID。
- App-launched 和 Standalone CLI 共享同一 Schema 和 Exporter 逻辑。
- Telemetry 失败、拥塞或未配置时不得阻塞或改变 Agent 行为。

### 2.2 非目标

- 不上传 Prompt、Message 正文、Tool 输入输出、文件内容、Header、Cookie、API Key 或完整 Provider Options。
- 不逐 Token、逐 SSE Delta 或逐 Streaming Chunk 上报。
- 不用 CLI Provider TTFT 替代 Renderer 用户可见 TTFT。
- 不把业务转化、购买、反馈等 `/event/report` 事件迁到本链路。
- 不把 Telemetry 状态写入 conversation snapshot、relay、desktop main 或 renderer store。
- 第一阶段不创建 ARMS 关系型“表”，不创建本地 `model_attempt_usage` 表。
- 第一阶段不删除或改变现有 RUM、业务埋点和本地 Usage 对外行为。

## 3. 已确认边界

| 边界              | 决策                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| 监控抽象          | 通用 Telemetry 运行时 + 模型专用强类型 Schema/Recorder                                                   |
| 模型调用分类      | 使用稳定的点分 `operation` 路径，不另设 `operation_phase`                                                |
| Feature 定制字段  | 使用 discriminated union 和命名空间字段，不允许任意属性 Map                                              |
| Provider Endpoint | 客户端内部自动清洗；用户无配置、无 UI、无感知                                                            |
| Path 清洗         | 删除 URL 凭证/query/fragment，再用轻量正则替换邮箱、UUID、长数字和 Token/Hash 风格 segment；不过度模板化 |
| Endpoint 缓存     | 在进程内按 `providerKind + baseURL` 记忆化；不持久化                                                     |
| Thought Level     | 复用现有 Model Catalog、UI `thoughtLevel` 和最终 Provider Options 映射，不另造供应商无关档位             |
| App ARMS          | 同账号/Workspace，App RUM 与 CLI OTel 分 Service、分 Endpoint                                            |
| 兼容策略          | 短期双写不破坏；中期对账；长期替代重复 request-level 链路                                                |
| 性能策略          | 业务线程只更新小型状态和入有界队列；真实网络由后台 Batch Exporter 执行                                   |
| UID/RID/SID       | Schema 使用明确名称；Exporter 可按后端约定映射为 `uid/rid/sid`，领域层不使用含糊缩写                     |

## 4. 当前事实与重合链路

### 4.1 当前模型请求主路径

所有生产模型请求最终集中到 AiSdk Model Adapter：

```text
Core / Tool / Sidecar
        |
        v
ModelPort.generateText / streamText
        |
        v
AiSdkModelAdapter
        |
        +--> runGenerateText
        +--> runStreamText
                 |
                 v
          Provider HTTP / SSE
```

Adapter 已产生以下 `ModelNetworkStatusEvent`：

- `model_request_started`
- `model_request_completed`
- `model_request_failed`
- `model_retry_scheduled`
- `model_stream_stalled`

事件已经包含 Trace/Query/Session/Turn、Request、Provider、Model、Base URL、Transport、Attempt、Duration、Usage、Failure Reason、Message 和 HTTP Status 的大部分基础事实。

### 4.2 当前监控/Usage 链路

```text
CLI model status
  |\
  | +--> protocol live fact --> Renderer --> RUM plan_request
  |
  +----> UI retry/debug projection

CLI runtime usage
  +----> SQLite model_usage / turn_usage / tool_usage

Renderer conversation lifecycle
  +----> /event/report message_completion / agent_step / context_compaction
  +----> RUM plan_ttft / UI TTFT / UI completion / UI stall

Desktop main
  +----> RUM crash / resource / HTTP / RPC / longTask
```

### 4.3 重合评审

| 机制                               | 与新方案关系                        | 短期                                         | 长期                                         |
| ---------------------------------- | ----------------------------------- | -------------------------------------------- | -------------------------------------------- |
| `ModelNetworkStatusEvent`          | 物理 Attempt 的最佳事实源           | 复用并补字段                                 | 保持为 Runtime/UI 投影和 Recorder 输入       |
| `ModelStatusSink`                  | 已有状态消费抽象                    | 修复 request/global 二选一问题，支持 fan-out | 保持，或下沉为统一 Composite Sink            |
| SQLite `model_usage`               | 逻辑调用 Token/耗时本地事实         | 保持表和查询不变                             | 改为消费同一个 Model Call Terminal Fact      |
| RUM `plan_request`                 | 与请求级 Attempt 高度重复           | 双写用于对账                                 | OTel 稳定后停止或仅保留兼容 Exporter         |
| RUM `plan_ttft`                    | Renderer 用户可见耗时               | 保持                                         | 保持，不与 Provider TTFT 合并                |
| `/event/report message_completion` | 用户 Turn/业务质量                  | 保持                                         | 保持，通过 Session/Turn ID 关联              |
| `/event/report agent_step`         | UI/业务步骤，不是 Model API Request | 保持                                         | 保持；名称需要在文档中避免与 Model Call 混淆 |
| Desktop RUM 网络监控               | Main/Renderer HTTP、RPC、WS         | 保持                                         | 保持，不能替代 CLI 子进程模型语义            |
| 本地日志                           | 单机诊断                            | 保持                                         | 保持；允许比 ARMS 更详细但仍需脱敏           |

核心原则是“合并事实生产，不强行合并所有消费端”。

## 5. 状态所有权

| 事实                              | 权威来源                                            | 镜像/消费端                        |
| --------------------------------- | --------------------------------------------------- | ---------------------------------- |
| Provider/Model/Base URL/Transport | Model Adapter 最终解析结果                          | ARMS OTel、UI 安全投影、日志       |
| Physical Attempt 生命周期         | `runGenerateText` / `runStreamText`                 | ModelApiTelemetry、UI retry/debug  |
| Token/Cache/Finish Reason         | Adapter Normalization 的最终 Usage                  | ModelApiTelemetry、SQLite Usage    |
| Operation 语义                    | Core/Tool/Sidecar 调用点                            | ModelApiTelemetry                  |
| Compaction/Verifier 最终业务结果  | 对应 Operation 调用方                               | Operation Record、现有业务事件     |
| Thought Level 请求值              | Session/Model Ref/调用方覆盖                        | ModelApiTelemetry                  |
| Thought Level 生效值              | 最终 merge 后 Provider Options + Model Catalog 反查 | ModelApiTelemetry                  |
| UID                               | App Host 当前 OAuth 身份快照；Standalone 可缺失     | Telemetry Context                  |
| Device MID                        | 现有 `telemetry-state.json`                         | App RUM、CLI OTel、`/event/report` |
| Session/Turn/Trace/Query          | CLI Runtime Trace Context                           | 所有模型记录                       |

Renderer、Desktop Main 和 Relay 不重新推导 Provider 请求事实。

## 6. 记录模型

### 6.1 三层记录

```text
Model Operation
  |
  +--> Model API Call #1 (streamText)
  |      |
  |      +--> Physical Attempt #1
  |      +--> Physical Attempt #2
  |
  +--> Model API Call #2 (generateText fallback)
         |
         +--> Physical Attempt #1
```

三层定义：

1. Operation：由 `operation_id` 和稳定 `operation` 路径表达，例如一次完整 Compaction 或 Goal Verification；已实现的 Model Phase 不额外发送 Operation Span。Agent Turn Trace 阶段会为 Compaction 等真正有独立生命周期的 Operation 增加父 Span。
2. `ModelApiCallRecord`：一次 `ModelPort.generateText()` 或 `streamText()` 调用。
3. `ModelApiAttemptRecord`：一次真实 Provider HTTP/SSE/WebSocket 请求。

普通 Agent Step 通常 Operation 与 API Call 一一对应。Compaction 的 SSE -> HTTP Fallback 是同一个 Operation 下的两个 API Call；Adapter 内部 Retry 是同一个 API Call 下的多个 Attempt。

### 6.2 Trace 边界的后续演进

Agent Session 可能持续很久，并包含不受限的 Step、Tool 和 Compaction。把整个 Session 做成一个长 Trace 会造成 Span 数量、内存、采样和查询边界不稳定。

Phase 1 已实现为每个 `ModelApiCallRecord` 对应一个短 Trace/Root Span，Physical Attempt 是
Child Span；通过 ZCode 自己的 `session_id`、`turn_id`、`operation_id` 和
`logical_call_id` 跨 Trace 关联。

目标结构不是 Session Trace，也不继续停留在孤立 Model Trace，而是：

```text
一个 Agent Turn = 一条 Trace
Turn -> Step -> Model Call -> Physical Attempt
             -> Tool Call
Turn -> Compaction -> Model Call -> Physical Attempt
```

异步 Sidecar、Background Subagent 和 Workflow Child 仍使用独立 Trace + OTel Link。
完整父子关系、生命周期和迁移方案以
[CLI Agent Turn Trace 可观测性设计](./turn-trace-observability-v2.md) 为准。

## 7. Operation 分类

### 7.1 稳定路径

本节记录 Phase 1 当前已经发出的 v1 值。新增链路不得继续扩展
`sidecar.*` 等旧命名；v2 规范值、兼容别名和迁移顺序以
[CLI Agent Turn Trace 可观测性设计](./turn-trace-observability-v2.md) 为准。

```text
agent.step
context.compaction
sidecar.session_title
sidecar.goal_title
sidecar.goal_verification
sidecar.git_commit_message
tool.web_search
tool.web_fetch
tool.read_session_context.extract
tool.read_session_context.synthesize
other
```

`operation_family` 从路径第一段派生，调用方不得手写。

### 7.2 路径准入规则

只有有限、稳定、具有业务语义的分支才能进入路径：

- `extract` / `synthesize` 可以进入路径。
- `attempt_2`、`failed`、模型名、Provider ID、Chunk Index 不能进入路径。
- 动态值必须使用字段。

### 7.3 执行角色

`actor_kind` 与 Operation 正交：

```text
main_agent
subagent
workflow_child
system
tool
```

`agent.step + actor_kind=subagent` 表示 Subagent 的正常模型 Step，不再使用 `query_source=subagent` 同时表达功能和角色。

迁移期保留原始 `query_source` 作为 Trace 兼容字段，由一个严格 Registry 映射到 `operation + actor_kind`；未知值映射为 `operation=other`，不得直接成为 Metrics Label。

## 8. Schema

### 8.1 公共身份与关联字段

```text
schema_version
record_id
occurred_at

user_id_hash
identity_state
device_mid

session_id
parent_session_id
turn_id
trace_id
query_id
operation_id
logical_call_id
request_id
provider_request_id
tool_call_id

app_version
cli_version
deployment_environment
runtime_surface
```

约束：

- `record_id`：每条事实唯一，用于幂等和去重。
- `logical_call_id`：一次 Model API Call。
- `request_id`：每个 Physical Attempt 唯一；Adapter Retry 必须生成新值。
- `provider_request_id`：Provider 响应 Header/Body 中的请求 ID，存在时记录。
- OAuth/账号原始 UID 不进入 Record、OTLP Resource 或 Agent 子进程公共环境；App Host 只注入 SHA-256。
- `user_id_hash` 用于 ARMS 用户关联；Exporter 同时映射为既有查询约定的 `uid`；`identity_state=authenticated|anonymous|unavailable`。
- Standalone 无 ZCode 账号身份时，UID 留空，不使用字符串 `unknown` 冒充用户。
- Exporter 映射 `uid/rid/sid = user_id_hash/request_id/session_id`；领域 Schema 仍使用完整名称。

上述 ID 只用于 Trace/SLS 详情查询，不作为 Metrics Label。

### 8.2 调用来源

```text
operation
operation_family
actor_kind
agent_name
step_index
runtime_surface
```

`agent_name`、`step_index` 只放 Trace；`operation`、`actor_kind`、`runtime_surface` 可作为受控 Metrics 维度。

### 8.3 Provider 与模型

```text
provider_id
provider_kind
provider_origin
provider_route
provider_endpoint_fingerprint
endpoint_sanitizer_version
model_id
model_role
```

- `provider_id`：用户/系统配置的 Provider 实例，例如 `company-prod`。
- `provider_kind`：实际 Adapter/协议类型，例如 `anthropic`、`openai-compatible`。
- `provider_id` 可能高基数，默认只放 Trace；`provider_kind` 可用于 Metrics。

### 8.4 Reasoning

首版 Schema 尚未上线，不保留 `thought*` / `reasoningEnabled` 兼容字段。公共领域和
Telemetry 统一使用 `reasoning`；`thinking`、`reasoning_effort`、`enable_thinking`
等供应商原生命名只允许存在于 Provider Adapter 和 wire request。

```text
reasoning_capability = supported | unsupported | unknown
reasoning_state = enabled | disabled | unknown
reasoning_control_type = none | toggle | effort | fixed_budget | adaptive | unknown
reasoning_requested_level
reasoning_effective_level
reasoning_effective_budget_tokens
```

含义：

- `capability`：是否有证据证明模型支持 Reasoning；Catalog 缺失不能写成
  `unsupported`。
- `state`：本次最终 Provider 请求是否实际开启 Reasoning。
- `control_type`：供应商控制机制；`disabled` 是状态，不是控制机制。
- `requested_level`：Session/调用方请求的档位。
- `effective_level`：从最终 merge 后的 Provider Options 和 Model Catalog 反查的档位。
- `effective_budget_tokens`：最终发给 Provider 的固定预算，不记录原始 Provider
  Options。
- Adapter 必须先按本次实际 `provider_kind` 和 SDK `provider_options_name` 投影出唯一
  Provider namespace，再解析 `state`、`control_type`、`effective_level` 和
  `effective_budget_tokens`。同一对象中其他 Provider 的 namespace 只能作为未消费配置，
  不得参与本次请求事实判定。

这三个字段是正交事实：

```text
capability：Catalog/显式配置是否证明模型具备能力
state：最终请求是否实际开启
control_type：最终请求或模型配置使用哪种控制方式
```

因此自定义模型缺少 Catalog 时，可以出现
`capability=unknown, state=enabled, control_type=fixed_budget`；这表示“无法证明模型
能力，但本次请求明确携带了固定预算”，不能把它改写为 `unsupported` 或
`disabled`。如果模型声明与最终请求冲突，也保留两边的真实值，供监控发现配置问题。

要求：

- 不把 GLM `enabled`、OpenAI `high`、Anthropic `xhigh` 强制归一成虚假的供应商无关档位。
- Sidecar 显式关闭 Reasoning 时，Requested 与 Effective 必须不同。
- 无法反查自定义 Provider Options 时记录 `unknown`，不得猜测或写成 `disabled`。
- 多个 Provider namespace 同时存在且互相冲突时，只记录当前 Adapter 实际消费的
  namespace；禁止递归扫描整个 `providerOptions`。
- `false` 只表示有明确关闭证据；未知事实不得伪造成 `false` 或 `0`。
- OTel 不接受 `null` Attribute；未知数值省略，低基数状态使用显式 `unknown`。
- 禁止上传完整 Provider Options。

### 8.5 Attempt 与 Transport

```text
transport
streaming
call_cause
previous_logical_call_id
attempt_number
max_attempts
attempt_cause
previous_request_id
retry_delay_ms
stream_recovery_number
stream_recovered_from_request_id
stream_output_committed
```

```text
call_cause = initial | transport_fallback | model_fallback | provider_fallback | recovery
attempt_cause = initial | retry
```

Transport/Model/Provider Fallback 在本设计里会创建新的 `ModelApiCallRecord`，通过
`previous_logical_call_id` 与前一个 Call 关联；Adapter 内部 Retry 才是在同一个 Call 下创建新的
Physical Attempt，并通过 `previous_request_id` 关联。这样不会把 Core Fallback 和 Adapter Retry
统计成同一种重试。

Compaction 等 Feature 专有字段放入命名空间，不污染公共 Schema：

```text
zcode.compaction.trigger
zcode.compaction.outer_attempt
zcode.compaction.stream_output_committed
zcode.compaction.fallback_eligible
```

### 8.6 耗时

```text
duration_ms
time_to_first_provider_event_ms
time_to_first_content_ms
time_to_first_text_ms
stream_max_idle_ms
stream_stall_count
retry_delay_ms
```

Provider Event、内容和用户可见文字是三个不同时间点；CLI 不宣称 `time_to_first_text_ms` 等价于 Renderer UI TTFT。

### 8.7 Token 与 Cache

```text
input_tokens
output_tokens
reasoning_tokens
cache_read_tokens
cache_write_tokens
provider_total_tokens
computed_total_tokens
cache_observation
```

```text
cache_observation = hit | hit_and_write | write | miss | unknown
```

当 Provider 没有返回 Usage 或请求在 Usage 前失败时必须是 `unknown`，不能误记为 `miss`。

### 8.8 成功、取消和错误

```text
status
finish_reason
error_code
failure_reason
provider_error_code
http_status_code
error_message
provider_error_message
error_phase
exception_type
error_fingerprint
retryable
retry_after_ms
cancelled_by
telemetry_terminal_missing
telemetry_abandon_reason
```

```text
status = completed | error | cancelled | abandoned
error_phase = prepare | connect | response | stream | parse | postprocess
```

约束：

- `error_code` 使用 ZCode `ModelErrorCode`。
- `provider_error_code` 保存 Provider 业务码，不能覆盖统一错误码。
- `error_message` 是 ZCode 归一化安全消息。
- `provider_error_message` 必须脱敏和截断，最大 1024 字符。
- 错误消息和 Stack 不得成为 Metrics Label。
- 成功调用不采集 Stack；错误 Stack 仅在明确开启且通过脱敏时进入详细 Trace。
- Cancellation 单列，不计入模型失败率分母。
- `abandoned` 只用于 shutdown、idle TTL 或容量保护导致的观测 terminal 缺失；它不等于
  Provider 错误，必须通过 `telemetry_abandon_reason` 单独统计。
- Retry 后成功的 Call：`status=completed`，同时记录 `had_error=true`、`recovered_after_retry=true`。
- Operation 后处理失败不能改写模型调用成功：分别记录 `call_status` 与 `operation_status`。

## 9. Provider Endpoint 清洗

### 9.1 产品边界

Endpoint 清洗完全是内部实现：

- 不增加用户配置。
- 不增加 `telemetryRouteTemplate`。
- 不在设置页暴露。
- 不要求用户理解或维护监控 Route。

### 9.2 轻量规则

```text
原始 Base URL
  |
  +--> 使用标准 URL parser
  +--> 删除 username/password
  +--> 删除 query 和 fragment
  +--> hostname 小写、删除默认端口
  +--> 对 path segment 做轻量正则替换
          email            -> {email}
          UUID             -> {uuid}
          长数字           -> {id}
          长十六进制/hash  -> {hash}
          Token 风格长串   -> {token}
  +--> 保留其余稳定 Path
  +--> 生成 origin / route / fingerprint
```

例如：

```text
https://user:pass@gateway.example.com/team-a/v1/messages?api_key=secret

provider_origin = https://gateway.example.com
provider_route  = /team-a/v1/messages
```

如果 `team-a` 不符合敏感正则就保留。这里接受低风险，不增加复杂的租户词典或 Provider 专用模板系统。

### 9.3 性能与缓存

清洗复杂度是 `O(URL 长度)`，相比一次模型网络请求可以忽略，但仍按 Provider 配置记忆化：

```text
cache key = provider_kind + "\0" + raw_base_url
cache value = ProviderEndpointIdentity
cache limit = 256
```

结果存放在 Resolved Provider/进程内 LRU，不持久化到 SQLite 或配置文件。原因：计算便宜、规则可能升级、Base URL 可能变化、持久化容易留下旧版本结果。

记录 `endpoint_sanitizer_version`，规则升级时自然重新计算。

Fingerprint 基于清洗后的 `origin + route`，不对仍含秘密的原始 URL 做无密钥 Hash。

## 10. 通用运行时与模型专用 Recorder

### 10.1 通用层

```ts
interface TelemetryRuntime {
  record(record: TelemetryRecord): void;
  flush(options: { timeoutMs: number }): Promise<void>;
  shutdown(options: { timeoutMs: number }): Promise<void>;
}
```

职责：

- 有界内存队列。
- Batch Export。
- Export 超时和失败隔离。
- P1 的采样策略和 P0 的告警速率限制。
- Resource Attributes。
- 本地 Exporter health snapshot 和限频警告；远端 self-telemetry 指标留到 P1。
- 测试 Memory Sink 和生产 No-op Sink。

不负责：

- 判断模型错误。
- 解析 Token/Cache。
- 识别 Compaction。
- 解析 Provider Options。
- 清洗模型领域字段。

### 10.2 模型层

```ts
class ModelApiTelemetryStatusSink implements ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void;
}
```

Recorder 在内存里维护极小状态，直到 Call/Attempt 收口后生成不可变 Terminal Record。OTel Sink 再把 Terminal Record 映射成具有明确 start/end timestamp 的 Span。

这种设计避免 Core/Adapter 持有 OTel Span 对象，也避免 OTel Context 穿过 Async Generator、Tool 和 Fallback 后污染领域代码。

### 10.3 TelemetryRecord

```ts
type TelemetryRecord = ModelApiCallRecord | ModelApiAttemptRecord | TelemetryExporterHealthRecord;
```

不是 `Record<string, unknown>`。

## 11. App 注入与 Standalone 初始化

```text
App-launched
  Host resolve config/identity
       |
       +--> spawn env / startup config
                    |
                    v
Standalone ------> async identity prepare
                    |
                    v
                  CLI Telemetry Bootstrap
                    |
                    +--> TelemetryRuntime
                    +--> ModelApiTelemetry
                    +--> OTLP Exporter
```

Standalone 的文件身份初始化属于 CLI 启动 I/O，不属于同步 Telemetry 工厂：

```text
headless / TUI / protocol async entry
  |
  +--> prepareModelTelemetryEnv()
         |
         +--> endpoint disabled/missing ----------> 原 env（零文件 I/O）
         |
         +--> host 已注入 device_mid ------------> 原 env（零文件 I/O）
         |
         +--> async read telemetry-state.json
                |
                +--> existing device_mid ---------> 注入启动 env
                |
                +--> async lock + atomic rename --> 注入新 device_mid
                |
                +--> I/O failure -----------------> identity unavailable
  |
  +--> synchronous createZCodeApp()
         |
         +--> synchronous createModelTelemetry()（只消费已准备的 env）
```

同一进程对同一 state 文件的并发 prepare 共享一个 Promise；跨进程继续复用
`telemetry-state.lock`、stale owner 检测和原子 rename。身份 I/O 失败必须旁路，最多让
`identity_state=unavailable`，不能阻断 App 创建或首个模型请求。直接嵌入并调用同步
`createZCodeApp()` 的宿主负责注入身份；官方 headless、TUI、protocol 入口统一执行异步 prepare。

配置优先级：

1. 显式注入的 `TelemetryRuntime`/Sink，供测试或进程内嵌入。
2. App 注入的 OTLP 配置。
3. Standalone CLI 环境变量/配置。
4. No-op。

Phase 1 使用标准 OTel 环境变量，不增加用户设置 UI：

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   # 优先，完整 /v1/traces 地址
OTEL_EXPORTER_OTLP_ENDPOINT          # 次选，CLI 自动追加 /v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS    # 优先于 OTEL_EXPORTER_OTLP_HEADERS
OTEL_SERVICE_NAME                    # 默认 zcode-cli-agent
OTEL_RESOURCE_ATTRIBUTES
ZCODE_MODEL_TELEMETRY_ENABLED        # false/0/off/disabled 可强制关闭
```

Desktop main 只把 allowlist 内的 OTLP 配置定向传给 host，并丢弃外部传入的 UID hash、Identity State、Device MID 和 Runtime Surface，避免环境变量伪造身份。Host 初始化 services 时立即捕获 OTLP 配置并从公共 `process.env` 删除；启动 Agent 时再注入，CLI bootstrap 捕获后同样删除。因此认证 Header 不会进入 Bash、MCP 或 Tool 子进程。Desktop UID 从 OAuth Profile 读取后在 Host 内做 SHA-256 伪名化，原值不跨 Agent 边界；该散列仍是可关联标识符，并非匿名数据。Device MID 复用 App 已有 `telemetry-state.json`。

当前 App 内置的 `ZCODE_ARMS_RUM_ENDPOINT` 是 `/rum/web/v2`，不能推导 OTLP 地址或复用 RUM 鉴权。部署环境必须另外提供目标 ARMS Workspace 的 OTLP Endpoint/Header；缺失时新链路明确 No-op，原 RUM、SQLite 和 `/event/report` 均保持运行。

### 11.1 Desktop 正式安装包配置交付

正式安装包不能依赖用户从 Terminal 启动，也不能读取开发仓库的 `.env`。构建流水线通过
以下专用变量向 Desktop Main 注入部署默认值：

```text
ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT
ZCODE_PACKAGED_AGENT_OTEL_HEADERS
ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME   # 可选，默认 zcode-cli-agent
```

它们只用于构建 Desktop Main，不直接作为通用 `OTEL_*` 变量暴露给 pnpm、
electron-builder 或其他构建子进程。运行时再映射为 Agent 已支持的标准字段：

```text
ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT     -> OTEL_EXPORTER_OTLP_ENDPOINT
ZCODE_PACKAGED_AGENT_OTEL_HEADERS      -> OTEL_EXPORTER_OTLP_HEADERS
ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME -> OTEL_SERVICE_NAME
```

```text
GitLab CI variables（Header 必须 masked）
  |
  +--> Desktop tsup build
         |
         +--> packaged deployment defaults（Main bundle）
                |
                +--> Desktop Main
                       |
                       +--> Host（仅连接配置）
                              |
                              +--> Agent（连接配置 + 可信身份）
                                     |
                                     +--> OTLP/HTTP -> ARMS
```

配置约束：

- Endpoint 与 Headers 必须同时存在；只配置一个时构建失败，禁止发布“看似启用、实际无法鉴权”的安装包。
- 普通开发/MR 构建在完全未配置时保持 No-op；`release/current` 和 Tag 构建完全缺失配置时也会失败，
  防止正式安装包静默退回 No-op。
- Endpoint 必须是 HTTP(S) URL；正式发布使用 HTTPS。
- 打包默认值优先级低于显式运行时 `OTEL_*`，方便运维诊断和隔离环境覆盖。
- 构建变量只允许产生 Endpoint、Headers 和 Service Name，不能携带 UID、Device MID、Session 等运行时身份。
- CI Header 必须使用 masked variable，不写入仓库、构建日志或 artifact 清单；目标发布分支启用
  GitLab protected branch 后，再同步将变量设为 protected。
- Desktop 客户端中的 ingestion credential 最终可被本机用户提取，因此它只能是低权限、可轮换的
  写入凭证，不能拥有查询或管理权限。长期方案应迁移到受控 Collector/Gateway 和短期凭证。
- Standalone CLI 继续只读取标准 `OTEL_*`；不会隐式继承 Desktop 安装包的部署默认值。

约束：

- 一次 CLI 运行只能有一个 OTel Exporter Owner。
- App 的 Main 只传 Endpoint/Auth/Resource 配置，Host 再注入可信 Identity；注入结果是配置而不是 Electron RUM SDK 对象。
- CLI 直接向 ARMS OTel 发送，不经 Renderer，不逐条经过 Host/Main IPC。
- UID 身份是启动快照；若产品要求不重启 CLI 即支持账号切换，后续通过严格协议增加 Identity Update，不在 P0 猜测。
- Remote SSH/WSL/Docker 必须显式、安全地传递配置；不假设本地进程环境自动到达远端。
- Relay/Main 不持有 Model Call 状态。

## 12. App ARMS 与 CLI ARMS

```text
同一个阿里云账号 / ARMS Workspace
  |
  +--> zcode-desktop-rum
  |      SDK: @arms/rum-electron
  |      Endpoint: /rum/web/v2
  |      范围: crash / JS error / UI / longTask / main-renderer network
  |
  +--> zcode-cli-agent
         SDK: minimal OpenTelemetry trace packages（Metrics 为 P1）
         Endpoint: OTLP
         范围: Model API / Agent Runtime
```

两边共享关联属性：

```text
device_mid
user_id_hash / uid
session_id
turn_id
app_version
cli_version
deployment_environment
runtime_surface
```

不得把 CLI 数据发送到现有 RUM `/rum/web/v2` Endpoint。

## 13. 性能、内存、CPU 与网络评审

### 13.1 热路径事件数量

正常成功模型调用：

```text
1 个 ModelApiCall Terminal Record
1 个 ModelApiAttempt Terminal Record
0 个逐 Chunk Record
```

OTel Span 在本地开始/收口后只导出一次。现有 `started/completed` 状态仍可服务 UI，但新 OTel 不把它们各自转换为独立网络 Custom Event。

Retry 一次只线性增加一个 Attempt Span；`retry_scheduled`、`stream_stalled` 优先作为 Attempt Span Event/聚合字段，不单独创建 Trace。

### 13.2 同步 CPU

业务线程允许：

- 单调时钟/墙钟读取。
- 少量整数计数。
- 小对象字段复制。
- Map 查找。
- Endpoint Identity 缓存读取。
- Terminal Record 入队。

业务线程禁止：

- 网络请求。
- 文件 I/O。
- 大对象 JSON stringify。
- Prompt/Message/Tool Payload 遍历。
- 成功调用 Stack 生成。
- 每个 SSE Chunk 分配 Telemetry Record。

设计验收目标：

| 项目                     | 目标        |
| ------------------------ | ----------- |
| `record()` 同步耗时 P95  | `< 0.5ms`   |
| `record()` 同步耗时 P99  | `< 1ms`     |
| 10 calls/s 稳态 CPU 增量 | `< 1%` 单核 |
| TTFT 额外同步延迟        | `< 1ms`     |

这些是验收预算。当前实现的实测结果见 13.7。

### 13.3 内存

建议双重上限：

```text
completed record queue: 2000 records 或 4 MiB，先到者生效
active call/attempt state: 1000 handles
endpoint identity cache: 256 entries
```

队列满时：

```text
丢弃 Telemetry
增加 telemetry_dropped_total
限频 warn
继续 Agent 业务
```

普通主流的 Consumer Close 为保持既有 direct-continuous 生命周期，不会新增 abort/terminal；Recorder 通过 30 分钟惰性清理和 1000 条上限时淘汰最旧悬挂 Call，防止永久增长。Compact 隐藏流仍会在 Consumer Close 时 abort 并收口。

设计验收目标：

| 项目                         | 目标                                                        |
| ---------------------------- | ----------------------------------------------------------- |
| Queue/Recorder 稳态 RSS 增量 | `< 10 MiB`                                                  |
| Exporter 故障 30 分钟        | 内存仍受硬上限约束                                          |
| 一次成功 Call 的状态         | 不保存 Prompt、Response、Header 或 Provider Metadata 原对象 |

OTel SDK 自身基线内存必须单独测量，不与 Queue 指标混淆。

### 13.4 网络

默认 Batch 建议：

```text
max_batch_size = 100 spans
flush_interval = 5s
export_timeout = 3s
shutdown_flush_timeout = 1~2s
```

必须启用 OTLP 批量和压缩；禁止每条 Record 发一次 HTTP。

设计目标：

- 成功路径只包含标量和短字符串。
- 不发送 Prompt、Headers、Body、Raw Usage JSON 和 Raw Provider Metadata。
- 正常一次 Model API Call 的未压缩 Telemetry 目标 `< 4 KiB`；错误/Retry Call 目标 `< 8 KiB`。
- 实际压缩率、日调用量和 ARMS 账单通过灰度采样测量，不用静态猜测代替。

容量公式：

```text
daily_raw_bytes ~= call_count * avg_call_record_bytes
                + attempt_count * avg_attempt_record_bytes
```

Phase 1 在进程内 `health()` 暴露，P1 再发送到独立 Metrics/Health 通道：

```text
telemetry_export_bytes_total
telemetry_export_batches_total
telemetry_export_failures_total
telemetry_dropped_total
telemetry_queue_size
```

### 13.5 启动与包体

当前 CLI/SEA 没有生产直接依赖的完整 OTel SDK。实现时必须显式添加依赖，不能依赖 Vitest 或 AI SDK 的传递依赖。

推荐使用最小包集合和手工 Span，不启用 Node 全量 Auto Instrumentation：

- 避免重复采集 AI SDK/fetch 请求。
- 避免把文件、DNS、HTTP 等无关自动 Span 带入。
- 降低 CLI/SEA 包体、启动 CPU 和内存。

Telemetry 未配置时延迟初始化或保持 No-op，不创建 Batch Worker。实现 MR 必须报告：

- `dist/zcode.cjs` minified 大小变化。
- SEA 二进制大小变化。
- Standalone `zcode --help` 和首次 Prompt 启动耗时变化。
- Telemetry disabled/enabled 的 RSS 基线。

不建议为减小包体自行实现一套非标准 OTLP 协议；先用最小官方 SDK，只有测量证明包体不可接受时再评估替代。

### 13.6 ARMS 故障行为

```text
ARMS timeout/down/rate limit
  |
  +--> 每个 Flush 周期至多一次失败请求
  +--> Queue 达上限后丢弃
  +--> 本地限频日志 + 自监控计数
  +--> Agent 模型调用完全不受影响
```

Exporter 禁止无限重试、无限落盘、阻塞进程退出或把异常抛到模型调用方。Phase 1
不在 CLI 外层重复实现 SDK 内部重试；失败批次丢弃，剩余队列留到下一次 Flush，shutdown 时按总超时收口。

### 13.7 Phase 1 实测结果

测试环境：macOS arm64、Node.js 24.14.0；时间与 RSS 是本机微基准，CI/生产机器需继续灰度复测。

| 项目                                                          |                                                      实测 | 结论                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------: | ---------------------------------------------------------- |
| 10,000 次完整 Call（started + completed + 2 records）同步 P50 |                                           `0.0022ms/call` | 低于预算                                                   |
| 同上 P95 / P99                                                |                                   `0.0046ms` / `0.0095ms` | 低于 `0.5ms` / `1ms` 预算                                  |
| 默认 2,000 条模型 Record 队列 RSS / heap 增量                 |                                     `6.20MiB` / `2.16MiB` | 低于 Queue/Recorder `10MiB` 预算                           |
| Telemetry 模块冷 import / disabled create                     |                                      `26.6ms` / `0.089ms` | OTel 已延迟到首批真实 Export，不在 disabled 热路径初始化   |
| Enabled create（身份已注入）                                  |                                                 `0.234ms` | 只创建有界 Runtime/Recorder，不做网络                      |
| Standalone device state 首次创建 P50/P95                      |                                     `0.286ms` / `0.354ms` | 历史同步基线；现已移至异步入口，复用既有锁且不覆盖业务状态 |
| Standalone device state warm read P50/P95                     |                                     `0.014ms` / `0.017ms` | 历史同步基线；现为异步启动 I/O，不在模型热路径             |
| 首批 OTel 加载 + 两 Span Export + shutdown                    |                                  `93.0ms`，RSS `+18.0MiB` | 发生在后台 Flush/退出，不进入模型 TTFT                     |
| 1 Call + 1 Attempt OTLP protobuf                              |                            未压缩 `3,456B`，gzip `1,159B` | 单 Call 批次约 `1.13KiB` 网络载荷                          |
| `dist/zcode.cjs`                                              |   `19,037,591B -> 20,146,129B`，`+1,108,538B`（`+5.82%`） | 官方最小 OTel SDK 是主要增量                               |
| darwin-arm64 SEA                                              | `181,513,504B -> 182,629,792B`，`+1,116,288B`（`+0.62%`） | SEA 总体增幅可控                                           |
| `--help` 冷启动 P50（30 次）                                  |                            `290.2ms -> 295.0ms`，`+4.8ms` | 调度噪声较大，平均值未退化；继续在 CI 追踪                 |

10 calls/s 下，仅按 P95 同步 Recorder 耗时折算约 `0.046ms CPU/s`，即单核 `0.0046%`；这只是热路径估算，不替代线上 CPU 与后台 protobuf/gzip 观测。

为控制 disabled 成本，`LazyOtlpTelemetryRecordExporter` 只在首个非空 Batch 时动态加载 OTel。Exporter Down 时每个 5 秒 Flush 周期最多发起一次失败请求；队列按 2,000 条或 4MiB 先到者丢弃，shutdown 的 Flush + SDK shutdown 共用一个总超时。

## 14. 代码侵入性评审

### 14.1 实际改动

| 层                 | 主要改动                                                                     | 侵入性                              |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------- |
| `@zcode/contracts` | Operation Registry、Typed Observation、Call/Attempt/Error Records、Sink 接口 | 已完成；纯类型/Schema，无 ARMS 依赖 |
| Model Adapter      | Attempt 生命周期、最终 Provider/Endpoint/Thought/Usage、错误补全             | 中；集中在 runner/status/options    |
| Core Runtime       | 主 Step/Compaction/Verifier/Title 等调用点补 `operation` 和 Operation 结果   | 低到中；约十个语义入口              |
| Tool Handlers      | WebSearch/WebFetch/ReadSessionContext 补严格 Operation                       | 低                                  |
| Bootstrap          | 创建 TelemetryRuntime/Recorder/Composite Sink；注入 Adapter/Runtime          | 中                                  |
| CLI Entry          | Standalone 配置、Flush/Shutdown                                              | 低到中                              |
| Services Host      | App spawn 配置和身份注入                                                     | 低；P0 不需要逐事件协议转发         |
| Desktop/UI         | 双写期保持现状；增加迁移 Feature Flag/对账                                   | 低                                  |
| SQLite             | P0 不迁表；接入保持当前写入                                                  | 低                                  |

### 14.2 避免侵入的关键设计

Phase 1 调用点只声明语义；v2 接入后 `actorKind` 由当前 Scope 自动继承：

```ts
model.generateText({
  ...request,
  modelCall: {
    operation: Operation.SessionTitleGeneration,
  },
});
```

公共事实由 Adapter 统一补齐，调用点不重复处理 Provider、Endpoint、Thought、Token、Cache 和错误。

`modelCall` 是 ZCode 内部字段，Adapter 在构造 AI SDK 请求时必须剥离，不能发送给 Provider。

### 14.3 Phase 1 结构问题处理结果

1. `publishModelStatus()` 已改为 request/global sink 独立 fan-out；任一 sink 抛错都会被旁路记录，另一个仍收到事件。
2. 流式完成事件已补齐最终 Usage、Finish Reason、首 Provider Event/Content/Text、Stall 与 Output Commit。
3. Failed Status Event 已携带统一 `error_code`、Provider 业务码/消息、HTTP Status、Request ID、阶段和异常类型。
4. `query_source` 通过严格 Registry 映射；未知值只进入 `other`。
5. Tool 内部模型调用已覆盖 ARMS Call/Attempt；SQLite logical usage 的长期统一仍留到 Phase 3。
6. Title/Git Commit 显式标记 Effective Disabled；其他调用复用最终 Provider Options + Model Catalog。
7. Adapter Retry 用多个 Request ID；Compaction Transport Fallback 用 `previous_logical_call_id` 关联；Stream Recovery 用 `stream_recovered_from_request_id`、恢复序号及同一 Session/Turn 关联。

### 14.4 不建议的实现

- 在每个 Call Site 手写 `arms.sendCustom()`。
- 把完整 Telemetry Event 通过 Renderer/Main IPC 再发送。
- 让 SQLite Row 直接充当 OTel Schema。
- 让 Model Adapter 依赖 Electron、ARMS RUM 或 Host Service。
- 用任意 `metadata: Record<string, unknown>` 承载所有 Telemetry 定制字段。
- 在业务路径 `await` 真实 Export。

## 15. Metrics 与统计口径

### 15.1 基础计数

```text
model_api_calls_total
model_api_attempts_total
model_api_errors_total
model_api_cancellations_total
model_api_retries_total
model_api_retry_recovered_total
model_api_fallbacks_total
model_api_tokens_total
model_api_cache_read_tokens_total
model_api_cache_write_tokens_total
```

### 15.2 公式

```text
Logical Call 成功率 = completed / (completed + error)

Attempt 成功率 = completed attempts / (completed attempts + failed attempts)

物理请求放大率 = physical attempts / model API calls

Retry 恢复率 = completed-after-retry / retried calls

Cache Call 命中率 = hit calls / cache-observable calls

Cache Token 命中率 = sum(cache_read_tokens) / sum(input_tokens)
```

Cancellation 单列，不进入默认失败率分母。

### 15.3 Metrics Label

允许：

```text
operation
operation_family
actor_kind
provider_kind
transport
status
error_code
runtime_surface
deployment_environment
```

默认不允许：

```text
user_id_hash / uid
device_mid
session_id
turn_id
trace_id
logical_call_id
request_id
provider_request_id
provider_id
agent_name
error_message
provider_route
```

`model_id` 只有经过已知模型白名单/基数预算后才能进入 Metrics；否则只用于 Trace/SLS 查询。

## 16. ARMS 数据组织

不按 `step/compact/title/tool` 创建独立表。使用一个 OTel Service：

```text
service.name = zcode-cli-agent
span.name = zcode.model.call
span.name = zcode.model.attempt
span.name = zcode.model.operation
```

通过 `operation`、`actor_kind`、`transport` 等字段分类。Trace 数据由 ARMS 托管存储；若未来需要长期宽表或固定离线分析，再通过 SLS Scheduled SQL 生成派生 Logstore，不作为 P0 前置条件。

## 17. Dashboard 与告警

### 17.1 Dashboard

1. 总览：Call/Attempt 量、Logical/Attempt 成功率、P50/P95/P99、TTFT、Token。
2. Provider/Model：Provider Kind、Provider ID、Model、Thought Level。
3. Compaction：SSE 成功、HTTP Fallback、Outer Retry、Operation Commit。
4. Retry/Error：统一错误码、Provider 错误码、HTTP Status、Retry 恢复率。
5. Cache：Call 命中、Token 命中、Cache Write。
6. Surface：Desktop、Standalone、Remote、Automation。
7. Telemetry Health：Queue、Drop、Export Failure、Export Bytes。

### 17.2 告警

- 告警必须带最小样本量，避免低流量误报。
- 成功率、P95、429、5xx、Timeout、Context Exceeded 分开告警。
- Exporter 故障只告警监控链路，不触发 Agent 失败。
- 第一阶段先采集基线，不在无数据时拍脑袋确定业务 SLO。

## 18. 采样与成本

P0：

- Logical Call Terminal、Error、Cancel、Retry、Fallback 100%。
- Attempt Terminal 100%，用于先建立真实基线和与 `plan_request` 对账。
- 不上报逐 Chunk。

基线稳定后：

- 精确 Calls/Errors/Duration/Token 使用不采样 Metrics 或完整 Terminal Facts。
- 详细成功 Trace 可采样。
- Error/Cancel/Retry/Fallback Trace 继续 100%。
- 不能用已采样成功 Trace 直接计算精确成功率。

## 19. 迁移路线

### Phase 0：Spec 与契约（已完成）

- 冻结 Operation Registry、Schema、隐私和性能预算。
- 增加 Golden Schema/Privacy Tests。

### Phase 1：旁路接入（代码已完成，待 ARMS 灰度）

- 新增 TelemetryRuntime 和 ModelApiTelemetry。
- 从现有 Model Status/Usage 旁路采集。
- 保持 RUM `plan_request`、SQLite、`/event/report` 不变。
- ARMS OTel 使用独立 Service。

### Phase 2：双写对账

对比：

- Started/Terminal/Attempt 数量。
- Provider/Model/Transport。
- Completed/Error/Cancelled。
- Duration/TTFT。
- Token/Cache。
- Retry/Fallback。

按 1% -> 10% -> 100% 灰度，观察 Exporter Drop、CPU、RSS、网络和账单。

### Phase 3：统一事实生产

- SQLite `model_usage` 改由统一 Model Call Terminal Fact 驱动。
- RUM `plan_request` 改为兼容 Exporter，或停止上报。
- UI retry/debug 继续消费安全投影，不依赖 ARMS。

### Phase 4：移除重复链路

- 对账稳定并确认旧看板迁移后，停止 Renderer 重新生产 `plan_request`。
- 保留 `plan_ttft`、UI Perf、业务 `/event/report` 和本地日志。
- 评估 Tool/RPC 等领域是否复用通用 TelemetryRuntime，但不强行共用 Model Schema。

## 20. 失败和降级状态矩阵

| 场景                      | Agent 行为          | Telemetry 行为                                |
| ------------------------- | ------------------- | --------------------------------------------- |
| 未配置 OTLP               | 正常运行            | No-op；SQLite 保持                            |
| ARMS 网络超时             | 正常运行            | 每个 Flush 周期至多一次失败请求，失败批次丢弃 |
| Queue 满                  | 正常运行            | 丢弃新/旧记录按实现策略，增加 Drop Counter    |
| Endpoint 清洗失败         | 正常运行            | 保留 Provider Kind/ID，Endpoint 字段缺失      |
| Thought 反查失败          | 正常运行            | Effective=`unknown`                           |
| Provider Usage 缺失       | 正常运行            | Token 可缺失，Cache=`unknown`                 |
| UID 缺失                  | 正常运行            | Identity=`anonymous/unavailable`              |
| Span/Record 收口失败      | 正常运行            | 限频本地日志，不抛到调用方                    |
| CLI 异常退出              | 进程退出            | 只做有界 Flush，不阻止退出                    |
| Remote 无法获得 OTLP 配置 | 远端 Agent 正常运行 | No-op/本地 Usage，不回传 Main 代发            |

Phase 1 没有新增 ARMS “表”：`zcode.model.call` 与 `zcode.model.attempt` 是同一 `service.name=zcode-cli-agent` 下的两类 Span，流量、成功率、耗时分位、Token/Cache 都从 Span 属性聚合。需要固定宽表时才在 SLS 侧创建派生 Logstore/定时 SQL，不改变 CLI Schema。

## 21. 维度与剪枝

### 21.1 主要领域

| 领域                       | 是否纳入 | 原因                                               |
| -------------------------- | -------- | -------------------------------------------------- |
| Model/Provider Runtime     | 是       | 模型、Thought、Transport、Retry 的事实源           |
| Monitoring/Telemetry/Usage | 是       | ARMS、SQLite、RUM、`/report` 的边界                |
| Architecture/Process       | 是       | App 注入、CLI 自初始化、Remote 边界                |
| Persistence                | 代表覆盖 | P0 不迁表，只验证现有 SQLite 不回归                |
| Conversation/UI            | 代表覆盖 | 只验证安全投影和现有事件不破坏，不展开全部状态组合 |

### 21.2 关键维度

| 维度            | 值                                                       |
| --------------- | -------------------------------------------------------- |
| Operation       | `agent.*` / `context.*` / `sidecar.*` / `tool.*`         |
| Actor           | main / subagent / workflow / system / tool               |
| Transport       | HTTP / SSE / WebSocket                                   |
| Outcome         | completed / error / cancelled                            |
| Attempt         | initial / retry / recovery / fallback                    |
| Cache           | hit / write / miss / unknown                             |
| Thought         | disabled / toggle / effort / budget / adaptive / unknown |
| Surface         | Desktop / Standalone / Remote / Automation               |
| Telemetry State | enabled / disabled / exporter down / queue full          |

### 21.3 剪枝原则

- 不做 Operation × 所有 Provider × 所有 Model 的全笛卡尔积；按 Provider 协议族和 Thought 控制类型选代表。
- 不做所有 Session/Turn ID 值组合；只验证存在、关联和高基数不进入 Metrics。
- 不逐 Streaming Chunk 枚举；只覆盖首内容、Stall、自然结束、前置失败和已提交后失败。
- UI `desktop-continuous` 与 `web-remote-replayable` 不共享真实网络上报语义；CLI 自身模型请求事实独立于 UI replay。
- Endpoint Path 只覆盖明显敏感模式与普通稳定 Path，不建立复杂租户模板矩阵。

## 22. 验证清单

### 22.1 单元测试

- Operation Registry 和 Query Source 映射。
- Endpoint 清洗：userinfo/query/fragment、邮箱、UUID、长数字、Hash、普通 Path 保留。
- Endpoint Cache 命中、上限和版本。
- Requested/Effective Thought：OpenAI、OpenAI-compatible、Anthropic Fixed/Adaptive、GLM Toggle、DeepSeek/Kimi、Sidecar Disabled。
- Error Code、Provider Code、HTTP Status、Message 脱敏和截断。
- Cache `hit/write/miss/unknown`。
- Metrics Label Allowlist。
- Queue 上限、Drop、限频日志、Flush Timeout。

### 22.2 Adapter 测试

- Generate Success/Error/Cancel/Retry。
- Stream Success、TTFT、Usage、Stall、Consumer Close。
- 每个 Physical Attempt 使用新 Request ID。
- Request Sink 和 Global Telemetry Sink 同时收到事件且不重复。
- Exporter 失败不影响模型结果。

### 22.3 Operation 测试

- Main/Subagent/Workflow Child 使用同一个 `agent.step`，Actor 不同。
- Compaction SSE 成功。
- Compaction 首内容前失败后 HTTP Fallback。
- Compaction 已提交内容后失败且不 Fallback。
- Goal Verifier 模型失败与 Fail-open Operation 结果分离。
- Title/Git Commit 的 Effective Thought Disabled。
- WebSearch/WebFetch/ReadSessionContext 全部产生 Call/Attempt Facts。

### 22.4 集成测试

- Fake OTLP Collector 接收批量 Span。
- App 注入与 Standalone 初始化只能启用一个 Exporter。
- Disabled 时不加载 Worker、不发网络。
- ARMS Down、Timeout、429、Queue Full 时 Agent 正常完成。
- App RUM `plan_request` 与 OTel 双写数量对账。
- SQLite Usage 结果不回归。
- 本地/SSH/WSL/Docker 的配置和身份边界。
- Windows/macOS/Linux 的 URL、Shutdown、Signal 行为。
- Desktop Agent 必须在不存在 `apps/zcode-cli/packages/telemetry/dist` 的干净环境中完成
  `prepare:desktop-runtime`；普通 pnpm 构建和 `bootstrap:with-remote` 直跑 tsc 构建必须共享
  `scripts/build-desktop-agent-cli.mjs` 中同一份 `cliWorkspaceBuilds` 依赖清单，顺序保持
  `@zcode/contracts -> @zcode/telemetry -> @zcode/bootstrap`。禁止依赖开发机残留的 dist。

### 22.5 性能测试

- 10 calls/s 成功路径 CPU/RSS。
- 高 Retry/Error 风暴。
- 30 分钟 Exporter Down。
- 1000 个活跃/悬挂 Handle 清理。
- CLI disabled/enabled 启动耗时和包体。
- 真实 OTLP Batch 大小、压缩率和日流量估算。

### 22.6 Phase 1 本地验证结果

2026-07-22 使用 Node.js 24.14.0 验证：

- `@zcode/telemetry`：6 files / 21 tests 通过，包含 Call/Attempt 父子 Span、真实本地 Fake OTLP Collector、gzip protobuf、队列、锁、错误脱敏和 Endpoint 清洗。
- `@zcode/adapters`：55 files / 775 tests 通过，2 skipped；包含 Provider Thought 映射、request/global sink fan-out 与完整 runner 回归。
- `@zcode/contracts`：22 files / 179 tests 通过；Operation Registry 和 Schema 测试通过。
- Core 本次相关 Compaction/Streaming：2 files / 104 tests 通过。
- Bootstrap Workflow/Model Catalog：3 files / 10 tests 通过。
- Shared/Services/Desktop 配置注入：3 files / 29 tests 通过。
- 根仓库 `pnpm typecheck` 通过；`pnpm lint` 0 error（52 个既有 warning）。
- CLI CJS 和 darwin-arm64 SEA 构建/启动 smoke test 通过。

Core 全量当前仍有 8 个与本功能无关的仓库基线失败，包含硬编码的外部本机路径、既有
I/O/模块行数边界、Subagent/WebFetch/Workflow 断言以及三个持久化/时序断言；本次相关的定向用例均通过。

## 23. Accepted Cases

| Case ID       | Setup                                        | Action                              | Assertions                                                                          | Evidence                           |
| ------------- | -------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| MODEL-OBS-001 | Standalone，OTLP enabled                     | Main Agent 完成一次模型调用         | 1 Call + 1 Attempt；Provider/Model/Thought/Token/ID 完整                            | Fake Collector + Memory Sink       |
| MODEL-OBS-002 | Adapter Retry 一次                           | 首次 429，第二次成功                | Logical completed；Attempt error+success；recovered=true                            | Span + Error Fields                |
| MODEL-OBS-003 | Compaction SSE 失败                          | 首内容前失败并 HTTP Fallback        | 同 Operation 下两个 Calls；最终 Operation committed                                 | Span + Runtime Event               |
| MODEL-OBS-004 | Stream 已有内容                              | 中途连接失败                        | `stream_output_committed=true`，不错误重放                                          | Span + Provider Fixture            |
| MODEL-OBS-005 | Goal Verifier                                | 模型失败且 Fail-open                | Call error；Operation fail_open                                                     | Span + Runtime Result              |
| MODEL-OBS-006 | Sidecar Title                                | Session Thought=high                | Requested=high，Effective=disabled                                                  | Span + Final Provider Options      |
| MODEL-OBS-007 | Exporter Down                                | 模型正常返回                        | 业务成功，Queue 有界，Exporter Failure 增长                                         | Result + Health Metrics            |
| MODEL-OBS-008 | App-launched                                 | Host 注入配置和身份                 | CLI OTel 生效，RUM 仍工作，无双 Exporter                                            | Process Env + Collector + RUM Ring |
| MODEL-OBS-009 | Standalone 无账号                            | 发起模型调用                        | UID 空、Identity anonymous、Device MID 存在                                         | Span                               |
| MODEL-OBS-010 | 敏感 Base URL                                | URL 含 userinfo/query/email/hash    | ARMS 仅见清洗 origin/route，无秘密                                                  | Privacy Test                       |
| MODEL-OBS-011 | WebFetch/ReadSessionContext                  | 工具内部调用模型                    | Operation 路径正确且不漏 Call                                                       | Span + Tool Result                 |
| MODEL-OBS-012 | Queue Full                                   | 持续产生 Terminal Records           | Agent 不阻塞，Drop Counter 增长，内存有界                                           | Benchmark + Health Metrics         |
| MODEL-OBS-013 | App 启动且 OTLP enabled，尚无 active session | Host 预热调用 `workspace/readState` | state-only adapter 接受 telemetry sink 注入且不创建模型请求；workspace 状态正常返回 | Protocol Test + Desktop Runtime    |
| MODEL-OBS-014 | 干净 checkout，无 telemetry dist             | 构建 Desktop Agent runtime          | 两种构建模式均先产出 telemetry，再编译 bootstrap；桌面 bundle 成功生成              | Script Contract + Clean Build      |

## 24. 未决项

| 项目                    | 默认决策                                                      | 实施前动作                                                                    |
| ----------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `rid` 后端精确定义      | 按 Physical `request_id` 映射                                 | 与 ARMS/数仓字段负责人确认；若实际是 Run/Resource ID，改用明确 Canonical 字段 |
| 原始 UID 是否进入 ARMS  | 已决：永不进入；只上传 SHA-256 `user_id_hash/uid`             | 若未来要改，必须重新做隐私评审                                                |
| OTel Metrics Endpoint   | Phase 1 用全量 Terminal Span 在 ARMS 聚合；独立 Metrics 为 P1 | 在目标 ARMS Workspace 验证 OTLP Metrics/Prometheus 接入和权限                 |
| `plan_request` 兼容期限 | 一个完整灰度/对账周期后停止                                   | 确认旧 Dashboard Owner 和迁移完成标准                                         |
| OTel SDK 包体预算       | 已测：CJS `+5.82%`，darwin-arm64 SEA `+0.62%`                 | 灰度继续观察启动/RSS，必要时再优化                                            |

## 25. 实现入口索引

- Telemetry Contract：`apps/zcode-cli/packages/contracts/src/telemetry/index.ts`
- Runtime/Recorder：`apps/zcode-cli/packages/telemetry/src/runtime.ts`、`model-api-recorder.ts`
- OTLP Bootstrap/Exporter：`apps/zcode-cli/packages/telemetry/src/bootstrap.ts`、`lazy-otlp-exporter.ts`、`otlp-exporter.ts`
- Endpoint 清洗：`apps/zcode-cli/packages/telemetry/src/provider-endpoint.ts`
- Model Adapter：`apps/zcode-cli/packages/adapters/src/model/runner.ts`
- Attempt Status：`apps/zcode-cli/packages/adapters/src/model/runner-status.ts`
- Generate：`apps/zcode-cli/packages/adapters/src/model/runner-generate.ts`
- Stream：`apps/zcode-cli/packages/adapters/src/model/runner-stream.ts`
- Failure Classifier：`apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
- Thought Catalog：`apps/zcode-cli/packages/contracts/src/model/catalog.ts`
- Thought Policies：`apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`
- Runtime Thought Mapping：`apps/zcode-cli/packages/adapters/src/model/runtime-thought-level.ts`（Bootstrap 保留兼容 re-export）
- App/Standalone Bootstrap：`apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
- Local Usage：`apps/zcode-cli/packages/core/src/runtime/methods/usage-observability.ts`
- SQLite Usage：`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`
- App ARMS：`packages/desktop/src/main/appARMSBootstrap.ts`
- RUM Plan Usage：`packages/ui/src/lib/planUsageArmsTelemetry.ts`
- Host Spawn：`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- Host OTLP 身份注入：`packages/services/src/zcode-agent/agentTelemetryEnv.ts`
- Business Telemetry：`packages/services/src/telemetry/telemetryCore.ts`

## 26. 关联文档

- [性能埋点事件字典](../../monitoring/performance-telemetry-catalog.md)
- [性能监控](../../monitoring/performance-monitoring.md)
- [Plan Usage ARMS 自定义事件](../../monitoring/plan-usage-arms-telemetry.md)
- [ARMS Electron 监控](../../monitoring/arms-browser-monitoring.md)
- [V4 对话埋点兼容规范](../../monitoring/conversation-telemetry-v4.md)
- [CLI Usage Observability](../../../apps/zcode-cli/docs/design/v2/usage-observability.md)
- [模型实现设计](../../../apps/zcode-cli/docs/design/v2/model/README.md)
- [ARMS OpenTelemetry Node.js 接入](https://help.aliyun.com/zh/opentelemetry/user-guide/use-managed-service-for-opentelemetry-to-submit-the-trace-data-of-a-node-js-application)
- [ARMS 可观测数据存储](https://help.aliyun.com/zh/opentelemetry/developer-reference/arms-observable-data-storage-overview)
