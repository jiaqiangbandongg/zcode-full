# Prompt Editor 复用说明

> **当前状态**：`ChatPromptEditor` 由 V4 主 composer 和 V4 用户消息编辑态共同复用。

`ChatPromptEditor` 是聊天输入框的轻量共享编辑器，负责承载 `LexicalChatInput`、提交/取消按钮、可选快捷入口和 workspace file drop。主输入区和用户消息编辑态都通过它复用输入核心。

主 `packages/ui/src/v4/ConversationComposer.tsx` 保留 session 级能力，例如 toolbar、prompt enhance、附件选择和停止生成；`ChatPromptEditor` 只处理通用编辑能力。用户消息 edit 由 `packages/ui/src/v4/ConversationRowView.tsx` 使用同一 editor inline 替换原气泡，只展示原文编辑、取消、提交、附件只读展示和 file mention 拖拽插入。

workspace file tree 拖拽追加 mention 的逻辑集中在 `workspaceFileComposer`，避免主 composer 和 edit composer 分别拼接 markdown，保证 `@file` mention 语义一致。
