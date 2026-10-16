# ZCode Computer Use 权限设置入口

## 目标

ZCode CUA 的 macOS product 权限主体必须是外置 `ZCode Computer Use.app`。设置页保留用户主动
权限入口；本地 desktop continuous 的官方 `request_access` 实时结果可以经可信 Host 确认后复用
同一 onboarding。聊天错误、tool card 文本和 PermissionDialog 不挂 CUA 权限副作用。启用插件
成功后只刷新状态，不自动打开权限 UI。

## 交互

- Computer Use 设置页提供 Accessibility 和 Screen Recording 两个权限入口。
- 2026-08-17 设置面收敛后，设置页不再展示 Helper 运行态/身份行与 Input controller 行；
  分区只剩总开关 + 两个权限行（见
  `docs/superpowers/specs/2026-08-17-cua-settings-surface-minimization.md`）。
- 旧版可拖拽 Helper tile 的 IPC 链（Prepare/StartCuaHelperPermissionDrag）
  已在 2026-08-16 审计中删除——渲染层零调用；授权引导统一走 `openCuaPermissionOnboarding`。
- Accessibility 入口会拉起 Helper，让 Helper 自己触发 macOS Accessibility prompt。Screen
  Recording 没有等价 prompt API，只打开对应系统设置页。
- 后台任务的官方 `request_access` 明确报告缺权时，窗口级监听先只读复查 Helper 状态，再弹
  ZCode ConfirmDialog。用户确认后再次复查并按 Accessibility → Screen Recording 顺序打开仍缺失项；
  取消、本轮重复结果、状态已恢复、未知或不可用均不打开系统设置。

## 边界

- 授权目标固定为 `${ZCODE_HOME:-$HOME/.zcode}/computer-use/ZCode Computer Use.app`。
- Python、Terminal、`uvx`、local checkout 或 legacy `ZCode.app` broker 不得显示 product
  onboarding。
- `zcode-cua` 通过 namespaced `_meta["zcode.cua/request-access-status-v1"]` 提供最小权限快照，
  不新增 MCP tool，也不把 broker token、socket token、argv 或 config args 放进 UI metadata。
  Consumer 只接受 authority-verified official `request_access`，普通文本解析不能触发 onboarding。
- Web/非 macOS 端不实现授权引导，只保留普通诊断或不显示该动作。
- mobile replayable、cold snapshot/recovery、SSH/WSL/Docker workspace 不接收 live permission
  observation。授权完成后不自动恢复或重放原任务。
- Renderer 发送的 onboarding request 只包含 `operationId`、`initialPermission` 和
  `requiredPermissions`；早期 `prepareAllRequired` / `missingPermissions` 输入不再属于 IPC 契约。
- Main 内部继续持有 Helper 路径、签名 identity 与 `openedPermissions` 作为验签和 session
  协调事实，但跨 IPC 只返回 `success/canceled/sessionId/returnedFromSettings/
restartHelperAfterReturn/error`。Renderer 不接收 Helper 文件系统路径或身份诊断字段。
- 从系统设置返回并成功完成 Helper 重启后，Settings 只显式请求一次真实截图探针；普通轮询和
  focus refresh 始终只读。

## 验证

- Unit：desktop main opener、Settings 与 live request_access 复用同一 onboarding、插件启用后仅 refresh、
  ordinary error/history/mobile/remote 无副作用。
- Product 手测：从 Computer Use 设置页打开 Accessibility/Screen Recording；授权返回后设置页
  状态应刷新；后台任务的 live request_access 先显示确认框，取消不打开设置，确认后只处理新鲜缺权项。
