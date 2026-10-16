# Model 公共契约

本篇给出业务调用方可见的 Model 类型。Provider 配置如何形成、Model 如何创建，分别见 [`../registry/configuration.md`](../registry/configuration.md) 和 [`../registry/model-creation.md`](../registry/model-creation.md)。

## 类型关系

```text
Model
├─ identity
│  ├─ providerId
│  └─ modelId
├─ properties
├─ optionSpecs
├─ options
├─ bind()
├─ generateText()
└─ streamText()
       |
       v
ModelRequest
├─ messages
├─ tools
├─ responseJsonSchema
├─ options
└─ abortSignal
```

四类数据承担不同职责：

| 数据            | 含义                                       | Request 能否修改           |
| --------------- | ------------------------------------------ | -------------------------- |
| Properties      | 当前模型已经确定的性质                     | 否                         |
| Option Specs    | 通用 Option 的可选值、顺序、上限和请求映射 | 否                         |
| Model Options   | 当前 Model 绑定的 Option                   | 通过 `bind()` 派生新 Model |
| Request Options | 单次调用的 Option 覆盖                     | 是，只影响本次调用         |

## Properties

```ts
interface ModelProperties {
  contextWindow: number;
  input_format: {
    support_text: boolean;
    support_image: boolean;
    support_video: boolean;
    support_audio: boolean;
    support_pdf: boolean;
  };
  output_format: {
    support_text: boolean;
  };
  supportsToolCall: boolean;
  supportsJsonSchemaOutput: boolean;
  supportsNativeWebSearch: boolean;
  supportsMidConversationSystem: boolean;
}
```

Properties 供调用方选择请求策略，也供 Model 在发送请求前检查请求与模型是否相容。

| Property                        | 使用位置                                    |
| ------------------------------- | ------------------------------------------- |
| `contextWindow`                 | Context 预算与 Compact 判断                 |
| `input_format`                  | Text、Image、Video、Audio、PDF 输入格式检查 |
| `output_format`                 | 当前 Text 输出格式检查                      |
| `supportsToolCall`              | Agent Tool 请求检查                         |
| `supportsJsonSchemaOutput`      | JSON Schema 请求检查                        |
| `supportsNativeWebSearch`       | 决定是否使用 Provider 原生搜索能力          |
| `supportsMidConversationSystem` | 决定历史消息的 Provider message 转换策略    |

`supportsNativeWebSearch` 和 `supportsMidConversationSystem` 是 Effective Model Config 的最终能力事实，在
Model 创建阶段固定。产生它们的 Model Config Rule 可以根据模型、Provider、API 类型等解析上下文组合
匹配，并不要求能力只能由 modelId 决定。Core 只读取固定后的结论，不再根据 Provider 类型、URL 或
modelId 临时推断。

## Option Specs

公共 Option 使用固定字段。每个模型通过 Option Specs 描述合法范围、语义顺序、硬上限和请求映射；Option Spec 不拥有执行默认值：

```ts
interface EnumOptionSpec {
  type: "enum";
  // 按语义强度从低到高；values[0] 是最低公开档位。
  values: readonly string[];
  map: string;
}

interface LimitOptionSpec {
  type: "limit";
  max: number;
  map: string;
}

interface ModelOptionSpecs {
  reasoningLevel: EnumOptionSpec;
  maxOutputTokens: LimitOptionSpec;
}

interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
```

`reasoningLevel` 是用户期望的推理强度。它是软约束：Adapter 尽可能用目标协议的 effort、level、toggle 或兼容 budget 表达。
`reasoningLevel.values` 按推理强度从低到高排列；`values[0]` 是模型公开的最低档位，但不保证等于关闭。
标准模型选择确实缺省时在 Host Selection 边界选择 `values.at(-1)`；明确采用低成本策略的辅助请求显式选择
`values[0]`。不得扫描 `off`、`nothink`、`none` 等名称猜测关闭能力。

`maxOutputTokens` 是推理与最终回答共享的总生成 Token 硬上限。Model 校验调用值没有超过对应 `LimitOptionSpec.max`，不替调用方静默截断。

Option 字段是封闭集合。Provider 不能通过公共接口增加任意 `Record<string, unknown>` 参数。新的通用 Option 需要先确定跨 Provider 语义，再进入 `ModelOptionSpecs`、`ModelOptions` 和 Adapter。

## Option 解析

```text
Model 绑定的具体 Options
        |
        | ModelRequest.options 覆盖
        v
Request Effective Options
```

Request 显式值覆盖 Model 绑定值。`ModelOptions` 是绑定/请求阶段的稀疏 Overlay，但进入 Executor 前必须同时
存在合法 `reasoningLevel` 和 `maxOutputTokens`。缺值在网络 I/O 前失败，Model、Adapter 和 Runner 不从
Option Spec 猜测执行值。标准初始选择只在 Host Selection 边界按 `values.at(-1)` 补齐一次；辅助调用显式绑定
`values[0]`。

```ts
const model = baseModel.bind({
  reasoningLevel: "high",
  maxOutputTokens: 32_000,
});

await model.generateText({
  messages,
  options: {
    maxOutputTokens: 8_000,
  },
});
```

上例的请求使用 `reasoningLevel = high` 和 `maxOutputTokens = 8_000`，不会修改 `model.options`。

## ModelRequest

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}
```

ModelRequest 描述一次模型调用。模型身份、API Key、Request Auth、Endpoint、Provider 类型和 Provider
专属参数已经由 Model 的执行实现及其依赖确定，不出现在 Request 中。`zhipu-account`
的动态访问材料在每个 request attempt 上由 Account Request Auth Service 解析，不改变公共 ModelRequest Schema。

## 请求检查

Model 在调用 Adapter 前执行统一检查：

| Request 内容         | 检查依据                                |
| -------------------- | --------------------------------------- |
| 图片消息             | `properties.input_format.support_image` |
| PDF 消息             | `properties.input_format.support_pdf`   |
| 视频消息             | `properties.input_format.support_video` |
| `tools`              | `properties.supportsToolCall`           |
| `responseJsonSchema` | `properties.supportsJsonSchemaOutput`   |
| `reasoningLevel`     | `optionSpecs.reasoningLevel.values`     |
| `maxOutputTokens`    | `optionSpecs.maxOutputTokens.max`       |

请求超出 Option Spec 时返回明确错误。Request 使用了模型明确声明为不支持的输入或能力时，Model 同样返回明确错误。这层检查是发送请求前的统一 double check；调用方仍可提前读取 Property 选择自己的策略。

目标 Registry 发布的 ModelConfig 必须具有完整 Property，因此目标设计中不存在 `unknown`。
输入输出格式的完整结构、Rule Overlay 和迁移边界见
[`input-output-format.md`](./input-output-format.md)。

## Adapter 边界

```text
ModelRequest
      |
      | resolve options + validate
      v
Provider-neutral request
      |
      | AI SDK / Adapter 序列化
      v
目标 API 原始 JSON Request Body
      |
      | per-option map（reasoningLevel 后 maxOutputTokens）
      v
最终 Provider request
├─ Option JSON Merge Patch
├─ 动态 Token / Header
├─ 路由与重试
└─ 错误归一
```

公共 Model 层分别理解 `reasoningLevel` 和 `maxOutputTokens`，不理解 thinking budget，也不增加 Provider
专属的组合约束。每个 Option Spec 的 `map` 是最终请求字段的唯一配置权威；Runtime 不再并行传递 AI SDK
reasoning namespace、标准 max-output 字段或 fixed-thinking 预算换算。完整契约见
[`model-option-map.md`](./model-option-map.md)。

## Result、Event 与归因

`ModelResult` 和 `ModelEvent` 使用 M1 已建立的统一结果类型：前者表达最终消息、usage 和结束原因，后者表达流式增量、tool call、usage 与结束事件。Provider SDK 原始对象留在 Adapter 内，不再为不同调用方形成平行结果类型。

Usage、Trace、Model IO、cost、quota 和错误归因读取发起请求的 Model identity 与本次 Effective Options，不读取 Composer Selection、后来变化的 Session Selection，也不依赖 Provider 响应中可缺省的 model 字段。
