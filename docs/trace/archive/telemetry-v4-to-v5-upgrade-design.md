# CLI Agent Telemetry V4 → V5 全面优化与升级设计

> 状态：V4 历史评审与 V5 升级设计
>
> 评审基线：2026-07-29 仓库实现
>
> 评审起点：Agent Trace V2；Model API Record V1；V4 已上线；本轮目标 Schema：`5`
>
> 范围：`apps/zcode-cli` 内部 Agent；[最终规范](../cli-agent-telemetry.md)

## 1. 目的

本文保留当前实现评审、问题根因、取舍和迁移计划，回答：

1. 当前 CLI Agent Trace 实际怎样运行；
2. 哪些可靠能力应保留；
3. 哪些能力重复实现了 OpenTelemetry；
4. Context、Link、Model Span、身份和版本为什么要调整；
5. 如何分阶段升级、验证和回滚。

最终 Span、Event、Attribute、Metric 和 Writer 契约以最终规范为准。

## 2. 一页结论

V4 奠定了完整 Trace 的基础；V5 继续移除父节点聚合事实、收紧原始错误归属并补全 Subagent
内部拓扑。两轮升级的共同核心不是重写 OTel，而是恢复正确分工：

```text
OpenTelemetry
  Resource / Context / Span / SpanContext
  Parent / Link / Event / Status
  ContextManager / BatchSpanProcessor / Exporter
                    │
                    ▼
ZCode 领域语义
  Turn / Step / Tool / Command
  Model Call / Model Attempt / Compaction
  zcode.* canonical attributes
  Typed Writer / 隐私清洗 / 查询投影
                    │
                    ▼
外部兼容 Adapter
  GenAI semantic conventions / ARMS aliases
```

目标变化：

- 一个 CLI 进程只有一个 Telemetry Runtime Owner；
- OTel Node Context Manager 是活动 Span 唯一真相；
- 业务执行 Context 不再伪装 OTel Trace Context；
- Parent、Link、传播使用原生 Context、SpanContext 和 W3C Propagator；
- Model Call/Attempt 在真实生命周期边界创建和结束；
- Trace 只保留 BatchSpanProcessor 一个队列；
- Event 表示瞬时里程碑，Span 表示持续工作，Attribute 表示事实/摘要；
- ZCode canonical 是内部分析真相，GenAI/ARMS 由 Adapter 派生；
- 身份按隐私类别治理，不把普通 SHA-256 称为匿名化；
- `service.version` 来自真实 CLI 构建，产品版本和 Schema 版本分别建模；
- 不兼容旧字段，按 Schema Version 原子切换报表。

## 3. Feature Impact Brief

### 3.1 目标行为

- Turn 向下可见 Step、Tool、Command、Model Call、Attempt、Compaction；
- Turn 外 LLM 调用也有明确 Root operation；
- 可按设备、用户、Session、Turn、模型、Provider、工具和操作检索；
- 可统计流量、成功率、取消率、耗时、TTFT、Token、Cache、Retry Recovery；
- App 可注入 ARMS，Standalone CLI 可初始化同一个 Runtime 工厂；
- Telemetry 故障不改变 Agent 结果；
- 默认不采 Prompt、文件内容、工具 I/O、原始 URL、Header、大段错误。

### 3.2 消费面

没有直接 UI 交互变更，消费面是：

- ARMS 调用链与 Trace Explorer；
- ARMS/Grafana 仪表盘与告警；
- 本地 Usage SQLite 对账；
- Telemetry health。

因此本次不新增 conversation UI case catalog。

### 3.3 State Owner

| 状态              | 当前                                | V4                       |
| ----------------- | ----------------------------------- | ------------------------ |
| Provider/Exporter | `OtlpTelemetryRecordExporter` 实例  | 进程级 Runtime Owner     |
| 活动 Agent Span   | `activeScopeStorage`                | OTel `context.active()`  |
| 执行 correlation  | 多份 execution context              | OTel Context 私有值      |
| Model 活动调用    | `ModelApiTelemetryStatusSink.calls` | Live Call/Attempt Writer |
| Record Queue      | `QueuedTelemetryRuntime.queue`      | 删除                     |
| SDK Queue         | `BatchSpanProcessor`                | 唯一 Trace Queue         |
| 本地 Usage        | SQLite                              | 保持独立事实源           |

### 3.4 不变量

1. Telemetry 永远旁路；
2. 每进程只有一个 Provider、Context Manager、Processor、Exporter；
3. Span 只终结一次；
4. 只记录 live execution，不从 hydration/recovery/remote replay 补造；
5. 不上传 Secret、Prompt、工具 I/O、文件内容；
6. 不向第三方模型 Provider 传播内部 Trace/Baggage；
7. 高基数 ID 可用于 Trace 查询，不得作为 Metric label；
8. Schema 与产品版本独立；
9. 关闭时不加载 OTel SDK；
10. 生产路径无同步文件/网络 I/O。

## 4. 当前实现事实

### 4.1 Agent Span 主链路

```text
RuntimeTelemetryFacade
  ├─ startTurn
  ├─ startStep
  ├─ startTool
  └─ startCompaction
         │
         ▼
AgentExecutionTelemetryRuntime
  └─ tracer.startSpan
       └─ BatchSpanProcessor
            └─ OTLP HTTP/protobuf -> ARMS
```

已具备且应保留：

- `scope.run()` 覆盖同步和 Promise；
- `end/fail/cancel` 一次性终态；
- 漏终态自动 `abandoned`；
- Tool success/denied/cancelled/failed 分离；
- 进程 Active Writer 和活动 Model Call 有界；
- shutdown 收口；
- warning 限流；
- 错误源事实清洗、截断和同一 cause 链去重；
- Tool/Command 仅在结构化失败时上传清洗后的短 message；
- Endpoint 解析缓存和脱敏；
- gzip、batch、timeout、有界队列；
- Desktop 注入与 Standalone 初始化。

旧的全局 idle TTL 属于迁移时移除项：它可能截断合法长 Turn/Command。V4 的
Turn/Step/Tool/Command 依靠正常 Terminal、Session/Process Shutdown 和 Owner Registry
收口；只有不经过 `run()` 的 Model Call/Attempt 使用 30 分钟无活动惰性回收，并有 1000
个活动 Call 的容量上限。

### 4.2 Model API 当前链路

```text
Model Adapter / Runner
  │ ModelNetworkStatusEvent
  ▼
ModelApiTelemetryStatusSink
  │ 归并 CallState / AttemptState
  ▼
ModelApiCallRecord / AttemptRecord
  ▼
QueuedTelemetryRuntime              # 第一层队列
  ▼
OtlpTelemetryRecordExporter
  │ 按 startedAt/endedAt 重建 Span
  ▼
BatchSpanProcessor                  # 第二层队列
  ▼
ARMS
```

当前已覆盖 Provider、Model、Transport、Reasoning、Token、Cache、TTFT、Retry、
Stream Recovery/Stall、Provider/HTTP Error。问题是它与 Agent Live Span 使用了不同生命周期。

### 4.3 当前 Context/Link/Resource

- `contracts/src/tracing/tracer.ts` 有业务 `TraceContext` 和一套 ALS；
- `telemetry/src/agent-trace-support.ts` 又有 `activeScopeStorage`；
- OTel Provider 未注册 Node 原生 Context Manager；
- `AgentTelemetryLink` 混合 SpanContext 与 session/turn/tool/operation；
- `spanContextFromLink()` 一律 `isRemote:true`，且丢 `traceState`；
- Resource 同时放了 service、runtime、device、user hash、`uid`；身份语义与作用域不清晰。

## 5. 主要问题与 V4 决策

### 5.1 P1：两套活动 Context

根因：

- Runtime Owner 没收敛；
- OTel Context Manager 没成为基础设施；
- 自建 ALS 承担 Parent、Link、correlation、聚合。

后果：

- `context.active()` 不可靠；
- 新入口容易忘记进入某套 ALS；
- Promise/Timer/EventEmitter 传播要重复验证；
- 业务 TraceContext 与 OTel SpanContext 概念竞争。

V4：

- 注册 `AsyncLocalStorageContextManager`；
- OTel Context 是活动 Span 唯一真相；
- correlation 使用私有 Context Key；
- 原业务 `TraceContext` 重命名为 execution/log correlation context；
- 业务 Context 不生成 OTel ID、不决定 Parent。

### 5.2 P1：Model Span 由终态 Record 重建

后果：

- 无法自然记录 Span Event；
- 崩溃只能靠 TTL 推断；
- Parent SpanContext 被压缩再恢复；
- 两层队列和两套 flush；
- Record 投影与 Agent Writer 容易漂移。

V4：

- logical call 开始时创建 `model_call`；
- physical request 开始时创建 `model_attempt` Child；
- network event 直接更新 Writer；
- retry 创建新 Attempt；
- terminal 直接结束；
- terminal 同时写 SQLite；
- 删除 Trace Record 重建与 Record Queue。

### 5.3 P1：Link 不是完整原生 SpanContext

正确规则：

- `isRemote=true` 仅用于从远端 carrier 提取的 Context；
- 同进程捕获保留原 `isRemote`；
- `traceState` 不得无理由丢失；
- Link 是 `{context: SpanContext, attributes?}`；
- session/turn/tool/operation 不属于 SpanContext。

V4：

- 同进程直接使用 `span.spanContext()`；
- 受信跨进程使用 W3C `traceparent/tracestate`；
- 使用 Propagator extract，不手拼远端 SpanContext；
- correlation 独立存储。

### 5.4 P1：Runtime Owner 可能重复

当前工厂同时接受 `runtime`、`agentExecution`，有 Endpoint 时还会自行创建。
若每 Session 初始化，会重复 Provider、Exporter、Queue、Timer。

固定优先级：

```text
显式注入完整 Runtime Owner
          │
          ├─ 有 -> 直接复用
          └─ 无 -> 进程启动配置创建一次
                         │
                         └─ 无配置 -> Noop Owner
```

Endpoint 不覆盖注入 Owner；所有 Session 引用同一 Owner。

### 5.5 P2：关闭时仍加载 SDK

`bootstrap.ts` 静态导入 Exporter，Exporter 静态导入 OTel SDK。

V4：

- Noop 判断先于 dynamic import；
- 仅确认启用后加载 SDK/Exporter/Context Manager；
- 进程级初始化 Promise 防并发重复加载；
- `--help`/无 Endpoint/显式关闭测试 SDK 不进入 module cache。

### 5.6 P2：没有真正使用 Span Event

当前自建 `Span.addEvent()` 是空实现；Agent Span 也未调用原生 Event。
Model stall/retry 只折叠成终态 Attribute，时间轴缺证据。

V4：

- 首 provider event、首 content、首 text、stall、fallback、permission state
  使用 typed Event；
- retry 本身是新 Attempt Span；
- 最终 TTFT、stall count/max idle 仍写 Attribute；
- 不记录每 chunk/token、request_sent、completed。

### 5.7 P2：用户身份放在 Resource

用户会登录、退出、切换，不满足 Resource 生命周期稳定性。

V4：

- Owner 持有动态 Identity Source；Desktop 登录、登出和账号切换通过受控更新通道刷新；
- 每个 Agent Turn Root（包括 Child Agent Turn）创建时只读取一次当前身份，形成不可变快照；
- Detached Root 默认不投影用户身份，只通过 Link/parent_turn_id 表达因果关系；
- Child Span 继承 Root 快照，不重复调用 Resolver，既有 Span 不回写；
- Resolver 抛错时省略用户标识并记录健康信号，不阻塞业务；
- 只对需独立检索的 Span做有限投影；
- `unknown`、空值等 sentinel 省略；
- device installation ID 经合规确认后可作为稳定 Resource；
- Metric 不带 user/device/session/turn。

### 5.8 P2：SHA-256 不等于匿名化

当前 Desktop/Standalone 可对 user ID 做无盐 SHA-256。它是确定性假名化：

- 低熵账号可字典反推；
- 无法轮换；
- 不降低基数；
- 不解除个人数据治理要求。

V4：

- 长期首选后端签发的 opaque telemetry subject；
- 当前 Desktop 在可信 Host 边界把账号标识转换成不可读的稳定
  `user_subject_id`，原始账号、邮箱和登录名不进入 Agent；
- 该 Subject 属于假名化个人数据，不宣称匿名，也不作为 Metric Label；
- 无合规标识时省略 user ID；
- device MID 是随机安装标识，不再 Hash；
- 随机 Session/Turn/Request/Tool ID 不重复 Hash。

### 5.9 P2：公共字段复制没有边界

ARMS 不保证任意祖先 Attribute 联表，因此部分投影必要；但不能复制一切。

V4：

- OTel 原生 trace/span/parent 不镜像成 `zcode.*`；
- Span 本地事实只写本地 canonical；
- 只投影独立检索必需 correlation；
- 投影需声明来源、目的、隐私等级、目标 Span；
- 高基数投影不进入 Metric。

### 5.10 P2：旧 V3 曾计划等待 Child 再结束 Parent

OTel 允许 Parent 先于 Child 结束。Telemetry 强制等待会污染 duration、增加引用计数，
并可能被 detached work 永久拖住。

V4：

- Parent 在自身业务完成时结束；
- 业务真正拥有的 Child 由业务 `await`；
- Telemetry 不额外等待；
- queued/background/fan-out work 使用新 Root + Link。

### 5.11 P3：Tool 与 Command 语义混用

Tool 包含 lookup/validation/permission/hook/execute/serialize；Command 描述子进程。
Read/Write 没有 process exit code，缺失值不能转成 `0`。

V4：

```text
tool
  ├─ command          # 仅命令执行工具
  └─ 其他持续内部工作
```

- Tool/Command 是父子 Span，不做运行中“替换类型”；
- Permission 首版使用 `permission_requested/permission_decided` Event；只有实际需要独立
  Duration/SLO 时，才经新增 Span 评审引入 `permission_wait`；
- exit code 只在 Command；
- 仅记录 executable category 与 allowlist subcommand；
- 不记录完整 command/args/cwd/env/stdout/stderr。

### 5.12 P3：版本来源被陈旧 dist 误导

2026-07-30：当前实现基线的仓库根产品版本为 `3.6.1`，CLI 构建版本为
`0.16.1`。`apps/zcode-cli/packages/cli/package.json` 的 `0.1.0` 只是 workspace 子包
元数据。仓库中存在 `v3.6.2` Tag，但它不是当前分支的版本真相；本机旧
`dist/zcode.cjs` 和 Desktop staging `bundled-agents/darwin-arm64/glm/zcode.cjs`
也不能作为版本真相。

旧 dist/staging bundle 不是版本真相。现行 CLI build 从 `apps/zcode-cli/package.json`
注入 `__CLI_VERSION__`；Desktop metadata 从仓库根产品构建元数据读取版本。正式打包必须
先重建 Agent，不能直接复用未通过版本校验的本地 staging 产物。

历史缺口是 Resource 只保留 Agent 自己的运行版本，无法单独确认外层 Desktop/产品版本。

V5 沿用 `service.version=CLI bundle 实际内置版本` 和 `zcode.product.version`；
Standalone 没有外层产品时省略后者。App 显式注入产品版本，发布重新生成 bundle，
并验证：

- `--version`=`apps/zcode-cli/package.json`=`service.version`；
- About=产品 package/build metadata=`zcode.product.version`；
- `zcode.build.commit_id` 可用；
- Schema Version 独立为整数 `5`。

V4 已经上线；本轮源事实、Metric 与 Subagent 拓扑发生破坏性变化，因此原子升级为 V5，
不与 V4 双写。

## 6. OTel 原生模型使用规则

### 6.1 Resource

Resource 描述“谁产生 Telemetry”，在 Provider 生命周期内稳定。

适合：

- `service.name`、`service.version`；
- `deployment.environment.name`；
- `service.instance.id`；
- product version、runtime surface、build commit、Schema Version；
- 经合规确认的 installation ID。

不适合 Session、Turn、当前用户、Model、Tool、Request ID。

Metric Resource 首版同样保留 `service.instance.id`，避免多个 CLI 进程的累计时序和重启重置
互相覆盖；查询时跨实例聚合。只有 Collector 已验证 DELTA Temporality 与 ARMS 多生产者语义
后，才在 Collector 聚合层剥离实例 ID。用户、设备、Session 和执行 ID 不进入 Metric
Resource。

### 6.2 Context 与 SpanContext

```text
OTel Context
  ├─ 当前活动 Span
  ├─ Baggage（默认无业务身份）
  └─ ZCode private values
       ├─ execution correlation
       └─ typed writer anchor
```

Context 是不可变、执行范围内传播的载体；本身不会上传或可查询。

Context 中的 correlation snapshot 不可变；Context 保存的 aggregate/writer anchor 引用不变，
但 anchor 是 Runtime 私有的受控可变计数器。业务不能读取、冻结、复制或修改它。

SpanContext 只含 trace ID、span ID、flags、state、isRemote，不含业务 ID/Attribute。

### 6.3 Parent 与 Link

Parent 条件：

1. 属于同一次端到端 operation；
2. 有唯一直接执行 owner；
3. 应共享 Trace 和采样决策。

OTel Link 可以指向任意 SpanContext；V4 只把它用于独立 Trace 的 queued、
fan-out/fan-in、background、Child Agent 和 recovery 因果关系。新 Root 必须显式以
`ROOT_CONTEXT` 创建，并在创建 Span 时传入 Link，让 Sampler 可见。

Parent 不是按“谁结束更晚”判断。

### 6.4 Event、Attribute、Span、Metric

```text
需要独立 duration/status/children？
  ├─ 是 -> Span
  └─ 否
      ├─ 最终稳定事实 -> Attribute
      ├─ 有具体发生时刻 -> Event
      └─ 高频聚合 -> Metric
```

少数事实可双表达：

- `first_content` Event 给时间轴；
- `time_to_first_content_ms` Attribute 给聚合；
- `stream_stalled` Event 给明细；
- `stall_count/max_idle_ms` Attribute 给摘要。

### 6.5 Baggage 与传播

Baggage 会复制到下游 Header，不是 ARMS 查询列。

默认：

- 不放 user/device/session/prompt；
- 不向模型 Provider 注入；
- 当前不启用业务 Baggage；未来即使只在受信 ZCode 进程边界传播低风险 routing value，
  也必须单独评审字段、传播范围和保留期；
- 主要关联依赖 SpanContext 与受控 Attribute 投影。

受信跨进程：

```text
Parent context
  -> propagator.inject(traceparent, tracestate)
  -> typed protocol metadata
  -> child propagator.extract()
  -> remote trigger Context
       ├─ new Agent Turn -> ROOT_CONTEXT + Link
       └─ trusted same-trace RPC -> remote Parent
```

新 Agent Turn 始终是 Root；Desktop/RUM 触发链路只通过 Link 关联，不把 Turn 变成远端 Child。

## 7. V4 目标运行时

### 7.1 单一 Owner

```text
AgentTelemetryRuntimeOwner
  ├─ Resource
  ├─ AsyncLocalStorageContextManager
  ├─ TracerProvider
  ├─ BatchSpanProcessor
  ├─ OTLPTraceExporter
  ├─ Tracer
  ├─ optional MeterProvider
  └─ health counters

Session A ─┐
Session B ─┼─> 同一 Owner
Subagent ──┤
Model ─────┤
Tools ─────┘
```

初始化和关闭各一次。`forceFlush()` 只用于测试、诊断和有界 shutdown。

### 7.2 Scope

Scope：

1. 从当前 OTel Context 取得 Parent；
2. 创建 Span；
3. 通过 `context.with()` 执行业务；
4. 业务在事实发生处调用 typed writer；
5. 业务显式提交正常或领域终态；异常、取消由 Scope 兜底；
6. Telemetry 异常被隔离。

异常兜底负责“Span 一定收口”，不替业务猜复杂终态。正常返回却没有提交终态时记为
`abandoned(missing_terminal)`，不能因为“没有抛异常”就猜成成功。

Fail-open 还必须覆盖 `context.with()` 和 Writer 构造本身：

- Writer 创建失败返回 No-op Writer；
- Context 激活前失败时，在无 Telemetry Context 下执行一次业务；
- 回调已经进入后即使 Context Manager 抛错，也只等待已创建的同一个业务 Promise，绝不重跑；
- Terminal Latch 先在内存中关闭，再调用 SDK/Adapter/Metric；
- Setter/Finish/Exporter 异常不覆盖业务返回值或原始异常。

### 7.3 生命周期

```text
Turn:  |--------------------|
Step:     |------|
Child:       |----------|
```

Child 可以晚于 Parent 结束。若业务必须等待，业务自己 `await`；否则应判断为独立 operation。

### 7.4 Subagent/Workflow Child

按实际生命周期选择 Parent 或 Link：

```text
前台：Main Turn -> Agent Tool -> Child Agent Turn -> Step/Call/Attempt/Tool
后台：Main Turn -> Agent Tool -- Link --> Child Agent Turn ROOT -> Step/...
```

Child Runtime 复用进程级 Telemetry Port，内部每个 Step、模型请求和工具调用都必须继续分
Span。前台由父 Tool 等待，使用真实 Parent；显式后台可独立结束和采样，使用 Root + Link。

## 8. Event 方案

建议：

| Span          | Event                   | 属性                   |
| ------------- | ----------------------- | ---------------------- |
| Model Attempt | `first_provider_event`  | 无                     |
| Model Attempt | `first_content`         | 无                     |
| Model Attempt | `first_text`            | 无正文                 |
| Model Attempt | `stream_stalled`        | bounded idle bucket    |
| Model Call    | `fallback_selected`     | transport、reason code |
| Tool          | `permission_requested`  | 无                     |
| Tool          | `permission_decided`    | result category        |
| Command       | `termination_requested` | reason                 |
| Compaction    | `fallback_selected`     | strategy、reason       |

`permission_requested/permission_decided` 只在真实等待用户决定时成对出现；`not_required` 只写
最终 Attribute，不制造 Event。

不建议：

- `request_sent`/`completed`（与 Span start/end 重复）；
- 每个 SSE chunk/token；
- 原始日志、错误栈、命令、工具 I/O、Prompt。

Retry：

```text
model_call
  ├─ model_attempt #1 ERROR
  └─ model_attempt #2 OK
```

当前不定义 `retry_scheduled` Event；Retry 由新 Attempt Span 及其
`attempt_cause/retry_delay_ms` 表达。Event/Attribute 容量预算统一引用最终规范，stall 明细
即使因上限丢弃也保留汇总 Attribute。

## 9. Canonical、Adapter 与投影

三类输出：

1. OTel 结构：trace/span/parent/status/time/kind；
2. ZCode canonical：`zcode.<span_name>.<property>`；
3. 外部兼容：GenAI、OTel semconv、ARMS alias。

业务只调用 Writer：

```text
writer.setRequestedModel(model)
          ├─ zcode.model_attempt.requested_model
          └─ adapter -> gen_ai.request.model
```

每个 Adapter 映射只能是：

- `exact`：语义、类型、单位一致；
- `convert`：有明确转换和测试；
- `omit`：语义不确定。

禁止把 unknown 填成 disabled、requested 当 effective、Tool status 当 exit code。

有限查询投影不在升级计划中维护第二份矩阵。字段、目标 Span、隐私和消费者统一引用
[最终规范第 9 节](../cli-agent-telemetry.md#9-query-projection)；
迁移实现和 Dashboard 必须同时按该矩阵验收。

## 10. 隐私

| 类别            | 示例                                | 策略                          |
| --------------- | ----------------------------------- | ----------------------------- |
| Secret/Content  | Key、Header、Prompt、文件、工具 I/O | 丢弃                          |
| Person identity | 邮箱、手机号、OAuth UID             | Host 生成 opaque subject/省略 |
| Execution ID    | Session、Turn、Request、Tool Call   | 可原样，受控保留              |
| Category        | Model、Provider、operation、outcome | 可原样                        |
| Unbounded text  | URL、错误、命令、路径               | 结构化/清洗/截断              |

URL：

- 保留 scheme/host/port/清洗后的 route；
- 删除 query、fragment、userinfo；
- 替换邮箱、UUID、长数字、hash/token-like、tenant/account segment；
- 清洗结果按 Base URL 缓存。

错误保留最靠近来源的原始 exception type/code/message，并独立记录 HTTP status、Provider
code/message、phase；category/retryable 只是额外的分析和控制事实，不覆盖原始异常。

Writer 创建接口只接受窄 Telemetry Descriptor：批准的 ID、稳定枚举和已清洗短字符串。
禁止把 Tool args/definition、parsed command、完整 ResolvedModelTarget、Header、URL 或
Provider Options 交给 Telemetry。Descriptor 是普通 TypeScript 类型，不引入 Schema DSL。

`finishFailed(stage, category, error?)` 允许在异常或结构化失败边界接收未知对象，并在同一个
Terminal Latch 内完成清洗和 Failed 终态。Sanitizer 立即从 Allowlist 标量读取
name/message/code/status/retry-after；不缓存、不递归遍历、不 `JSON.stringify`，也不读取
response/request/config。候选字符串先硬截断，再正则清洗。恶意 Getter 或 Sanitizer 失败时
只保留 type/code/stage，并以 `unknown` 作为错误分类。

消息去 Secret/URL query/path 后再截断到最终限制；原始 stack
不上传。

Command 允许 executable category、allowlist subcommand、exit/signal/duration、
output bytes/truncated、timeout/cancel reason；禁止 command args/cwd/env/stdout/stderr。

## 11. 性能

热路径要求：

- 只有内存写；
- 无同步 I/O；
- 无 JSON stringify/深拷贝；
- 不扫描 Prompt/工具输出/大错误；
- 不创建重复 Owner；
- 不在业务调用 `forceFlush()`；
- 只清洗短字符串。

容量、Batch、Export、Shutdown、Metric Series 和网络体积的数值门禁只在
[最终规范第 15、16 节](../cli-agent-telemetry.md#15-metric-设计)
维护，升级计划不复制第二份容易漂移的数值。

首版不使用全局 TTL，也不让每个 Setter/Child 更新祖先活动时间。正常 Terminal、
Session Teardown 和 Process Shutdown 负责收口；Model Status 事件驱动且不经过 `run()` 的
Call/Attempt 额外维护轻量 `lastActivityAt`，在状态事件入口最多每分钟惰性 Sweep 一次，
30 分钟无活动时以 `missing_terminal` 收口。

过载顺序：

1. 丢低价值 Event；
2. 丢 detail Span，Root 写 overflow count；
3. 尽量保留 Turn/Model Call terminal；
4. Collector 失败不无限重放；
5. warning 限流；
6. health Metric 记录 drop/failure；
7. 不阻塞业务。

基准覆盖 disabled、healthy、timeout、200 Step/Turn、1,000 active Call、
SSE 高频 chunk、残留 Span shutdown；观察 startup、CPU、heap、event-loop delay、
queue bytes、drop、shutdown 和业务 latency。

## 12. 迁移阶段

### Phase 0：规范与版本

- 最终规范和本升级设计；
- Schema Version=`5`；
- Span/Event/Attribute catalog；
- ARMS V4 查询；
- 版本验收设计。

验收：字段隐私完整；每 Span Parent/Link 明确；高基数投影明确。

### Phase 1：进程级 Owner

- 新增 Runtime Owner；
- 固定注入优先级；
- 引入 `@opentelemetry/context-async-hooks`，进程启动时只注册并启用一个
  `AsyncLocalStorageContextManager`；
- disabled 路径 dynamic import；
- shutdown 幂等；
- Resource 写版本、commit、Schema `5`。

验收：多 Session 单 Provider；注入不被覆盖；disabled 不加载 SDK。

### Phase 2：Context 与 Link

- Scope 改 `context.with()`；
- correlation 使用私有 Context Key；
- 删除 Agent active-span ALS；
- capture 使用原生 SpanContext；
- 保留 traceState/isRemote；
- 跨进程 W3C Propagator；
- 重命名业务 TraceContext。

验收：Promise/Timer/EventEmitter/并发不串；same-process remote=false；
extract remote=true；tracestate 往返；模型请求无传播；前台 Child Agent Turn 与触发 Tool
同 Trace 且具有 `parentSpanId`，显式后台 Child 使用新 `traceId` 并 Link 指向触发 Span。

### Phase 3：V5 Writer

- Turn、Step、Tool、Compaction typed Writer；
- canonical + Adapter；
- Child 与 Usage 只写各自源 Span/Metric；删除 Parent 摘要、
  `TurnAggregates` / `ModelCallAggregates` 以及终态 `writeAggregates()`；
- `finish*()` 只接收本节点的终态、失败阶段、错误分类和原始异常，不接收业务 Result 或
  Usage/计数汇总；
- 所有可失败 Span 使用原子 `finishFailed(stage, error_category, error?)`；`failed` 以外的终态不
  接受错误分类；
- 创建接口改为窄 Telemetry Descriptor；
- terminal 幂等；
- Telemetry 异常隔离，包括 Writer 构造与 `context.with()`；
- Parent 不等待 Child。

验收：success/fail/cancel/abandoned；字段类型；Adapter exact/convert/omit。

### Phase 4：Command Child

- 命令工具创建 Command Child；
- exit code 只在 Command；
- executable/subcommand allowlist；
- timeout/signal/cancel；
- output size/truncation。

验收：Read/Write 无 exit；脚本和 stderr 不上传；Tool/Command terminal 可区分。

### Phase 5：Model Live Span

- Call start 创建 live Span；
- Attempt start 创建 Child；
- `call_cause` 使用 `initial | continuation | fallback_replacement | recovery` 固定枚举；
- Transport/Provider Adapter 在真实失败点提供 Attempt Failure Stage，不能把所有错误归到
  `response`；
- milestone/stall/fallback 使用 Event；
- retry 创建新 Attempt；
- 不再重试或耗尽时显式结束 Call，terminal 直接结束并写 SQLite；
- 删除 Record -> Span 重建。

验收：真实时间；retry Tree；Event/TTFT 一致；错误清洗；abandoned；
SQLite/ARMS logical call 对账。

### Phase 6：补齐 LLM 入口

至少：

- normal Step；
- Compaction streaming/non-stream/fallback；
- Session title；
- Goal summary/title；
- Completion verification；
- Git commit message；
- Web search/fetch processing；
- Read session context extract/synthesize；
- Workspace generate text；
- Subagent/Workflow Child；
- 新 Provider Adapter。

从最终 model adapter 向上反查调用者；每个真实请求有 Attempt。
`read_session_context`、`web_fetch_processing` 要同时写 Usage 与 ARMS。

### Phase 7：Event、Metric、报表

- typed Event；
- Telemetry health；
- Turn/Tool/Model RED Metric；
- success/cancel/retry recovery；
- p50/p95 duration/TTFT；
- token/cache/provider/model breakdown。

Metric Instrument 的 Counter/Histogram/UpDownCounter、UCUM Unit、记录时点、合法 Label 和
Histogram Bucket 以最终规范第 15 节为准。CLI 固定 `AlwaysOnSampler`；需要降采样时在
Collector/ARMS 做 Tail Sampling。直连 ARMS 不支持 Tail Sampling 时全部 Trace 入库，精确
成功率和 Token 分母始终来自 Metric。

实现边界：

- Trace 与 Metric 共享同一份 Resource 以及 CLI/Product/Schema/Commit 四条版本轴；
- Duration Histogram 只在 Terminal Latch 获胜后记录一次；
- Token Counter 在 Attempt Usage Setter 的事实边界按单调新增量记录，不等到 Call/Turn End；
- Token 只写事实来源 Attempt 和低基数 Metric，不再复制到 Call/Step/Turn；
- Metric Label 只允许规范字段，禁止设备、用户、Session、Turn、Request、Endpoint、错误正文
  和命令正文；实际请求 Model ID 经过限长并由 Series Cardinality Limit 保护。

错误链路必须额外满足“事实保真”：

- Transport 捕获到的原始异常对象只沿 Telemetry 专用观察回调进入活动 Attempt/Call Writer，
  不写入 SessionEvent、产品日志或领域 Result；
- Canonical `error_type/error_code/error_message` 来自原始异常，仅脱敏和限长；
- 业务重试分类产生的展示文案、`error_category` 和 Metric Label 只能作为额外投影，不能覆盖
  原始异常事实；
- 删除未被消费的 Provider/Model/Error 指纹和基于字符串猜测的 Model 厂商桶；Metric 的
  `model` 使用受 Series 上限保护的实际请求 Model ID。

业务流量使用 Duration Histogram 自带的 Count，不并行创建同 Label 的重复 Counter。TTFT、
Stall 等 Detail Instrument 必须先通过每进程 Series、压缩字节和 ARMS 费用 Canary。

### Phase 8：Canary

1. 测试环境 Schema 5；
2. 本地真实请求；
3. CI 打包产物；
4. Desktop 注入；
5. Standalone 初始化；
6. ARMS Trace Explorer；
7. SQLite 对账；
8. 24 小时 health；
9. 存储量和基数评估。

### Phase 9：生产切换

- 不双写两棵完整 Trace；
- 一个构建只输出一个 Agent Schema；
- 报表按 Schema 5 切换；
- 历史 V2 保留；
- 删除旧 ALS、Record queue/reconstruction、旧 alias/contracts；
- SQLite Usage 保留。

## 13. 文件影响

Contracts：

- `contracts/src/telemetry/agent-execution.ts`
  移除混合 Link，定义 V5 Port/relation/Writer；
- `contracts/src/telemetry/index.ts`
  移除仅供 Trace 重建的 Record；
- `contracts/src/tracing/tracer.ts`
  重命名业务 Context，删除伪 OTel Span/空 `addEvent()`。

Telemetry：

- `telemetry/package.json`
  增加 Node Context Manager；启用独立 Metric 信号时再增加 Metric SDK/Exporter；
- `telemetry/src/bootstrap.ts`
  单 Owner、lazy load、动态 identity source、V4 Resource；
- `telemetry/src/otlp-exporter.ts`
  只负责 Provider/Processor/Exporter，注册 Context Manager；
- `telemetry/src/agent-trace-runtime.ts`
  V4 Scope/Writer、原生 Context；
- `telemetry/src/compatibility-adapters.ts`
  集中维护 GenAI、标准 HTTP/Server 与 ARMS 所需 Alias；Canonical Writer 不直接依赖外部命名；
- `telemetry/src/agent-trace-support.ts`
  删除 ALS，保留 limits/terminal/sanitizer；
- `telemetry/src/model-api-recorder.ts`
  live Model Writer + Usage 投影；
- `telemetry/src/runtime.ts`
  删除 Trace Record Queue；
- `error-sanitizer.ts` 与 Model Adapter 的 Endpoint Descriptor
  保留并强化测试。

Core/Bootstrap：

- `core/src/telemetry/runtime-telemetry.ts`
  V5 Port，不拼完整 OTel context；
- `core/src/tool/executor/telemetry.ts`
  Tool Writer + Command Child；
- Turn/Step/Compaction 在真实边界写事实；
- `bootstrap/src/app/create-app.ts`
  只接收进程级 Owner；
- Subagent/Workflow protocol 传播 W3C Context；
- `services/src/zcode-agent/agentTelemetryEnv.ts`
  注入 product version 和动态 identity update，调整 user identity policy；
- Desktop build 继续从根版本注入。

测试：

- telemetry runtime：Context、Parent/Link、terminal、limits；
- exporter：Resource、single owner、schema/version；
- OTLP integration：真实 protobuf Tree/Event；
- model：Call/Attempt、retry、stall、cache；
- core：Tool/Command、异常、取消、permission；
- packaged E2E：OTLP build env 与真实版本。

## 14. 验证

### 14.1 单测矩阵

| 维度      | Cases                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| Scope     | sync、async、throw、reject、cancel、double terminal、Context 激活失败、No-op exactly-once |
| Context   | nested、parallel、timer、emitter、missing parent                                          |
| Link      | same process、remote、tracestate、invalid carrier、Turn Root+Link                         |
| Turn      | success、failed、cancelled、abandoned                                                     |
| Tool      | success、denied、failed、cancelled                                                        |
| Command   | exit 0/nonzero、signal、timeout、missing exit                                             |
| Model     | success、retry recovery/exhausted、cancel、abandoned                                      |
| Stream    | SSE、HTTP、first content、stall、recovery                                                 |
| Cache     | hit、write、none、unknown                                                                 |
| Reasoning | unsupported、disabled、level、budget、adaptive、unknown                                   |
| Privacy   | URL、email、token、path、command、provider error、恶意 Getter、循环对象                   |
| Capacity  | span/detail/event/queue limits、长 Span、shutdown/capacity 竞争                           |
| Identity  | login、logout、switch、resolver error、旧 Span 不回写                                     |
| Metric    | type、unit、bucket、label、multi-process reset                                            |
| Version   | CLI project package、product root、Desktop build metadata、bundle、Resource               |

### 14.2 Integration

本地捕获 OTLP protobuf，断言：

- Trace/Span ID 与 Parent 合法；
- Link 保留 traceState；
- Child Agent Turn 是新 Root 且 Link 指向 remote trigger；
- Event timestamp 正确；
- Resource 只有稳定字段；
- Schema=`4`；
- service.version 与 CLI bundle 一致；
- packaged Desktop 的 product.version 与产品 build metadata 一致；
- 无 Secret/Content；
- gzip/protobuf 可解码。

### 14.3 ARMS 人工验收

触发正常 Turn、Tool、Command、retry、Compaction、Turn 外标题、Child Agent、
错误、取消。检查：

1. Tree 完整；
2. Call/Attempt Parent 正确；
3. Root Link 可定位；
4. Event 在时间轴；
5. status/outcome 正确；
6. provider/model/reasoning/cache 合理；
7. identity 合规；
8. error 可诊断无隐私；
9. product/schema version 正确。

### 14.4 SQLite 对账

按 logical call 与时间窗比较 ARMS Call/Attempt、`model_usage`、Turn 汇总、
retry recovery、token/cache token。

sampling、crash、capacity drop、disabled、网络失败可以造成差异，但必须由 health
counter 解释。

### 14.5 工程门禁

```text
pnpm typecheck
pnpm lint
```

并运行 telemetry/core/bootstrap 单测和实际 OTLP 集成测试。

## 15. 版本与发布

| 字段                             | 来源                    | 示例              | 变化时机     |
| -------------------------------- | ----------------------- | ----------------- | ------------ |
| `service.version`                | 实际 CLI bundle         | `0.16.1`          | CLI 发布     |
| `zcode.product.version`          | 外层产品 build metadata | `3.6.1`           | 产品发布     |
| `zcode.build.commit_id`          | build metadata          | commit SHA        | 每次构建     |
| `zcode.telemetry.schema_version` | contract                | `5`               | 数据契约变化 |
| `service.name`                   | Telemetry 固定常量      | `zcode-cli-agent` | 不随部署变化 |

打包门禁：

1. 执行 `zcode.cjs --version`；
2. 读取 CLI project package、仓库根 product package 与 Desktop build metadata；
3. 读取 Desktop build metadata；
4. 启动打包 Agent 发送 Trace；
5. 解码 OTLP Resource；
6. 断言 `--version`=`service.version`=CLI project package；
7. 断言 About=`zcode.product.version`=产品 package/build metadata；
8. 断言 Schema=`4` 且 commit 非 `unknown`。

它防止旧 dist、错误 cache、Desktop 内置旧 Agent、Resource 版本漂移。

## 16. Rollout 与回滚

迁移期建议开关：

- `ZCODE_AGENT_TELEMETRY_SCHEMA=4`；
- `ZCODE_MODEL_TELEMETRY_ENABLED=0` 总关闭；
- Event 明细；
- identity projection；
- Collector/ARMS Tail Sampling Policy。

CLI 端不提供 Ratio Head Sampling 开关，固定 AlwaysOn。Tail Sampling 尚未就绪时以全部入库做
容量评估，不能用客户端采样假装“错误 100% 保留”。

Canary：

```text
local -> CI packaged CLI -> internal Desktop
      -> small cohort -> all production
```

每级观察 Agent/model latency、startup、heap/event loop、export failure/drop、
ingestion volume、隐私抽样。

回滚：

- 回退完整构建或关闭 Telemetry；
- 不并行运行 V2/V4 两棵 Tree；
- SQLite Usage 不受影响；
- 历史 ARMS 数据不删；
- Dashboard 按 Schema 选择；
- 后端故障先关闭/降采样，不回滚 Agent 业务。

## 17. 风险与待确认

合规：

- device MID 是否允许作为 Resource；
- user telemetry subject 的签发/轮换；
- identity 保留期/查询权限；
- Provider error message allowlist；
- Model ID 是否可作 Metric label。

平台：

- ARMS Link 展示/查询能力；
- ARMS Event 检索/聚合能力。

技术：

- 移除第二 ALS 后的 callback 传播缺口；
- 各 Provider 网络事件顺序；
- 跨进程 protocol schema；
- Child Root/Link UI 可读性；
- Event 存储量；
- Schema 与 Dashboard 同步发布；
- 远程 workspace trusted boundary。

缓解：Context stress test、Provider 状态机测试、协议 runtime schema、Link +
correlation 双定位、Event 上限/采样、Dashboard 先建后切、propagation allowlist。

## 18. 完成定义

- [ ] 单进程单 Owner；
- [ ] disabled 不加载 SDK；
- [ ] OTel Context 是唯一活动 Span 真相；
- [ ] 业务 Context 不伪装 OTel；
- [ ] Parent/Link/remote/tracestate 正确；
- [ ] Turn/Step/Tool/Command/Model/Compaction Tree 正确；
- [ ] 所有 LLM 入口有静态清单和动态验证；
- [ ] Model Call/Attempt 为 live Span；
- [ ] 只有一个 Trace queue；
- [ ] Event 用于瞬时里程碑；
- [ ] Tool/Command exit code 不混淆；
- [ ] Adapter exact/convert/omit 有测试；
- [ ] identity policy 通过隐私评审；
- [ ] Secret/Content 未进入 payload；
- [ ] Metric 无高基数 identity；
- [ ] SQLite/ARMS 可解释对账；
- [ ] Telemetry 故障不影响 Agent；
- [ ] 性能满足预算；
- [ ] `service.version` 等于 CLI bundle 版本；
- [ ] packaged Desktop 的 product.version 等于产品版本；
- [ ] Schema=`4`；
- [ ] ARMS Dashboard/Query/Alert 切换；
- [ ] typecheck/lint/集成测试通过；
- [ ] 实际安装包完成 OTLP 验收。

## 19. 参考

- [OpenTelemetry Context](https://opentelemetry.io/docs/specs/otel/context/)
- [OpenTelemetry Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [OpenTelemetry Resource](https://opentelemetry.io/docs/specs/otel/resource/) / [Resource Data Model](https://opentelemetry.io/docs/specs/otel/resource/data-model/)
- [OpenTelemetry Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/) / [Propagators](https://opentelemetry.io/docs/specs/otel/context/api-propagators/)
- [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [OpenTelemetry GenAI Registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [ARMS Trace Explorer](https://help.aliyun.com/en/arms/application-monitoring/developer-reference/use-trace-explorer-to-query-traces)
- [当前 Turn Trace](./turn-trace-observability-v2.md) / [Model API 事实](./model-api-observability-v1.md)
