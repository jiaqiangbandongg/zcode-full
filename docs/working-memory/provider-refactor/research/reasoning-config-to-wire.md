# Reasoning：从模型配置到最终请求

> 状态：现状调研完成，目标边界已形成；具体迁移方案尚未实施
> 日期：2026-08-10
> 对应阶段设计：[`../steps/01-model-and-request.md`](../steps/01-model-and-request.md)
>
> 术语说明：本文调研时使用 `ModelBinding` 表示连续执行持有的模型对象；当前设计已经收敛为可调用 `Model`，并以 `model.bind(options)` 表达不可变派生。本文中的旧术语仅用于还原当时的代码链路。

## 结论

Reasoning 在产品层可以保持一个很简单的模型：模型声明自己支持哪些档位，用户选择其中一个档位，一段连续执行固定这个选择，Adapter 再把它写成目标接口接受的请求字段。

```text
模型声明 levels
      |
      v
用户选择 reasoningLevel
      |
      v
Model.bind() 固定 reasoningLevel
      |
      v
具体 Adapter 序列化
      |
      v
Provider HTTP 请求
```

当前实现还没有形成这条干净的边界。系统先把逻辑档位转换成一份任意结构的 `providerOptions`，再把这份对象从 Catalog、Bootstrap、Runtime 一直传到 Adapter。转换逻辑同时分布在 App 配置投影、CLI Catalog 默认策略、动态 Provider overlay、历史兼容和辅助模型任务中。

这项调研原本只是 M1 ModelBinding 设计中的一个参数问题。代码展开后可以确认，它已经形成独立的迁移主题：仓库 Catalog 保存过明确参数映射，App 侧会剥离映射而只保留档位，CLI 随后又分别通过动态 `first-match-wins` 规则和 Standalone CLI `last-match-wins` 默认策略重建参数，Title、Git、Compact 与 Memory 还会在调用前再次修改结果。

因此本轮调研在这里划定停止点。M1 在公开边界中只保留通用 `reasoningLevel`：Selection 保存用户选择，`Model.bind(options)` 固定连续执行使用的档位，Request 可以在受 Option Specs 校验的范围内覆盖。现有 `providerOptionsByLevel` 解析集中到兼容装配和 Adapter 路径，不再暴露给业务调用方。统一 Catalog、删除名称推导、统一优先级和重做 Adapter 方言属于后续独立迁移。本文继续作为该课题的现状行为基线。

最容易混淆的几个名字可以先这样理解：

- `thoughtLevel`、`reasoningLevel` 和 `ModelRef.variant` 表达用户选择的逻辑档位，例如 `high`。
- `providerOptionsByLevel` 是“档位到供应商参数”的查询表，它不会原样发送给模型接口。
- `providerOptions` 是某次运行准备交给 AI SDK 的中间对象，里面还混有 reasoning、transport、输出预算和其他 Provider 参数。
- `reasoning_effort`、`enable_thinking`、`thinking`、`output_config.effort` 才是最终 HTTP 请求中的字段。

同一个 OpenAI-compatible 协议下，这些最终字段并不统一。当前代码主要依据显式映射、`provider.kind`、`providerId`、`modelId` 和档位列表选择方言；Base URL 不参与 reasoning 方言判断。因此，两个相同 kind、相同 modelId、不同 URL 的 Provider，在没有显式映射时会得到相同参数。这是当前实现的一项明确限制。

### `apiFormat`、`defaultKind` 与 `kind`

设置页对用户暴露的是 `apiFormat`：

```text
anthropic-messages
openai-chat-completions
openai-responses
```

保存 Provider Config 时，页面同时写入由它派生的 `defaultKind`。Host 生成运行态 Registry 时先解析出最终 `apiFormat`，再派生 CLI 使用的 `kind`：

```text
apiFormat                    defaultKind / kind
anthropic-messages        <-> anthropic
openai-responses          <-> openai
openai-chat-completions   <-> openai-compatible
```

内置 Provider 进入 `ModelProviderConfig` 时通常也同时填充 `apiFormat` 和 `defaultKind`。硬编码 Start Plan 直接写入这对值；远端 builtin schema 通常先给出 `primaryKind`，加载时再派生 `apiFormat`。

在当前三种协议下，这些字段没有表达独立信息。运行态协议同时允许 `kind` 和 `apiFormat`，却没有从类型上排除不一致组合。拟定的演进方向是让 `apiFormat` 成为配置和协议中的单一事实；Adapter factory 内部可以继续使用自己的实现枚举，但该枚举不再进入 Provider Config 或跨进程协议。这个方向还需要在实施前验证 Standalone CLI 的 `provider.kind` 迁移，以及一个 Provider 存在多个 endpoint 时如何显式选择当前协议。

## 一条完整链路

下面这张图先把现状中的主要对象摆在同一条线上：

```text
App config / CLI config / builtin Catalog
                |
                | 声明 levels，部分来源还声明参数映射
                v
ModelCapability.reasoning
├─ enabled
├─ levels
├─ defaultLevel
└─ providerOptionsByLevel
                |
                | 用户在 App / TUI / Automation / Subagent 中选择
                v
thoughtLevel / ModelRef.variant
                |
                | resolveThoughtProviderOptionsForLevel()
                v
Runtime.modelProviderOptions
                |
                | Model Step 构造 ModelTextRequest
                v
ModelTextRequest.providerOptions
                |
                | runner-options 按 Provider kind 归一化 namespace
                v
AI SDK providerOptions
                |
                | 各 SDK 序列化
                v
HTTP request body
```

`ModelCapability.reasoning` 当前既描述可供用户选择的能力，又保存供应商参数映射：

```ts
interface ModelReasoningCapability {
  enabled: boolean;
  levels: string[];
  defaultLevel?: string;
  providerOptionsByLevel?: Record<string, Record<string, unknown>>;
}
```

例如：

```ts
{
  enabled: true,
  levels: ["low", "high"],
  defaultLevel: "high",
  providerOptionsByLevel: {
    low:  { openaiCompatible: { reasoningEffort: "low" } },
    high: { openaiCompatible: { reasoningEffort: "high" } }
  }
}
```

用户选择 `high` 后，Runtime 得到的是：

```ts
{
  openaiCompatible: {
    reasoningEffort: "high";
  }
}
```

OpenAI-compatible Adapter 最终把它发成：

```json
{
  "reasoning_effort": "high"
}
```

## 配置从哪里来

### App 的持久配置

App 的权威文件是 `~/.zcode/v2/config.json`。目前持久化的 reasoning 只描述档位，不保存供应商请求参数：

```jsonc
{
  "provider": {
    "deepseek": {
      "kind": "openai-compatible",
      "options": {
        "apiKey": "sk-...",
        "baseURL": "https://api.deepseek.com/v1",
      },
      "models": {
        "deepseek-v4-pro": {
          "reasoning": {
            "enabled": true,
            "variants": ["high", "max"],
            "defaultVariant": "max",
          },
        },
      },
    },
  },
}
```

这份配置读入 App 后会转换成内部 `ModelProviderReasoningSpec`。每个 level 暂时只有名字，没有 patch：

```ts
{
  defaultLevel: "max",
  levels: {
    high: {},
    max: {}
  }
}
```

App 保存配置时会清理旧的 `model.variants`、`reasoningSpec` 和 `zcode.reasoning` 参数映射。换句话说，普通用户通过 App 设置页保存的配置无法直接规定 `high` 最终使用 `reasoning_effort` 还是 `enable_thinking`；zcode-cli 会在运行时补出映射。

相关转换位于 `modelProviderServiceStorage.ts` 的 `openCodeReasoningToModelReasoning()` 与 `modelReasoningToOpenCodeReasoning()`。

### Standalone CLI 的配置

Standalone CLI 读取 `~/.zcode/cli/config.json`。它接受更接近 Runtime 的结构，可以显式保存 `providerOptionsByLevel`：

```jsonc
{
  "provider": {
    "custom-qwen": {
      "kind": "openai-compatible",
      "baseURL": "https://example.com/v1",
      "models": {
        "qwen3.5-plus": {
          "reasoning": {
            "enabled": true,
            "levels": ["enabled", "disabled"],
            "defaultLevel": "enabled",
            "providerOptionsByLevel": {
              "enabled": { "enable_thinking": true },
              "disabled": { "enable_thinking": false },
            },
          },
        },
      },
    },
  },
}
```

因为 Provider kind 是 `openai-compatible`，CLI schema 会把未带 namespace 的参数包装成：

```ts
{
  enabled: {
    openaiCompatible: { enable_thinking: true }
  },
  disabled: {
    openaiCompatible: { enable_thinking: false }
  }
}
```

如果配置已经带有 `anthropic`、`openai` 或 `openaiCompatible` namespace，则保持原样。

这意味着 App 配置和 Standalone CLI 配置当前并不对称：App 只保存档位；CLI 可以同时保存档位和发送参数。

### Model Catalog 与内置 Provider

历史 Model Catalog 和远端 builtin 配置使用 patch 描述每种 transport 的参数：

```ts
interface ModelProviderReasoningSpec {
  defaultLevel?: string;
  levels: Record<
    string,
    Partial<Record<"anthropic" | "openai" | "openai-compatible", ProviderOptionsPatch>>
  >;
}
```

Kimi K3 的一条真实 Catalog 配置是：

```jsonc
{
  "defaultLevel": "max",
  "levels": {
    "high": {
      "anthropic": {
        "set": [{ "path": ["output_config", "effort"], "value": "high" }],
      },
      "openai-compatible": {
        "set": [{ "path": ["reasoningEffort"], "value": "high" }],
      },
    },
  },
}
```

App 向 zcode-cli 投影当前 transport 时，只取相应 kind 的 patch。假设当前 kind 是 `openai-compatible`，上面会变成：

```ts
{
  high: {
    openaiCompatible: {
      reasoningEffort: "high";
    }
  }
}
```

普通 App 持久配置会清掉这些 patch，但内置 Coding Plan、Start Plan 和远端 client config 可以在内存中携带完整 `ModelProviderReasoningSpec`，再经过同一个协议投影函数进入 zcode-cli。

Plan 的登录态、权益判断、运行时 API Key 和一次性安全校验 Header 不参与 reasoning 方言选择。它们先形成当前可调用的 Provider；reasoning 仍由这个 Provider 的 `kind` 与模型定义决定。当前 ZCode 内置 Plan 主要按 Anthropic runtime 投影，因此 GLM 等模型会走 `anthropic.effort` / `anthropic.thinking` 路径。请求前刷新 Token 或 Header 只改变鉴权材料，不改变已经选择的 reasoning level。

当前本地 Catalog 中实际出现的 reasoning patch 路径只有五类：

```text
anthropic
├─ output_config.effort
└─ thinking

openai-compatible
├─ reasoningEffort
├─ enable_thinking
└─ thinking.type
```

Catalog 的 patch 结构是配置层表达；最终是否能直接被 SDK 接受，还会经过 zcode-cli 的模型特例和 Adapter 归一化。例如 Kimi K3 会在 CLI overlay 中重新生成 `anthropic.effort`，不会直接把 Catalog 的 `anthropic.output_config.effort` 交给 SDK。

## zcode-cli 如何形成 `providerOptionsByLevel`

### 动态 App Provider

App 通过协议下发 Provider 后，`workspace-model-catalog.ts` 为每个模型创建运行时 capability。顺序大致如下：

```text
Kimi K3 模型特例
        |
        | 命中时直接使用 K3 规则
        v
入站 reasoning levels
        |
        +-- 按 kind / providerId / modelId 生成缺失映射
        |
        +-- 合并入站显式 providerOptionsByLevel
        |   显式字段优先
        v
过滤到入站声明的 levels
        |
        v
ModelCapability.reasoning
```

没有入站 reasoning 时，CLI 再尝试按模型名和 Provider kind 补默认值。主要判断字段是：

```text
provider.kind
provider.providerId
model.modelId
model.reasoning.levels
model.reasoning.providerOptionsByLevel
```

Base URL 不在这组判断中。

当前有几类硬编码识别：

- `gpt` 模型按 `provider.kind` 选择 OpenAI、OpenAI-compatible 或 Anthropic 参数。
- `qwen` 通过 providerId 前缀或 modelId 判断，使用 `enable_thinking`。
- `glm` 根据模型名和档位判断是开关还是深度档位。
- `deepseek-v4` 同时使用 `thinking.type` 与 `reasoningEffort`。
- Kimi、MiMo 等模型按 providerId/modelId 家族使用 `thinking.type` 开关。
- Kimi K3 强制使用 `low/high/max`，并按 transport 使用 effort。

同名模型接入两个不同 URL 时，只要 kind、providerId/modelId 规则相同，就会产生相同映射。要表达不同方言，当前只能让上游显式携带不同的 reasoning patch，或者增加新的代码特例。

### Standalone CLI 默认策略

Standalone CLI 的静态 Catalog 使用另一组默认规则，核心位于 `default-policy.ts` 和 `reasoning-policy.ts`：

```text
Kimi K3                 -> low / high / max
DeepSeek V4             -> high / max
GLM 5.2                 -> max / high / nothink
其他 GLM / DeepSeek     -> enabled / disabled
Claude                   -> low / medium / high / xhigh
Claude Opus 4.7          -> low / medium / high / xhigh / max
GPT                      -> low / medium / high / xhigh
```

这里同样按 `providerId` 和 `modelId` 选择默认映射。对于没有显式 reasoning 的自定义 `openai-compatible` 模型，当前配置解析还会补一个通用的 `thinking.type = enabled/disabled` 开关。这一规则覆盖面较宽，无法保证适合所有 OpenAI-compatible 服务。

### 档位名称如何归一化

正常选择先做精确匹配，再做大小写不敏感匹配。没有显式选择时，使用合法的 `defaultLevel`；缺少合法默认值时，使用 `levels[0]`。

当前还有两组模型专用别名：

```text
DeepSeek V4
├─ low / medium -> high
└─ xhigh         -> max

thinking toggle
├─ enabled       -> enabled
└─ disabled/off  -> disabled
```

App UI 会把 `off`、`disabled`、`none`、`nothink` 等值翻译成适合展示的文案，但展示别名本身不会自动改变 Provider 参数。真正的执行归一化仍由 Catalog/Bootstrap 规则完成。

### 静态 options 与档位 options 如何合并

模型 target 可以先带一份静态 `providerOptions`，例如 API format、structured-output 选项或用户配置的自定义字段。Bootstrap 再把选中档位对应的 options 深度合入，档位 options 覆盖同路径的静态值：

```text
target.providerOptions
        +
providerOptionsByLevel[selectedLevel]
        |
        | recursive merge，selected level 优先
        v
Runtime.modelProviderOptions
```

如果静态 options 使用旧 `extra_body` reasoning 路径，Bootstrap 会先移除已经识别的旧 reasoning 字段，再合入 canonical 档位 options；其他自定义字段继续保留。

到了 Adapter runner，Provider Registry 上的静态 options 与 `ModelTextRequest.providerOptions` 还会再合并一次。这一层是顶层合并，请求对象的同名顶层 namespace 优先。正常主链在进入这里前已经由 Bootstrap 合成了完整 namespace，但直接调用 ModelPort 的外围路径仍可能依赖这层行为。

## 当前所有主要参数方言

这里不存在一个有限枚举的“reasoning 状态机”。当前本地 Catalog 只有五种 patch 路径；经过 CLI 默认策略与 SDK namespace 转换后，形成下表七类主要字段形态，并允许 effort 与 thinking 组合出现。

| 运行接口                    | 中间 canonical 字段                  | 典型最终请求字段           |
| --------------------------- | ------------------------------------ | -------------------------- |
| OpenAI Responses            | `openai.reasoningEffort`             | `reasoning.effort`         |
| OpenAI-compatible effort    | `openaiCompatible.reasoningEffort`   | `reasoning_effort`         |
| Qwen compatible             | `openaiCompatible.enable_thinking`   | `enable_thinking`          |
| Kimi/MiMo compatible toggle | `openaiCompatible.thinking.type`     | `thinking.type`            |
| Anthropic effort            | `anthropic.effort`                   | `output_config.effort`     |
| Anthropic fixed thinking    | `anthropic.thinking.budgetTokens`    | `thinking.budget_tokens`   |
| Anthropic adaptive thinking | `anthropic.thinking.type = adaptive` | `thinking.type = adaptive` |

下面按最终接口分组。每一节都给出逻辑档位、中间 `providerOptions` 和最终请求体。

### OpenAI Responses：`reasoning.effort`

OpenAI Provider 当前使用 AI SDK Responses model。逻辑档位通常是：

```text
low / medium / high / xhigh
```

动态 App Provider 形成的中间值：

```ts
{
  openai: {
    reasoningEffort: "high";
  }
}
```

Standalone 默认策略有时仍产生顶层 canonical 字段：

```ts
{
  reasoningEffort: "high";
}
```

`runner-options.ts` 会把顶层字段包装进 `openai` namespace。最终 OpenAI Responses 请求是：

```json
{
  "reasoning": {
    "effort": "high"
  }
}
```

关闭 reasoning 时，支持 `none` 的模型会得到：

```ts
{
  openai: {
    reasoningEffort: "none";
  }
}
```

最终请求：

```json
{
  "reasoning": {
    "effort": "none"
  }
}
```

AI SDK 只会为它识别出的 reasoning model 生成 `reasoning` 对象。某个 level 是否被具体模型接受，仍由 OpenAI API 判定；例如 `none` 和 `xhigh` 并非所有 GPT 型号都支持。

### OpenAI-compatible effort：`reasoning_effort`

Kimi K3、GLM 5.2、通过兼容接口调用的 GPT，以及部分 DeepSeek 使用这条路径。

中间值：

```ts
{
  openaiCompatible: {
    reasoningEffort: "max";
  }
}
```

Adapter 会把 `openaiCompatible` 内容复制到 AI SDK 实际使用的动态 Provider namespace。AI SDK 再把 camelCase 转为 snake_case：

```json
{
  "reasoning_effort": "max"
}
```

GLM 5.2 的 `nothink` 映射为：

```ts
{
  openaiCompatible: {
    reasoningEffort: "none";
  }
}
```

最终是：

```json
{
  "reasoning_effort": "none"
}
```

Kimi K3 在兼容接口下的完整档位是：

```text
low  -> reasoning_effort: "low"
high -> reasoning_effort: "high"
max  -> reasoning_effort: "max"
```

### Qwen 开关：`enable_thinking`

Qwen 的 OpenAI-compatible 接口使用布尔字段：

```ts
// enabled
{
  openaiCompatible: {
    enable_thinking: true;
  }
}

// disabled / off
{
  openaiCompatible: {
    enable_thinking: false;
  }
}
```

AI SDK 将未识别的兼容字段直接透传，因此最终请求分别是：

```json
{ "enable_thinking": true }
```

```json
{ "enable_thinking": false }
```

当前 Qwen 识别依赖 providerId 以 `qwen-alibaba-model-studio` 开头，或 modelId 以 `qwen` 开头。

### Kimi K2、MiMo 与通用兼容开关：`thinking.type`

另一批 OpenAI-compatible 服务使用对象开关：

```ts
// enabled
{
  openaiCompatible: {
    thinking: {
      type: "enabled";
    }
  }
}

// disabled / off
{
  openaiCompatible: {
    thinking: {
      type: "disabled";
    }
  }
}
```

最终请求保持同样的形状：

```json
{ "thinking": { "type": "enabled" } }
```

```json
{ "thinking": { "type": "disabled" } }
```

当前默认规则还会把部分没有显式映射的 GLM、DeepSeek 和未知 OpenAI-compatible 模型归入这种方言。

### DeepSeek V4：effort 与 thinking 同时出现

DeepSeek V4 的 `high/max` 同时携带深度和开启状态：

```ts
// high
{
  openaiCompatible: {
    reasoningEffort: "high",
    thinking: { type: "enabled" }
  }
}
```

最终请求：

```json
{
  "reasoning_effort": "high",
  "thinking": { "type": "enabled" }
}
```

当前本地 Catalog 还声明了 `off`：

```ts
{
  openaiCompatible: {
    thinking: {
      type: "disabled";
    }
  }
}
```

Catalog patch 会同时 unset `reasoningEffort`。动态 overlay 接收入站 `off` 时也会生成 disabled thinking。静态默认策略本身只列出 `high/max`，因此不同来源对 DeepSeek V4 可选档位的覆盖范围并不完全一致。

### Anthropic effort：`output_config.effort`

通过 Anthropic Messages 调用 Kimi K3、GPT 等只需要深度档位的模型时，中间值是：

```ts
{
  anthropic: {
    effort: "xhigh";
  }
}
```

Anthropic SDK 最终生成：

```json
{
  "output_config": {
    "effort": "xhigh"
  }
}
```

Kimi K3 的 `low/high/max` 也走这一形态，不携带 `thinking`。

### Anthropic fixed thinking：effort + budget

普通 Claude 默认策略当前把档位转换成固定预算：

```text
low    -> 4,000 tokens
medium -> 8,000 tokens
high   -> 16,000 tokens
xhigh  -> 32,000 tokens
```

例如 `high`：

```ts
{
  anthropic: {
    effort: "high",
    thinking: {
      type: "enabled",
      budgetTokens: 16000
    }
  }
}
```

最终请求：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 16000
  },
  "output_config": {
    "effort": "high"
  }
}
```

固定 thinking budget 还会影响输出预算。Adapter 会先让 reasoning budget 落在本次 `maxOutputTokens` 以内，再交给 Anthropic SDK；最终线上的 `max_tokens` 保持本次请求的总输出预算，而不是在其上额外无限增加 thinking tokens。

### Anthropic adaptive thinking

Opus 4.7 当前使用 adaptive thinking，并支持 `max`：

```ts
{
  anthropic: {
    effort: "max",
    thinking: {
      type: "adaptive"
    }
  }
}
```

最终请求：

```json
{
  "thinking": {
    "type": "adaptive"
  },
  "output_config": {
    "effort": "max"
  }
}
```

### Anthropic 开关

通过 Anthropic Messages 调用只提供开关的模型时，启用状态通常使用一个 1,024-token 兼容预算：

```ts
{
  anthropic: {
    thinking: {
      type: "enabled",
      budgetTokens: 1024
    }
  }
}
```

最终请求：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```

关闭状态的中间值是：

```ts
{
  anthropic: {
    thinking: {
      type: "disabled";
    }
  }
}
```

当前 AI SDK 会在最终请求中省略 `thinking`，同时不生成 `output_config`。它不会发送 `{ "thinking": { "type": "disabled" } }`。仓库中的 wire test 已明确锁定这一行为。

### GLM / DeepSeek 通过 Anthropic Messages

GLM 5.2 的 `high/max` 同时带 effort 和固定预算：

```ts
// max
{
  anthropic: {
    effort: "max",
    thinking: {
      type: "enabled",
      budgetTokens: 32000
    }
  }
}
```

最终请求与 Claude fixed thinking 相同：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 32000
  },
  "output_config": {
    "effort": "max"
  }
}
```

`nothink` 产生 `thinking: disabled` 的中间值，最终省略 `thinking` 和 `output_config`。

DeepSeek V4 通过 Anthropic Messages 时，`high/max` 使用相应 effort，并固定 `thinking.budgetTokens = 1024`。

## `extra_body` 与历史兼容

早期配置为了把非标准字段塞进 OpenAI-compatible 请求，使用过多层包装：

```ts
{
  openaiCompatible: {
    extra_body: {
      chat_template_kwargs: {
        reasoning_effort: "high",
        enable_thinking: true
      }
    }
  }
}
```

当前 Bootstrap 能识别以下旧路径：

```text
openaiCompatible.extra_body.chat_template_kwargs.reasoning_effort
openaiCompatible.extra_body.chat_template_kwargs.enable_thinking
openaiCompatible.extra_body.thinking
openaiCompatible.extra_body.enable_thinking
openaiCompatible.thinking
```

如果当前 Catalog 能把这些字段匹配到一个 level，Bootstrap 会移除旧 reasoning 子路径，再合入 canonical 映射。例如：

```text
extra_body.chat_template_kwargs.reasoning_effort = "high"
        |
        v
openaiCompatible.reasoningEffort = "high"
```

如果模型无法识别，原始 `extra_body` 会被保留，避免破坏用户自定义参数。

到了 Adapter 边界，仍然存在的 `openaiCompatible.extra_body` 会被展开一次：

```ts
{
  openaiCompatible: {
    extra_body: {
      thinking: { type: "enabled" }
    },
    reasoningEffort: "max"
  }
}
```

最终请求：

```json
{
  "thinking": { "type": "enabled" },
  "reasoning_effort": "max"
}
```

新的本地 Catalog 已经不再保存 `extra_body` reasoning patch；当前 source catalog 的 OpenAI-compatible patch 都使用 direct canonical 字段。

## 用户选择如何进入 Runtime

### App 与协议

UI 中该选项的 ID 是 `thought_level`。模型 capability 提供可选值，Composer、Draft、Workspace default、Task meta 和 Session snapshot 会在各自作用域保存一个字符串。

切换档位时，当前协议调用 `session/setThoughtLevel`。CLI 的 `setThoughtLevel()` 会：

```text
读取当前 modelRef
        |
        v
从 Catalog 校验 level
        |
        v
查 providerOptionsByLevel[level]
        |
        v
同时修改 Runtime
├─ modelRef.variant = level
└─ modelProviderOptions = 对应 options
        |
        v
持久化 Session model selection
```

Session 持久条目保存的是：

```ts
{
  providerId: string,
  modelId: string,
  thoughtLevel?: string
}
```

Runtime 当前保存的是“逻辑选择 + 已展开参数”两份事实。系统恢复和遥测中出现大量反向推导，根源就在这里。

### TUI 与 Standalone CLI

TUI 的 `/effort` 和 `/variant` 命令先读取当前模型的 `listThoughtLevels()`，再调用同一个 `app.setThoughtLevel()`。它不会自行拼接供应商参数。

Standalone CLI 还保存一份全局最近 reasoning level，位置在 Session SQLite 的 local setting：

```text
namespace = "model"
key       = "reasoningLevel"
scope     = "user"
scopeID   = "default"
value     = { level: "high" }
```

这份全局值参与新 Runtime 或临时 Turn 模型的首选档位。Session 本身仍然持久化自己的 `thoughtLevel`。

当前一次性 Prompt CLI 没有独立的 `--reasoning` / `--thought-level` 参数。调用方没有通过 Runtime config 明确提供 `modelProviderOptions` 时，启动装配会读取上面的全局值；已有 Session 的恢复链路还会用 Session 自己保存的 `thoughtLevel` 恢复当前选择。

### Automation、Bot 与闲时任务

Automation、Bot、OffPeak Task 都可以携带 `thoughtLevel` 字符串。普通 Automation/Bot 最终通过创建或恢复 Session 的参数应用档位，之后仍走 `setThoughtLevel()`。

闲时任务还携带一份完整的 `turnRuntimeModel`：

```ts
{
  model: { providerId, modelId },
  thoughtLevel,
  provider: {
    kind,
    baseURL,
    apiKey,
    models: [...]
  }
}
```

Host 把临时 Provider 作为 turn overlay 注入，CLI 再生成 `TurnExecutionModel`，其中已经包含 `modelRef` 和 `modelProviderOptions`。这个对象是当前最接近未来 ModelBinding 输入的结构。

这里存在一个值得迁移时修正的差异：`ZCodeModelRuntimeConfig.thoughtLevel` 会随闲时任务传入，但当前 `resolveTurnExecutionModel()` 解析参数时读取的是 CLI 全局 reasoning preference，并没有直接把 `runtimeModel.thoughtLevel` 作为 preferred level 传入。只有两者恰好一致，或模型默认值一致时，本轮实际档位才与 Host 指定值一致。

## Model Step 如何使用参数

主 Agent Loop 在每个 Model Step 开始时选择：

```text
存在 turnExecutionModel
├─ modelRef            <- turnExecutionModel.modelRef
├─ context / output    <- turnExecutionModel
└─ providerOptions     <- turnExecutionModel.modelProviderOptions

不存在 turnExecutionModel
├─ modelRef            <- Runtime defaultModelRef
├─ context / output    <- Runtime config
└─ providerOptions     <- Runtime config.modelProviderOptions
```

随后 `ModelTextRequest` 同时携带：

```ts
{
  model: ModelRef,
  messages: [...],
  tools: [...],
  providerOptions: Record<string, unknown>
}
```

Adapter Registry 再用 `model` 查询 Provider factory、endpoint、credential 和 SDK model。`runner-options.ts` 合并 Provider 静态 options 与请求 options，并执行最终 namespace 转换。

这条链路中，模型身份和 reasoning 参数来自 Runtime/Turn 快照，Provider client 来自 Adapter Registry，capability 又来自 Catalog。目标 `Model` 的职责是把三者收进同一个可调用对象。

## 特殊模型调用如何处理 reasoning

### Automatic Compact

Automatic Compact 当前默认继承主 Loop 的 `modelRef` 和 `providerOptions`。`ENABLE_COMPACT_SUMMARY_THINKING` 目前为 true，所以摘要请求继续使用主 Loop 的 reasoning。

代码仍保留关闭 Compact reasoning 的分支。该分支会删除 effort，并把 Anthropic/OpenAI-compatible thinking 改为 disabled。它属于历史可切策略，当前默认路径不会触发。

### Session Title 与 Goal Summary Title

标题任务固定关闭 reasoning。当前实现先继承 Runtime 的 `providerOptions`，然后根据模型和方言修改对象：

```text
Anthropic              -> thinking disabled，删除 effort
OpenAI GPT 支持 none   -> reasoningEffort = "none"
OpenAI-compatible      -> enable_thinking=false / thinking disabled / effort none
MiniMax M3             -> 再按 apiFormat 补专用关闭字段
```

这段逻辑位于 `title-provider-options.ts`，它必须同时理解模型名、Provider namespace 和三种 API format。目标设计若保留“标题不思考”，应通过通用 Model Options 表达 `reasoningLevel = disabled`；究竟在任务开始时 `bind()`，还是作为单次 Request 覆盖，由该任务的生命周期决定。Core 不再直接修改供应商参数对象。

### Git Commit Message

`workspace/generateText` 的普通调用继承当前 Provider options；Git Commit Message 复用标题任务的 no-thinking 投影，因此具有相同的方言分支。

### Repo Wiki

Repo Wiki 目前没有走 `ModelPort`、`workspace/generateText` 或上述 `providerOptions` 链路。它从 workspace 对应的 Provider Registry 中读取 provider、model、endpoint、API Key、headers 与 `apiFormat`，随后在 `packages/services` 内直接构造三种 HTTP 请求：

```text
openai-chat-completions
└─ model / max_tokens / messages / temperature

openai-responses
└─ model / input / max_output_tokens

anthropic-messages
└─ model / max_tokens / messages / temperature
```

这些请求都没有携带 reasoning level，也没有发送 `reasoning_effort`、`enable_thinking`、`thinking` 或 `output_config`。因此 Repo Wiki 当前既不继承 Session 的档位，也没有自己的 reasoning 策略。它是 Provider 重构必须收拢的独立模型调用链：未来应先创建自己的 Selection/Binding，再通过 Binding 发起请求；是否使用默认档位或明确关闭 reasoning，需要由 Repo Wiki 的产品语义决定。

### Bot

Bot 没有另一套模型请求 Adapter。Bot 的 `/thoughtLevel` 配置、草稿状态和任务参数保存逻辑 level，创建或恢复 ZCode Task 后仍进入标准 Session/Agent 执行链。因此 Bot 需要统一的是 Selection、Submission 与 Session 恢复语义，不需要新增 reasoning wire 方言。

### Project Memory

Project Memory Recall selector 使用 Lite 模型或主模型，只生成 256-token structured output。当前代码仅把 `anthropic` namespace 清空，以免固定 thinking 消耗预算：

```ts
{
  ...providerOptions,
  anthropic: {}
}
```

它没有为 OpenAI 和 OpenAI-compatible 做同等处理，也没有形成一个明确的 logical reasoning choice。这是一条局部修补链路。

Project Memory Extraction 与 Dream 会捕获模型和 Provider options，再运行自己的小型 Agent Loop。

### Goal Completion Verification

Goal verifier 使用当前 Runtime 的模型和 `modelProviderOptions`，没有独立 reasoning 策略。重试期间模型 ref 会被捕获，但 Provider options 仍从 Runtime config 读取。

### Subagent

Subagent profile 可以同时声明 model 和 `thoughtLevel`。只有 profile 指定了具体模型时，当前代码才调用 `resolveModelProviderOptions(modelRef, profile.thoughtLevel)` 为 Child Runtime 解析参数。

```text
profile 指定具体模型与 thoughtLevel
└─ 按 child model + profile thoughtLevel 解析 providerOptions

profile 使用 inherit / main
└─ 继承父 Runtime 的 modelProviderOptions

闲时 turnExecutionModel 存在
└─ 强制 Child 使用整个 TurnExecutionModel 快照
```

这已经体现了正确的产品语义：Child 选择改变模型或 reasoning 时，应形成自己的 Binding；继承时复用父选择。当前实现仍通过 `modelRef + providerOptions` 分别传递。

## 反向推导与遥测

当前 Runtime 经常只有 `providerOptions`，因此系统还需要反向回答“这到底是哪个档位”。`runtime-thought-level.ts` 会把当前 options 与 `providerOptionsByLevel` 逐项深度匹配：

```text
Runtime providerOptions
        |
        | 和每个 level 的 options 比较
        v
推回 effective thought level
```

它还会识别以下控制类型：

```text
fixed_level   reasoningEffort / reasoning_effort / effort
fixed_budget  budgetTokens / budget_tokens
adaptive      thinking.type = adaptive
toggle        enable_thinking / reasoning_enabled / thinking.type
```

遥测只检查当前 Adapter 真正消费的 namespace，避免一个对象里同时存在 `anthropic` 和 `openaiCompatible` 时误判。OpenAI-compatible 的实际 namespace 又由 `providerOptionsName` 决定。

这套反向推导服务于 Session 恢复、UI current level、Trace 与 telemetry 归因。未来 Binding 直接持有 `ModelSelection.reasoningLevel` 后，正常执行链可以直接记录逻辑选择；Adapter 仍可记录最终线上的有效参数，用于排查供应商行为，但无需再靠任意对象猜回用户选择。

## 当前问题集中在哪里

### 能力声明与序列化规则混在一起

`ModelCapability.reasoning` 同时告诉 UI “有 high 档位”，又告诉 Adapter “high 要传什么对象”。Renderer 只需要前半部分，Core 也不应理解后半部分。

### 同一条规则有多个生成位置

目前至少有以下生成或修正点：

```text
App Catalog patch 投影
Standalone CLI default-policy
Standalone CLI config normalization
动态 workspace-model-catalog
Bootstrap legacy migration
Title / Git / Compact / Memory 请求修补
Adapter runner namespace normalization
```

一项新模型方言经常需要在多处增加特例。

### OpenAI-compatible 的方言识别依赖名称

当前使用 kind、providerId、modelId 和 levels 推断；URL 不参与。名称能覆盖官方已知模型，但无法可靠表达私有网关、代理服务或“相同 modelId、不同兼容实现”。

### App 与 CLI 配置表达不同

App 只保存 variants；Standalone CLI 可保存完整 `providerOptionsByLevel`。Builtin 内存配置又可以携带 transport patch。三种来源进入同一 Runtime 前需要多次补齐和转换。

### Runtime 同时保存选择和展开结果

`modelRef.variant` 是逻辑选择，`modelProviderOptions` 是展开结果。两者可能被不同入口分别更新，因此代码需要大量同步、恢复和反向匹配。

### 辅助任务直接修改任意参数

Title、Git、Compact 和 Memory 根据各自需要删除或补写 Provider 字段。每个调用点都必须了解供应商差异，Adapter 的职责被泄漏到了 Core。

## 对 Model 与 ModelRequest 设计的约束

公共 Option 的语义已经进一步明确：`reasoningLevel` 是用户期望的推理强度，属于软约束；`maxOutputTokens` 是 reasoning 与最终回答共享的总生成 Token 上限，属于硬约束。Model 分别校验两者，不理解 thinking budget，也不承担 Provider 特有的组合校验。

第一阶段保持现有 Adapter 行为。即使部分 Anthropic 新模型的官方推荐已经转向 adaptive thinking，只要当前 fixed-budget 请求仍然能够工作，本轮不改变模型识别、档位映射和 wire request。现有 fixed thinking 继续使用 `min(levelBudget, maxOutputTokens - 1)` 保证总预算。未来 Adapter 专题再评估原生 effort/adaptive 迁移，并把仍需 fixed budget 的方言调整为 `min(levelDefaultBudget, floor(maxOutputTokens * 3 / 4))`，为最终回答保留稳定空间。

这次调研支持下面这条目标链路：

```text
Model
├─ Option Specs 中的 reasoning levels / default
├─ 当前 Model Options
└─ Adapter 内部的 reasoning 方言实现
                |
                | bind({ reasoningLevel })
                |
                v
派生 Model
├─ options.reasoningLevel
├─ properties / optionSpecs
├─ generateText()
└─ streamText()
                |
                v
Adapter 私有序列化
```

目标边界需要满足：

- UI、Session、Submission、Automation 和 Subagent 保存逻辑 level，不保存供应商参数。
- 派生 Model 固定 provider、model 和 reasoning level；连续执行中不再重新读取可变 Runtime 选项。
- Adapter 路径拥有 reasoning 方言。OpenAI-compatible 的差异不能继续泄漏给 Core。
- `providerOptionsByLevel` 在迁移期由一个兼容边界读取，随后封装进 Model/Adapter，不再暴露给 ModelRequest。
- Title、Git 等确实改变 reasoning 的任务，使用 `bind()` 或 Request Options 表达通用档位，不再修改供应商参数对象。
- Compact 只改变消息和预算时复用当前 Model。
- Usage、Trace 和消息历史从实际发起请求的 Model 记录 provider/model/reasoning。
- 最终线上的 Header、Token 刷新、路由、重试和字段序列化继续留在 Adapter 内部。

具体采用“更细的 Adapter 类型”还是“一个 Adapter 加强类型 reasoning strategy”，仍需在后续 Adapter 设计中裁决。无论字段最终叫什么，它必须成为 Provider/Adapter 路径中的显式事实，能够区分相同 modelId 接在不同兼容服务上的情况。

## 实施前需要锁定的测试

迁移不能只验证中间 `providerOptions`。至少要保留三层测试：

```text
配置/Definition 测试
└─ levels、默认值和方言声明正确

Model 测试
└─ Options 被校验并固定，Core 看不到任意 providerOptions

Wire 测试
└─ 捕获真实 SDK 请求 body，验证最终字段
```

现有 wire tests 已覆盖 OpenAI Responses `none`、Anthropic effort、Anthropic thinking budget、OpenAI-compatible `reasoning_effort`、`enable_thinking`、`thinking.type` 和 legacy `extra_body` 展开。它们应成为迁移时的行为基线。

## 主要代码证据

- 能力类型：`apps/zcode-cli/packages/contracts/src/model/catalog.ts`
- App provider/config 类型：`packages/shared/src/model-provider-types.ts`
- App config 读写：`packages/services/src/model-provider/modelProviderServiceStorage.ts`
- App 到协议的 reasoning patch 投影：`packages/shared/src/zcode-protocol/index.ts`
- 动态 App Provider 映射：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- CLI 静态默认规则：`apps/zcode-cli/packages/adapters/src/model/default-policy.ts`
- 各种内置映射：`apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`
- Standalone CLI 配置归一化：`apps/zcode-cli/packages/adapters/src/config/schema.ts`
- level 解析与遥测反推：`apps/zcode-cli/packages/adapters/src/model/runtime-thought-level.ts`
- Runtime options 合并与旧配置迁移：`apps/zcode-cli/packages/bootstrap/src/runtime-model-metadata.ts`
- Session 档位切换：`apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
- Model Step 使用点：`apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts`
- Adapter 最终归一化：`apps/zcode-cli/packages/adapters/src/model/runner-options.ts`
- OpenAI-compatible wire tests：`apps/zcode-cli/packages/adapters/tests/openai-compatible-extra-body-wire.test.ts`
- Anthropic wire tests：`apps/zcode-cli/packages/adapters/tests/anthropic-effort-wire.test.ts`
- disabled wire tests：`apps/zcode-cli/packages/adapters/tests/reasoning-disabled-wire.test.ts`
- 特殊调用策略：`apps/zcode-cli/packages/core/src/runtime/methods/title-provider-options.ts`、`compact-active.ts`、`workspace-generate-text.ts` 和 `project-memory-recall.ts`
- Repo Wiki 直连请求：`packages/services/src/repo-wiki/repoWikiModelClient.ts` 与 `repoWikiProviderRegistryModelConfig.ts`
- Bot 档位选择与任务派发：`packages/services/src/bots/botsService.ts`
