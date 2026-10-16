# Builtin Provider 维护清单

> 状态：Todo 76/79 已实施的 Builtin 维护基线（持续维护）
>
> 日期：2026-09-10（Todo105/111/112/113 更新）

本文只回答“ZCode 内置提供哪些入口、每个入口维护哪些模型”。它不是 Provider Config 的副本，不描述
reasoning map、能力字段、请求 Header 或 Personal Provider Instance。

协议选择遵循统一原则：供应商或具体模型/Endpoint 支持 Anthropic Messages 时，官方模板优先使用 Anthropic；否则选择该入口
实际支持且验证最充分的其他 API Schema。不同模型需要不同协议时，拆分模板身份，不伪装成一个固定协议入口。

## 维护级别

```text
重点维护：默认 enabled=true，作为产品首选和主要测试对象
一般维护：默认 enabled=false，仍提供完整配置和可选能力
不维护：不进入 Builtin Template，不做兼容迁移
```

“一般维护”不是 Legacy/Compatibility 层，只表示仍在官方入口中有实际价值，但不是当前默认推荐。

## 入口清单

表中模型 ID 是产品维护范围。普通 API 入口使用 `templateId`；账号入口使用具体 `providerId`。
表中的 `account:zai-*` / `account:bigmodel-*` 只是把同一供应商的套餐入口合并展示的文档简写，实际配置仍保留
每个具体的 Account Provider ID。

| 供应商                   | 类型             | ID                               | Base URL                                                 | 产品维护模型                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------- | -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Z.AI Coding Plan API     | API Template     | `zai-api`                        | `https://api.z.ai/api/anthropic`                         | `GLM-5.3`★、`GLM-5.3-Flash`★                                                                                                                                                                                                                                                                                                                                                                                            |
| Z.AI API                 | API Template     | `zai-standard-api`               | `https://api.z.ai/api/paas/v4`                           | `GLM-5.3`★、`GLM-5.3-Flash`★、`GLM-5V-Turbo`★、`GLM-5.1`○、`GLM-5.1-Highspeed`○、`GLM-5`○、`GLM-5-Turbo`○、`GLM-4.7`○、`GLM-4.7-FlashX`○、`GLM-4.7-Flash`○、`GLM-4.6`○、`GLM-4.5-Air`○、`GLM-4.5`○、`GLM-4.6V`○、`GLM-4.6V-Flash`○、`GLM-4.6V-FlashX`○、`GLM-4.1V-Thinking-FlashX`○、`GLM-4.1V-Thinking-Flash`○、`GLM-4-FlashX-250414`○、`GLM-4-Flash-250414`○、`GLM-4V-Flash`○、`codegeex-4`○、`charglm-4`○、`emohaa`○ |
| BigModel Coding Plan API | API Template     | `bigmodel-api`                   | `https://open.bigmodel.cn/api/anthropic`                 | `GLM-5.3`★、`GLM-5.3-Flash`★                                                                                                                                                                                                                                                                                                                                                                                            |
| BigModel API             | API Template     | `bigmodel-standard-api`          | `https://open.bigmodel.cn/api/paas/v4`                   | `GLM-5.3`★、`GLM-5.3-Flash`★、`GLM-5V-Turbo`★、`GLM-5.1`○、`GLM-5.1-Highspeed`○、`GLM-5`○、`GLM-5-Turbo`○、`GLM-4.7`○、`GLM-4.7-FlashX`○、`GLM-4.7-Flash`○、`GLM-4.6`○、`GLM-4.5-Air`○、`GLM-4.5`○、`GLM-4.6V`○、`GLM-4.6V-Flash`○、`GLM-4.6V-FlashX`○、`GLM-4.1V-Thinking-FlashX`○、`GLM-4.1V-Thinking-Flash`○、`GLM-4-FlashX-250414`○、`GLM-4-Flash-250414`○、`GLM-4V-Flash`○、`codegeex-4`○、`charglm-4`○、`emohaa`○ |
| Z.ai                     | Account Provider | `account:zai-*`                  | 由套餐入口固定                                           | 个人／团队：`GLM-5.3`★、`GLM-5.3-Flash`★；Start／闲时保持各自名单                                                                                                                                                                                                                                                                                                                                                       |
| BigModel                 | Account Provider | `account:bigmodel-*`             | 由套餐入口固定                                           | 个人／团队：`GLM-5.3`★、`GLM-5.3-Flash`★；Start／闲时保持各自名单                                                                                                                                                                                                                                                                                                                                                       |
| Kimi                     | API Template     | `moonshot-kimi`                  | `https://api.moonshot.cn/anthropic`                      | `kimi-k3`★、`kimi-k2.7-code`★、`kimi-k2.6`★、`k3`○、`k3-256k`○、`kimi-k2.5`○、`moonshot-v1-8k`○、`moonshot-v1-32k`○、`moonshot-v1-128k`○、`moonshot-v1-8k-vision-preview`○、`moonshot-v1-32k-vision-preview`○、`moonshot-v1-128k-vision-preview`○                                                                                                                                                                       |
| MiniMax                  | API Template     | `minimax`                        | `https://api.minimaxi.com/anthropic`                     | `MiniMax-M3`★、`MiniMax-M2.7`★、`MiniMax-M2.7-highspeed`★、`MiniMax-M2.5`○、`MiniMax-M2.5-highspeed`○、`MiniMax-M2.1`○、`MiniMax-M2.1-highspeed`○、`MiniMax-M2`○                                                                                                                                                                                                                                                        |
| DeepSeek                 | API Template     | `deepseek`                       | `https://api.deepseek.com/anthropic`                     | `deepseek-flash`★、`deepseek-v4-pro`★、`deepseek-v4-flash`○                                                                                                                                                                                                                                                                                                                                                             |
| Alibaba Cloud (China)    | API Template     | `qwen-alibaba-model-studio-cn`   | `https://dashscope.aliyuncs.com/apps/anthropic`          | `qwen3.8-max`★、`qwen3.8-flash`★、`qwen3.5-plus`○、`qwen3.5-flash`○、`qwen3-max`○、`qwen-plus`○、`qwen-flash`○、`qwen3-vl-plus`○                                                                                                                                                                                                                                                                                        |
| Alibaba Cloud (Global)   | API Template     | `qwen-alibaba-model-studio-intl` | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `qwen3.8-max`★、`qwen3.8-flash`★、`qwen3.5-plus`○、`qwen3.5-flash`○、`qwen3-max`○、`qwen-plus`○、`qwen-flash`○、`qwen3-vl-plus`○                                                                                                                                                                                                                                                                                        |
| Xiaomi MiMo              | API Template     | `xiaomi-mimo`                    | `https://api.xiaomimimo.com/anthropic`                   | `mimo-v2.5-pro`★、`mimo-v2.5`★、`mimo-v2-pro`○、`mimo-v2-omni`○、`mimo-v2-flash`○                                                                                                                                                                                                                                                                                                                                       |
| OpenAI                   | API Template     | `openai`                         | `https://api.openai.com/v1`                              | `gpt-6-astra`★、`gpt-5.6-sol`★、`gpt-5.6-terra`★、`gpt-5.6-luna`★、`gpt-5.6`○、`gpt-5.3-codex`○                                                                                                                                                                                                                                                                                                                         |
| Anthropic                | API Template     | `anthropic`                      | `https://api.anthropic.com/v1`                           | `claude-fable-5-1`★、`claude-fable-5`★、`claude-opus-5`★、`claude-sonnet-5`★、`claude-haiku-4-5-20251001`★                                                                                                                                                                                                                                                                                                              |
| xAI                      | API Template     | `xai`                            | `https://api.x.ai/v1`                                    | `grok-4.6`★、`grok-build-0.1`★、`grok-4.3`○                                                                                                                                                                                                                                                                                                                                                                             |

`★` 表示重点维护、默认启用；`○` 表示一般维护、默认关闭。

### OpenRouter

OpenRouter 是普通 API Template，当前使用 `templateId=openrouter`。官方模板统一采用 Anthropic Messages，Base URL 为
`https://openrouter.ai/api`。本轮假设清单中的维护模型都支持该入口，不另建 OpenRouter Chat/Responses 模板；只有未来出现
明确反证时，才另开后续 Todo 处理其他 Schema。

模型范围覆盖本清单中各家普通 API Template 的全部维护模型，只要 OpenRouter 当前实际提供，就全部纳入，不再只挑少数
“代表模型”。每个上游供应商至少有一个重点模型默认启用，同一供应商的其他模型一般维护、默认关闭。OpenRouter 自己的全量
动态目录不复制进 Builtin Config，未列入 ZCode 维护范围的模型仍由用户通过自定义 Provider 使用。

OpenRouter 的模型 ID 按它实际返回的值登记。例如当前可能出现 `openai/gpt-5.6-sol`，它对应上游的 `gpt-5.6-sol`；这只是
OpenRouter 的命名事实，不是所有聚合供应商的通用格式，也不要求运行时剥离前缀。OpenRouter 的配置仍独立维护，不复用上游
Provider 的能力或 Option 配置。

当前目标维护列表（以 2026-09-04 Models API 实际存在的 ID 为准）按上游供应商分组如下：

列表只登记可直接用于普通对话/Agent 请求的模型 ID；OpenRouter 返回的 `:batch` 等批处理变体不单独作为模型成员，`:free`
等影响实际路由或计费的变体只有在需要独立配置时才另行登记。

- OpenAI：`openai/gpt-6-astra`★、`openai/gpt-5.6-sol`★、`openai/gpt-5.6-terra`★、`openai/gpt-5.6-luna`★、`openai/gpt-5.3-codex`○；
- Anthropic：`anthropic/claude-fable-5.1`★、`anthropic/claude-fable-5`★、`anthropic/claude-opus-5`★、`anthropic/claude-sonnet-5`★、`anthropic/claude-haiku-4.5`★、
  `anthropic/claude-opus-4.8`○、`anthropic/claude-opus-4.7`○、`anthropic/claude-opus-4.6`○、
  `anthropic/claude-opus-4.5`○、`anthropic/claude-sonnet-4.6`○、`anthropic/claude-sonnet-4.5`○；
- DeepSeek：`deepseek/deepseek-v4-pro`★、`deepseek/deepseek-v4-flash`★；
- Moonshot：`moonshotai/kimi-k3`★、`moonshotai/kimi-k2.7-code`○、`moonshotai/kimi-k2.6`○、`moonshotai/kimi-k2.5`○；
- Z.AI：`z-ai/glm-5.3`★、`z-ai/glm-5.3-flash`★、`z-ai/glm-5.2`○、`z-ai/glm-5.1`○、`z-ai/glm-5v-turbo`○、
  `z-ai/glm-5`○、`z-ai/glm-5-turbo`○、`z-ai/glm-4.7`○、`z-ai/glm-4.7-flash`○、`z-ai/glm-4.6`○、
  `z-ai/glm-4.6v`○、`z-ai/glm-4.5-air`○、`z-ai/glm-4.5`○；
- Qwen：`qwen/qwen3.8-max`★、`qwen/qwen3.8-flash`★、`qwen/qwen3.7-max`○、`qwen/qwen3.7-plus`○、
  `qwen/qwen3.7-flash`○、`qwen/qwen3.6-plus`○、`qwen/qwen3.6-flash`○、`qwen/qwen3.5-plus-20260420`○；
- MiniMax：`minimax/minimax-m3`★、`minimax/minimax-m2.7`○、`minimax/minimax-m2.5`○；
- Xiaomi MiMo：`xiaomi/mimo-v2.5-pro`★、`xiaomi/mimo-v2.5`★；
- xAI：`x-ai/grok-4.6`★、`x-ai/grok-build-0.1`○、`x-ai/grok-4.3`○。

### OpenCode Zen

这里的 OpenCode 指 OpenCode Zen API，不是 OpenCode Agent runtime。Zen 使用同一个站点
`https://opencode.ai/zen/v1`，但模型按官方 Endpoint/Schema 分成三个 Template：

- `opencode-zen-responses`：GPT 5.6 Sol、Terra、Luna，以及其他 GPT Responses 模型；
- `opencode-zen-messages`：Claude、Qwen 等 Anthropic Messages 模型；
- `opencode-zen-chat`：Kimi、DeepSeek、MiniMax、GLM 及 Zen 的免费 Chat 模型。

OpenCode Zen 的维护范围覆盖官方模型表中仍有效的各家模型，不因为已经有某个品牌的重点模型就省略其他品牌。每个进入清单的
上游品牌至少有一个重点模型默认启用，同一品牌的其他官方模型一般维护、默认关闭。当前目标列表按协议展开：

- Responses：`gpt-6-astra`★、`gpt-5.6-sol`★、`gpt-5.6-terra`★、`gpt-5.6-luna`★、`gpt-5.5`○、`gpt-5.5-pro`○、
  `gpt-5.4`○、`gpt-5.4-pro`○、`gpt-5.4-mini`○、`gpt-5.4-nano`○、`gpt-5.3-codex`○、`gpt-5.3-codex-spark`○、
  `gpt-5.2`○、`gpt-5.1`○；
- Anthropic Messages：`claude-fable-5-1`★、`claude-fable-5`★、`claude-opus-5`★、`claude-sonnet-5`★、`claude-haiku-4-5`○、
  `claude-opus-4-8`○、`claude-opus-4-7`○、`claude-opus-4-6`○、`claude-opus-4-5`○、
  `claude-sonnet-4-6`○、`claude-sonnet-4-5`○；Qwen：`qwen3.7-max`★、`qwen3.7-plus`○、`qwen3.6-plus`○、
  `qwen3.5-plus`○；
- OpenAI-compatible Chat：`kimi-k3`★、`minimax-m3`★、`minimax-m2.7`○、`deepseek-v4-pro`★、
  `deepseek-v4-flash`○、`glm-5.2`★、`glm-5.1`○、`big-pickle`★、`mimo-v2.5-free`★、`hy3-free`○、
  `ling-3.0-flash-fin-free`○、`nemotron-3-ultra-free`○、`nemotron-3.5-lightning-free`○、
  `muse-spark-1.2-contributor-free`○。

上面是 ZCode 的维护列表，不是 Zen 的全量动态目录；正式写入前仍以 Zen 官方 `/zen/v1/models` 返回值和协议验证结果为最终门槛。

Z.ai、BigModel、Kimi、MiniMax 和 Qwen 的“一般维护”模型以各自具体 API 入口在实现时的官方可用模型列表为最终门槛；
如果某个 ID 已不再被该入口接受，则从表和对应 Template 一并删除。这里不因为供应商官网仍保留历史资料就继续维护。

## 删除范围

- Z.ai / BigModel 个人/团队 Account 和手动 Coding Plan 模板仅预设 `GLM-5.3`、`GLM-5.3-Flash`；不删除其他型号规则或用户已保存的选择。
- 普通 Z.ai / BigModel API 模板保留维护中的其他官方 GLM 型号，非重点成员默认关闭；不把它与 Coding Plan API 混为一个入口。
- Kimi 删除 `moonshot-v1-*`；K2.5/K2.6 只要官方 API 仍支持就一般维护，不因版本号较旧直接删除。
- MiniMax 删除 M2.1 及更早型号；M2.7/M2.5 仍被官方发布文档列出，作为一般维护候选保留。
- MiMo 删除 `mimo-v2-pro`、`mimo-v2-omni`、`mimo-v2-flash`；官方已公告这些旧型号于 2026-06-30 退役，迁移目标是 V2.5 系列。
- Anthropic 删除已经退休的 Claude 3.x、Sonnet 4、Opus 4 和 Opus 4.1；Opus 4.8/4.7、Sonnet 4.6 等仍保留为一般维护。

## 本轮边界

- 本轮修改现有 Builtin Provider 的 Template 成员和 Model Rules，并按本表纳入 OpenRouter、OpenCode Zen 两个普通 API 入口。
- Azure、Volcano Ark、AWS Bedrock 仍由 Todo 22 单独处理，不写入本轮入口表。
- Google Gemini 继续因原生 API Schema 独立而不纳入本表。
- 未出现在表中的供应商模型，不进入 Builtin Template；用户仍可在自定义 Provider 中自行填写。

### OpenRouter / OpenCode 的清单口径

- OpenRouter 是动态聚合目录，不把它的全量目录复制到 Builtin Config；但也不做只覆盖少数品牌的窄精选。维护集合是“本表已维护的
  上游模型”与 OpenRouter 当前实际提供模型的交集：各家已有维护模型只要被 OpenRouter 提供，就全部纳入；每家至少选择一个重点
  模型默认启用，其余模型一般维护、默认关闭。这里的“各家”指本表中的普通 API Template 供应商，不把同一供应商的 Account
  Provider 再重复计算。含 `/`、`:free` 等后缀的 ID 原样保存。
- OpenRouter 的模型清单按它实际返回的模型 ID 登记；当前示例中上游 `gpt-5.6-sol` 对应 `openai/gpt-5.6-sol`，但这只是
  OpenRouter 的命名事实，不是所有聚合供应商的通用格式，也不要求运行时做 ID 剥离。Model Rule 和 Model+API Rule 可以用
  前后缀模式表达已知变体，Template Model、Provider Model 和 Site Rule 不使用这种模型通配。模型集合是缓慢更新的封闭维护
  范围，新增或改名时直接补一条明确的 `modelMatch` 规则。
- OpenCode Zen 的官方模型使用同一个站点，但不同模型实际分布在 Responses、Anthropic Messages、OpenAI-compatible Chat
  三种 Endpoint/Schema。当前 `ProviderTemplate` 的 `api.type` 是单值，因此清单先按 `responses`、`messages`、`chat` 三个
  模板身份登记；实现时不把不同 Schema 的模型伪装成一个固定模板，也不在未有类型设计前扩展一套临时字段。
- OpenCode 的模型清单以 Zen 官方 `/zen/v1/models` 和文档为准；表中★/○只表达 ZCode 的默认启用策略，不代表 Zen 的计费或
  推荐等级。
- OpenCode Zen 的维护集合覆盖其官方模型表中仍有效的各家模型，不因某一个品牌已经有重点模型就省略其他品牌；每个有模型进入
  清单的上游品牌至少有一个默认启用模型，其余官方模型一般维护、默认关闭。

## 资料依据

- [Z.AI Models](https://docs.z.ai/guides/overview/overview)
- [Kimi Code Models](https://www.kimi.com/code/docs/en/kimi-code/models.html)
- [DeepSeek Models](https://api-docs.deepseek.com/quick_start/pricing/)
- [Alibaba Model Studio Models](https://help.aliyun.com/en/model-studio/models)
- [Xiaomi MiMo API Models](https://mimo.mi.com/docs/en-US/quick-start/model)
- [OpenAI Models](https://platform.openai.com/docs/models/gpt-4-turbo-and-gpt-4)
- [Anthropic Model Deprecations](https://docs.anthropic.com/en/docs/about-claude/model-deprecations)
- [MiniMax Model Releases](https://platform.minimaxi.com/docs/release-notes/models)
- [xAI Grok 4.6](https://docs.x.ai/developers/grok-4-6)
- [OpenRouter Models](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [OpenCode Zen](https://dev.opencode.ai/docs/zen)
