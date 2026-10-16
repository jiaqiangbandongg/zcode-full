# Edit Tool 模型可见结果契约

## 背景

Edit 工具的 provider-visible `tool_result` 是模型判断编辑是否生效、是否需要重读文件的依据。
本文约束 Edit 成功与失败时的模型可见文本、`old_string` 的转义匹配，以及 read-before-edit
的读取状态判定。

## 行为

- 成功 Edit 的模型可见文本需要带 freshness suffix：
  ` (file state is current in your context — no need to Read it back)`。
- Edit 执行错误进入模型上下文时需要包装为
  `<tool_use_error>...</tool_use_error>`，但 UI/日志使用的原始错误消息仍保持裸文本。
- `old_string` 中的 `\uXXXX` escape 应能匹配文件中的真实字符，例如
  `<tag>` 匹配 `<tag>`。
- 已读取且未变更的 partial view read state 可作为 Edit 的 read-before-edit 依据；
  文件变更后仍必须走 stale guard。

## 目标

1. Edit success/error 的模型可见文本使用上述固定形态。
2. 保持 Edit error 的结构化错误类型和 UI 展示消息不被 `<tool_use_error>` 包装污染。
3. 支持 unicode escape fallback 的 `old_string` 匹配。
4. 保持 stale 文件保护，不因为允许 partial read state 而放宽已变更文件的写入保护。

## 非目标

- 不修改桌面端、Web 端或手机远控链路。
- 不修改 Read/Bash/WebSearch 等其它 tool 的模型可见错误格式。

## 验证

- `apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts`
- `pnpm typecheck`
- `pnpm lint`
