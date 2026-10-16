# Runtime、隐私、性能与 ARMS 参考

> 本文定义 CLI Agent Telemetry Runtime 的生命周期、传播、隐私、性能、测试和 ARMS 运维约束。
> 整体设计与接入方式见 [CLI Agent Telemetry 设计与开发规范](../cli-agent-telemetry.md)；字段定义见
> [Schema 字典](./schema-reference.md)。

## 1. 进程级 Runtime

### 1.1 唯一 Owner

每个 CLI 进程只有一个 `AgentTelemetryRuntimeOwner`：

```text
AgentTelemetryRuntimeOwner
|
+-- AsyncLocalStorageContextManager
+-- BasicTracerProvider
|   +-- ParentBasedSampler(TraceIdRatioBasedSampler=10%)
|   +-- BatchSpanProcessor
|   `-- OTLPTraceExporter
+-- MeterProvider
|   +-- PeriodicMetricReader
|   `-- OTLPMetricExporter
+-- AgentExecutionTelemetryRuntime
+-- ModelApiTelemetryStatusSink
`-- many lightweight Writers shared by Sessions
```

Session 借用 Owner 的 `agentExecution/modelExecution/statusSink`，不创建独立 Provider、Exporter、
队列或 Timer。Session 关闭时：

```text
abandonSession(sessionId)
    +-- 该 Session 未结束 Writer -> abandoned(session_shutdown)
    `-- 清理 Model Status Sink 索引

flush(timeout=1.5s)
    `-- 尽力刷新共享 Owner，不关闭它
```

只有最外层进程入口在 CLI/TUI/Protocol Agent 退出时调用 `shutdown()`。Shutdown 先停止状态记录，
再把剩余 Writer 收口为 `abandoned(process_shutdown)`，然后有界关闭 Trace 和 Metric Provider。

### 1.2 注入与自初始化

两种入口最终使用同一个 Owner 契约：

```text
Desktop/Host
    `-- 注入 OTLP 配置、版本、运行面、安装 ID、身份更新

Standalone CLI
    `-- 从受控环境读取同样的 OTLP 配置

                    v
prepareModelTelemetryEnv()  异步准备
                    v
createOwnedAgentTelemetryRuntime()
```

`createModelTelemetry({ owner })` 的显式 Owner 优先于进程已准备的 Owner；Endpoint 配置不能覆盖
调用方注入实例。一个 Session 只能借用，不得替换进程级 Owner。

常用配置：

```text
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
OTEL_EXPORTER_OTLP_ENDPOINT
OTEL_EXPORTER_OTLP_TRACES_HEADERS
OTEL_EXPORTER_OTLP_HEADERS
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
OTEL_EXPORTER_OTLP_METRICS_HEADERS
OTEL_SERVICE_NAME
ZCODE_MODEL_TELEMETRY_ENABLED
ZCODE_TELEMETRY_DEVICE_MID
ZCODE_TELEMETRY_USER_SUBJECT_ID
ZCODE_TELEMETRY_IDENTITY_STATE
ZCODE_TELEMETRY_RUNTIME_SURFACE
ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION
ZCODE_APP_VERSION
ZCODE_BUILD_COMMIT_ID
```

若只配置公共 `OTEL_EXPORTER_OTLP_ENDPOINT`，Trace 自动追加 `/v1/traces`，Metric 自动追加
`/v1/metrics`。若只提供 ARMS Trace 专用 URL，当前实现允许 Metric 沿用同一 URL，因为 ARMS 的
自定义 OTLP HTTP 接入点支持三类信号共用地址。

Header 是运行时 Secret，只进入 Exporter 配置，不进入 Resource、Span、Metric 或日志。

### 1.3 Disabled 路径

没有合法 Trace Endpoint，或 `ZCODE_MODEL_TELEMETRY_ENABLED` 为
`0/false/off/disabled` 时：

- 不动态 import OTel SDK/Exporter；
- 不创建 Provider、队列、Timer 或网络请求；
- 返回共享 No-op Writer；
- No-op `run()` 直接且只执行一次业务回调；
- `--help`、版本查询和无 Agent 工作路径不承担 SDK 初始化成本。

### 1.4 安装 ID 与身份更新

Standalone 安装 ID 保存于：

```text
$ZCODE_HOME/v2/telemetry-state.json
或 ~/.zcode/v2/telemetry-state.json
```

创建使用异步文件 I/O、临时文件原子 Rename、跨进程锁和 5 分钟 Stale Lock 回收。另一个活跃
进程正在更新时不等待，本次可以省略匿名关联；任何读写失败都不阻塞 CLI。

身份快照可在登录、登出和账号切换时通过 `updateIdentity()` 更新。每个新 Turn 创建时读取一次
当前快照；已经存在的 Span 不回写，保证一次执行内部身份稳定。

## 2. Context、拓扑与多执行面

### 2.1 进程内 Context

`BaseSpanWriter.run()` 使用 OTel `context.with()` 激活当前 Span：

```text
parent.run(async () => {
    child = startChild()       // 自动从 active context 找 Parent
    return child.run(...)
})
```

Runtime 不维护第二套“当前 Span”AsyncLocalStorage。私有 `ActiveWriterContext` 与 OTel Span 放在
同一个 Context 中，包含 correlation snapshot、Parent Writer 和 Tool Call ID。

### 2.2 Causation 模式

`AgentTurnTraceStart` 支持：

```text
causationMode=child
    从保存的 SpanContext 重建 Parent Context
    Child 与 Parent 共享 traceId

causationMode=linked_root（默认）
    从 ROOT_CONTEXT 创建新 Trace
    Link 到保存的 SpanContext
```

`DetachedOperationTraceStart` 根据 `executionKind` 决定：Foreground 使用 Child；Queued 和
Background 使用 Root + Link。Recovery Link 使用 `resumed_from`，其他独立操作使用
`triggered_by`。

显式 Causation 重建必须以 `ROOT_CONTEXT` 为基础，不得继承执行阶段的临时 Baggage、Active
Span 或私有 Writer State。

### 2.3 Subagent 与 Workflow

```text
前台 Subagent（父 Tool await）
parent tool
    `-- child agent_turn
          `-- child 自己的 step/call/attempt/tool

后台 Subagent
parent tool --Link(spawned_by)--> child agent_turn root

Workflow / Script Workflow Child
trigger --Link(spawned_by)--> child agent_turn root
```

Child Runtime 接收同一个 `AgentExecutionTelemetryPort` 和捕获的 Causation，因此内部所有 Step、
Tool、Call、Attempt 都会正常分 Span，而不是只留下一个 Subagent 黑盒。

Actor Kind 从 `SessionTaskType` 归一化：

```text
subagent_child                         -> subagent
workflow_child / nested_workflow_child -> workflow_child
其他                                   -> main
```

### 2.4 Turn 外操作

`detached_operation` 覆盖标题、Goal、Project Memory、Workspace 文本生成和其他 Turn 外工作。
这些操作如果调用模型，必须在它的 `scope.run()` 中执行，使 Model Call 自动成为 Child。

Project Memory Recall 在调度/预取时捕获 Causation；Dream、Extraction、Title 等同理。完整 Operation
枚举见 [Schema 字典](./schema-reference.md#101-operation-目录)。

### 2.5 多端 Live Fact

```text
desktop-continuous 真实执行 --------------------> 创建 Span
web-remote-replayable 触发 shared host 真实执行 ---> 创建同一个 CLI Span
snapshot / hydration / UI replay --------------> 不创建 Span
```

Trace 记录 Agent Runtime 的真实执行，不记录 Renderer 回放。手机 `/remote` 使用 shared-host
attachment 时，数据仍由承载真实 CLI Runtime 的 Host 上报；不能在 Relay、Main 或恢复 UI 中补报，
否则会重复计数。

当前 `AgentTelemetryCausation` 是 CLI 内部严格类型，不等价于 Desktop/RUM 到 Agent 的完整 W3C
跨进程传播。未来打通时必须修改 `@zcode/protocol` 严格 Schema 并补拓扑测试。

## 3. Writer 与终态保证

### 3.1 直接 Setter 模型

Writer 不使用运行时 Schema Registry，也不要求业务把结果重新封装成 Telemetry DTO：

```text
业务事实发生
    -> 具体 Writer Setter
         +-- 归一化/脱敏
         +-- 写 Canonical zcode.*
         +-- 必要时写 Event
         +-- 必要时记 Metric
         `-- 必要时投影 Compatibility Alias
```

Contracts 提供编译期接口；Runtime 中显式 Key 让实现和查询一眼可见；Schema 字典解释代码无法
表达的语义。

### 3.2 `run()` 的 exactly-once 行为

`run<T>(() => T): T` 同时支持同步值和 Promise：

```text
进入 context.with
    |
    +-- 业务同步抛错
    |      -> 未终态则 finishUnhandled -> 重新抛出原错误
    |
    +-- 返回 Promise
    |      +-- resolve：未显式终态 -> abandoned(missing_terminal)
    |      `-- reject：未终态 -> finishUnhandled -> 重新 reject
    |
    `-- 返回普通值
           -> 未显式终态 -> abandoned(missing_terminal)
```

Context Manager 理论上不应在业务回调外抛错，但 Runtime 仍防御三种情况：

1. 激活前失败：记录受控 Warning，在 Context 外执行业务一次；
2. 业务已经返回后 Context teardown 失败：保留业务返回，不重跑；
3. 业务自身失败：收口 Span 后原样抛出。

内部 `entered/businessReturned/businessValue/businessError` 闩锁保证业务回调不会因 Telemetry 异常
执行两次。

### 3.3 Terminal Latch

所有终态方法共享一次性 Latch：

```text
claimTerminal()
    先 ended=true
    再写 outcome / status / metric / span.end()
```

即使 SDK、Adapter、Metric 或 `span.end()` 抛错，Latch 也不会重新打开。后续终态调用是 No-op。
Session/Process 回收与正常终态并发发生时，仅首个终态操作生效。

### 3.4 Error 认领

同一 Error 对象及其最多 8 层 `cause` 链使用 `WeakSet` 认领：

```text
ProviderError 在 model_attempt 首次记录正文
    -> AdapterError(cause=ProviderError) 冒泡到 model_call
         -> call 记录 failed/category/stage，不再复制正文
             -> step/turn 同理
```

原始对象不被长期持有；WeakSet 不延长生命周期。非对象错误无法认领时，在当前最近 Span 做受控
转换。该保证依赖上层继续传递同一个 Error 或 `cause` 链；如果某个 Producer 为每一层重新创建
无因果关系的 Error 对象，Runtime 无法识别它们是同一来源，因此 Producer 禁止这样做。

## 4. Model Status 到 Trace

模型 API 封装层通过统一 Status Event 提供真实请求事实，`ModelApiTelemetryStatusSink` 管理：

```text
logical_call_started
    -> startCall(logicalCallId, operation, requested target)

attempt_started
    -> call.startAttempt(requestId, actual target, transport, cause)

headers / stream / usage / error status
    -> attempt 的具体 Setter / marker

attempt_terminal
    -> attempt.finish*

logical_call_terminal
    -> call.finish*
```

它维护最多 1000 个活跃 Model Call。状态事件入口至多每分钟惰性清理一次；30 分钟无活动的 Call
和 Attempt 以 `missing_terminal` 收口。这个 TTL 只属于状态索引，不是通用 Span TTL；合法长
Turn/Command 不会因为持续时间长被自动结束。

模型入口的 `operation` 优先使用调用点显式 Observation；旧 `querySource` 只作为兼容映射。未知
Query Source 回退到 `tool_internal_model_call`，不会生成自由文本 Operation。

## 5. Compatibility Adapter

Adapter 只接受已经归一化、清洗后的事实：

```text
Provider Adapter / Writer Setter
        |
        +-- Canonical zcode.*
        |
        `-- compatibility-adapters.ts
              +-- gen_ai.*
              +-- http.response.*
              +-- server.*
              +-- process.*
              `-- error.*
```

业务调用点不感知 GenAI 或 ARMS 字段。外部约定变化时，修改 Adapter 和 exact mapping 测试；
Canonical 仍保持内部语义完整。不能从兼容字段反向重建 Canonical，因为转换可能丢失信息。

## 6. 隐私与脱敏

### 6.1 数据分类

| 类别           | 例子                                               | 策略                               |
| -------------- | -------------------------------------------------- | ---------------------------------- |
| 低风险运行事实 | Outcome、Token、HTTP Status、Provider Kind         | 受类型/基数限制后记录              |
| 假名关联标识   | Installation、User Subject、Session、Turn、Request | 只进入 Trace，受访问和保留策略约束 |
| 受控自由文本   | Model、Provider Error、Safe Name                   | 清洗、截断、测试                   |
| 高隐私内容     | Prompt、正文、文件、命令、Header、Body             | 禁止采集                           |

安装 ID 是随机、持久化的产品假名；不是 MAC、硬盘序列号等硬件标识。User Subject ID 当前不在
CLI 再 Hash，Host 必须只提供允许进入 Telemetry 的稳定主体 ID。二者都可能用于关联用户行为，
不能称为匿名数据。

### 6.2 Provider Endpoint

输入 Base URL 后：

```text
长度 > 4096                              -> 省略
非 http/https 或 URL 解析失败             -> 省略
username/password                         -> 删除
query/fragment                            -> 删除
hostname                                  -> 小写
默认 80/443 port                          -> 规范化删除
path segment 为 email/uuid/长数字/长 hex/token -> 占位符
普通 segment                              -> 最多 128 字符
route                                     -> 最多 1024 字符
```

输出：

```text
provider_origin = scheme://host[:port]
provider_route  = sanitized pathname
```

不要求用户配置安全模板。`ProviderEndpointIdentityCache` 按 `(providerKind, baseURL)` 缓存最多
256 项，避免每次请求重复 URL 解析和正则清洗。

### 6.3 Error Message

Error 处理遵循“尽量保留原始诊断信息，但去掉高风险内容”：

1. 输入先截到 4096 字符，限制恶意 Provider 消息的 CPU/内存成本；
2. URL 移除 Query/凭据并清洗动态 Segment；
3. 清除 Authorization、API Key、Token、Password、Secret、Cookie、Session 等键值；
4. 清除 Bearer/Basic、常见 `sk-*`、GitHub Token、AWS Key、Google Key；
5. 替换邮箱、用户本地路径、Temp 路径和 Windows 绝对路径；
6. 去控制字符、折叠空白；
7. 最终截到 2048 字符。

`provider_error_message` 和 Lifecycle `error_message` 都使用这一 Sanitizer。错误码只做控制字符清理
和 128 字符截断，不按人为模板重分类。

### 6.4 Tool 与 Command

允许：Registry Tool Name、命令类别、Shell Kind、受控 Safe Name、Exit Code、Signal、Timeout、
Output Bytes、Truncated。

禁止：Tool 参数、Tool 输出正文、完整命令、脚本、参数、路径、cwd、环境变量。Safe Name 只能从
命令 Registry/Allowlist 生成，不能把命令文本简单截断后当作“安全”。

### 6.5 访问与保留

代码脱敏不是全部隐私控制。ARMS Workspace 仍需要最小权限、查询审计和合理保留期；包含用户或
安装假名 ID 的导出结果不能随意分享。OTLP Header/License Key 不得进入截图、文档示例或 Git。

## 7. 性能、容量与可靠性

### 7.1 当前实现默认值

| 项目                        | 当前值/行为                            |
| --------------------------- | -------------------------------------- |
| Active Writer 上限          | 每进程 5000                            |
| Model Status 活跃 Call 上限 | 1000                                   |
| Model Status 惰性回收       | 30 分钟无活动；至多每分钟 Sweep 一次   |
| BSP Queue                   | 2000 Span                              |
| Export Batch                | 100 Span                               |
| Batch Delay                 | 5 秒                                   |
| Export Timeout              | 3 秒                                   |
| Session Flush               | 默认 1.5 秒                            |
| Process Shutdown            | 默认 1.5 秒                            |
| Metric Export Interval      | 5 分钟；进程退出时仍 best-effort flush |
| Metric Series 上限          | 每 View 250                            |
| Trace Head Sampling         | Root 10%；子 Span 继承父 Span 决策     |
| Histogram Min/Max           | 不记录；保留 Count、Sum 与精简 Bucket  |
| OTLP 压缩                   | Gzip                                   |

### 7.2 热路径

- Writer 创建和 Setter 只处理小型已知输入；
- 没有同步文件或网络 I/O；
- 不遍历 Prompt、Messages、Header、Body 或任意大对象；
- Endpoint 清洗有界缓存；
- 错误正则前先截断；
- Streaming 只记录 First、Stall Count 和 Max Idle，不逐 Chunk 创建 Event；
- Token Metric 使用累计值的单调 Delta，避免重复上报；
- Trace 由 BSP 异步导出，业务不等待每个 Span 上报。

### 7.3 容量和降级

达到 Active Writer 上限时：

```text
拒绝创建新 Span
    -> 返回共享 No-op Writer
    -> zcode.telemetry.creation_drop.count += 1
    -> onWarning（容量恢复前只报告一次活跃告警）
    -> 业务继续执行
```

Runtime 目前远端可观测的 Health Metric 只有 `creation_drop` 和 `abandoned`。BSP Queue Drop、
Exporter Failure、Shutdown Timeout 的专属 Metric 尚未实现，Dashboard 不应假定它们存在。完全
断链时远端 Metric 本身也无法送达，仍需“服务数据消失”类告警或 Collector 外部健康检查。

### 7.4 Sampling

当前 CLI 直连 ARMS，Root Trace 使用
`ParentBasedSampler(TraceIdRatioBasedSampler(0.10))` 做确定性的 10% Head Sampling；同一条
Trace 的子 Span 必须继承父 Span 决策，禁止按 Span 独立抽样形成残缺树。Metric 不跟随 Trace
采样，准确流量、成功率、Token 和延迟分位数继续由全量 Metric 提供。

客户端 Head Sampling 在 Span 开始时决策，无法知道最终是否失败或变慢。因此当前阶段接受错误
Trace 也按 10% 抽样的成本/诊断取舍，不能声称失败、慢请求已 100% 保留。若后续引入 Collector
Tail Sampling，应把客户端恢复为 AlwaysOn，再由 Collector 按完整 Trace 终态执行：

- failed、abandoned、慢 Trace 和稀有 Operation 优先保留；
- 精确 QPS、成功率、Token 和分位数仍取 Metric；
- Root + Link 是两条独立 Trace，采样结果也独立；
- Collector 投产前必须验证容量、故障保留率和 Trace 树完整性，不能与客户端 10% Head
  Sampling 叠加。

### 7.5 Metric 降量口径

- `PeriodicExportingMetricReader` 的周期从 60 秒改为 5 分钟；DELTA temporality 不变，CLI
  正常 shutdown 仍触发最后一次 best-effort flush，短生命周期进程不会因未满 5 分钟必然丢失。
- Histogram 关闭 `recordMinMax`，避免每个时序额外写入最小值和最大值；Count、Sum 和 Bucket
  仍保留。
- Duration/TTFT Histogram 使用不超过 10 个、覆盖既有 SLO 转折点的精简 Bucket；Attempts
  Histogram 保留 `1/2/3/5/8`。调整只降低观测分辨率和 ARMS 点数，不改变 Writer、模型调用、
  Tool 或 Session 的执行路径。

## 8. 测试与发布门禁

### 8.1 单元与行为测试

至少验证：

- 每个 Setter 的 Canonical Key、类型、枚举、单位；
- Compatibility Alias exact/convert/omit；
- Endpoint、Error、Tool、Command 隐私负向用例；
- exactly-once End、`missing_terminal`、Session/Process abandon；
- completed/failed/cancelled/denied/discarded/backgrounded 与 OTel Status；
- Telemetry 任意边界抛错时业务结果和执行次数不变；
- Unknown/Absent/False/0；
- First Event 去重、Token Delta、Metric Label Allowlist。

### 8.2 拓扑 Golden Test

Memory Exporter 验证：

```text
Turn -> Step -> Call -> Attempt
Turn -> Step -> Tool -> Command
Turn -> Compaction -> Call -> Attempt
Tool -> Call -> Attempt
Tool -> Foreground Child Agent Turn
Tool --Link--> Background Child Agent Turn Root
Trigger --Link--> Detached Operation Root
Retry = one Call + multiple Attempt
```

同时核对 traceId、parentSpanId、Link SpanContext、traceState、isRemote 和 Query Projection。

### 8.3 完整性与隐私

- 每个 Model Operation 至少一个调用入口测试；
- 每个真实 Provider Attempt 同时进入 OTel 和 SQLite `model_usage`；
- Read Session Context、Web Fetch、Project Memory、Title 等内部模型调用不能漏；
- Stream/Non-stream、Retry、Fallback、Cancellation、Compaction 全覆盖；
- Snapshot/Hydration/Replay 不补报；
- 恶意 Getter、循环对象、超长 Error、Secret、URL Query、文件路径、邮箱、完整命令不能出现在
  OTLP Payload。

### 8.4 构建与集成

- Disabled 验证 SDK、Timer、Network 为 0；
- Standalone CLI 与 Desktop Packaged Agent 发送真实 Canary；
- Packaged 构建缓存指纹包含 Endpoint/Header/Service Name 等构建输入；
- `service.version` 与 bundle 内 CLI 版本一致；
- `zcode.product.version` 与产品安装包版本一致；
- `zcode.build.commit_id` 能定位构建；
- 提交前执行相关测试、`pnpm typecheck` 和 `pnpm lint`。

主要现有测试：

```text
packages/telemetry/tests/agent-trace-runtime.test.ts
packages/telemetry/tests/model-api-recorder.test.ts
packages/telemetry/tests/agent-metrics.test.ts
packages/telemetry/tests/error-sanitizer.test.ts
packages/telemetry/tests/provider-endpoint.test.ts
packages/telemetry/tests/compatibility-adapters.test.ts
packages/telemetry/tests/otlp-integration.test.ts
packages/core/tests/runtime-agent-telemetry.test.ts
packages/core/tests/tool-agent-telemetry.test.ts
packages/bootstrap/tests/telemetry-bootstrap.test.ts
```

路径均相对于 `apps/zcode-cli/`。

## 9. ARMS 查询、大盘与统计口径

### 9.1 数据位置

OTLP Trace 进入 ARMS Trace 存储，OTLP Metric 进入指标存储，不需要新建业务“表”。需要建设的
对象是 Saved Query、Dashboard 和 Alert Rule。

```text
OTel 原生字段
    serviceName / spanName / traceId / duration / statusCode

Resource
    resources.service.version
    resources.zcode.product.version
    resources.zcode.build.commit_id
    resources.zcode.telemetry.schema_version
    resources.zcode.runtime.surface
    resources.zcode.device.installation_id

Span Attribute
    attributes.zcode.execution.turn_id
    attributes.zcode.<span_name>.outcome
    attributes.zcode.model_attempt.provider_origin
```

不同 ARMS 控制台版本可能使用可视化条件、SPL 或等价查询语法，字段语义不变。

### 9.2 Saved Query

公共条件：

```text
serviceName : zcode-cli-agent
and resources.zcode.telemetry.schema_version : 5
```

Turn：

```text
and spanName : agent_turn
```

失败 Attempt：

```text
and spanName : model_attempt
and attributes.zcode.model_attempt.outcome : failed
```

429：

```text
and spanName : model_attempt
and attributes.zcode.model_attempt.http_status_code : 429
```

按 Provider Error 信息排查：

```text
and spanName : model_attempt
and attributes.zcode.model_attempt.outcome : failed

聚合/展示：
attributes.zcode.model_attempt.provider_origin
attributes.zcode.model_attempt.provider_route
attributes.zcode.model_attempt.http_status_code
attributes.zcode.model_attempt.provider_error_code
attributes.zcode.model_attempt.provider_error_message
attributes.zcode.model_attempt.error_code
attributes.zcode.model_attempt.error_message
```

注意：Provider 没有返回结构化错误正文时，`provider_error_message` 可以为空；网络/DNS/Timeout
等错误通常在 Lifecycle `error_message`。查询排障时两列都展示，而不是用
`coalesce` 覆盖来源差异。

版本比较至少展示：

```text
resources.service.version
resources.zcode.product.version
resources.zcode.build.commit_id
resources.zcode.telemetry.schema_version
```

ARMS 若不支持语义版本字符串的 `>=`，不要按字典序比较 `3.10` 和 `3.9`。使用精确版本集合、
Build Commit/发布时间切分，或在数据进入前增加数值化版本维度并升级 Schema。

### 9.3 推荐 Dashboard

#### Agent 总览

- Turn 数、完成/失败/取消/Abandoned；
- P50/P95/P99；
- Actor Kind、Launch Surface、Runtime Surface；
- CLI Version、Product Version、Build Commit。

#### Model Call

- 逻辑成功率；
- Attempt/Call 放大率；
- Retry 恢复率；
- Operation、Model Role、Call Cause；
- 每 Call 的 Attempt 分布。

#### Model Attempt

- Provider Kind、Origin、Model、Transport、API Operation 流量；
- 物理成功率、P50/P95/P99；
- First Provider Event、TTFC、TTFT；
- HTTP Status、Provider Error Code、Failure Stage；
- Input/Output/Reasoning/Cache Read/Cache Write Token；
- Stream Stall Count 与 Max Idle。

#### Tool 与 Command

- Tool Name 流量、成功率、耗时；
- Permission Denied、Output Truncated；
- Command Category/Safe Name、非零 Exit Code、Timeout、First Output。

#### Telemetry Health

- Creation Drop；
- Abandoned 按 Span Name/Reason；
- 服务数据消失；
- 当前尚无专属 Export Failure/Queue Drop Metric，应明确标注缺口。

### 9.4 统计公式

各 Span 流量取对应 `*.duration` Histogram 的 Count，不再建立重复的 Request Counter。

默认业务成功率：

```text
completed / (completed + failed)
```

`cancelled`、`denied`、`discarded`、`backgrounded` 和 `abandoned` 单独展示，不能偷偷塞进失败分母。

Retry 恢复率：

```text
model_call.duration count where retry_state=recovered
/
model_call.duration count where retry_state in (recovered, not_recovered)
```

Attempt 放大率：

```text
sum(zcode.model.call.attempts) / count(zcode.model.call.attempts)
```

Cache 使用原始 Token：

```text
cache read token ratio =
sum(token where token_type=cache_read)
/
sum(token where token_type in (input, cache_read))
```

具体 Provider 的 Token 定义可能不同，Dashboard 必须保留 Provider/Model 筛选，不能把所有厂商的
Cache 语义无说明地合并成一个“命中率”。

准确流量、成功率、Token 和延迟分位数优先用 Metric；Trace 用于错误消息、Endpoint、ID 关联和
具体样本下钻。

## 10. 版本与 Schema 演进

```text
service.version                  CLI Telemetry 生产者版本
zcode.product.version            Desktop/产品版本
zcode.telemetry.schema_version   数据契约版本
zcode.build.commit_id            精确构建身份
```

破坏 Attribute Key/类型/单位、Outcome 含义、Parent/Link 拓扑或 Metric 统计分母时升级 Schema
Version。新增可选字段或兼容 Alias 通常不要求升级，但必须更新字段字典、Golden Test 和大盘。

历史设计和迁移方案只用于追溯，不能作为新报表或实现依据。
