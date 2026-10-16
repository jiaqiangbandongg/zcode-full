# Model Option Map 与原始请求体

> 状态：当前有效设计
>
> 最近更新：2026-09-02

## 目标

`reasoningLevel` 与 `maxOutputTokens` 是 ZCode 的公共 Model Option。每个 Option Spec 同时声明
值域和它到目标 API 原始 JSON Request Body 的映射：

```ts
interface EnumOptionSpec {
  type: "enum";
  /** 按语义强度从低到高，values[0] 是最低公开档位。 */
  values: readonly string[];
  map: string;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}
```

`map` 是受限 CEL 表达式。它唯一可读取的变量与所属 Option 同名：`reasoningLevel.map` 读取
`reasoningLevel`，`maxOutputTokens.map` 读取 `maxOutputTokens`。表达式返回一个 RFC 7396
JSON Merge Patch Object。Config、Registry、Active Model 与 Runtime 共用同一个字段名和事实，不再建立
`reasoningMapping`、AI SDK `providerOptions` 映射或输出预算兼容 DTO。

## 唯一执行链

```text
Effective Model Config
        |
        | 完整 optionSpecs
        v
ModelFactory 创建 Active Model
        |
        | 编译每个 map 一次
        v
Model.bind / ModelRequest options
        |
        | bound < request；进入 Executor 前必须完整
        v
Effective Request Option values
        |
        | reasoningLevel，随后 maxOutputTokens
        v
有序 JSON Merge Patches
        |
        v
AI SDK 已完成协议序列化和 Schema 兼容的原始 JSON Body
        |
        | 应用 Patch，并记录 Model IO
        v
业务 Header / 动态鉴权 / 请求安全校验 / 网络发送
```

Map 必须在 AI SDK 和协议兼容层已经形成最终 JSON Body 之后、动态请求安全校验之前应用。`generateText()` 与
`streamText()` 共用同一个执行器；Model IO 捕获的是 Patch 后真正发送的请求体。Runtime 不再同时传递
AI SDK 标准 `maxOutputTokens` 或 reasoning namespace，否则会形成第二份请求字段权威。

## 受限 CEL

唯一实现位于纯 TypeScript 包 `@zcode/model-option-map`，由 Provider Config 校验与 CLI Adapter 共同使用。
实现固定为 tokenizer、parser、AST evaluator；禁止 `eval`、`Function` 或动态代码执行。

支持：

```text
所属 Option 的同名变量（`reasoningLevel` 或 `maxOutputTokens`）
string / number / boolean / null
object / array literal
== != < <= > >=
+ - * / %
&& || !
condition ? whenTrue : whenFalse
括号
```

每个 Map 只暴露自己的同名变量；旧通用变量 `value` 不受支持。不支持函数、方法、成员访问、宏、
comprehension、其他 Option、Provider/Model/凭据对象、时间、随机数和
任何 IO。数值统一采用 JavaScript `number`，算术、比较、除法与取模均遵循 JavaScript 数值语义；本受限
表达式不实现 CEL 的 `int` / `double` 类型区分或整数除法。数值输入和计算结果必须能安全表示为有限 JSON
number；Map 最终必须返回 JSON Object。

## Overlay 与完整性

Rule Input 中的 `optionSpecs.reasoningLevel` 和 `optionSpecs.maxOutputTokens` 都是可嵌套的稀疏 Overlay；
`type`、值域、max 与 map 可以独立继承、覆盖或用 `null` 清除。Effective Model Config 必须得到
完整 Option Spec：

- `maxOutputTokens` 必须具有合法 `type/max/map`；
- `reasoningLevel` 必须具有合法 `type/values/map`；
- `reasoningLevel.values` 非空、无空白项、无重复项，并按语义强度从低到高排列；客户端不根据名称猜测语义；
- 所有 map 必须能由同一个受限 CEL compiler 编译，并返回 Object Patch；
- 不兼容读取未发布的 `reasoningMapping`，也不建立 dual-read 或 importer。

设置页以固定高度技术文本框编辑 Reasoning Map。Personal Map 是输入值，Inherited Map 是 placeholder；
清空输入表示删除 Personal `map` 叶子并恢复继承。Renderer 仍只维护稀疏 Personal Model Rule，不能把
Inherited 值反向展开成 Personal 覆盖。Max Output Map 暂不开放编辑，保存其他字段时必须原样保留。

## Patch 顺序与冲突

同一请求按固定顺序执行：

```text
reasoningLevel.map
        |
        v
maxOutputTokens.map
```

两个 Map 可以写同一对象下的不同叶子，例如 `reasoning.effort` 与 `reasoning.max_tokens`。如果写入相同
路径，或一方写父路径而另一方写其子路径，则请求在网络前明确失败；不能依赖覆盖顺序静默决定结果。
RFC 7396 中 `null` 表示删除字段，数组和其他非 Object 值在对应路径整体替换。

## 典型 Schema

```text
Anthropic Messages
├─ reasoningLevel -> thinking.type 或 output_config.effort
└─ maxOutputTokens -> max_tokens

OpenAI Chat Completions
├─ reasoningLevel -> reasoning_effort（或经证据确认的兼容字段）
└─ maxOutputTokens -> max_completion_tokens / max_tokens

OpenAI Responses
├─ reasoningLevel -> reasoning.effort
└─ maxOutputTokens -> max_output_tokens
```

具体表达只属于命中 `providerId/modelId/api.type/baseURL` 的 Model Config Rule。Runtime 与 Adapter 禁止根据
具体模型 ID、Provider ID 或 API 类型重新推断这些字段。

## Built-in 兜底与专用规则（Todo 95）

表达式写作与排版统一遵循 [Option Map 写作风格](option-map-writing-style.md)：对象展开、两空格缩进、简单三目同行。写作风格与下列改造/兼容约束分开维护。

- 专用 Map 的整理只允许合法输入的请求等价化：同名 effort 直接透传，条件下沉到变化字段；字段是否存在不同才保留对象分支。不得用 `null` 代替省略，也不改模式、预算和值域。
- API Schema 兜底增强：Chat Completions 同时输出 `thinking.type`、`enable_thinking`、`reasoning_effort`、`reasoning.effort`，关闭 `disabled/none` 统一为关闭开关与 effort `none`；Responses 仅使用 `reasoning.effort`；Messages 为 `disabled` 或 Adaptive + 原 effort，不增加手动预算模式。
- 混合 Chat 兜底依赖用户已接受的假设：未知字段被忽略，一致的重复控制可并存，关闭模式下额外 effort 可被忽略或允许 `none`。不是所有站点的已验证保证；不兼容正常报错，不删字段重试。
- 通用 values 仍只有 `disabled`，新增合法档位才能使用该档位；专用规则与 Personal Map 仍按既有 Overlay 顺序覆盖兜底。Reasoning Map 不写输出上限。
- 非原生关闭档位改名为单独兼容变更；未经 Personal Map-only 覆盖与执行入口的安全验证，不把 `off/nothink` 改成 `disabled`。来源受限的旧选择兼容不能替代对用户 Map 语义的保护。
