# 服务开发规则

本文件补充[根规则](../../AGENTS.md)。修改 Agent/session/runtime 或进程职责时，先读 [runtime 边界](../../docs/agents/runtime-boundaries.md)，同时考虑桌面本地和手机远控。

## 日志

Agent/session/runtime 日志统一用 [createServiceLogger(scope)](src/logger/serviceLogger.ts)，按实际频率和故障用途选择等级：

| 等级  | 使用场景                                                                                    |
| ----- | ------------------------------------------------------------------------------------------- |
| debug | 原始 NDJSON、part.delta、tool.updated、stream chunk 统计、逐工具 trace 等高频协议细节       |
| info  | 进程启动/退出、session 创建/关闭、权限结果、provider 就绪、一次性配置加载等生产生命周期事件 |
| warn  | 可恢复异常或降级，如 session/close 失败、单次重试、已知 stderr 警告                         |
| error | 不可恢复错误，如进程崩溃、协议握手失败、鉴权丢失                                            |

- 与消息流同数量级的日志必须使用 debug，避免生产日志随流量膨胀。
- debug 默认只在本地开发运行时启用，判据由 [nodeEnv.ts](src/runtime-tools/nodeEnv.ts) 提供；非开发运行时为 no-op，测试可通过 logger 选项覆盖。沿用该统一判据，不自行从 shell 的 NODE_ENV 推断。
- `ZCODE_ENV` 仅表达产品环境（test/production），不用于判断本地开发形态。
- RPC 的频道、命令和耗时已有 [logging middleware](../rpc/src/logging-middleware.ts)；排查前先核对已有记录，避免重复高频日志。
