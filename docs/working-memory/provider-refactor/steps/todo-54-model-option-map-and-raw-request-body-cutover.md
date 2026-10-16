# Todo 54：Model Option Map 与原始 Request Body 收口

> 状态：已完成
>
> 日期：2026-08-31
>
> 前置：Todo 42 已固定 Reasoning 档位顺序与辅助调用最低档位语义；本 Todo 不改变该裁决，只收口 Option 到原始 API Schema 的映射方式。

## 1. 背景

当前 Model Config 已经用统一 Option 表达两项公共调用参数：

```ts
interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
```

但它们到实际 Provider 请求的投影仍然分裂：

```text
reasoningLevel
├─ optionSpecs.reasoningLevel 定义值域与默认值
├─ 独立 reasoningMapping 按档位保存 Provider 参数
└─ Adapter 再把参数包装为 AI SDK providerOptions namespace

maxOutputTokens
├─ optionSpecs.maxOutputTokens 定义 max/default
├─ Adapter 通过 AI SDK 标准 maxOutputTokens 发送
└─ Anthropic fixed thinking 另有“先减、后由 AI SDK 加回”的兼容换算
```

这会让同一个 Option 的定义与请求效果分散在 Config、ModelFactory、AI SDK namespace 和 Adapter helper 中，
也迫使高级配置作者理解 `providerOptions.anthropic`、`providerOptions.openai`、`extra_body` 等 ZCode/AI SDK
中间协议，而不是直接理解目标 Anthropic Messages、OpenAI Chat Completions 或 OpenAI Responses Schema。

本 Todo 将映射能力收回每个 Option Spec：每个 Option 只认识自己的最终 `value`，用一条受限 CEL `map`
生成面向原始 API Schema Request Body 的 JSON Merge Patch（RFC 7396）。不要把它扩张成聚合 Option Mapping、
通用 Request Adapter 或任意请求改写语言。

正式迁移 Option Config 之前，必须先独立实现并充分验证唯一的受限 CEL 编译/执行模块。Config 完整性检查和
Adapter 请求执行复用同一个模块，不能各自解析或解释表达式。

## 2. 第一性原理

### 2.1 ZCode 统一 Option 与原始 API 字段

| ZCode Option      | Anthropic Messages                               | OpenAI Chat Completions                                | OpenAI Responses    |
| ----------------- | ------------------------------------------------ | ------------------------------------------------------ | ------------------- |
| `reasoningLevel`  | `thinking.type`、必要时 `thinking.budget_tokens` | `reasoning_effort` 或目标兼容 Schema 的同义字段        | `reasoning.effort`  |
| `maxOutputTokens` | `max_tokens`                                     | `max_completion_tokens`；部分兼容协议使用 `max_tokens` | `max_output_tokens` |

ZCode 保持公共 Option 的统一语义；具体字段名、对象层级和开关表达由命中当前 `providerId/modelId/api.type`
的 Model Config Rule 声明。Runtime 与 Adapter 不再根据具体模型 ID、Provider ID 或 API 类型硬编码同一映射。

### 2.2 用户面对原始 API Schema，而不是 AI SDK 协议

Model 设置中的 Option Map 是高级配置项。使用者可以理解当前 Provider 使用的是 Anthropic Messages、
OpenAI Chat Completions 或 OpenAI Responses，并直接书写这些公开 Schema 的字段；不要求理解：

- AI SDK `providerOptions` 的 namespace；
- `extra_body` 等 SDK 透传入口；
- ZCode 内部 `ReasoningParameters`；
- Adapter 为兼容 SDK 建立的预算加减与字段清洗 helper。

Config 中的 Map 结果是最终原始 Request Body 字段权威。AI SDK 或 Adapter 如何生成基础请求体属于内部实现，
不得成为第二份可配置语义。

## 3. 已确认目标结构

### 3.1 每个 Option 自带一个 `map`

```ts
interface EnumOptionSpecConfigInput {
  type?: "enum" | null;
  values?: readonly string[] | null;
  default?: string | null;
  map?: string | null;
}

interface EnumOptionSpec {
  type: "enum";
  /** 按语义强度从低到高；values[0] 是最低公开档位。 */
  values: readonly string[];
  default: string;
  /** CEL：读取当前 Option 的 value，返回 JSON Merge Patch Object。 */
  map: string;
}

interface LimitOptionSpecConfigInput {
  type?: "limit" | null;
  max?: number | null;
  default?: number | null;
  map?: string | null;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  default: number;
  /** CEL：读取当前 Option 的 value，返回 JSON Merge Patch Object。 */
  map: string;
}

interface ModelOptionSpecs {
  reasoningLevel?: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}
```

Config Rule 使用可嵌套、可稀疏 Overlay 的 Input；Effective Model Config 和 Active Model 使用完整 Option Spec。
`map` 位于具体 Option 内，完整路径已经准确表达归属：

```text
optionSpecs.reasoningLevel.map
optionSpecs.maxOutputTokens.map
```

不再新增或保留以下平行概念：

- `reasoningMapping`；
- 聚合 `optionMapping`；
- `requestPatch` / `requestBodyPatch`；
- `requestAdapter` / `requestAdapterRule`；
- `requestBodyTransform`；
- `reasoningLevelPolicy`；
- 任意 Runtime capability/option DTO。

### 3.2 CEL 输入与输出

```text
当前 Option 的 Effective value
              |
              v
          Option.map
              |
              v
    JSON Merge Patch Object
              |
              v
目标 API Schema Request Body
```

首版边界固定为：

- CEL 唯一输入变量是当前 Option 的 `value`；
- Enum Option 的 `value` 是当前最终字符串档位；
- Limit Option 的 `value` 是当前最终数值；
- 可以使用 CEL 条件表达式和必要的算术运算；
- 除当前 `value` 外，表达式中的值必须是字面量；
- 返回值是 JSON Object，按 RFC 7396 JSON Merge Patch 语义应用；
- `null` 使用 RFC 7396 的删除字段语义；数组、字符串、数字和布尔值在对应路径执行整体替换；
- Map 只作用于 JSON Request Body，不处理 Header、Query、Path、Endpoint、鉴权或请求安全校验。

明确不向 CEL 暴露：

```text
其他 Option
context
messages / tools
Provider / Model 对象
apiKey / JWT / Request Auth
Environment / Runtime 状态
AI SDK 实例或 providerOptions
```

如果未来出现独立 Option Map 确实无法表达的正式 Provider，必须带真实 API Schema 和请求证据重新裁决；
不能在本 Todo 中为假想需求提前建立跨 Option 上下文、聚合 Adapter 或表达式依赖图。

### 3.3 受限 CEL 子集

本轮不引入 Beta JavaScript CEL Runtime，也不为了很小的需求携带完整 CEL 实现。仓库新增一个独立、无副作用的
受限 CEL 模块，以 tokenizer、parser、AST evaluator 三层实现；禁止 `eval`、`Function` 或任何动态代码执行。

支持的语法严格限定为：

```text
value
string / number / boolean / null literal
object / array literal
== / != / < / <= / > / >=
+ / - / * / / / %
&& / || / !
condition ? trueValue : falseValue
括号
```

不支持：

```text
函数调用、方法调用、宏、comprehension
成员反射、动态变量、其他 Option、Context
时间、随机数、IO、Provider/Model/凭据对象
完整 CEL 标准库或用户扩展函数
```

该模块对外明确称为“受限 CEL 表达式”：语法和控制流采用本文声明的 CEL 子集，但数值统一使用 JavaScript
`number`，算术、比较、除法与取模遵循 JavaScript 数值语义，不实现 CEL 的 `int` / `double` 类型区分或整数
除法。解析器必须拒绝未实现语法，不能近似解释。数值只接受可安全投影为 JSON number 的有限值；NaN、Infinity、超出 JavaScript 安全整数
范围的整数和 BigInt 结果必须失败。

模块作为 Provider Config 与 CLI Adapter 都可以依赖的纯 TypeScript 独立包存在，不放进 UI、Services 或具体 Adapter，
避免跨域反向依赖。生命周期固定为：

```text
CEL source（持久化）
        |
        v
Config 读取时用共享 compiler 验证
        |
        v
Registry/协议继续传递不可变 CEL source
        |
        v
CLI ModelFactory 创建 Active Model 时编译并绑定 Program
        |
        v
每次请求只绑定 value 并执行
```

同一个 compiler/evaluator 同时服务 Config 编译检查和 Adapter 执行；不允许 Config 与 Runtime 各自实现一个子集。

### 3.4 Config Overlay

`reasoningLevel` 与 `maxOutputTokens` 继续是两个独立的嵌套配置项，Option 内部按照叶子 Overlay。模型 Rule 可以只声明
值域/default，API Schema Rule 可以只声明对应 `map`，两者汇合成完整 Effective Option Spec：

```text
Model Rule
└─ optionSpecs.reasoningLevel
   ├─ type / values / default
   `─ map 缺省

API Schema Rule
└─ optionSpecs.reasoningLevel
   `─ map

             叶子 Overlay
                  |
                  v
Effective Option Spec
├─ type / values / default
`─ map
```

Config Rule 中每个叶子允许缺省、覆盖或用 `null` 清除；Personal Rule 继续只保存用户明确修改的叶子，并排在 Built-in
之后。Effective Option Spec 必须得到完整的 type、值域、default 和 map，否则完整性检查失败。设置页展示继承值不产生
Personal Rule；“全部恢复默认”删除对应的 Personal 叶子覆盖。不得把 `map` 拆成另一个 Overlay Source 或独立持久化字段。

## 4. Reasoning 语义

### 4.1 档位顺序

```text
reasoningLevel.values
├─ values[0]：最低公开档位
└─ 后续元素：按语义强度逐渐增强
```

最低档位不保证等于关闭。例如：

```json
["off", "low", "high"]
```

或：

```json
["low", "high", "max"]
```

普通请求使用显式选择或 `default`；Title、Goal Title、Git Commit Message、Memory Recall 等明确采用低成本
策略的辅助调用继续统一选择 `values[0]`。Runtime 不扫描 `off`、`none`、`nothink` 等字符串推断开关。

### 4.2 Anthropic Messages 示例

```json
{
  "type": "enum",
  "values": ["off", "low", "high"],
  "default": "low",
  "map": "value == 'off' ? {'thinking': {'type': 'disabled'}} : {'thinking': {'type': 'enabled', 'budget_tokens': value == 'low' ? 1024 : 8192}}"
}
```

### 4.3 OpenAI Chat Completions 示例

```json
{
  "type": "enum",
  "values": ["low", "medium", "high"],
  "default": "medium",
  "map": "{'reasoning_effort': value}"
}
```

### 4.4 OpenAI Responses 示例

```json
{
  "type": "enum",
  "values": ["low", "medium", "high"],
  "default": "medium",
  "map": "{'reasoning': {'effort': value}}"
}
```

### 4.5 `budgetTokens` 边界

需要删除的是 ZCode/AI SDK 中间层的统一 `budgetTokens` 参数与兼容换算，不是 Anthropic 原始 API 字段：

```text
ZCode 中间字段 budgetTokens
└─ 删除，不进入公共 Option、Request 或 Mapping 参数结构

Anthropic 原始 thinking.budget_tokens
└─ 允许作为 reasoningLevel.map 生成的字面量字段
```

## 5. Max Output Tokens 语义

`maxOutputTokens` 保持统一的总生成预算语义：

> 单次模型生成的总 Token 上限，包括 reasoning/thinking Token 与用户可见输出 Token。

`LimitOptionSpec.max` 是模型支持的值域上限，`default` 是调用方没有显式覆盖时的默认 Option Value；二者属于
统一 Option 抽象，不能因为某个 SDK 可以省略发送而删除。

### 5.1 Anthropic Messages

```json
{
  "type": "limit",
  "max": 128000,
  "default": 32000,
  "map": "{'max_tokens': value}"
}
```

### 5.2 OpenAI Chat Completions

```json
{
  "type": "limit",
  "max": 128000,
  "default": 32000,
  "map": "{'max_completion_tokens': value}"
}
```

使用旧式或第三方兼容 Schema 时可以由对应 Rule 写：

```cel
{'max_tokens': value}
```

### 5.3 OpenAI Responses

```json
{
  "type": "limit",
  "max": 128000,
  "default": 32000,
  "map": "{'max_output_tokens': value}"
}
```

Provider 不得重新解释 ZCode `maxOutputTokens` 为“仅用户可见输出”。字段名称差异由 Map 解决，语义不变。

## 6. AI SDK 与 Wire 边界

目标顺序：

```text
Model Effective Options
        |
        | 每个 Option 只执行自己的 map(value)
        v
Option JSON Merge Patches
        |
        | 按固定 Option 顺序展开并检查写入路径冲突
        v
无冲突的有序 Patches
        |
        v
AI SDK 序列化基础 JSON Request Body
        |
        v
应用 Option Patches
        |
        v
注入 Access 材料 / 请求安全校验
        |
        v
发送 HTTP 请求
```

对已经由 Option Map 管理的字段：

- 最终原始 Body 以 Map 为权威；
- 不再同时把同义值写进 AI SDK `providerOptions`；
- 不保留 `createRequestProviderOptions(api.type, reasoningMapping[level])`；
- 不保留按 Provider Kind 修改同一 Option 语义的 Runtime 分支；
- 不保留 Anthropic fixed thinking 的“ZCode 先减、AI SDK 再加回”换算；
- 不保留原始 `max_tokens`、`max_output_tokens`、`max_completion_tokens` 与 canonical Option 竞争的字段清洗事实。

Generate 与 Stream 必须使用同一 Patch 执行器和相同应用顺序。Patch 必须在任何依赖 Body 内容的请求安全校验之前完成；
Request Auth、Attribution Headers、重试与响应解析不属于本 Todo 的配置语言。

固定应用顺序首版为 `reasoningLevel` 后 `maxOutputTokens`；未来新增公共 Option 时必须加入显式顺序，不能依赖 JavaScript
对象属性枚举。运行时在应用前展开每个 Patch 实际写入的 RFC 7396 路径并比较：同一路径重复写入、父路径被
`null`/数组/标量整体替换后又写子路径，或其他祖先替换冲突，均立即让本次请求装配失败。对象下不同叶子路径可以合并。
本轮不增加优先级、自动覆盖或复杂静态冲突分析。

Model IO、Debug 和网络捕获必须记录 Patch 后、安全校验前的最终 Request Body；不能继续把 AI SDK 在 Patch 前保存的
`result.request.body` 当作 Wire 事实。现有脱敏规则继续作用于最终捕获结果。

若实现验证发现某个 AI SDK Provider 在请求到达最终 Body Patch 阶段之前强制依赖同义参数，先用真实请求测试固定
失败，再把它作为具体 Schema Adapter 兼容问题处理；不得因此把 AI SDK namespace 暴露回 Config，或恢复第二份映射权威。

## 7. 校验边界

本 Todo 不新增复杂预演或运行时验证体系。

Config/Schema 只要求：

```text
稀疏 Config Input 的已提供叶子类型合法
                +
Effective Enum/Limit Option Spec 所有必需叶子完整
                +
map 是非空字符串且受限 CEL 可以编译
```

明确不做：

- 枚举执行所有 `reasoningLevel.values`；
- 遍历 `LimitOptionSpec` 值域或试跑 default/max；
- 构造不同 Option 的笛卡尔积；
- 静态分析或预演 JSON Path 冲突；
- 建立第二套 Anthropic/OpenAI Request Schema validator；
- 自动改写或修复用户 CEL；
- 为 Map 增加 `language`、`engine`、`version` 或 Policy discriminator。

请求发生时执行受限 CEL、检查当次 Patch 写入路径冲突并应用 RFC 7396，是正常请求装配，不是枚举值域或笛卡尔积
预演。表达式执行、JSON 兼容转换、路径冲突或 Merge Patch 应用失败时，本次请求装配失败并返回明确错误；不得静默
忽略 Map、回退旧 `reasoningMapping` 或让 AI SDK 猜测字段。

独立 Option Map 预期写入互不冲突的原始字段。Runtime 只检查本次实际产生的 Patch 路径冲突；不建设 Config 静态
冲突证明、优先级或跨 Map 依赖能力。Built-in 发布者负责避免多个 Map 竞争同一路径；若未来出现真实、不可回避的
同路径写入需求，再单独裁决。

## 8. UI 与协议投影

设置页不再展示独立的“推理参数 Mapping JSON”，也不提供 Reasoning 或 `maxOutputTokens.map` 的 UI 编辑入口。
Map 由 Built-in 中按 `api.type` 的通用/具体 Model Config Rule 提供；设置页修改 Option 值域、default、max 等可见字段时，
不得把继承的 Map 复制进 Personal Rule，也不能用 `null` 清除 Map。高级配置文件仍使用同一个 Option Spec 结构，
不新增 UI-only Mapping 类型。

跨进程 Config、Settings draft、Personal JSON round-trip、Registry Model Config 与 Active Model Option Specs 使用同一
结构。不得新增平铺 `reasoningMap`、Runtime capability DTO 或 UI-only Mapping 类型。

Vision 标识、输入输出格式、模型选择、Session Selection、Automation、Subagent、Repo Wiki、Compact 与 Off-Peak
继续只消费 Effective Model/Options；本 Todo 不改变它们的模型身份、队列、恢复或持久化归属。

## 9. 实现范围

### 9.1 Config 与 Resolver

- 为 `EnumOptionSpec`、`LimitOptionSpec` 增加 `map`；
- 将 Enum/Limit Option Config 改为叶子级嵌套 Overlay，更新严格 Schema、冻结、`null`、JSON round-trip 与完整性检查；
- 删除 `ReasoningParameters`、`ReasoningMappingConfig`、`ModelConfig.reasoningMapping` 及其完整性循环；
- 将 Built-in 与 Personal Config 投影迁移到每个 Option 内的 `map`；模型 Rule 与 API Schema Rule 可以分别提供不同叶子；
- 更新 Resolver、Registry Model Config、Active Model 与跨进程 Config 投影；
- 新 Schema 不读取未发布的旧 `reasoningMapping`，不增加 dual-read 或一次性 importer；Built-in、测试和当前开发配置直接迁移。

### 9.2 Adapter

- 复用前置阶段已经验证的唯一受限 CEL 模块，引入 RFC 7396 Merge Patch 与运行时路径冲突检查；
- Generate/Stream 共用执行器；
- 删除 reasoning level 到 AI SDK providerOptions 的旧映射；
- 删除 Anthropic fixed-thinking output budget 加减；
- 删除 mapped max output 的并行 AI SDK 字段权威、旧清洗 helper、`visibleMaxOutputTokens` fixed-thinking 换算和含糊中间态；
- 保留消息、工具、媒体、结构化输出、流式解析、Access 和 Attribution 的现有独立职责。

这里只删除 reasoning/max-output 映射生成的 AI SDK namespace 和重复预算字段。`apiFormat`、Anthropic reasoning 历史块的
`signature`/`redactedData`、请求 metadata、工具与消息编码所需的内部 provider metadata/options 不属于本轮删除范围。

### 9.3 Built-in Config

- 按 `api.type` 将所有 `reasoningMapping` 迁入 `optionSpecs.reasoningLevel.map`；
- 为所有 `maxOutputTokens` Spec 增加正确的原始 API 字段 Map；
- Anthropic、OpenAI Chat、OpenAI Responses 与第三方 compatible Rule 分别按其真实 Schema 写 Map；
- 不按具体模型 ID 在生产代码分支，模型差异只存在于 Rule 内容；
- 保持 `reasoningLevel.values` 从低到高和既有 `default` 不变，除非另有模型事实证据。

### 9.4 文档与设置页

- 更新 Model Contract、Configuration、Runtime/Execution、Settings、Built-in Config 与 Access/Adapter 边界文档；
- 删除“Reasoning Mapping 是独立 Model Config 字段”的所有当前设计表述；
- 设置页删除独立 Reasoning Mapping 编辑状态、协议字段和保存 helper，不新增 max-output Map 编辑器；
- Built-in Config 中的 Map 继续直接书写原始 API Schema 字段，不出现 AI SDK namespace；设置页不展示 Map。

## 10. Impact Brief

### 10.1 Feature Summary

| Field            | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Developer intent | 每个公共 Model Option 自带一个受限 CEL Map，直接投影到原始 API Schema Request Body                        |
| Capability       | Model Option Config、Provider Adapter 请求装配                                                            |
| Change layer     | option-source、validation、commit-effect、persistence                                                     |
| Operating mode   | planning                                                                                                  |
| Primary seeds    | `packages/provider/src/config/model-config.ts`、`packages/provider/src/config/schema.ts`、Adapters runner |
| Out of scope     | Access、Header、Endpoint、模型选择、队列、恢复、跨 Option Context、通用 Request Adapter                   |

### 10.2 UI Surface Matrix

| User scenario               | UI entry                        | Draft owner                  | Default/inherit source       | Commit/persistence                | Must remain isolated from                   |
| --------------------------- | ------------------------------- | ---------------------------- | ---------------------------- | --------------------------------- | ------------------------------------------- |
| 编辑 Built-in/Personal 模型 | Provider Model Metadata Dialog  | Model Config draft           | Effective Model Config Rules | Personal Model Config Rule        | Provider 成员、账号资格、Session Selection  |
| 选择 Reasoning/Max Output   | Chat/Automation/Subagent 等选项 | 各入口自己的 Selection draft | Active Model Option Specs    | 各入口既有 Selection/record       | 其他入口的草稿和提交落点                    |
| 实际生成请求                | 无直接 UI                       | 本次 ModelRequest            | Active Model Effective Value | 无新增持久化；提交到 Adapter/HTTP | Desktop continuous / Mobile replayable 状态 |

### 10.3 Feature Relationships

| Rank           | From                      | Semantic edge       | To                             | Why inspect                                                |
| -------------- | ------------------------- | ------------------- | ------------------------------ | ---------------------------------------------------------- |
| must-inspect   | Model Config Schema       | defines             | Option Spec `map`              | 唯一配置与叶子 Overlay 契约                                |
| must-inspect   | Restricted CEL module     | compiles/evaluates  | Option Spec `map`              | Config 与 Runtime 必须共享唯一语义                         |
| must-inspect   | ModelFactory/Active Model | freezes             | Effective Option Specs         | Map 必须与值域/default 同轮冻结                            |
| must-inspect   | Adapter runner            | applies             | AI SDK serialized Request Body | 删除旧 reasoning/max-output 第二权威                       |
| must-inspect   | Built-in Rules            | publishes           | 三种 API Schema Map            | 字段名与对象层级来自配置                                   |
| should-inspect | Settings editor           | edits/persists      | Personal Option Spec           | 删除独立 Mapping JSON 并保留稀疏 Overlay                   |
| invariant-only | Core auxiliary calls      | selects             | `reasoningLevel.values[0]`     | 最低档位语义不改变                                         |
| invariant-only | Access/Request Auth       | signs/authenticates | Patched request                | Patch 必须先于 Body-dependent signing，不改变凭据归属      |
| evidence-only  | Adapter wire/debug tests  | proves              | final raw body                 | 不能只断言 AI SDK options/providerOptions 或 Patch 前 Body |

### 10.4 State Owners And Commit Sinks

| State/fact                      | Authoritative owner                      | Commit/persistence                  |
| ------------------------------- | ---------------------------------------- | ----------------------------------- |
| Option value-domain/default/map | Effective Model Config Rule 叶子 Overlay | Built-in JSON / Personal Model Rule |
| 本次 Option value               | Immutable Active Model + ModelRequest    | 本次调用，不反写 Config             |
| 最终原始 Option 字段            | Option Map 执行结果                      | Request Body，仅本次网络请求        |
| AI SDK/provider metadata        | Adapter 内部兼容实现                     | 不得成为 Config 或 Option Map 权威  |

### 10.5 Must-Preserve Invariants

| Invariant                                                              | Proof needed                             |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| `reasoningLevel.values[0]` 仍是辅助调用最低公开档位                    | Title/Goal/Git/Recall 回归               |
| `maxOutputTokens` 始终表示 reasoning + visible output 的总生成预算     | 三 Schema wire 与预算测试                |
| Active Model 创建后继续冻结，后续 Config 更新只影响新 Model            | ModelFactory/Registry 测试               |
| Personal Rule 继续稀疏，设置页修改/恢复默认不复制或清除 Built-in Map   | Overlay/UI round-trip 测试               |
| Config 编译和请求执行使用同一个受限 CEL 实现                           | CEL 单测与纵向 Adapter 测试              |
| Debug/Model IO 展示的 Body 与最终发送 Body 一致                        | Patch 后捕获与脱敏测试                   |
| Remote Workspace 仍同步同一 Provider Registry，不建立远端 Mapping 权威 | 现有 Registry sync 回归                  |
| Desktop continuous 与 Mobile replayable 不因 Request Body Patch 改变   | 不修改协议/恢复状态；相关 typecheck/回归 |

### 10.6 Graph Drift / Delta

当前 Feature Graph 已覆盖 Provider Registry、Model Option 和 Adapter 执行种子，但尚未声明“Option Spec Map 投影到原始
Request Body”这条语义边。实现阶段在当前设计文档更新后补充该边；本 Todo 不把历史 `reasoningMapping` 继续登记为稳定能力。

## 11. 测试计划

坚持测试先行。

### 11.1 受限 CEL 模块

- tokenizer、parser、AST evaluator 分层测试；
- `value`、各类 literal、嵌套对象/数组、比较、布尔、算术、三元表达式和括号；
- 运算符优先级、短路求值、字符串转义、错误位置和稳定错误消息；
- 未知标识符、函数/方法、宏、成员访问、comprehension 和尾随非法 token 全部拒绝；
- 禁止动态代码执行，执行环境只包含当前 `value`；
- 非有限数值、不安全整数、BigInt 和不可转换为 JSON 的结果失败；
- 编译 Program 可缓存、可重复执行且没有跨请求可变状态；
- 以代表性 CEL 标准语义样例交叉验证已支持子集，不声称完整 CEL conformance；
- Node 开发、单测、CLI build、SEA/发布 bundle 的加载与执行验证。

### 11.2 Config

- Enum/Limit `map` 严格 Schema、冻结和 JSON round-trip；
- Option Spec 每个叶子的三态 Overlay、模型 Rule 与 API Schema Rule 汇合、Personal 后置覆盖；
- `map` 缺失、空字符串和 CEL 编译失败；
- `reasoningLevel.values` 只校验非空以及 `default` 属于值域；不校验重复值或语义强度顺序，这两项由配置发布者负责；
- 删除独立 `reasoningMapping` 后新 Schema 不接受旧字段；
- Effective Config 完整性仍覆盖 reasoning default/values 与 max/default；
- Config 校验不执行 enum 值、不遍历 limit、不预演冲突。

### 11.3 CEL 与 Patch

- Enum 字符串、Limit 数值作为唯一 `value` 输入；
- 条件表达式、算术和嵌套对象；
- RFC 7396 的新增、替换、嵌套 merge、数组整体替换和 `null` 删除；
- 不提供其他 Option、Context、Provider、Model 或凭据变量；
- 固定 Option 应用顺序；不同对象叶子可合并；同路径及父子替换冲突明确失败；
- CEL 执行失败和非对象结果让本次请求明确失败，不回退旧映射。

### 11.4 Wire

- Anthropic reasoning `thinking` 与 `max_tokens`；
- OpenAI Chat `reasoning_effort` 与 `max_completion_tokens`；
- OpenAI Responses `reasoning.effort` 与 `max_output_tokens`；
- 第三方 compatible 的自定义字段路径；
- Generate/Stream 最终 Body 一致；
- Patch 在请求安全校验之前生效；
- Model IO、Debug 和网络捕获观察同一份 Patch 后 Body，并保持敏感字段脱敏；
- 最终 Body 不同时保留 AI SDK namespace、旧字段或重复 canonical 字段；
- Anthropic 不再执行 fixed thinking 的先减后加换算。

### 11.5 Runtime/UI 回归

- 普通请求使用 `default` 或显式 Option；
- Title、Goal、Git、Recall 使用 `values[0]`，且没有 Reasoning Spec 时不合成；
- Compact、Memory、Subagent、Off-Peak、Repo Wiki 继续读取本轮 Active Model；
- 设置页不展示 Map；编辑可见 Option 字段时不复制、不覆盖、不清除 Built-in Map；
- 取消编辑不提交，隐藏字段不丢失；
- 本地/远端 Registry 使用同一结构，无第二套 Runtime DTO。

## 12. 执行阶段

### 阶段 0：受限 CEL 模块与独立验证

1. 建立 Provider Config 与 CLI Adapter 共用的纯 TypeScript 独立模块，固定受限语法、AST 和错误契约；
2. 测试先行实现 tokenizer、parser、evaluator 和 JSON 兼容结果转换，模块不得依赖 UI、Services 或具体 Adapter；
3. 证明编译缓存与重复执行无共享可变状态；
4. 完成 Node、CLI build、SEA/发布 bundle 验证；
5. 独立 Review 安全边界、本文声明的受限表达式语义和未支持语法的 fail-closed 行为。

阶段 0 未完整通过，不进入 Config 或 Adapter 迁移。

### 阶段 A：失败测试与 Spec 同步

1. 更新当前 Model/Configuration/Execution/Settings 设计；
2. 为 Config 叶子 Overlay、Model freeze 和三种 Wire 写失败测试；
3. 固定不支持聚合 Mapping、Context 输入和旧 `reasoningMapping` 的边界。

### 阶段 B：Config 与 Built-in 迁移

1. 修改 Option Spec Input/Effective 类型、叶子 Overlay、Schema、Resolver、Registry 和协议投影；
2. 删除独立 Reasoning Mapping 类型与字段；
3. 迁移 Built-in/Personal 投影；
4. 更新设置页草稿与保存结构。

### 阶段 C：Adapter Wire 收口

1. 接入阶段 0 的共享受限 CEL Program、RFC 7396 Patch 和运行时路径冲突检查；
2. 接入 Generate/Stream 最终 JSON Body；
3. 删除 providerOptions reasoning 映射、budgetTokens 中间态、fixed-thinking 加减、`visibleMaxOutputTokens` 旧换算和输出字段双权威；
4. 将 Model IO/Debug 请求捕获移到 Patch 后、安全校验前的唯一事实位置；
5. 用三种 API Schema wire 测试证明最终请求。

### 阶段 D：清理与验证

1. 全仓清零旧符号、旧文案、旧 JSON 与测试 helper；
2. 更新 Feature Graph 和当前事实文档；
3. 执行定向测试、相关包 typecheck、根 `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、格式检查与
   `git diff --check`；
4. Review Config 权威、AI SDK 边界、Generate/Stream 一致性和本地/远端不变量；
5. 使用 Conventional Commit 提交。

## 13. 完成标准

- 独立受限 CEL 模块先完成充分验证，并成为 Config 编译与 Runtime 执行的唯一实现；
- 每个公共 Option Spec 通过自己的 `map(value)` 声明原始 API Schema Request Body 投影；模型/API/Personal Rule 通过叶子 Overlay 汇合；
- `reasoningMapping`、`ReasoningParameters`、reasoning/max-output 的 AI SDK namespace 映射和旧完整性循环彻底删除；
- `maxOutputTokens` 与 Reasoning 都由 Option Map 形成最终原始 Body，不存在 Adapter 第二套字段映射；
- Anthropic fixed-thinking 的预算先减后加和 ZCode 中间 `budgetTokens` 清零；原始 `thinking.budget_tokens` 只作为
  Anthropic Map 字段存在；
- 三种 API Schema 的 Generate/Stream Wire 测试证明字段路径、值和总输出预算语义正确；
- 多 Option Patch 使用固定顺序并拒绝实际写入路径冲突；Debug/Model IO 与最终 Wire Body 一致；
- Settings、Personal Overlay、Registry、Active Model 和远端同步使用同一 Option Spec 结构；
- Settings 不暴露 Map 编辑入口，Map 由 Built-in Rule 覆盖且不会被可见字段编辑误写；
- 不新增聚合 Option Mapping、Context 输入、通用 Request Adapter、跨 Option依赖或复杂验证器；
- 定向与全量验证通过，Design、Feature Graph、实现和测试一致。

## 14. Planning Handoff

| Item             | Destination                                                                  | Status |
| ---------------- | ---------------------------------------------------------------------------- | ------ |
| Spec update      | Model Contract、Configuration、Execution、Settings、Built-in Config          | done   |
| Case catalog     | 本 Todo 第 11 节                                                             | ready  |
| Coverage matrix  | Restricted CEL / Config / Patch / Wire / Runtime/UI                          | done   |
| Decision backlog | 无；未来跨 Option/Context 需求必须以真实 Provider 重新裁决                   | closed |
| E2E handoff      | 设置页结构变化已更新既有 Provider Settings fixture；Wire 以 Adapter 测试为主 | done   |

## 15. 实施与验证记录

本轮最终实现结果：

- 新增纯 TypeScript `@zcode/model-option-map`，以受限 CEL、RFC 7396 Merge Patch、固定 Option 顺序和写入路径冲突检查提供唯一映射实现；
- Config Schema、稀疏 Overlay、Built-in Rules、Registry、Active Model、CLI Adapter 和 Settings 已统一迁移到 per-option `map`；
- Patch 在 AI SDK 完成基础请求体后、请求安全校验前应用，Generate/Stream、Debug、Model IO 和真实网络请求观察同一份最终 Body；
- 删除 `reasoningMapping`、`ReasoningParameters`、旧 max-output/visible-output 预算换算、Anthropic fixed-thinking 加减、OpenAI compatible `extra_body` 推理投影和相关旧 helper；
- Feature Graph 已补充 Model Option Map 到最终原始 Request Body 的稳定语义边。

最终验证：

- `@zcode/model-option-map`：25/25 单测、typecheck、build 通过；
- `@zcode/provider`：152/152 单测、typecheck 通过；
- `@zcode/provider-node`：48/48 单测、typecheck 通过；
- CLI Adapter 定向测试：190/190 通过，typecheck 通过；
- CLI Core 定向测试：197/197 通过，typecheck 通过；
- CLI Bootstrap 定向测试：52/52 通过，typecheck 通过；
- UI 定向测试：90/90 通过；Contracts typecheck 通过；
- `pnpm --filter @zcode/cli build`、`pnpm lint`、改动文件格式检查、Feature Graph YAML 解析和 `git diff --check` 通过。

全仓门禁仍报告三项与本 Todo 无交集的现有基线问题：Desktop E2E helper 的两个 nullable 端口类型错误；Electron 文档样例和二进制文件导致全仓 `fmt:check` 失败；Adapter 的 Bash 进程组清理测试在当前环境中无法清除忽略 TERM 的后代进程。受影响文件的格式、类型和测试均已单独验证通过。
