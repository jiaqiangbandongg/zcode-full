# ZCode Built-in Provider Config 维护设计

> 状态：当前有效设计
>
> 本文规定 `config/provider/zcode-builtin.json` 的长期维护方式。字段契约、Overlay 和 Registry
> 完整语义分别以 [`configuration.md`](./configuration.md)、
> [`provider-and-model-configuration-overview.md`](./provider-and-model-configuration-overview.md) 为准。

正式环境源文件沿用 `zcode-builtin.json`，测试环境使用同目录 `zcode-builtin.test.json`。
两份遵循相同维护规范，按 `ZCODE_ENV` 打包；选择与缓存契约见
[双环境打包](../../../../builtin-provider-config-build-environments.md)。

## 1. 目标与边界

ZCode Built-in Release 原子发布两类内容：

```text
ZCode Built-in Release
├─ Account Provider Config Map
├─ Provider Template Map
│  └─ Template 元数据壳 + Provider Config Overlay
└─ Model Config Rules
```

Account Provider Config Map 声明 ZCode 维护的账号 Provider 身份与调用配置。Provider Template Map 为普通 API
Provider 提供创建基线；每个 Template 以领域壳保存多语言 `nameMap` 和复用的 Provider Config Overlay，不进入
Registry。Model Config Rules 声明模型事实、API/Endpoint 请求能力、Option Specs、
per-option raw-body map 和 Provider/Model 产品事实。

本文是发布者写作规范和评审心智模型，不新增：

- Rule `priority`、`specificity` 或排序字段；
- Runtime Rule 重排或第二个 Resolver；
- 按 modelId、Provider ID 或 URL 编写的业务代码分支；
- 配置内的 evidence、provenance 或 confidence 字段；
- Provider/Model 成员、Account 权益或 Personal 意图的新事实源。

能力事实的维护还必须区分“没有查到”和“明确不支持”：

- 新模型没有可靠证据时，通用基线继续给出保守默认值；
- 已发布模型能力从 `true` 降为 `false` 时，必须有当前官方资料的明确否定、目标 Endpoint 的可复现请求结果，
  或服务发布者的明确裁决；
- 搜索结果缺席、研究报告未记录、旧文档没有提及，都不能单独作为能力降级证据；
- 同一模型存在多个 Endpoint/产品形态时，只能把结论写到证据真正覆盖的 Model、API 或 Endpoint 层，不能从一个
  产品页面外推到所有线路。

这个不对称规则是有意的：未知模型采用保守默认值可以避免误放行；已经声明并投入使用的能力则不能因为一次资料
刷新遗漏而被静默关闭。

## 2. 两种 Rule 类型

系统只有两种 Model Config Rule：

```ts
type ModelConfigRule =
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    }
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    };
```

统一术语如下：

| Rule type        | 术语                      | 含义                                     |
| ---------------- | ------------------------- | ---------------------------------------- |
| `match`          | Match Rule                | 用 matcher 命中一组解析上下文            |
| `provider-model` | Provider-Model Exact Rule | 精确命中一个 `providerId + modelId` 组合 |

Built-in 与 Personal 都可以包含这两种类型。`Built-in`、`Personal` 只表示 Source 所有者，不产生第三种
Rule 类型。Built-in Exact Rule 由 Release 维护；Personal Exact Rule 跟随设置页模型生命周期维护。

## 3. Built-in Rule 的物理写作顺序

Built-in Rules 按数组顺序应用，后命中的配置项覆盖前面。以下层级只是发布文件的写作顺序和评审心智模型，
不由代码计算优先级：

```text
1. Complete Baseline Match Rule
   └─ modelMatch=.*
   └─ 为未知 Personal Model 提供完整、保守的默认配置
            |
            v
2. Model Match Rule
   └─ modelMatch
   └─ 与 API Schema 和 Endpoint 无关的模型事实
            |
            v
3. Model + API Match Rule
   └─ modelMatch + apiMatch
   └─ 该公开协议下的请求能力、Option Spec 和参数映射
            |
            v
4. Model + API + Endpoint Match Rule
   └─ modelMatch + apiMatch + baseURLMatch
   └─ 指定官方或兼容 Endpoint 的已证实差异
            |
            v
5. Provider-scoped Match Rule
   └─ providerMatch + modelMatch
   └─ 适用于该 Provider 全部当前/未来成员的服务能力
            |
            v
6. Provider-Model Exact Rule
   └─ providerId + modelId
   └─ 默认 enabled 和无法由 Endpoint 表达的窄产品事实
```

同一模型家族的第 2～4 层连续放置，避免在文件不同区域维护同一模型的事实。跨模型成立的
Provider-scoped 服务事实放在各模型事实之后、Exact Rules 之前。第 1 层只出现一次。
Reasoning Option Spec 的 `values` 必须按推理强度从低到高书写；首项是辅助调用使用的最低公开档位，
末项是普通缺省选择使用的最高公开档位。模型不支持关闭时不得为了统一名称伪造 `off` 或 `nothink`。

Resolver 继续原样遍历 Built-in 数组。Effective Rules 继续由现有领域边界组合：

```text
Built-in Rules（保持物理顺序）
              +
Personal provider-model Rules（保持内部顺序）
              +
Personal Provider-Model Exact Rules（保持内部顺序）
```

不得为实现上述作者规范修改 `ModelConfigRules.composeEffective()` 或增加动态 specificity 排序。

## 4. 各层负责的事实

### 4.1 Complete Baseline

通用基线保证任何合法 Personal Model 都能得到完整 Model Config。默认值必须保守：

- 输入输出格式仅开启明确通用的 Text；
- 未经证明的媒体、工具、JSON Schema 输出、原生搜索和 MCS 为 `false`；
- 提供完整 context、max output 和其他必填叶子；
- `enabled=true`，使用户新建并明确加入 Personal 成员的模型可用。

通用基线不能伪装成某个具体模型的真实能力。

### 4.2 Model Match

Model Match Rule 只表达不随 API Schema 或 Endpoint 改变的事实，例如：

- context window 和模型最大输出硬上限；
- Text/Image/Video/Audio/PDF 输入事实；
- Text 输出事实；
- 可以被所有目标 Schema 可靠表达的模型级 Tool 能力。

模型名匹配对完整 Model ID 做 ASCII 大小写不敏感匹配，但不改写真实请求中的 Model ID。

### 4.3 Model + API Match

这一层表达公开协议差异，例如：

- reasoning level 从低到高的完整可选值；
- `optionSpecs.reasoningLevel.map` 与 `optionSpecs.maxOutputTokens.map`；
- `responseJsonSchema` 能否由该 Schema 编码；
- Tool、MCS、max output 参数在该 Schema 下是否可执行；
- `requiresMfjsToolSchema` 等确属请求编码的窄事实。

“覆盖三种 Schema”表示每个维护模型对三种 Schema 都有明确、可审计的解析结果；不表示厂商官方 Endpoint
必须支持三种 Schema，也不要求把完整模型事实复制三份。缺少官方协议时使用保守结果，第三方兼容 Endpoint
可以由下一层晋升。

### 4.4 Model + API + Endpoint Match

Endpoint 特化优先使用：

```text
modelMatch + apiMatch + baseURLMatch
```

它表达同一模型和 Schema 在某条真实服务线路上的差异。`baseURLMatch` 对规范化后的 URL 做完整正则匹配：
Host 大小写、默认端口和尾斜杠已经规范化，Path、Query 和 Fragment 仍有语义。

适合放在此层的事实包括：

- 官方兼容 Endpoint 实际支持的 JSON Schema、MCS 或 reasoning 参数；
- 只有该 Endpoint 提供的原生 Web Search；
- 同一公开 Schema 在不同服务端实现上的已验证限制。

它不负责 Provider 成员、Account 权益、默认启用或访问材料。一个 Personal Provider 指向同一 Endpoint 时，
应自然取得相同的 Endpoint 事实。

### 4.5 Provider-scoped Match Rule

当一个 Provider 的服务链为其全部当前和未来模型成员提供相同能力，而且该能力不能由 API Schema 或
Endpoint 独立表达时，使用：

```text
providerMatch + modelMatch
```

它仍是普通 Match Rule，不产生新的 Rule 类型。例如 Start Plan、Individual Coding Plan 和 Team Coding Plan
会在模型 API 前使用视觉模型把 Image/Video 转成文字，因此这些 Plan Provider 的全部模型成员都可以声明：

```ts
properties.input_format.support_image = true;
properties.input_format.support_video = true;
```

这里的“多模态”只指已确认的 Image/Video 视觉输入，不推断 Audio 或 PDF。该 Rule 必须精确匹配 Plan Provider，
不能命中由 `zai-api` / `bigmodel-api` Template 创建的普通 API Provider；后者继续使用模型 API 的原生能力。系统不存在
`zhipu-account/mode=api-key` 的“Account API Provider”。

Provider-scoped Rule 只用于真正对全部成员成立的服务事实。仅对一个模型成立的差异仍放在 Model/API/Endpoint
或 Exact Rule，不能借 `modelMatch=.*` 扩散。

### 4.6 Provider-Model Exact Rule

每个 `builtinModelIds` 成员都必须有且只有一条 Exact Rule 明确声明默认 `enabled`，避免新增成员因通用基线
`enabled=true` 而意外进入用户候选。除这张 enabled 矩阵外，Exact Rule 的其他字段应保持稀少，主要负责：

- 某个 Built-in Provider 下该模型的默认 `enabled`；
- 不能由 `model + api + baseURL` 准确表达的 Provider 产品目录事实。

不能为了书写方便，把本可由 Endpoint Match 复用的事实复制到多个 Exact Rule。

## 5. JSON Schema 输出字段

目标字段名固定为：

```ts
properties.supportsJsonSchemaOutput: boolean;
```

它只表示当前 Effective Model 能接受应用提供的 `ModelRequest.responseJsonSchema`，并由目标 Adapter/Schema
编码为 JSON Schema 约束输出。它不表示普通 JSON、JSON Object Mode 或提示词要求返回 JSON。

证据仅证明 `response_format={type:"json_object"}` 时，该字段必须保持 `false`。只有目标 Schema/Endpoint
能够接受 JSON Schema 时才可设为 `true`。UI 文案使用“JSON Schema 结构化输出”。

当前实现中的 `supportsJsonSchemaOutput` 是待迁移旧名；迁移时 Config、Registry、Model、Runtime、Adapter、
Protocol、Settings 和测试必须一次性改名，不保留双字段或 Runtime alias。

## 6. 证据与保守推断

每项非显然事实在发布评审材料中归为三类之一，但分类不写进运行时 Config：

| 分类     | 含义                                                       | 可配置范围                               |
| -------- | ---------------------------------------------------------- | ---------------------------------------- |
| 官方确认 | 厂商当前模型/API 文档明确声明                              | 对应 Model、Schema 或 Endpoint           |
| 产品确认 | ZCode 产品服务、账号接口或内部正式契约明确声明             | 对应 Built-in Provider 产品事实          |
| 协议推断 | 为第三方兼容服务提供的保守通用结果，尚无官方 Endpoint 证明 | 不确定能力为 `false`，允许 Personal 覆盖 |

### 6.1 Models API 是发布证据，不是新的运行时配置层

部分厂商在推理 Endpoint 旁提供模型发现接口：

```text
Base URL + API Schema + 当前访问材料
                    |
                    v
         Provider Models API
                    |
                    +--> 当前访问材料可见的 Model ID
                    `--> 可选的 context / output / capability 元数据
```

这里的查询对象不是脱离账号的 Base URL，而是 `Endpoint + API Schema + 当前访问材料`。同一 Endpoint
在不同账号、区域、套餐或 API Key 下可能返回不同成员。Models API 的路径和认证也由协议及厂商共同决定，
不得在任意 `baseURL` 后机械拼接 `/models`。

发布者按以下边界使用结果：

- 实时成功响应中的 Model ID 是校验该访问材料当前可见成员的强证据；文档中的示例响应只能证明响应形状，
  不能代替实时目录；
- 响应明确返回的 context、max output、输入能力、thinking 或 structured output 等字段，可以成为对应
  Model/API/Endpoint Rule 的官方证据；
- OpenAI-compatible 的基础 Models 响应通常只包含 ID、owner 和时间，不能据此推断媒体、reasoning 或
  Option Specs；
- Anthropic Models API 当前可以返回更丰富的 capability 与 token 上限，但第三方 Anthropic-compatible
  Endpoint 可能只实现其中的子集；
- Account 或 Plan 的账号特定模型集合仍归 Account Overlay；通用 Models API 不覆盖产品权益接口。

Models API 只进入发布验证、差异报告或用户主动导入流程。它不在应用启动或普通请求期间直接覆盖
ZCode Built-in、Account 或 Personal Config，不形成第四层 Config，也不让瞬时网络失败改变 Registry。

官网写“Structured Output”“Search”或“Tools”不足以跨 Schema、Endpoint 扩散。官方资料缺失时可以补齐三种
Schema 的保守规则，但不能凭同家族、相似名称或营销术语开启高风险能力。

能力证据还必须区分“服务接受输入”与“模型消费输入”。请求携带未知字段、图片或其他内容而未报错，可能只是
服务端容忍或忽略，不能据此把对应能力设为 `true`。媒体能力至少需要官方明确声明、ZCode 产品服务契约，或能证明
内容确实参与模型回答的协议级实测。

官网未列出但第三方兼容服务可能提供的模型，可以有完整的保守 Model Rules；只有官方文档、实时 Models API
或产品事实确认该模型可由目标 Endpoint 和 API Schema 调用后，才能把它作为对应官方 Built-in Provider 的
默认启用成员。这样既为 Personal Provider 提供默认值，又不把兼容推断伪装成官方产品承诺。

## 7. 模型成员、默认启用与初始顺序

每个 Built-in Provider 的 `builtinModelIds` 包含保留给用户配置的完整产品目录。默认启用由该 Provider 的
Exact Rules 表达。

发布文件同时遵守：

```text
builtinModelIds
├─ enabled=true 的当前主力或独特模型
└─ enabled=false 的旧型号、重复别名或被替代模型
```

这只是 Built-in 初始成员顺序。系统不增加 enabled-first 动态排序，也不重写 Personal `modelOrder`。
Account Overlay 返回模型子集时按该 Built-in 顺序投影；用户产生完整 `modelOrder` 后继续由现有成员顺序算法负责。

默认启用评审至少回答：

1. 它是否是当前主力型号；
2. 它是否提供其他已启用型号没有的速度、价格、视觉、超长上下文或 Coding 能力；
3. 它是否只是另一个型号的 alias；
4. 它是否已经弃用、下线或被明确替代；
5. 当前 Built-in Endpoint 是否真的提供该 Model ID。

## 8. 发布检查

每次维护 Built-in Release 至少验证：

- Provider Map 和 Rules 仍作为一个原子 Release；
- 每个 `builtinModelIds` 成员都能解析出完整 Model Config；
- 每个维护模型在三种 API Schema 下都有明确解析结果；
- Endpoint 差异优先使用 `baseURLMatch`，Exact Rule 保持产品事实边界；
- Provider-scoped Match Rule 只表达对全部当前/未来成员成立的服务能力；
- Built-in Rule 物理顺序符合本文层级，没有依赖动态优先级；
- Exact Rule 中的 `enabled` 与同 Provider 的初始成员顺序一致；
- retired/alias 模型保留时默认 disabled；
- Personal Exact Rule 仍可后置覆盖；
- Runtime、Adapter 和 UI 不按具体 modelId/Provider ID 重新推断事实；
- 非显然能力有官方、产品或可复现 Endpoint 证据。

发布检查可以使用模型 ID 验证配置事实；生产业务代码不得据此分支。
