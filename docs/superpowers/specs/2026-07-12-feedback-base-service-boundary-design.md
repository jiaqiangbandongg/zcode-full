# SSH 断连场景反馈服务边界设计

## 背景

反馈中心是桌面应用级能力。创建工单、读取设备信息、上传截图和打包诊断日志都由桌面本机 host process 提供的 `feedbackService` 完成，不依赖当前 workspace 的文件系统、Agent runtime 或 SSH 连接。

当前 `FeedbackHost` 从 workspace-scoped `services` 读取 `feedbackService`。SSH workspace 正常连接时，renderer 会把 base services 与 remote services 合并，`feedbackService` 恰好仍来自本机 base services；但在远程 session 尚未绑定或已经断开时，workspace service resolver 会返回断连代理。提交反馈的首个 `getDeviceSnapshot()` 调用因此在 renderer 内直接抛出 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`，请求尚未到达反馈 API。

## 目标

- 反馈中心始终显式使用桌面启动时注册的 base `feedbackService`。
- SSH 正常连接、连接中和断连时均可提交反馈。
- 保持本地 workspace 和 SSH 正常连接时的现有反馈行为不变。
- 不改变远程文件、终端、Git、Agent、task 和 session 服务的 workspace 路由。
- 不改变桌面 `desktop-continuous`、手机 `web-remote-replayable`、snapshot、queue 或 owner/lease 语义。
- Web 远控继续使用现有 unsupported feedback fallback；本次不为 Web 新增反馈能力。

## 非目标

- 不修改 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` 断连代理的保护规则。
- 不让 workspace-scoped 服务在断连后普遍回退到本机 services。
- 不调整反馈表单、截图、日志归档、附件上传或反馈 API 协议。
- 不处理 SSH 自动重连或远程 session 生命周期问题。

## 方案

`Root` 已持有桌面 renderer 启动时注入的 base `IServiceAccessor`。它将其中的 `feedbackService` 作为独立依赖传给 workspace UI，最终交给 `FeedbackHost`。

`App` 继续接收 workspace-scoped `services`，供文件、任务、终端等 workspace 能力使用；反馈中心不再从该对象读取 `feedbackService`。这使依赖边界显式化：

- workspace 能力依赖 `workspaceScopedServices`；
- 应用级反馈能力依赖 `baseFeedbackService`。

反馈中心的挂载位置、store、弹窗生命周期和当前任务/模型上下文读取方式保持不变，避免扩大 UI 行为变化。

## 数据流

1. Desktop renderer 收到本地 host service port，创建 base services。
2. `Root` 接收 base services，并将 `baseServices.feedbackService` 作为独立 prop 向下传递。
3. SSH tab 根据连接状态继续解析 workspace-scoped services：已连接时为合并 services，未连接时为断连代理。
4. `FeedbackHost` 无论当前 workspace 状态如何，均调用第 2 步传入的 base feedback service。
5. 设备快照、工单创建、截图上传和日志归档继续在本机 host 中完成。

## 错误处理

- SSH 断连不再成为反馈提交错误来源。
- 反馈 API、附件上传或本机日志归档的真实错误继续按现有流程展示，不新增吞错或重试。
- 远程 workspace 的其他 service 调用仍由断连代理返回 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED`，防止远程路径误路由到本机。

## 兼容性

- 桌面本地 workspace：传入的实例与现有实际使用的 base feedback service 相同。
- 桌面 SSH 已连接：当前合并 services 中的反馈实例本就来自 base services，改动后调用对象不变。
- 桌面 SSH 连接中/已断开：由断连代理切换为 base feedback service，这是本次唯一预期行为变化。
- 手机 Web 远控：继续使用入口注入的 unsupported feedback service，不新增远程业务状态，也不绕过 replayable 恢复边界。
- macOS、Windows、Linux：仅调整依赖选择，不引入平台分支。

## 测试设计

新增回归测试验证反馈服务选择不依赖 workspace-scoped services：

| 场景 | workspace services | feedback service | 预期 |
| --- | --- | --- | --- |
| 本地 workspace | base services | base feedback | 行为不变 |
| SSH 已连接 | merged remote services | base feedback | 行为不变 |
| SSH session 尚未绑定 | disconnected proxy | base feedback | 可提交，不抛断连错误 |
| SSH 已断开 | disconnected proxy | base feedback | 可提交，不抛断连错误 |

测试应直接断言 `FeedbackHost` 接收显式的 base feedback service，并避免仅依赖对象展开恰好保留该字段。现有 feedback submission 测试继续覆盖 `getDeviceSnapshot`、工单创建、附件和日志流程。

## 验证

- 运行新增/相关 UI 单元测试。
- 运行 `pnpm typecheck`。
- 运行 `pnpm lint`。
- 检查桌面本地与 SSH service 边界未发生额外 diff。
