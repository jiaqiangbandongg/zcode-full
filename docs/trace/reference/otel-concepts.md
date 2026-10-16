# OpenTelemetry 概念与 ZCode 取舍

> 本文说明 CLI Agent Trace 使用的 OpenTelemetry 概念、结构关系和 ZCode 建模约束。整体设计
> 与接入方式见 [CLI Agent Telemetry 设计与开发规范](../cli-agent-telemetry.md)。

## 1. 总体模型

```text
Resource
    描述 Telemetry 生产者
    |
    `-- TracerProvider
          |
          `-- Tracer（Instrumentation Scope）
                |
                `-- Trace
                      |
                      +-- Span
                      |    +-- SpanContext
                      |    +-- Attributes
                      |    +-- Events
                      |    +-- Status
                      |    `-- Links
                      |
                      `-- Parent/Child 拓扑

Context
    进程内传播当前 Active Span 和 ZCode 私有关联快照

Metric
    独立于单条 Trace 的跨请求聚合信号
```

这些概念在 OpenTelemetry 数据模型中承担不同职责，不存在逐层转换为 Attribute 的关系：

- Resource 随导出数据附带，描述生产者；
- Context 只存在于运行时传播过程中；
- SpanContext 是 Span 的传播身份；
- Attribute/Event/Status 是 Span 的数据；
- Parent/Link 是 Span 之间的结构；
- Metric 是另一类信号。

## 2. Resource、Provider 与 Instrumentation Scope

### 2.1 Resource

Resource 描述一个 Provider 生命周期内稳定的生产者属性，例如：

```text
service.name
service.version
service.instance.id
deployment.environment.name
process.runtime.name
os.type
host.arch
zcode.telemetry.schema_version
zcode.product.version
zcode.runtime.surface
```

它适合回答“哪一个服务、版本、进程和运行面产生了数据”。Session、Turn、登录用户会变化，不
属于 Resource。

同一个 Resource 会附在许多 Span 上，但不是业务代码给每个 Span 重复调用 Setter。OTel SDK
在导出时组合 Resource 与 Span 数据。

Trace Resource 包含 `service.instance.id` 和 `zcode.device.installation_id`，便于单次诊断。
Metric Resource 刻意去掉这两个高基数值，否则每个短生命周期 CLI 进程都会制造新的时序。

### 2.2 TracerProvider 与 Tracer

`TracerProvider` 拥有处理器、Exporter、Sampler 和 Resource。当前一个 CLI 进程只创建一个
Owner，其中包含一个 TracerProvider 和一个 MeterProvider。

Tracer 通过 Instrumentation Scope 标识“哪个库创建了这些 Span”：

```text
name    = @zcode/cli-agent-telemetry
version = Telemetry Schema Version
```

这个 OTel Instrumentation Scope 不等于业务代码里的 Typed Span Writer，也不等于
`scope.run()` 的执行作用域。

## 3. Trace、Span 与 SpanContext

### 3.1 Trace

Trace 是共享同一 `traceId` 的 Span 集合。它不是一个需要单独创建的对象：创建 Root Span 时
产生 traceId，Child Span 继承它。

ZCode 通常以一个主 Agent Turn 为一条 Trace。后台任务或 Workflow 有独立生命周期时创建另一条
Trace，通过 Link 保留因果关系。

### 3.2 Span

Span 是一段有开始、结束和耗时的工作。它包含：

```text
name / kind / start time / end time
attributes / events / status / links
spanContext
parentSpanId（如果是 Child）
```

Span Name 是稳定、低基数的节点类型，例如 `agent_step`、`model_attempt`。ZCode 不再额外维护一个
和 Span Name 重复的 `span_type` Attribute，也不把 Step Index 或 Model Name拼入 Span Name。

`SpanKind.INTERNAL` 用于 Turn、Step、Tool、Command、Compaction、Call 等进程内工作；
`model_attempt` 使用 `SpanKind.CLIENT` 表示向 Provider 发出的请求。

### 3.3 SpanContext

SpanContext 是 Span 的不可变传播身份：

```text
traceId
spanId
traceFlags
traceState
isRemote
```

它不包含 Session ID、UID、Prompt 或 Span Attribute。Parent 和 Link 使用的是 SpanContext，
不是整个 Span。

`isRemote` 表示该上下文是否从远端传播边界提取；在当前 CLI 内从 Active Span 捕获的因果引用
保持原值，不能为了“看起来像跨任务”随意改成 true。

## 4. Context 与 Active Span

OTel Context 是进程内不可变传播载体。Node SDK 使用
`AsyncLocalStorageContextManager`，因此 Promise、`await`、Timer 和并发异步链能得到各自正确的
Active Span。

```text
scope.run(callback)
    |
    +-- context.with(childContext, callback)
    |       |
    |       `-- callback 内 startStep/startTool/startCall
    |               自动读取正确 Active Span 作为 Parent
    |
    `-- callback 结束后恢复调用者 Context
```

ZCode 在同一个 OTel Context 中还保存 Runtime 私有的 `ActiveWriterContext`，用于传递不可变的
Execution Correlation、当前 Writer 和 Tool Call ID。业务代码不能访问私有 Context Key，也不
应层层透传 Session/Turn/Provider 等字段。

Context 本身不会被导出，也不会自动变成 Attribute。哪些关联字段需要在 ARMS 搜索，必须由
`executionProjection()` 明确投影。

### 4.1 Context 和 Span Context 的关系

```text
Span ------持有------> SpanContext
  |
  `-- trace.setSpan(Context, Span) --> 新 Context

Context --trace.getSpan()---------> 当前 Span
Context --trace.getSpanContext()--> 当前 SpanContext
```

Context 是“运行时容器”，SpanContext 是“可传播身份”，Span 是“可记录数据的工作对象”。

## 5. Parent、Link 与 Causation

### 5.1 Parent/Child

Child Span 与 Parent 共享 traceId，Child 的 `parentSpanId` 指向 Parent。它表达同一个执行树中的
所有权，而不要求 Parent 一定晚于 Child 结束。

当前 Active Span 足够时，Writer 自动建 Child。只有延迟、并发边界或新 Runtime 不能依赖当前
Context 时，才显式捕获 Causation。

### 5.2 Link

Link 是新 Span 创建时指向另一个 SpanContext 的边。两个 Span 可以拥有不同 traceId。它用于
“由它触发，但不是它拥有”的关系：

```text
Trace A                                     Trace B
tool_execution --Link(spawned_by)--------> agent_turn(root)
trigger span   --Link(triggered_by)-------> detached_operation(root)
old run        --Link(resumed_from)-------> recovery root
```

Link 必须在 Span 创建时写入。Root + Link 必须显式使用 `ROOT_CONTEXT` 创建，不能让当前 Active
Span 偷偷成为 Parent。

当前 Link Attribute：

```text
zcode.link.relation = spawned_by | triggered_by | resumed_from
```

### 5.3 `AgentTelemetryCausation`

ZCode 用一个严格类型保存延迟任务需要的因果引用：

```ts
interface AgentTelemetryCausation {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: string;
  isRemote: boolean;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
}
```

前五项是 OTel SpanContext；后三项是 ARMS 当前无法跨 Link Join 时的受控查询投影。它不携带
Prompt、Tool 参数或任意业务对象。

捕获必须发生在调度边界：

```text
Active Span
    |
    +-- captureCausation()  <- 入队/创建 child 时
    |
    `-- Parent 结束

稍后执行任务
    `-- 用已保存 Causation 创建 Child 或 Root + Link
```

如果等到“稍后执行”才读取 `context.active()`，得到的可能是另一条任务的 Span。

### 5.4 当前跨进程边界

当前 Agent Telemetry 的 Causation 主要在共享 CLI Runtime 与内部 child runtime 之间传递；它还
没有把 Desktop/RUM Trace 和 CLI Agent Turn 统一成一条 W3C 跨进程 Trace。协议中已有的
`traceparent` 字段属于更广泛的 RPC tracing 基础设施，不能据此假定 CLI Agent Writer 已完成
自动注入/提取。

若未来打通跨进程边界，应使用 OTel Propagator 注入和提取 `traceparent`/`tracestate`，并更新
严格协议 Schema；不要手写另一套 Header。Agent Turn 是否继续作为 Root + Link，需要按执行
所有权单独决定。

## 6. Attribute、Event、Status 与异常

### 6.1 Attribute

Attribute 描述 Span 的事实或终态摘要。适合 Provider、Model、Token、Exit Code、Outcome、
Failure Stage 等需要过滤和聚合的值。

Attribute 有类型和基数约束，不是日志文本容器。动态大对象、正文、Header 或完整 Error Stack
不能塞入 Attribute。

### 6.2 Event

Event 是 Span 生命周期内的瞬时记录：

```text
model_attempt
  10:00:00 start
  10:00:01 event: first_provider_event
  10:00:02 event: first_content
  10:00:05 end
```

选择规则：

- “是什么/最终是多少”通常是 Attribute；
- “什么时候发生”通常是 Event；
- “持续了多久且有独立结果”通常是 Child Span。

某些里程碑同时写 Event 和最终 Attribute，例如 `markFirstContent()` 写
`first_content` Event，也写 `time_to_first_content_ms`。Event 用于单次时序，Attribute 用于快速
筛选和下钻，无需在查询时重算。

### 6.3 Status 与业务 Outcome

OTel Status 只有 `UNSET/OK/ERROR`，不足以表达业务结果。ZCode 使用 Span 专属 `outcome`：

| Outcome        | OTel Status | 含义                        |
| -------------- | ----------- | --------------------------- |
| `completed`    | `OK`        | 业务正常完成                |
| `failed`       | `ERROR`     | 业务失败                    |
| `cancelled`    | `UNSET`     | 取消，不默认算系统错误      |
| `denied`       | `UNSET`     | 权限或策略拒绝              |
| `discarded`    | `UNSET`     | 结果被明确丢弃              |
| `backgrounded` | `UNSET`     | 命令转后台，前台观测结束    |
| `abandoned`    | `UNSET`     | Writer 未走正常终态，被回收 |

`failure_stage` 表示错误发生在该 Span 的哪个业务阶段，`error_category` 是低基数分类，
`error_message` 保留脱敏后的来源信息。三者互补，不能只保留分类。

## 7. Metric

Trace 回答“哪一次为什么失败”，Metric 回答“总体失败率和 P95 是多少”。Metric Series 由
Instrument 名和 Label 组合决定，高基数 Label 会造成成本与正确性问题。

ZCode Writer 在事实确定时同时记录 Metric，不从导出的 Trace 离线猜测：

```text
Writer Setter / Terminal Latch
    +-- Span Attribute/Event
    `-- OTel Metric（低基数标签）
```

因此未来即使后端对 Trace 做采样，Metric 的计数和 Token 分母仍保持完整。Session、Turn、
Request、用户、安装实例、Endpoint 和错误消息都禁止进入 Metric Label。

## 8. Baggage

Baggage 是可随 Context 跨服务传播的任意键值，可能被自动注入下游请求。它不是“公共
Attribute”，传播范围也比普通 Span Attribute 更危险。

CLI Agent 当前不使用业务 Baggage：

- 不写 UID、安装 ID、Session ID、Prompt、文件路径或 Tool 参数；
- 不向模型 Provider 注入 Baggage；
- 新增任何 Baggage 字段必须单独评审接收方、生命周期和隐私。

需要在多个 Span 上查询的字段，优先使用 Resource、受控 Execution Projection 或 Trace 拓扑，
不能因为“传起来方便”就放入 Baggage。

## 9. 常见误区

1. **把 Context 当作公共字段集合。** Context 不导出；必须明确选择 Resource 或 Attribute。
2. **把 SpanContext 当成 Span。** SpanContext 只能关联和传播，不能写 Attribute 或结束。
3. **为 Parent/Child 重复所有父字段。** 拓扑已经表达结构，只投影后端确实需要搜索的 ID。
4. **因为 Parent 先结束就改用 Link。** Parent 可以先结束；Link 的依据是独立生命周期。
5. **用 Event 统计独立耗时。** Event 没有独立终态；需要 SLO 就建 Child Span。
6. **把日志、Trace 和 Metric 混为一体。** 三者采集方式、隐私、基数和查询用途不同。
7. **同时把动态值放进 Span Name。** 使用稳定 Span Name，动态事实进入受控 Attribute。
8. **把 GenAI 字段当内部 Schema。** `zcode.*` 是权威字段，兼容字段由 Adapter 投影。

## 10. 进一步阅读

- [OpenTelemetry Specification](https://opentelemetry.io/docs/specs/otel/)
- [Context](https://opentelemetry.io/docs/specs/otel/context/)
- [Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/)
- [Resource](https://opentelemetry.io/docs/specs/otel/resource/)
- [Metrics Data Model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/)
- [Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
- [Baggage](https://opentelemetry.io/docs/concepts/signals/baggage/)
