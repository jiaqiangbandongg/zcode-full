# Account Provider 与 Built-in Provider Config 研究报告

> 日期：2026-08-28
>
> 状态：研究结论；确定项已进入 Built-in Provider Config revision 4
>
> 设计依据：[`zcode-builtin-provider-config.md`](../design/registry/zcode-builtin-provider-config.md)

## 1. 范围与结论

本文记录 Provider Refactor 后对以下问题的复核：

1. Account Provider 页面相对 staging 是否有非预期退化；
2. Built-in Provider Config 的 Provider 模型成员与 Model Config Rules 是否完整、事实是否可靠；
3. Model、API Schema、Endpoint 和 Provider Exact Rule 应如何分工；
4. 各 Built-in Provider 默认启用哪些模型，以及文件顺序如何维护。

结论如下：

- Team Plan 曾因导航项携带了 Individual Provider 对象而无法显示模型详情；这是 UI 身份投影 Bug，不是
  Account Overlay 或 Provider Config 设计变化，现已在后续工作中修复。
- Built-in 成员大多能被通用规则解析，但“能解析”不等于“事实准确”。当前仍需系统校准 Provider 模型成员、三种
  API Schema、Endpoint 差异和默认启用集合。
- Model Config 只有 `match` 和 `provider-model` 两种 Rule。Built-in/Personal 是 Source，不是第三种 Rule 类型。
- Built-in Rule 的层级是文件写作顺序和评审心智模型，不新增 priority、specificity 或动态排序。
- 非 GLM 的通用事实优先由 `model + api.type` 表达；服务线路差异由
  `model + api.type + baseURL` 表达。Provider-scoped Match Rule 只承担对全部成员成立的服务事实；
  Provider-Model Exact Rule 只承担默认 `enabled` 和单个组合的窄产品事实。
- 严格 JSON Schema 能力字段目标名是 `supportsJsonSchemaOutput`。普通 JSON 或 JSON Object Mode 不能作为
  该字段为 `true` 的证据。
- Built-in Provider 的 `builtinModelIds` 在发布文件中把默认启用模型写在前面；这不是运行时排序功能，也不覆盖
  Personal `modelOrder`。
- Individual/Team Coding Plan 的静态成员增加 `GLM-5.3`，物理顺序固定为
  `GLM-5.3`、`GLM-5.3-Flash`、`GLM-5.2`、`GLM-5-Turbo`。
- Start/Individual/Team Plan 的模型请求会先由服务端视觉模型把 Image/Video 转成文字，所以这些 Plan Provider
  的全部模型成员都声明 Image/Video 输入；普通 Account API 不继承这项服务能力。

## 2. Account Provider 复核

### 2.1 历史问题

Provider Refactor 将 Individual 和 Team 拆为独立 Provider 身份。旧 UI 在生成 Team 导航项时只替换了
`presetId`，却继续携带 Individual Provider 对象：

```text
Team 导航项
├─ presetId = account:*:team-coding-plan
└─ provider.providerId = account:*:individual-coding-plan
                    |
                    v
Detail 身份校验不相等
                    |
                    `-- 只显示套餐状态，不显示 Team 模型详情
```

正确边界是：套餐状态和额度来自 Team entitlement；Provider API、模型成员和模型编辑对象来自同 ID 的
Effective Team Provider；模型编辑仍只写 Personal Model Config Rule。不能退回“Team 复用 Individual
Provider”的旧身份。

### 2.2 与 Built-in Provider Config 研究的关系

Account Overlay 继续约束对应 Built-in Account Provider：

- `enabled` 表达当前账号下该 Provider 是否可用；
- Start Plan 返回的模型集合可以约束该 Provider 的模型成员；
- Account 返回的模型集合不改写 ZCode Built-in Model Rules；
- Personal Provider Config 和 Personal Model Rules 仍最后覆盖其允许覆盖的配置叶子。

因此 Account 页面问题不改变本文后续 Built-in Provider Config 的写作规则。

## 3. Built-in Config 当前结构

当前 `config/provider/zcode-builtin.json` 原子包含 Provider Map 和 Model Config Rules，覆盖三种 API Schema：

- `anthropic-messages`
- `openai-chat-completions`
- `openai-responses`

revision 2 审计时共有 21 个 Provider、120 条 Model Rule，尚无 `baseURLMatch` Rule。revision 3 已加入当前主推
模型、Endpoint 特化和 Provider-Model Exact enabled；通用基线继续为未知 Personal Model
提供完整保守值，但具体模型事实仍存在下列维护风险：

1. 某个家族只覆盖一至两种 Schema，第三种 Schema 偶然继承通用值；
2. 官网只证明 JSON Object，却被误读成严格 JSON Schema；
3. 同一个模型在官方 Endpoint 和第三方兼容 Endpoint 的能力被错误合并；
4. 旧模型、alias 和当前主力模型全部继承 `enabled=true`；
5. Provider 模型成员顺序没有与默认启用状态同步维护。

## 4. Rule 写作模型

Built-in 文件按以下物理顺序维护：

```text
Complete Baseline Match Rule
          |
          v
Model Match Rule
          |
          v
Model + API Match Rule
          |
          v
Model + API + Endpoint Match Rule
          |
          v
Provider-scoped Match Rule
          |
          v
Provider-Model Exact Rule
```

各层职责如下：

| 层级                         | 主要事实                                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| Complete Baseline            | 未知 Personal Model 的完整、保守默认值                           |
| Model Match                  | context、max output、输入输出格式等不随线路变化的模型事实        |
| Model + API Match            | Schema 下的 Tool、JSON Schema、MCS、Options 和 reasoning mapping |
| Model + API + Endpoint Match | 同一 Schema 在特定官方或兼容 Endpoint 上的已证实差异             |
| Provider-scoped Match        | 对 Provider 全部当前/未来成员成立的服务能力                      |
| Provider-Model Exact         | 默认 enabled、单个 Provider-Model 组合的产品事实                 |

这只是 Built-in JSON 的作者规范。Resolver 仍按数组物理顺序遍历，后命中的明确叶子覆盖前面；不计算哪个 Rule
“更具体”，不实现额外优先级。

非 GLM 模型通常无需 Provider-Model Exact Rule 来重复请求能力。若两个 Provider 指向同一 API Schema 和
Endpoint，应自然取得同一套 Endpoint 事实。只有无法由 Endpoint 区分、且对 Provider 全部当前/未来成员成立的
服务能力才进入 Provider-scoped Match Rule；Exact Rule 只在默认启用或单个组合的真实产品差异处出现。

## 5. 能力字段判定

### 5.1 JSON Schema 输出

目标字段：

```ts
properties.supportsJsonSchemaOutput: boolean;
```

它只表示当前 Effective Model 能接收 `ModelRequest.responseJsonSchema`，并由当前 Adapter/API/Endpoint 编码为
严格 JSON Schema 约束输出。以下证据不够：

- 提示词要求模型输出 JSON；
- 只支持 `response_format={type:"json_object"}`；
- 官网笼统写了 “Structured Output”，但没有对应当前 Schema/Endpoint；
- 另一个兼容 Endpoint 成功。

### 5.2 MCS

`supportsMidConversationSystem` 表示当前 Adapter 和 Endpoint 能可靠编码对话中途的 system 消息，不是模型
“是否聪明”或厂商营销能力。它应放在 Model + API 或 Model + API + Endpoint Rule，不能按模型家族凭常识全开。

### 5.3 三种 Schema 的覆盖

“覆盖三种 Schema”表示每个维护模型在三种 Schema 下都有明确、可审计的解析结果。它不表示厂商官方 Endpoint
必须原生支持三种协议。官方未提供某种协议时，可以为第三方兼容 Endpoint 留保守结果，但高风险能力保持 false，
直到有官方文档或可复现 Endpoint 证据。

## 6. 各模型家族调研

证据分为三类：官方确认、产品确认、Endpoint 待验证。证据分类只进入评审材料，不进入运行时 Config。

### 6.1 GLM / BigModel / Z.ai

当前产品主推模型确认是：

- `glm-5.3`
- `glm-5.3-flash`

公开官网内容可能仍停留在旧版本，属于公开资料滞后，不能据此把 5.3 判定为可疑或仅供内测。5.3/5.3 Flash
应作为“产品确认”的当前主力模型维护。`GLM-5.2` 是否属于 Coding Plan Provider 的模型成员，则由对应
Account Overlay 与 Built-in Provider Config 决定，不应反向替代普通 GLM API 的 5.3 主力模型。

BigModel 当前官方模型总览将 `GLM-5.3` 列为文本旗舰，将 `GLM-5.3-Flash` 列为原生多模态模型，并明确
Flash 原生理解图片和视频；Chat Completion 文档的图片、视频示例也使用 Flash。因此普通 Account API 的原生事实是：

| 模型          | Image | Video | 证据         |
| ------------- | ----- | ----- | ------------ |
| GLM-5.3       | false | false | 官方文本模型 |
| GLM-5.3-Flash | true  | true  | 官方多模态   |

`glm-5v-turbo` 与 `glm-5-turbo` 不是速度档关系。前者的 `V` 表示 Vision，是面向视觉 Coding/GUI Agent 的
Text/Image/Video/File 多模态模型；后者是面向 OpenClaw 长链路执行、工具调用和持续任务优化的 Text-only
Agent 模型。两者当前官方规格均为 200K context、128K max output，应该作为两个平行特化型号维护，不能因
共同带有 `Turbo` 而互相覆盖能力。

Start、Individual、Team Plan 则有额外产品事实：请求会先由服务端视觉模型把 Image/Video 转成文字，所以 Plan
Provider 的所有模型成员都可以接收这两类视觉输入。这是 Provider 服务能力，不改变 GLM-5.3 的原生模型事实，
也不推断 Audio/PDF。

Individual 和 Team 的静态成员顺序固定为：

```text
GLM-5.3
GLM-5.3-Flash
GLM-5.2
GLM-5-Turbo
```

Start Plan 的成员仍由 `billing/balance` 在 Account Overlay 中动态约束；本轮不在 Built-in Provider Config
中替上游静态新增 5.3，
但无论上游返回哪些成员，都应用 Plan Provider 的 Image/Video 服务能力。

在 MacBook Air 正式 App 的真实产品链路中，使用一张包含 Provider 列表、模型列表和红色箭头的设置页截图完成了
以下实测：

| 连接方式                        | 模型          | 结果                                                   |
| ------------------------------- | ------------- | ------------------------------------------------------ |
| BigModel Team Coding Plan       | GLM-5.3-Flash | 准确识别 Provider 列表，并指出箭头指向 `glm-5.3-flash` |
| BigModel Team Coding Plan       | GLM-5.2       | 准确识别 Provider 列表，并指出箭头指向 `glm-5.3-flash` |
| BigModel Account API（API Key） | glm-5.3       | 请求未报错，但已确认模型 API 不消费视觉内容            |
| BigModel Account API（API Key） | glm-5.3-flash | 图片被正常接收；Agent 准确识别 Provider 列表和箭头     |

Team Plan 的 GLM-5.2 结果符合“Plan 服务提供统一视觉转写”的产品事实。普通 Account API 则已确认没有视觉能力：
接口接受含图片的请求但不报错，只表示服务端容忍或忽略了内容，不表示模型消费了图片。Model Config 的原生事实因此
继续按官方文档维护：`GLM-5.3` 保持文本输入，`GLM-5.3-Flash` 声明 Image/Video。

此前从磁盘缓存中直接取普通、Individual、Team Key 发请求均返回 HTTP 401；运行日志随后证明正式 App 使用的是运行时
刷新后的 Team Project Key，磁盘值已经过期。这个 401 不能作为模型能力证据，也不能用来否定上述正式 App 实测。

后续仍需按真实 Endpoint 继续核对：

- 5.3/5.3 Flash 的 context、max output、Image/Video、Tools 和三种 Schema 能力；
- Z.ai、BigModel、Coding Plan Endpoint 的 MCS、JSON Schema 和 reasoning 参数差异；
- `glm-5v-turbo` 是否仍作为独特视觉型号默认启用；
- 大小写 Model ID 只用于请求身份，不应导致同一模型事实分叉。

参考：[BigModel 模型总览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、
[Z.ai Chat Completion](https://docs.z.ai/api-reference/llm/chat-completion)、
[Z.ai 核心参数](https://docs.z.ai/guides/overview/concept-param)。

### 6.2 Kimi

当前 Built-in Provider Config 同时包含 K3、K2.x 和 Moonshot V1。Kimi 当前资料已经展示 K3、K2.7 Code 和
K2.6；K3 为 1M 上下文，K2.7 Code/K2.6 为 256K。当前 Provider 模型成员缺少 K2.7 Code，而 `k3`、
`k3-256k` 等别名是否为真实 Endpoint ID 需要确认。

Kimi Chat API 已提供 `json_schema` 形式的响应格式证据，可在对应官方 API/Endpoint Rule 中开启严格 JSON Schema；
不能自动扩散到其他兼容协议。

参考：[Kimi 模型主页](https://platform.kimi.ai/)、[Kimi Chat API](https://platform.kimi.ai/docs/api/chat)。

### 6.3 MiniMax

MiniMax 当前公开直接 API 以 M3 为最新主推，并继续提供 M2.7/M2.7-highspeed。中国区官方模型调用文档明确
给出 M3 在 `https://api.minimaxi.com/anthropic` 与 `https://api.minimaxi.com/v1` 的调用示例，因此它必须是
MiniMax Built-in Provider 的首位默认启用成员。M3 为 1M context，原生 Text/Image/Video；M2.7 系列为
204800 context，并作为不同速度档继续默认启用。

此前“直接 Endpoint 尚未证明 M3”的判断来自过时接口概览和 Models API 文档示例，已经被当前模型调用文档
推翻。Models API 的示例响应只能证明协议形状；真正用于成员校验的是携带当前访问材料的实时成功响应。

参考：[MiniMax 文本生成](https://platform.minimaxi.com/docs/guides/text-generation)。

### 6.4 DeepSeek

Built-in 的 `deepseek-v4-flash` 与 `deepseek-v4-pro` 可以继续作为两个当前产品档位。官方 Responses 文档目前只明确
列出 Flash，因此 Pro 的 Responses 与 JSON Schema 能力必须独立核验，不能从 Flash 复制。

参考：[DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)。

### 6.5 Qwen

Built-in Provider Config 当前以 Qwen 3.5 Plus/Flash 为主，但阿里云公开模型列表已出现 Qwen 3.7/3.8，需先做
Provider 模型成员升级裁决。
Qwen 3.5 Plus/Flash 的 1M context、64K output、Text/Image/Video、Tool 等能力有官方依据。严格 JSON Schema
只覆盖部分型号；JSON Object 支持范围更广，两者不能混同。

参考：[Qwen 视觉模型能力](https://help.aliyun.com/en/model-studio/vision-model/)、
[Qwen Structured Output](https://help.aliyun.com/en/model-studio/qwen-structured-output)。

### 6.6 MiMo

MiMo v2.5/v2.5-pro 是当前主力，官方给出 1M context、128K output；旧 v2-pro/v2-omni/v2-flash 已公告
2026-06-30 下线，应保留时默认 disabled。当前结构化输出资料只足以证明 JSON Object，因此在没有严格 Schema
证据前，`supportsJsonSchemaOutput` 保持 false。Web Search 是 Endpoint/Plugin 能力，不应写成全局模型事实。

参考：[MiMo 模型总览](https://mimo.mi.com/docs/en-US/quick-start/model)。

### 6.7 OpenAI

Sol/Terra/Luna 分别提供不同能力和成本档位，官方当前资料给出约 1.05M context、128K output，并支持 Image、Tools
和 Structured Output。通用 `gpt-5.6` 是指向 Sol 的 alias，不宜和 Sol 同时默认启用，避免重复入口。

参考：[OpenAI Models](https://developers.openai.com/api/docs/models)。

### 6.8 Anthropic

Fable、Opus、Sonnet 和 Haiku 是能力/成本不同的产品档位，不应仅因“只保留最新”而删除低价或高速档。当前资料中
前三者为 1M/128K，Haiku 为 200K/64K；每个档位可以独立默认启用。

参考：[Anthropic Models](https://platform.claude.com/docs/en/about-claude/models/overview)。

### 6.9 xAI

Grok 4.6 为当前通用主力并有 500K context、Image、Tools 和严格 Schema 依据；Grok Build 是独特 Coding 档位，
可保留默认启用；Grok 4.3 作为旧型号默认 disabled。

参考：[Grok 4.6](https://docs.x.ai/developers/models/grok-4.6)、
[xAI Structured Outputs](https://docs.x.ai/developers/model-capabilities/text/structured-outputs)。

## 7. revision 4 默认启用结果

以下确定项已写入 Config；未被官方直接 Endpoint 证明或已被替代的成员保留为 disabled，供 Personal/兼容服务使用。

| Provider 家族 | 默认 enabled 候选                                                            | 默认 disabled / 待确认                            |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| GLM API       | `glm-5.3`、`glm-5.3-flash`、`glm-5v-turbo`                                   | 旧 5.1/5/4.x                                      |
| Coding Plan   | Individual/Team：5.3、5.3 Flash、5.2、5-Turbo；Start 由 Account 返回集合决定 | 不用静态规则扩大 Start 账号集合                   |
| Kimi          | K3、K2.7 Code、K2.6 中仍在当前 Endpoint 的独特档位                           | 旧 K2.x、Moonshot V1、重复 alias                  |
| MiniMax       | M3、M2.7、M2.7-highspeed                                                     | 更老 M2.x                                         |
| DeepSeek      | `deepseek-v4-flash`、`deepseek-v4-pro`                                       | 严格 Schema 仅由官方 Responses Endpoint Rule 晋升 |
| Qwen          | `qwen3.8-max`、`qwen3.8-flash`                                               | 被替代的 3.5/3.x 型号                             |
| MiMo          | `mimo-v2.5-pro`、`mimo-v2.5`                                                 | 已退役 v2-pro/v2-omni/v2-flash                    |
| OpenAI        | Sol/Terra/Luna                                                               | `gpt-5.6` alias、被替代 Codex 型号                |
| Anthropic     | Fable/Opus/Sonnet/Haiku 各独特档                                             | 无明确重复项                                      |
| xAI           | `grok-4.6`、`grok-build-0.1`                                                 | `grok-4.3`                                        |

最终写入时，每个 Provider 的 `builtinModelIds` 按“默认 enabled 在前、默认 disabled 在后”调整物理顺序；运行时不
新增 enabled-first 排序，用户排序仍只由 Personal `modelOrder` 负责。

## 8. 推荐实施顺序

1. 优先调用厂商 Models API，生成访问材料可见成员和接口明确返回的 capability 差异报告；
2. 使用后续模型验证 API 持续生成 Provider 成员 × 三种 Schema × Endpoint 的实测矩阵；
3. 对 revision 4 中仍属保守推断的 Endpoint 能力逐项晋升或回退；
4. 将 `supportsStructuredOutput` 一次性改名为 `supportsJsonSchemaOutput`，同步 Config、Registry、Model、Runtime、
   Protocol、Settings 与测试，不保留双字段；
5. 继续补齐尚未有官方资料的 Model + API + Endpoint 差异；
6. 使用真实 Built-in Config 完整性测试和三 Schema Adapter 集成测试证明后续结果。

任何需要改变 Account Overlay、模型成员所有权、Personal 覆盖顺序或 Runtime 选择语义的问题，必须另行裁决，
不能借 Built-in Provider Config 校准顺手修改。

## 9. 后续实施影响简报

变更层级主要是 `option-source`、`draft-default`、`validation` 和 `persistence`；不改变模型选择、会话、队列或
恢复语义。

| 表面                     | 显示/默认来源                     | 用户提交或发布落点                     | 必须保持的边界                          |
| ------------------------ | --------------------------------- | -------------------------------------- | --------------------------------------- |
| Built-in Provider 设置页 | Effective Provider + Model Config | Personal Overlay                       | 不回写 Built-in Release                 |
| Account Provider 设置页  | Built-in + Account + Personal     | Personal Overlay；账号事实仍由 Account | Team/Individual 身份和成员不串线        |
| Personal Provider 设置页 | 通用 Built-in Rules + Personal    | Personal Provider/Model Rules          | Personal Model 同样取得完整保守基线     |
| 普通模型选择器           | Registry 的 selectable projection | Session Selection                      | 只过滤并保留成员顺序，不按 enabled 重排 |
| Runtime / Adapter        | 已冻结 Active Model               | Model API Request                      | 不按 modelId、Provider ID 再推断能力    |

Plan Provider 的输入能力仍沿唯一事实链进入 Runtime：

```text
Built-in Model 原生事实
          |
          v
Plan Provider-scoped Match Rule
          |
          v
Effective Model Config
          |
          v
Active Model.properties.input_format
          |
          v
Adapter 媒体检查与编码
```

Runtime 不判断 Plan ID、Access mode 或模型名称；它只读取 Active Model 的最终 Properties。

必须检查的实现种子：

- `config/provider/zcode-builtin.json`：Provider 成员、物理顺序和 Built-in Rules；
- `ModelConfigRules.composeEffective()` / `ModelConfigRules.resolve()`：顺序组合和 matcher 解析；
- `packages/provider/src/resolver.ts`：Effective Provider/Model 完整性与 Registry 输入；
- `packages/provider-node/test/zcode-builtin-integrity.test.ts`：真实 Built-in Provider/Model Config 事实证据；
- `packages/ui/src/settings/model-provider-section/`：默认值预览、Personal 稀疏覆盖和模型编辑；
- 各 Adapter 的 `responseJsonSchema`、Tool、MCS 与 reasoning 请求测试。

当前 Graph 漂移已经补入 Feature Graph：Built-in Rule 的物理写作顺序、Endpoint 层和“不新增动态 specificity”
成为 Provider Registry 的明确不变量。后续实施如只调整 Built-in Config，不应触碰 Desktop continuous、Mobile
replayable、workspace identity、队列或任务恢复。

### 9.1 本轮边界与验收用例

| Case             | Setup                             | Assertion                               | 状态     |
| ---------------- | --------------------------------- | --------------------------------------- | -------- |
| ACCOUNT-PLAN-001 | Z.ai/BigModel Individual Provider | 成员顺序为 5.3、5.3 Flash、5.2、5-Turbo | accepted |
| ACCOUNT-PLAN-002 | Z.ai/BigModel Team Provider       | 成员顺序为 5.3、5.3 Flash、5.2、5-Turbo | accepted |
| ACCOUNT-PLAN-003 | Start/Individual/Team 任一成员    | Effective input 支持 Image/Video        | accepted |
| ACCOUNT-PLAN-004 | 普通 Account API + GLM-5.3        | 原生事实保持文本；不报错不视为视觉支持  | accepted |
| ACCOUNT-PLAN-005 | 普通 Account API + GLM-5.3-Flash  | 原生 Image/Video；ZCode 图片端到端可用  | accepted |
| ACCOUNT-PLAN-006 | Team Plan + GLM-5.2/5.3 Flash     | 有语义截图均能被准确理解                | accepted |
| ACCOUNT-PLAN-007 | 普通 Account API 携带图片         | 服务可容忍，但模型不消费视觉内容        | accepted |

不纳入本轮：Audio/PDF 请求编码入口、Start 上游是否新增 5.3、Off-Peak 是否复用视觉转写、Account 权益/凭据生命周期、
会话与恢复语义。MiMo v2.5 已按官网把 Audio 记录为静态输入事实，但不会触发本轮未实现的 Audio 内容投影。
