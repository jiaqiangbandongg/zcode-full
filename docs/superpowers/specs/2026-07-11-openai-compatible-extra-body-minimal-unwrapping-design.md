# OpenAI-compatible reasoning canonical request fields

## 状态

Implemented

## 背景与根因

ZCode 的 reasoning policy 和 bundled model catalog 曾把 OpenAI-compatible 扩展参数保存为
`openaiCompatible.extra_body`。runner 再把 wrapper 展开后交给
`@ai-sdk/openai-compatible`。这让同一参数在“模型配置”和“最终请求”之间存在两种表达，并且把
Python/OpenAI client 的 `extra_body` 调用参数误当成 provider 协议字段。

实际 provider 与 AI SDK 的合同都是 canonical direct options：

- `reasoningEffort` -> wire `reasoning_effort`
- `thinking` -> wire `thinking`
- `enable_thinking` -> wire `enable_thinking`

GLM-5.2 旧映射还把 `reasoning_effort` 放入 `chat_template_kwargs`，导致支持顶层
`reasoning_effort` 的 OpenAI-compatible gateway 拒绝请求。

本次只纠正 ZCode 自动生成的模型请求参数；不改变模型识别、思考档位集合、默认档位、UI、协议或
provider 连接选择。

## 请求合同

```text
model/catalog reasoning profile
          │ canonical AI SDK options
          ▼
providerOptions.openaiCompatible
          │ copy to resolved provider-name namespace
          ▼
@ai-sdk/openai-compatible
          │ serialize once
          ▼
provider wire body (no ZCode-generated extra_body)
```

ZCode 自动生成的 OpenAI-compatible 参数固定为：

| 模型合同                     | 档位                       | canonical option                                    | 最终 wire                                            |
| ---------------------------- | -------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| GLM-5.2                      | `max` / `high` / `nothink` | `reasoningEffort=max/high/none`                     | `reasoning_effort=max/high/none`                     |
| DeepSeek V4 自动推断         | `high/max`                 | `thinking.type=enabled` + `reasoningEffort=<level>` | `thinking.type=enabled` + `reasoning_effort=<level>` |
| Qwen thinking toggle         | `enabled/off`              | `enable_thinking=true/false`                        | `enable_thinking=true/false`                         |
| Kimi/MiMo 等 thinking toggle | `enabled/off`              | `thinking.type=enabled/disabled`                    | `thinking.type=enabled/disabled`                     |

GLM-5.2 的 UI key `nothink` 保持不变，只在 provider option 边界映射成 `none`；不新增 alias 或 UI
档位。

DeepSeek V4 的内置精确 catalog 可展示 `off/high/max`；上表只描述没有精确 catalog 时的自动推断。
`low/medium` 仅作为旧配置值归一化到 `high`，不是 canonical 可展示档位。

## 兼容边界

- 现有 programmatic/user config 若显式传入 `openaiCompatible.extra_body`，runner 继续按既有逻辑浅展开，
  保持向后兼容。
- ZCode 自己的 reasoning policy、workspace catalog 补全和 bundled catalog 不再生成
  `extra_body`。
- canonical direct 字段仍复制到 SDK 实际读取的动态 provider-name namespace；raw provider-name
  override 的既有优先级不变。
- title/goal-title 这些短 sidecar 继续要求关闭思考，并共用同一份模型感知 no-thinking 转换；Git commit message 生成需要区分调用意图：当请求携带显式 thought variant 时，保留用户选择的 thinking/providerOptions；当没有显式 variant 时，仍按 no-thinking sidecar 投影关闭继承的思考。Bug 原因：commit message 是用户主动触发的提交消息生成，使用当前选中模型与思考强度；旧合同把它和自动 title sidecar 归为同类，会把始终思考模型的 `max/high/low` 错误改成 disabled。
- no-thinking 转换必须在删除 inherited effort 前保留原始 options：对已经存在的 direct thinking toggle 设为 disabled；GLM-5.2 和明确支持 `none` 的 GPT 基础模型将 effort 转换为 canonical `reasoningEffort=none`。MiniMax M3 在 reasoning options 缺失时按已有 `apiFormat` 写入官方关闭参数；没有 off 合同的 effort-only 模型只移除 inherited effort，不伪造 `none`。
- GPT minor version 只识别官方点号形式（例如 `gpt-5.1`）；`gpt-5-2025-08-07` 这类 GPT-5 日期快照不得把年份误判成 minor version，也不得写入其不支持的 `none`。
- compact 保持既有边界；所有路径都不得为了关闭思考新建 `extra_body`。

## 明确不做

- 不删除显式用户 `extra_body` 的兼容解包。
- 不修改 provider/模型识别规则、reasoning levels、默认选择或 models-dev snapshot。
- 不增加 Base URL 推断、字段 allowlist、400 后删字段重试或 provider 特判。
- 不修改 UI、ZCode Protocol、持久化、队列、remote 或 workspace identity。
- 不把 bundled catalog 的 context window、max output 或其他 metadata 投影到 runtime。

## 验证范围

- adapter policy/unit tests 独立断言 canonical provider options，不复制生产 helper 作为预期。
- 使用真实 `@ai-sdk/openai-compatible` 与 fake fetch 直接断言 GLM、DeepSeek、Qwen 和 thinking
  toggle 的最终 wire body，且 ZCode 自动生成路径不含 `extra_body` 或 `chat_template_kwargs`。
- core sidecar 表驱动测试覆盖 GLM、DeepSeek、Qwen、Kimi K2/K3、MiMo、MiniMax、Claude 和 GPT：支持 off 的模型产生正确关闭参数，不支持 off 的模型不伪造 `none`，所有路径都不重新合成 `extra_body`。
- core runtime 测试覆盖 Git commit message 未携带显式 variant 时使用 GLM-5.2 canonical effort 生成 `reasoningEffort=none`，且主请求 options 不被修改；同时覆盖携带显式 variant 时保留 selected thinking/providerOptions，并把 commit message 可见输出预算与 Anthropic fixed thinking 预算合成为合法 wire 总预算。
- E2E I14 同时验证 GLM-5.2 `max/nothink` 主请求与 title `reasoning_effort=none`，I15 验证 DeepSeek V4 `high/max`，I65 验证表单创建的
  Qwen 与 Kimi custom provider 的 `enabled/off`。三条都从 UI 选择一路断言到 replay server 捕获的
  最终请求体。
