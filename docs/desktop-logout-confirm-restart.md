# Desktop Logout Confirmation And Restart

## 背景

桌面端退出登录会改变全局鉴权上下文。现有 ZCode Agent 会话、运行中的 task、后台工具链都依赖当前 provider token 和派生 Start/Coding Plan key。为了避免退出登录后旧会话继续持有失效上下文，桌面端退出登录需要在用户确认后中断当前运行并重启 App。

## 设计

- UI 侧继续使用统一 `ConfirmDialogHost`，不新增弹窗组件。
- Root 的 `handleLogout` 在执行 `oauthService.logout()` 前先查询桌面主进程维护的运行中会话计数。
- 如果检测到运行中 agent session，确认文案显示具体数量；如果没有检测到，文案仍说明 App 会重启。
- “断开连接并重启”是完成退出登录流程的主操作，确认按钮使用统一 ConfirmDialog 的默认 primary 按钮；运行中会话风险只通过标题和描述说明，不降级为 warning/danger 按钮。
- 用户取消时不触发 telemetry、logout 或重启。
- 用户确认后按原有顺序清理 OAuth、provider family domain 和展示态，然后通过桌面命令请求 App 重启。

## 边界

- 运行中会话计数来自 main 进程已有的 host running task 统计，只用于桌面端确认文案，不把 session/task 业务状态下沉到 main。
- Web / mobile remote 不使用该重启命令；Web fallback 返回 0 个运行中会话并保持 no-op。
- 重启命令先走现有 app quit preparation，确保 host process 和 agent 子进程仍按桌面退出路径清理。
