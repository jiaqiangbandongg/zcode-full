# Code Comment Viewer

代码查看面板支持在行级范围上添加本地 comment，用作后续对话上下文能力的交互入口。

## 交互范围

- hover 行号栏时显示添加 comment 按钮。
- 桌面端 hover / focus 添加 comment 按钮时在按钮右侧显示轻量 tooltip，提示支持点击或拖拽；手机端不依赖 hover，点击仍直接进入评论输入。
- 点击按钮为单行添加 comment；按住并拖过其他行可选择连续行范围。
- 松开拖拽后，在范围末行下方打开 comment 输入框；comment 文本可不填，直接提交时只把代码范围作为会话上下文。
- 提交后，comment 预览显示在对应范围末行下方；删除预览不会修改源文件。
- 提交后的 comment 会作为聚合 chip 显示在聊天输入框顶部，形态和普通附件一致。
- 移除聊天输入框里的 comment chip 时，会同步清理 code viewer 中的本地预览。
- 可以从其他项目的 code viewer 把 comment 添加到当前对话框；附件会保留来源 `workspacePath` / `workspaceIdentity` 和完整文件路径。
- 关闭文件 tab 后，再打开同一 workspace + 文件路径时，会从 renderer 内的 preview store 恢复尚未提交/移除的 comment 预览。

## 实现边界

- 当前阶段完成 code viewer 内的交互、本地预览，以及 composer 顶部和用户消息里的 comment 附件展示。
- comment 不写入源文件。
- comment preview 只在当前 renderer 生命周期内保存；刷新窗口或重启应用后不会恢复。
- 发送 prompt 时，复用 `codeCommentContext` 中的结构化 prompt 工具拼接上下文；跨项目 comment 使用来源 workspace 信息做 preview 清理，不使用当前 composer 的 workspace 过滤添加事件。
- 添加 comment 按钮继续使用 `@pierre/diffs` 内建 gutter utility 与 `onGutterUtilityClick`，tooltip 仅通过 Shadow DOM 内 unsafeCSS 和 `title` / `aria-label` 增强，不切换到自定义 `renderGutterUtility`，避免破坏拖拽选择多行范围。

## 布局说明

普通代码行使用父级 grid 的行号列和代码列。comment 输入框/预览需要在横向滚动时固定在可视区域内，因此使用 sticky 的内部 grid；内部 grid 的内容列起点通过读取父 grid 中真实 code cell 的左边界对齐，避免行号位数变化导致错位。
