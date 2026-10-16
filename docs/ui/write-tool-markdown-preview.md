# Write Tool Markdown Preview

> **当前状态**：V4 tool row 通过统一的 `ToolCallBlocks` 正文组件实现该预览。

`write` / `create` / `save` 类工具在卡片详情里展示文件内容预览时，如果目标文件扩展名是 `.md`，会直接按 Markdown 正文渲染；其他文本文件继续使用代码块高亮。

## 交互规则

- Markdown 预览复用聊天消息的 `MessageResponse` 渲染能力，支持标题、列表、代码块和链接。
- 指向工作区内文件的相对链接会继续走 Code Viewer 打开。
- 预览区保留固定最大高度和滚动容器，避免长文档撑开工具卡片。

## 实现入口

- `packages/ui/src/ToolCallBlocks/ToolCallBody.tsx` 的 `InlineCodeContent`
- `packages/ui/src/lib/codeViewer.ts` 的 `inferCodeLanguage`
