# Anthropic Thinking Max Output Budget

## 背景

MiMo Anthropic-compatible 请求在启用 `thinking.type = "enabled"` 时，AI SDK 会把请求层的 `maxOutputTokens` 与固定 `thinking.budgetTokens` 一起计入最终 provider 可见的 `max_tokens`。当模型 metadata 的 `maxOutputTokens` 已经等于 provider 最大输出上限时，继续叠加 thinking budget 会让最终 `max_tokens` 超过 provider 支持范围。

现场失败请求：

- provider/model: `default-mimo/mimo-v2.5-pro`
- requestId: `d19aedba-9da4-477a-9765-696c9cb5eb00`
- request `maxOutputTokens`: `131072`
- request `thinking.budgetTokens`: `1024`
- provider 报错：`max_tokens 132096 is out of supported range (0, 131072]`

## 目标

- Anthropic transport 下，core 选出的 `maxOutputTokens` 是 thinking 与可见输出共享的总预算，最终 provider `max_tokens` 不得超过该值。
- fixed thinking 大于总预算时，只限制当前请求中的 thinking budget，不修改共享 provider options。
- 非 Anthropic transport 不改变现有行为。
- 未启用固定 thinking budget 时不改变现有行为。

## 方案

fixed thinking budget 必须小于最终 `max_tokens`，即限制为 `min(configuredBudget, max_tokens - 1)`。
ZCode 通过 AI SDK 发送请求，而 AI SDK 会把 `maxOutputTokens` 与 thinking budget 相加，因此在
adapter 请求选项构造阶段统一投影两个请求值：

```text
effectiveThinkingBudget = min(configuredThinkingBudget, requestedMaxOutputTokens - 1)
aiSdkMaxOutputTokens = requestedMaxOutputTokens - effectiveThinkingBudget
```

归一化后的总预算小于 2 时，fixed thinking 与可见输出无法同时获得至少 1 token。adapter
必须在网络请求前抛出 `InvalidModelRequest`，不得合成零或负的 thinking budget，也不得静默关闭
用户配置的 thinking。这里不引入 Anthropic 官方的 1,024 token 下限；大于等于 2 的预算继续
按上述公式投影，保留 Anthropic-compatible BYOK endpoint 的协议空间。

例如 Compact 总预算为 20,000、fixed thinking 为 32,000 时，本次请求使用
`thinking.budgetTokens=19,999` 和 `maxOutputTokens=1`，AI SDK 最终发送
`max_tokens=20,000`。投影必须克隆当前请求的 Anthropic options，后续主请求仍使用原始 32K
thinking 配置。

其中 `requestedMaxOutputTokens` 仍遵循现有规则：

- 显式 request `maxOutputTokens` 优先。
- Anthropic transport 缺省时继续使用 adapter 默认 `32000`。
- 非 Anthropic transport 缺省时继续不传。

不修改 preflight 的 candidate/baseline 选择，不关闭 Compact thinking，也不增加 minimum、重试、
fallback 或 side-request 特例。

## 验证

- 单测覆盖 Anthropic `generateText` 与 `streamText` 在固定 thinking budget 下扣减预算。
- 单测覆盖总预算 0.5 和 1 在请求发送前返回 `InvalidModelRequest`，总预算 2 仍可投影为
  1 token thinking 与 1 token 可见输出。
- 单测覆盖 fixed thinking 大于总预算时同步限制本次请求 options，且原始 options 不变。
- wire test 覆盖 Compact 场景最终发送 `max_tokens=20000` 与 `thinking.budget_tokens=19999`。
- 单测覆盖 OpenAI-compatible transport 不受影响。
- 执行 `pnpm typecheck` 与 `pnpm lint`。
