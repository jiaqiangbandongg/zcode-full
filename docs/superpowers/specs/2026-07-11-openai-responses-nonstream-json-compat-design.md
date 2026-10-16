# OpenAI Responses 非流式 JSON 最小兼容设计

> 2026-07-15 更新：本文的 JSON normalizer 和 provider 边界继续有效；“compact 固定非流式”合同已被
> [Compact Stream-first → Non-stream Fallback 设计](./2026-07-15-compact-stream-first-nonstream-fallback-design.md)
> 取代。该兼容器现在服务于 compact streaming 失败后的 HTTP fallback leg。下文保留原始设计背景，
> 其中固定 non-stream 的描述仅代表 2026-07-11 的实现基线。

## 背景与根因

部分第三方 OpenAI Responses 服务在流式请求中返回可被 AI SDK 接受的 SSE 事件，但在非流式
JSON 响应中省略官方 Responses 结构要求的字段：

- `output[].type === "message"` 时省略 `id`；
- `output[].content[].type === "output_text"` 时省略 `annotations`。

ZCode 的主会话默认走流式请求，而 compact 固定调用 `modelAdapter.generateText()`。因此同一个
provider/model 可以正常完成主会话，却在 compact 的 HTTP 200 响应进入
`OpenAIResponsesLanguageModel.doGenerate()` 后，被 AI SDK 以 `Invalid JSON response` 拒绝。

当前工作区实际使用的 `@ai-sdk/openai` 仍在非流式 Responses schema 中要求上述两个字段。
这不是请求参数、鉴权、网络或 compact prompt 问题，而是第三方 Responses 非流式返回体不完整。

## 目标

在不改变 compact 非流式合同、不修改 AI SDK、不影响其他协议的前提下，让已确认的缺字段
Responses JSON 可以通过 AI SDK 校验并返回文本。

## 兼容边界

新增独立的 OpenAI Responses JSON fetch 兼容器，并只在 adapter registry 的
`providerKind === "openai"` factory 分支组合：

```ts
const providerFetch = createProviderBusinessErrorFetch(...);

createOpenAI({
  ...,
  fetch: createOpenAIResponsesJsonCompatFetch(providerFetch),
}).responses;
```

`createProviderBusinessErrorFetch()` 继续只负责所有 provider 共用的网络代理与业务错误识别。
Responses 返回体兼容不得放入该共享 fetch，也不得进入 `anthropic`、`gateway` 或
`openai-compatible` factory。

ZCode 的 provider 类型合同已经把 `providerKind === "openai"` 唯一映射为
`apiFormat === "openai-responses"`。registry 必须显式返回 AI SDK 的 `provider.responses`
factory，让 factory 组合本身成为协议判据；兼容器不得通过请求 URL、method、模型名或 baseURL
再次猜测协议。

兼容器只处理该 Responses factory 返回且同时满足以下条件的响应：

1. HTTP 状态为 2xx；
2. 响应不是 `text/event-stream`；
3. body 是可解析的 JSON object，且 `output` 是数组。

任一条件不满足时返回原始 `Response`。

## 最小归一化规则

只归一化已由历史日志和当前 AI SDK 最小复现确认的两种缺失字段：

1. 对 `type === "message"` 且 `id === undefined` 的 output item：
   - 只有顶层 `response.id` 是非空字符串时才补 ID；
   - 使用 Node `node:crypto` 的 `randomUUID()` 补为 `msg_<UUIDv4>`，避免复用 provider
     已返回 ID 的可预测命名空间；不新增 UUID 依赖或 collision resolver。
2. 对上述 message 的 `type === "output_text"` 且 `annotations === undefined` 的 content item，
   补为 `annotations: []`。

以下输入不属于本次归一化范围，继续交给 AI SDK 校验：

- 除上述两个字段缺失之外的 schema 问题；
- 非 message output item；
- 非 output_text content item；
- 顶层 `response.id` 无效时缺失的 message ID；
- 无效 JSON、错误响应与 SSE。

只有确实发生归一化时才重建 `Response`。重建时保留 status、statusText 和其他 headers，并删除
已经失效的 `content-length` 与 `content-encoding`。合法 Responses 响应必须返回原始
`Response` 实例。

## 明确不做

- 不把 compact 改为 `streamText()`，继续保留其非流式请求合同。
- 不在非流式失败后回退到流式重试，避免重复请求、重复计费和潜在副作用。
- 不修改、fork 或放宽 AI SDK schema。
- 不给所有 output item 补 ID，不兼容其他未观察到的缺失字段。
- 不根据模型名、provider 名或 baseURL 建立名单。
- 不根据 URL pathname 或 HTTP method 推断 Responses 协议。
- 不修改 Chat Completions、Anthropic、Gateway、reasoning policy 或请求 payload。
- 不新增 model-io、prompt-trajectory、遥测字段或协议事件。

## 错误与诊断合同

兼容器无法解析或不满足最小规则时必须返回原始响应，让 AI SDK 保留现有
`AI_APICallError: Invalid JSON response` 及具体 validation issues。不得吞掉错误、改写成空文本或
触发额外重试。

## 验证范围

### 单元与集成测试

- pure normalizer：缺失 message `id` 与 output_text `annotations` 时只补这两个字段，
  message ID 符合 `msg_<UUIDv4>`；
- 合法 Responses JSON 返回原始 Response，body 不变；
- 未知 output item 不被修改；
- SSE、非 2xx 响应保持原样；
- 使用 fake API key 与本地 fake HTTP server，真实经过
  `AiSdkModelRegistry -> AiSdkModelAdapter.generateText -> @ai-sdk/openai doGenerate`，证明历史缺字段
  JSON 最终返回 compact summary 文本；
- registry 集成测试证明 `openai` 显式选择 Responses factory，并以最相邻的
  OpenAI-compatible Chat Completions 为负向对照，证明其 response body 不进入该兼容器；
  Anthropic 与 Gateway 的互斥 factory 分支保持不变。

### E2E

新增一个 case-local fake Responses server 场景：

1. 主会话 `stream: true` 返回合法 SSE 并成功；
2. `/compact` 发出非流式 `/responses` 请求；
3. fake server 的非流式 JSON 刻意省略 message `id` 和 output_text `annotations`；
4. compact 最终发布 completed boundary，并保留 summary marker；
5. 抓包证明 provider 原始响应确实缺字段，同时没有请求 Chat Completions endpoint。

测试只使用 fake API key 和本地 server，不依赖真实 provider。

该场景是现有手动 compact success 产品状态 F08 的 provider 兼容补充证据，不新增独立的
conversation product case、自动化缩写或 coverage audit 规则，也不改变产品 case 统计。

扩展 compact harness 时保持既有 artifact 合同：dry-run 的顶层 `model`、`baseURL` 和 suite
结果的顶层 `model` 继续存在。单独运行具有 case-local model 的场景时，顶层 `model` 可以使用
该场景的准确值；多 case 仍保留原有默认 model，并由具体 case 的 `model` 字段表达例外。
case registry 解析必须位于 suite 的统一 `try/finally` 内，确保注册表异常仍进入失败落盘和
既有的诊断目录保留策略。

## 验收标准

- 当前 AI SDK 下的历史缺字段最小复现由失败变为成功；
- compact 仍发送非流式 Responses 请求；
- 主会话 SSE 行为不变；
- 其他 provider kind 与协议的请求和响应字节不变；
- 不产生额外请求或重试；
- 相关测试、`pnpm typecheck`、`pnpm lint` 通过。
