# Compact Thinking Control

## 背景

Compact summary 是一次短输出的辅助请求。runtime 通过 `ENABLE_COMPACT_SUMMARY_THINKING`
决定是否把主对话的 reasoning/thinking providerOptions 透传给 compact。这个开关只控制
summary 是否使用 thinking；Anthropic fixed thinking 与可见输出仍共享 compact 的请求总预算，
由 adapter 在当前请求内限制 oversized thinking，不修改主对话配置。

## 行为

- `ENABLE_COMPACT_SUMMARY_THINKING` 为 `false` 时，compact summary 请求会禁用 inherited thinking/reasoning providerOptions。
- `ENABLE_COMPACT_SUMMARY_THINKING` 为 `true`（当前默认）时，compact 继续透传当前 `modelProviderOptions`；Anthropic fixed thinking 仍受本次请求总预算约束。
- 普通对话、subagent、标题生成等非 compact 请求不受这个开关影响。

## 范围

这里只控制 compact summary request 是否继承 reasoning/thinking providerOptions，不负责请求总预算
约束，也不改变 compact prompt、history selection、UI compact divider 展示或普通模型请求的
reasoning 配置。
