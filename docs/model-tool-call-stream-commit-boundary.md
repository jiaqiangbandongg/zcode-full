# Model Tool Call 流式提交边界

## 背景

模型 provider 会把工具参数拆成多个 delta 返回。一个尚未结束的参数前缀可能已经是合法 JSON，
例如先收到 `{}`，随后仍继续追加字段。因此“当前可以 `JSON.parse`”只描述语法状态，
不能作为工具调用完成或执行的依据。

当前锁定依赖为 `ai@6.0.193`、`@ai-sdk/anthropic@3.0.81`、
`@ai-sdk/openai@3.0.65` 和 `@ai-sdk/openai-compatible@2.0.60`。在 ZCode 当前可达的普通
agent-tool 路径中，provider adapter 会在同一个本地 transform / flush 中依次 enqueue
`tool-input-end` 和 final `tool-call`；两者会成为 AI SDK full stream 中相邻的本地事件，
中间不会再次读取 provider 网络流。

不同 provider 的完成时机仍由 AI SDK 适配：

- Anthropic Messages：`content_block_stop`；
- OpenAI Responses：工具 output item / arguments done；
- OpenAI-compatible Chat Completions：response stream `flush()`。

## 行为规范

ZCode 不再从 delta 合成可执行调用。普通主请求中，流式展示、重试缓冲和最终执行输入的关系如下：

```text
Provider SSE
    │
    ▼
AI SDK
    ├─ tool-input-start / delta / end
    └─ final tool-call(input)
                    │
                    ▼
ZCode retry-safe buffer
    ├─ start / delta / end ───────────────→ 仅展示，等待最终调用
    │
    └─ final tool-call
            │
            ├─ 严格归一化 final input
            └─ 一次刷出 start / delta / end / tool_call
                                          │
                                          ▼
                                    Core 调度与执行
```

- 不得因累计参数第一次 `JSON.parse` 成功而合成 `tool_input_end` 或 `tool_call`。
- 普通主请求中的 `tool-input-start`、`tool-input-delta` 和 `tool-input-end` 属于 final
  call 前的 retry-safe prelude；delta 只用于展示，不作为最终执行参数来源。
- 已出现 `tool-input-start` 的调用仍保留既有 end gate：缺少 `tool-input-end` 时，
  final call 不能替代结束事件，也不会被发布或缓存。
- 执行参数只取 AI SDK final `tool-call.input`。这能保留只出现在 final input、未出现在
  delta 中的 provider 初始参数。
- final `tool-call` 到达后，Adapter 严格归一化一次并作为既有 retry boundary 刷出此前缓冲事件。
- final call 前发生网络失败时，继续使用既有 Adapter retry：丢弃当前 attempt 的展示前缀，
  不从 delta 猜参数。
- 没有 start/delta 的原子 `tool-call` 直接按 final call 处理。
- 同一 id 的重复 final call 只发布一次。
- `tool-input-start.providerExecuted` 仅作为既有元数据兼容：final call 显式提供时以 final 为准，
  final 省略时回填 start 值；这不增加新的提交、重试或执行语义。
- malformed/null 的严格归一化与 `{}` 恢复规则见
  [Model Tool Call Validation](./model-tool-call-validation.md)。

当前 SDK 的 end/call 是同一次本地转换产生的相邻事件；ZCode 在同一 attempt 中消费这对事件，
并继续使用既有 Adapter retry、Core recovery 与 Compact 策略。

## 多 provider 时序

```text
Anthropic content_block_stop ──────┐
OpenAI Responses item done ────────┼─→ AI SDK tool-input-end
OpenAI-compatible stream flush ────┘             │
                                                 └─→ final tool-call
                                                          │
                                                          ▼
                                              ZCode 严格归一化并发布
```

Anthropic 和 OpenAI Responses 保留各自逐调用完成时机。OpenAI-compatible 的 Chat Completions
协议没有标准逐调用 done，当前适配器会在 response stream flush 时结束仍在累计的工具参数。
ZCode 统一消费 AI SDK 事件，不再自行设计 provider capability 或检查 `finish_reason` / `[DONE]`。

Compact 继续由既有 raw provider boundary 决定 SSE/fallback 重试边界，不套用普通主请求的
prelude 分类；但同样不从 delta 合成调用，并且只用 final `tool-call.input` 执行。Core
stream recovery、provider-executed ownership 与 request cancellation 行为保持不变。

## 验收标准

- 参数前缀第一次可解析时不生成 `tool_call`。
- `start/delta` 后、final call 前发生可重试网络错误时，Adapter 可以发起下一 attempt。
- 已进入 streaming input 但缺少 `tool-input-end` 时，不发布 `tool_call`。
- `tool-input-end` 后紧邻 final call 时，按 `start/delta/end/tool_call` 顺序只发布一次。
- 即使 delta 已经是可解析 JSON 且只包含部分字段，发布的 input 仍必须完整取自 final
  `tool-call.input`，保留仅存在于 final call 的 provider initial input。
- final call 的 malformed/null input 不打断模型请求，具体恢复行为由 validation spec 覆盖。
- 原子 final call 使用相同归一化路径。
- 普通请求与 Compact 不再按“首次 JSON 可解析”提前合成调用；Compact 其他行为保持原样。
