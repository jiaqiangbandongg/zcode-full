# CLI Agent Trace

本目录定义 `apps/zcode-cli` 内部 Agent 的 OpenTelemetry 执行链路。文档分为核心规范和专题参考
两个层级：核心规范定义稳定的设计、边界和接入方式；专题参考展开底层概念、完整字段以及运行时与
运维细节。

## 文档结构

| 层级     | 文档                                                                     | 内容                                                       |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 核心规范 | [CLI Agent Telemetry 设计与开发规范](./cli-agent-telemetry.md)           | 数据模型、链路拓扑、设计原则、接入方式、隐私约束和查询     |
| 专题参考 | [OpenTelemetry 概念与 ZCode 取舍](./reference/otel-concepts.md)          | Resource、Context、SpanContext、Parent、Link、Event 等     |
| 专题参考 | [Span、Attribute、Event 与 Metric 字典](./reference/schema-reference.md) | 完整字段、枚举、缺失语义、兼容投影、事件和指标             |
| 专题参考 | [Runtime、隐私、性能与 ARMS 参考](./reference/runtime-and-operations.md) | Runtime 生命周期、传播、脱敏、容量、测试、查询和 Dashboard |

核心规范与专题参考共同描述当前实现：设计原则和业务接入以核心规范为准；字段定义、运行时行为和
平台统计口径以相应专题参考为准；方法签名和类型约束以 TypeScript Contracts 为准。

## 相邻但独立的本地观测

- [Desktop Renderer 用户操作 Trace](./desktop-renderer-user-action-trace.md)
- [CLI 本地 Usage Observability](../../apps/zcode-cli/docs/design/v2/usage-observability.md)
- [CLI 本地 Debug Observability](../../apps/zcode-cli/docs/design/v2/debug-observability.md)

Desktop Renderer Trace 只记录 Desktop UI 语义操作，不传播到 CLI；Usage 和 Debug 文档保留在
CLI 包内，分别描述本地 SQLite 事实源和本地调试设施。它们不属于 CLI Agent ARMS Trace Schema，
可用于 Trace 对账和故障诊断。

## 历史设计

以下文档只用于追溯，不得作为新增 Span、Attribute、Event、Metric、查询或大盘的依据：

- [V1 Model API 可观测设计](./archive/model-api-observability-v1.md)
- [V2 Turn Trace 可观测设计](./archive/turn-trace-observability-v2.md)
- [V4 → V5 升级设计](./archive/telemetry-v4-to-v5-upgrade-design.md)

## 文档维护规则

1. 整体原则、接入接口或系统边界变化时，更新核心规范。
2. 新增或修改 Span、Attribute、Event、Metric、枚举、兼容别名、隐私或统计口径时，必须更新
   对应专题参考；完整字段字典必须随代码变更同步维护。
3. 阶段性评审和迁移方案完成后移入 `archive/`，不在主目录保留多个版本。
4. 代码、测试、ARMS 查询和 Dashboard 不得依赖归档文档。
