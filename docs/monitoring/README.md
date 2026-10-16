# Monitoring 文档入口

本目录保留 App/RUM、Conversation 业务事件、资源监控、产品专项埋点和测试监控。
CLI Agent 的 OpenTelemetry 执行链路已独立到
[`docs/trace/`](../trace/README.md)，不再与其他监控文档混放。

## App、Renderer 与进程

- [性能监控](./performance-monitoring.md)
- [性能埋点事件字典](./performance-telemetry-catalog.md)
- [ARMS Electron 监控](./arms-browser-monitoring.md)
- [Agent 进程崩溃 ARMS 上报](./agent-process-crash-arms.md)
- [全进程 CPU / 内存监控埋点](./process-resource-telemetry.md)
- [全进程资源仪表盘与查询](./dashboards/process-resource-dashboard.md)
- [MCP 进程生命周期 ARMS 上报](./mcp-process-arms-telemetry.md)
- [进程内存本地诊断日志](./memory-diagnostics-log.md)

## Conversation 与业务事件

- [V4 对话埋点兼容规范](./conversation-telemetry-v4.md)
- [业务质量监控](./business-monitoring.md)
- [Agent Step 真实模型与 Token 归属](./agent-step-model-token-attribution.md)

## 产品专项

- [Plan Usage ARMS 自定义事件](./plan-usage-arms-telemetry.md)
- [远程场景使用量埋点 V1](./remote-usage-telemetry-v1.md)
- [远程工作区连接 ARMS 自定义事件](./remote-usage-arms-telemetry.md)
- [Off-Peak Task telemetry V1](./off-peak-task-telemetry-v1.md)
- [Session 首次打开 ARMS 埋点](./session-open-telemetry.md)
- [定时任务 / 闲时任务消息埋点](./automation-message-telemetry.md)

## 工程质量

- [E2E Metrics Bitable Dashboard](./e2e-metrics-bitable-dashboard.md)

本目录中的文档只负责各自监控通道或产品功能，不得重新定义 CLI Agent Trace 的 Span、
Attribute、Event、Metric、隐私和统计口径。相关变更统一更新
[`docs/trace/cli-agent-telemetry.md`](../trace/cli-agent-telemetry.md)。
