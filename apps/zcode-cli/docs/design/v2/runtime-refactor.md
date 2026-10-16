# Runtime Refactor

## 背景

`packages/core/src/runtime.ts` 已经承担 session 配置、context 初始化、模型请求、tool loop、compact、rewind、事件持久化和后台任务等多种职责。文件体积过大后，agent 很难定位修改边界，也难以判断副作用是否集中在正确的 adapter 或 service 层。

## 目标

- `./runtime.js` 的公开导出保持稳定，调用方继续使用 `AgentRuntime` 与现有 public types。
- `AgentRuntime` 只保留构造、公开 API 类型和原型方法安装，不继续承载所有实现细节。
- runtime 内部按高内聚能力拆分为 `context`、`model`、`turn`、`tools`、`compact`、`rewind`、`persistence`、`background` 和纯 helper 模块。
- 模块之间只通过显式的 runtime internal contract 调度，不依赖文件顺序或隐式全局状态。
- 新增或重构文件默认不超过 400 行；发现超过阈值时必须继续拆分或在同一变更中留下明确的后续拆分说明。

## 接口契约

公开契约仍由 `packages/core/src/runtime.ts` 提供：

- `AgentRuntime`
- `AgentRuntimeConfig`
- `AgentRuntimeDeps`
- turn、resume、permission、checkpoint 相关 public result types
- `RuntimeFactory`

内部契约收敛到 `AgentRuntimeInternal`，它只在 `packages/core/src/runtime/*` 内使用，用于描述 runtime 状态字段和私有协作方法。外部包不得导入 runtime internal modules。

## 错误与副作用

- 模型、文件、子进程、MCP、artifact、session store 等外部 I/O 仍必须通过已有 port/adapter 进入。
- 拆分过程中不改变错误类型、事件 payload、trace 传播、permission broker 行为和 session persistence 语义。
- turn cancellation、model context exceeded、compact retry、rewind restore 等失败路径必须保持原有事件与日志可观测性。

## 测试覆盖

- 现有 runtime tests 继续作为行为回归覆盖。
- 增加 runtime module boundary 测试，确保 `runtime.ts` 不再膨胀回巨型实现文件。
- 完成变更前运行 `npm run lint` 和 `npm test`；如果仓库中已有未归属变更导致失败，需要记录失败点与风险。
