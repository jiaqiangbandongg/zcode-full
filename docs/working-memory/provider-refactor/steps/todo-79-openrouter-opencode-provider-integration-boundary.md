# Todo 79：OpenRouter / OpenCode Provider 接入边界与现有基础

> 状态：已完成（Builtin 模板首轮接入）
>
> 日期：2026-09-04
>
> 来源：从 Todo 22 的 OpenRouter/OpenCode Zen 章节迁移；Todo 22 继续承载 Azure、Volcano Ark、AWS Bedrock 等其他 Provider。

## 1. 当前已有基础

### OpenRouter Model ID

OpenRouter 的模型 ID 按普通字符串保存于结构化 `providerId + modelId` 中。含 `/` 或 `:free` 的 ID（例如 `vendor/model:free`）不应被拆成 Provider、slug 化或改写。现有 OpenRouter 冒号模型 E2E 已覆盖该保存和恢复边界。

### OpenRouter Attribution

`packages/shared/src/openrouter-attribution.ts` 已按最终 `baseURL` 识别 OpenRouter：协议必须为 HTTPS，host 为 `openrouter.ai` 或其子域。命中后添加：

```text
X-OpenRouter-Title: ZCode
X-OpenRouter-Categories: programming-app
```

该基础设施覆盖模型请求、连接测试、Repo Wiki/Git 提交请求和 bootstrap Provider headers；它不代表 OpenRouter 已完成 Built-in Template 接入。

### OpenCode Model ID

`packages/shared/src/opencode-model-id.ts` 与 OpenRouter 无关。它只为 OpenCode Agent 的自定义模型生成稳定运行时 ID：

```text
<provider-slug>-<provider-hash>/<modelName>
```

用于避免不同自定义 Provider 的模型 ID 冲突。

## 2. OpenRouter Built-in Template 首轮接入范围

维护成员以 [`Builtin Provider 维护清单`](../design-v2/builtin-provider-inventory.md) 为准。OpenRouter 不是只接入少数代表模型，
而是覆盖本表中各家普通 API Template 的全部维护模型：某个上游模型只要当前被 OpenRouter 提供，就纳入 OpenRouter Template；
同一供应商的 Account Provider 不重复计算。每家至少一个重点模型默认启用，其余一般维护、默认关闭。OpenRouter 仍不复制自己的
全量动态目录，未列入 ZCode 维护范围的模型继续由用户通过自定义 Provider 使用。

OpenRouter 的模型清单参照本表中各家上游 API Template 的维护模型。当前 OpenRouter 的一个实际命名示例是上游模型 ID
`gpt-5.6-sol` 对应 `openai/gpt-5.6-sol`；这只是 OpenRouter 的模型成员和命名事实，不是所有聚合供应商的通用格式，也不是
配置复用或运行时 ID 转换。OpenRouter 仍需为自己的模型成员
维护独立的 Model/API/Site 配置，因为聚合站点可能改变协议字段、能力和参数映射。

OpenRouter 同时提供 Chat Completions、Responses 和 Anthropic Messages 入口。按项目统一原则，官方模板统一采用
Anthropic Messages 协议，模板显示名称为 `OpenRouter`。在没有明确资料指出某个维护模型不能使用 Anthropic Messages 的情况下，默认认为清单中的维护模型
都支持该入口；本轮不为 Chat 或 Responses 另建 OpenRouter 模板，也不因缺少模型级协议说明而主动拆分。

公开资料能确认入口存在，但不能直接给出完整的“模型只能使用哪一种 Schema”清单：Chat Completions 文档描述其可以使用
OpenRouter 提供的模型，Anthropic Messages 文档列出 PDF、工具和 `output_config` 等 Anthropic 语义；Models API 提供模型的
`supported_parameters`，另有按模型查询 endpoints 的接口。它们都不是一张可直接替代请求验证的模型到 Schema 矩阵。因此本轮采用
明确的产品假设：清单模型统一进入 Anthropic 模板，不把“文档没有写明”解释成“不支持”。将来只有出现明确反证时，才另开
后续 Todo 讨论其他 Schema 模板。

- 确认公开 API Schema、Endpoint、鉴权和推荐模型成员；
- 保持含 `/`、`:free` 的 Model ID 在 ModelSelection、Registry、Runtime 和持久化中的原样语义；
- 确认 Anthropic 入口的 reasoning、tool call、JSON Schema、web search、usage 和流式响应契约；
- 将 OpenRouter 站点差异写入 Provider Site Config，不把聚合站点能力硬编码到 Model baseline；
- 以代表性真实请求完成 Anthropic 模板和连接测试烟测；不以逐模型验证结果决定是否拆分模板。

## 3. OpenCode Zen Built-in Template 首轮接入范围

这里的 OpenCode 指 OpenCode Zen API，不是 OpenCode Agent runtime。OpenCode Zen 也纳入 Builtin 维护清单，并覆盖官方模型表中
仍有效的各家模型；不能因为已经有某个品牌的重点模型，就省略其他品牌。重点维护／一般维护级别沿用 Builtin Provider 维护清单的全局原则。官方表格显示同一 Zen Base URL 下同时存在：

```text
Responses              gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / GPT 系列
Anthropic Messages     claude-opus-5 / claude-sonnet-5 / qwen3.7-max 等
OpenAI-compatible Chat kimi-k3 / deepseek-v4-* / minimax-m3 / glm-5.2 等
```

当前 ProviderTemplate 的 API 配置是单值。按统一原则，能使用 Anthropic Messages 的 Zen 模型优先归入
`opencode-zen-messages`；只支持 Responses 或 OpenAI-compatible Chat 的模型分别归入 `opencode-zen-responses` 或
`opencode-zen-chat`。实现时不能把不同 Schema 的模型塞进一个固定模板，也不先发明临时的每模型 API 字段；如果后续发现
必须共享一个站点壳，再单独提出类型设计。
维护成员和默认启用策略以清单为准：每个进入清单的上游品牌至少一个模型默认启用；同一品牌的其他官方模型一般维护、默认关闭。

- 确认 OpenCode Zen 的 API Schema、Endpoint、鉴权和模型目录；
- 将 OpenCode Agent 的运行时 ID 转换与 Provider Config 的 `modelId` 语义分开；
- 确认 reasoning、tool call、JSON Schema、usage 和流式响应契约；
- 完成 Built-in Template、Access、Model Config 和真实请求验证。

## 4. 边界与非目标

- 当前只完成维护范围和接入边界登记，不把 OpenRouter 或 OpenCode Zen 伪装成已完成的 Built-in Provider；
- 不把 OpenCode 的运行时 Model ID 转换复用于 OpenRouter；
- 不因为存在 attribution header 就推断 OpenRouter 的模型能力；
- 不在本 Todo 中处理 Google Gemini 原生 Schema、Azure、Volcano Ark 或 AWS Bedrock。

## 5. 与历史 Todo 的关系

- Todo 22 原有 OpenRouter/OpenCode Zen 章节迁移到本 Todo；Todo 22 继续保留其他 Provider 的独立接入规划。
- Todo 76 的 Builtin Config 分层适用于本 Todo：Model baseline → Model + API Schema → Provider Site → Template Model → Provider Model → Personal Provider Instance。

## 6. 资料依据

- [OpenRouter Models](https://openrouter.ai/docs/guides/overview/models)
- [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [OpenCode Zen](https://dev.opencode.ai/docs/zen)

## 实施记录（2026-09-04）

### 名称修正（2026-09-15）

- 按用户要求，OpenRouter 模板中英文名称统一为 `OpenRouter`，移除 `(Anthropic)` 后缀；模板卡片和提示沿用同一配置名称。
- 生产配置是唯一编辑源，测试配置由现有同步脚本生成；不改变 `openrouter` 模板 ID、Anthropic Messages 协议、URL、模型与推理映射。
- 已创建供应商的个人名称不迁移、不重命名；OpenCode 等其他模板名称保持不变。
- 验证：新增名称断言先红 2 项，修改后 OpenRouter 契约单测 16 项通过；Pro 浏览器窄屏中文浅色／宽屏英文深色两例验证卡片和悬停提示均通过。根目录 typecheck、Desktop typecheck:e2e、配置同步检查通过，lint 0 错误（42 条既有警告）。浏览器 pending 不替代完整 Electron／手机远控验收。
- 以下保留首轮实施的历史命名记录。

- 新增独立的 `openrouter` Template，固定使用 `OpenRouter (Anthropic)` 与 `https://openrouter.ai/api`；模型 ID 按聚合站点实际命名原样保存，不剥离供应商前缀，也不复用上游 Runtime 配置。
- 新增 `opencode-zen-responses`、`opencode-zen-messages`、`opencode-zen-chat` 三个 Template，分别对应 Zen 的三种协议入口；同一站点不同协议不再混装在一个 ProviderTemplate 中。
- OpenRouter 与 OpenCode 模型成员按维护清单登记，重点成员默认启用，其余一般维护、默认关闭；每条成员均有独立 `template-model` 记录和最小完整输出上限配置。
- 新增 Builtin 完整性测试，确认聚合 Template 的独立 API 配置、模型成员和 Registry Provider 顺序；相关 Provider Node 测试通过，`pnpm typecheck` 与 `pnpm lint` 通过（0 error）。
- 该接入没有改变 OpenCode Agent runtime 的 ID 转换，也没有把聚合站点的配置能力映射为上游 Provider 的复用规则。
