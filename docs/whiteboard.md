# Whiteboard

右侧共享 pane 新增 `Whiteboard` tab，与 Browser、Review、Treemapping 使用同一套 side pane tabs。

## 行为

- 新建画板时按当前 workspace 隔离，workspace key 使用 `workspaceIdentity?.trim() || workspacePath`。
- 默认名称按当前语言生成，例如 `画板 1` / `Whiteboard 1`，同一 workspace 内不会重复。
- 画板内容保存为笔画数据，包含工具、颜色、粗细和点位；关闭 tab 不会删除画板。
- 聊天输入框的 `@` 面板会展示当前 workspace 的画板。用户选中画板时才把当前笔画导出为 PNG，并作为现有 `image` 附件加入 composer。
- 画板 pane 工具栏提供“添加到对话区”按钮，点击后把当前画板导出为 PNG 并加入当前聊天输入框附件区。按钮只发起 UI 内事件，真正的导出、附件上限校验、草稿和焦点恢复仍由 composer 统一处理。

## 边界

- 画板是 UI 层能力，不新增 Agent runtime、relay、main process 或服务端状态。
- 图片发送复用现有 `ZCodePromptAttachment.kind === "image"` 路径；Agent 不支持图片时沿用现有错误处理。
- Web 远控和桌面端都走同一条 composer 附件链路，不改变 desktop continuous 与 web remote replayable 的 task stream 边界。
