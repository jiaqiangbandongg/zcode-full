# Tool Inline Diff

> **当前状态**：V4 tool row 通过 `ToolCallBlocks` 渲染，聊天内联 diff 使用轻量高亮预览；
> 完整 Diff Viewer 仍保留完整 diff 渲染能力。

## 背景

聊天区里的文件修改类 tool 之前只展示参数和原始输出，用户需要再点开 code viewer 才能看到实际 diff。

这次先做一个最小版本：

- 仅处理 `edit` / `patch` 一类能生成 patch 预览的 tool
- 直接在 tool 卡片内联渲染 unified diff
- 使用轻量、异步高亮的 unified diff，避免在聊天主线程挂载大型 Shadow DOM
- 继续保留“查看 Diff”按钮作为兜底入口

## 当前实现

入口在 `packages/ui/src/ToolCallBlocks/renderers/edit.tsx` 与
`packages/ui/src/ToolCallBlocks/renderers/EditInlineDiffContent.tsx`：

- 通过 `getToolCallCodePreview()` 判断当前 tool 是否能生成 `patch` 预览
- 对 `opencode` 这类 `edit` tool，优先解析 `raw.content` 里的标准 `diff` block
- 普通 tool call 先渲染成“状态 + 工具标题 + 可选摘要”的紧凑折叠行，默认不展开原始内容
- 运行中状态用 shimmer 状态文案，结束态 hover / focus 后才在右侧显示展开箭头
- 命中 `patch` 时，展开内容使用 `HighlightedLightweightDiffPreview`；不额外展示参数和原始 JSON 输出
- “查看 Diff”按钮仍保留，但要在用户点开对应 tool call 后才会出现

## 已知边界

- 当前同时消费结构化 file summary、patch preview 和旧快照/provider 兼容数据；兼容推断仍只属于 UI 展示层
- 只支持 unified diff，不支持 side-by-side
- 只处理当前 `codeViewer` 已能识别的 patch / before-after 结构
- tool call 摘要目前只从 `input` 的字符串 / `command` / `path` / `prompt` 派生，还没有覆盖更多工具专属字段

## 后续可扩展

- 把 diff 结构化类型补到 `@zcode/shared`
- services 层统一解析 ZCode 标准 `toolContent`
- 增加 side-by-side diff 和 location follow-along
