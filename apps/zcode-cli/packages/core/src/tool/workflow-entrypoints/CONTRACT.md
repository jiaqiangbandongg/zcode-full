# Workflow 工具入口

登记 `AmendWorkflow`、`ListModels` 与 `FillWorkflowHole` 的既有工具入口。保留 handler 文件和公开导入路径，继续向同一个 registry 注册原 ToolEntry。

- 三个入口均保留 deferred 分类；是否曝光、包装准入与权限仍由现有公共工具链判断。
- `ListModels` 只读取当前宿主目录，不切换会话模型；缺少目录端口时返回既有能力缺失结果。
- `AmendWorkflow` 沿用前驱解析、技能检查和审批链；执行只经现有 workflow port，不创建第二个运行态。
- `FillWorkflowHole` 沿用留白解析、技能检查、审批及填充端口；不另起工作流，不改变调用的会话归属。
- input/output schema、超时、取消和结果预算仍来自原入口；契约不复制这些配置，也不直接执行 handler。
- 共享 workflow 辅助函数及执行器仍属于现有 CLI 模块，本次登记不改变它们的所有权。

策略精确覆盖三个 handler 文件、本契约目录和契约测试目录，不把整个 handlers 目录划入本模块。
