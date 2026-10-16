# 模型请求 provider 兼容后续 Action

> 状态：差异已审计，未纳入本轮输出 token 最小修复。本文不修改 Compact、`extra_body`
> 展开优先级、空回复状态或 UI。

## 当前协议职责

| 请求协议               | 当前实现                     | 字段序列化责任                                                  |
| ---------------------- | ---------------------------- | --------------------------------------------------------------- |
| OpenAI Compatible Chat | 已接入                       | AI SDK 将 `maxOutputTokens` 映射为 `max_tokens`                 |
| OpenAI Responses       | 已接入                       | AI SDK 将 `maxOutputTokens` 映射为 `max_output_tokens`          |
| Anthropic Messages     | 已接入                       | AI SDK 映射 `max_tokens`，并把 fixed thinking budget 加入最终值 |
| Gemini                 | 未接入对应 SDK/provider kind | 不能视为已由现有 AI SDK 路径支持                                |
| Bedrock                | 未接入对应 SDK/provider kind | 不能视为已由现有 AI SDK 路径支持                                |

ZCode 负责模型能力预算、provider 条件省略和最终 JSON body 的 provider-specific 改名；
AI SDK 只负责已接入协议的标准字段序列化，不负责 ZCode 的 provider/model 策略。

## Action 1：统一 providerOptions 深合并边界

当前存在四个不同的合并行为：

1. workspace provider options 与 model options 使用顶层浅合并；model 同名 namespace 会整体覆盖 provider namespace。
2. model target options 与 thought-level options 使用递归深合并。
3. 同一 provider 的多个 registry target 如果 `providerOptions` 不完全相等会报配置冲突。
4. adapter runner 将 resolved provider options 与 request provider options 顶层浅合并；之后仅对
   OpenAI Compatible 的 SDK namespace 做局部递归合并。

受影响字段包括：

- `anthropic.thinking`、`anthropic.effort`、cache/beta 类 options；
- `openai.reasoningEffort`、`reasoningSummary`、`store`、cache key；
- `openaiCompatible.extra_body`、`thinking`、`chat_template_kwargs`；
- gateway routing/caching namespace；
- 后续 Gemini、Bedrock provider namespace。

典型差异是 base 中 `{ anthropic: { custom: true, thinking: {...} } }` 与请求覆盖
`{ anthropic: { effort: "high" } }` 合并后，当前 runner 会丢失 `custom` 和 `thinking`。

后续实现应先明确唯一优先级，再将共享递归合并函数用于 provider→model→runtime request；
数组和标量仍由后者整体覆盖。`extra_body` 只参与普通对象合并，不改变其现有展开和同名字段优先级。

## Action 2：补齐 provider/model 默认请求参数矩阵

当前主轮次默认只显式设置模型输出预算和 reasoning providerOptions；`temperature`、`topP`、
`topK`、penalty、stop、seed 虽然存在于通用请求合同，但主轮次未设置时会交给 SDK/provider 默认值。

需要逐项评估而不是一次性全开：

- Responses/OpenAI-compatible 的 `store`、reasoning summary、encrypted reasoning continuation；
- session/prompt cache key；
- OpenRouter/Gateway usage 与 caching options；
- Gemini、Anthropic-compatible、Alibaba 等 reasoning/thinking 默认值；
- Qwen、Gemini、MiniMax、Kimi 等模型的 temperature/topP/topK 默认值；
- provider-required headers 与 tool streaming 开关。

每条默认值必须以 provider/model capability 为条件，并使用最终 request body 测试证明；未知 provider
保持不注入，避免把一个 provider 的扩展参数发送到所有兼容端点。

## Action 3：扩展 message/tool 兼容矩阵

当前已有：media capability projection、空媒体替换、Anthropic cache control、DeepSeek reasoning
回放、Anthropic thinking metadata、Responses stateless reasoning item 清理、Anthropic tool eager input
关闭和结构化 tool result 投影。

尚未统一覆盖：

- 非法 Unicode surrogate 清理；
- Anthropic/Bedrock 空消息和空 content part 过滤；
- Claude、Mistral 的 tool call id 字符集/长度要求；
- Mistral tool→user 消息序列修正；
- OpenAI、Moonshot、Gemini tool JSON Schema 降级；
- providerOptions namespace 在 message/content part 上的重映射；
- provider-specific no-op tool 与 tool-call repair。

后续应按真实 provider failure 逐项加入，不建立未知 provider 的自动猜测或失败重试。每项至少包含
纯 transform 测试和一个最终 provider-visible request body 测试。

## Action 4：新增一等 provider 协议

Gemini、Bedrock、Azure、Vertex 等不能仅靠当前 OpenAI Compatible 路径声明为完整支持。接入时需要同时提供：

- provider factory、鉴权和 endpoint 选择；
- providerOptions namespace 投影；
- reasoning/default options；
- message/tool schema compatibility；
- 最终请求体与流式响应测试。

优先级应按真实用户 provider 需求确定，不因 catalog 中存在模型记录就自动视为 runtime 已支持。
