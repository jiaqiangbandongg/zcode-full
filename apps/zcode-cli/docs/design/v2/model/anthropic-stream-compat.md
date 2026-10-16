# Anthropic Stream Compatibility

Status: L1 Implemented

## 当前实现状态

Implementation status as of 2026-08-07: L1 已落地在 Anthropic provider
fetch 边界。`packages/adapters/src/model/registry.ts` 只在
`provider.kind === "anthropic"` 时把 provider fetch 包装为
`createAnthropicStreamCompatFetch()`；`openai-compatible`、`openai`、`gateway`
和 custom provider 不经过该兼容层。

已实现：

- `packages/adapters/src/model/anthropic-stream-compat.ts` 只处理
  `content-type` 包含 `event-stream` 的响应，非 SSE 响应原样返回。
- 兼容 transform 会识别 assistant stream 中非标准的裸
  `content_block_start.content_block.type === "tool_result"`，按 `index` 丢弃
  start、delta 和 stop frame，并在 `message_start` 时清理跨 message 状态。
- 合法 text、`server_tool_use`、`web_search_tool_result` 等 frame，非 JSON SSE
  frame，以及 `[DONE]` 都原样透传。thinking frame 在无需补全签名时也原样透传；
  若 provider 只在 `content_block_start` 的 thinking block 中携带非空
  `signature`，兼容层会在同 index 的 `content_block_stop` 前补一个标准
  `signature_delta`。如果流中已经出现原生 `signature_delta`，则不重复补全。
- `message_start` 会同时清理待补 thinking signature 和待过滤 block index，避免
  前一个 message 的未闭合状态污染下一个 message。
- 包装后的 SSE 响应会移除已失效的 `content-length` 和 `content-encoding`，避免
  过滤后 response metadata 与 body 不一致。
- Anthropic function tool 投影默认显式关闭 AI SDK 的 eager input streaming，
  使请求体不携带 per-tool `eager_input_streaming` 字段。这个字段属于 provider
  兼容敏感能力，部分 Anthropic-compatible 后端、协议转换代理和 gateway 路由会把它当
  unknown tool schema field 拒绝；ZCode 当前先采用稳定兼容优先策略。

测试覆盖在 `packages/adapters/tests/registry.test.ts`，包括裸 `tool_result`
过滤、typed result 保留、thinking start 签名补全、原生 signature delta 去重、
非 event-stream 不改写和非 JSON SSE frame 透传。

## 背景

ZCode 图片输入经由 Anthropic-compatible provider 时，部分后端会在 assistant
SSE 中暴露 provider 内部工具结果。例如图片分析后端可能先返回
`server_tool_use`，随后在同一 assistant stream 中返回裸 `tool_result`。

Vercel AI SDK 的 `@ai-sdk/anthropic` 会在 provider 边界用运行时 schema 校验
`content_block_start.content_block.type`。Anthropic response stream 中允许
`server_tool_use`、`web_search_tool_result`、`mcp_tool_result` 等 typed result，
但不接受裸 `tool_result`。裸 `tool_result` 通常属于下一轮 user message 中对
client-side `tool_use` 的响应，不应作为 assistant stream content block 出现。

## 兼容策略

ZCode 不 patch `@ai-sdk/anthropic`，也不改变 ZCode 图片输入格式。兼容逻辑收敛在
model adapter 的 Anthropic provider fetch 边界：

- 仅处理 `content-type` 为 `text/event-stream` 的响应。
- 除下述裸 `tool_result` 过滤和 thinking signature 补全外，保留合法 SSE event
  的原始内容和顺序。
- 当 `content_block_start.content_block.type === "thinking"` 且其 `signature` 是
  非空字符串时，按 block `index` 暂存该签名。
- 如果同 index 后续出现原生 `content_block_delta.delta.type ===
  "signature_delta"`，立即清除暂存签名并原样透传原生 delta，禁止重复合成。
- 如果同 index 到 `content_block_stop` 仍有暂存签名，在原始 stop frame 之前合成
  一个标准 `content_block_delta`，其 delta 为
  `{ type: "signature_delta", signature }`；随后清除该 index 的暂存状态并原样
  透传 stop。合成 frame 不提前到 thinking delta 之前，也不改变其他 frame 的顺序。
- 当遇到 `content_block_start` 且 `content_block.type === "tool_result"` 时，
  将该 `index` 标记为 provider-internal 非标 block，并丢弃该 frame。
- 丢弃同一 `index` 的后续 `content_block_delta` 和 `content_block_stop`；收到
  stop 后清理标记。
- 不改写为 `mcp_tool_result`、`web_search_tool_result` 或 text block，避免伪造
  provider 语义或重复展示内部工具输出。
- 收到 `message_start` 时清空待补签名和待过滤 index；状态只属于当前 assistant
  message，不允许跨 message 继承。
- 非 event-stream 响应、无法解析为 JSON 的 SSE frame、以及合法 typed result
  必须原样透传。

这个策略等价于把 provider 内部工具痕迹从 Anthropic stream 中剥离，让后续的
thinking/text 继续进入 AI SDK。若后端修正为标准 Anthropic-compatible stream，
该兼容层不应改变行为。

### Tool Input Streaming 字段策略

`@ai-sdk/anthropic` 默认会在 streaming Anthropic 请求的每个 function tool 上注入
`eager_input_streaming: true`。ZCode 的 provider adapter 必须默认关闭该注入：

- 普通 client-side function tool 转成 AI SDK tool 时，设置
  `providerOptions.anthropic.eagerInputStreaming = false`。
- 这个 provider option 只用于影响 AI SDK 的 Anthropic 请求体序列化，不进入
  ZCode 的 `ModelToolContract`、tool runtime schema、session event 或 UI 投影。
- Provider-native tools 不追加该 option；它们按各自 provider-native contract 处理。
- 后续若重新启用 fine-grained tool input streaming，必须先补 provider capability
  contract，按 provider/baseURL/model allowlist 或显式配置开启，并覆盖代理拒绝字段、
  invalid partial JSON、max_tokens 中断和 stream recovery 测试。
- 即使默认不主动请求 Anthropic eager input streaming，adapter 仍必须能消费任意
  provider 已经返回的 `tool-input-start/delta/end`，按
  `streaming-tool-execution-and-recovery.md` 的 assembler 规则合成唯一
  `tool_call`。是否发送 `eager_input_streaming` 请求字段仍由 provider
  capability gate 决定。

## 可观测性与错误边界

兼容层不吞掉 HTTP 错误、provider business error 或 stream 传输错误。它只过滤
已经成功建立的 SSE 响应中的特定非标 content block，或把 thinking start 中已有的
签名投影为 AI SDK 可读取的标准 signature delta；不会生成、校验或修改签名内容。
上游 JSON 业务错误仍由现有 provider business error fetch 检测。

## 测试覆盖

测试需要覆盖：

- 裸 `tool_result` block 及同 index stop 被过滤。
- 普通 text/thinking/server_tool_use event 保留。
- thinking 签名只出现在 `content_block_start` 时，在同 index 的
  `content_block_stop` 前合成一个 `signature_delta`，原始 start、thinking delta
  和 stop 的相对顺序保持不变。
- 同 index 已有原生 `signature_delta` 时不再合成，原生签名及事件顺序原样保留。
- SSE frame 跨 transport chunk、CRLF frame separator 与末帧缺少空行时，仍在 stop 前合成
  唯一签名事件，并保持已有 framing。
- 新 `message_start` 会清除未闭合 block 的待补签名状态，不会把上一条 message 的
  签名补到下一条 message。
- 非流式 JSON thinking 的空字符串 `signature` 与 `redactedData` 仍视为已有 metadata，
  不会被 unsigned-thinking 兼容清理误删。
- 合法 typed result，例如 `web_search_tool_result`，不被误删。
- 非 event-stream 响应不被改写。
- 非 JSON SSE frame 原样透传。
- Anthropic client-side function tool request options 显式包含
  `providerOptions.anthropic.eagerInputStreaming = false`，从而不产生
  `eager_input_streaming` 请求字段。
