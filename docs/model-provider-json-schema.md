# Model Provider JSON Schema

> 历史文档：下一阶段不再使用 `zcode.model-providers.v1` catalog schema，也不再使用
> `reasoning.levels[level][kind]` patch 作为新配置主格式。新的权威设计见
> `docs/model-provider-opencode-config.md`。

## 目标

这个 JSON 用来描述一个模型供应商的连接信息、接口格式、模型能力和思考参数映射。
它应该贴合当前 ZCode runtime 的概念，而不是再发明一套协议命名。

核心约束：

- 接口格式统一用现有 `kind`：`anthropic`、`openai`、`openai-compatible`。
- JSON 里只写 `openai-compatible`，不要出现 `openaiCompatible`。
- `endpoints` 使用一个公共 `baseURL`，各 `kind` 只配置自己的 URL `path`。
- `reasoning` 不放 UI 字段，比如 `label`、`rank`、`enabled`。
- `reasoning` 只描述“某个 level 在某个 kind 下要怎么改请求参数”。

## 顶层结构

```jsonc
{
  "schemaVersion": "zcode.model-providers.v1",
  "providers": [
    {
      "id": "example",
      "name": "Example",
      "endpoints": {
        "baseURL": "https://api.example.com",
        "paths": {
          "anthropic": "/anthropic/v1/messages",
          "openai-compatible": "/v1/chat/completions",
          "openai": "/v1/responses"
        }
      },
      "defaultKind": "openai-compatible",
      "models": []
    }
  ]
}
```

`endpoints.paths` 的 key 必须是 `kind` 字面量。这样配置里不会同时出现
`openaiCompatible` 和 `openai-compatible` 两种写法。

`baseURL + path` 表示该 kind 的完整请求地址。比如：

```text
https://api.example.com + /v1/chat/completions
```

如果某个供应商不同 kind 连 host 都不同，v1 建议拆成两个 provider，不在一个
provider 里做 per-kind `baseURL` 覆盖。

## Model 结构

```jsonc
{
  "id": "example-reasoner",
  "name": "Example Reasoner",
  "kinds": ["anthropic", "openai-compatible"],
  "defaultKind": "anthropic",
  "modalities": {
    "input": ["text", "image", "video", "audio"],
    "output": ["text"]
  },
  "contextWindow": 200000,
  "maxOutputTokens": 64000,
  "reasoning": {}
}
```

字段说明：

- `id`：默认发送给上游的模型名。
- `kinds`：该模型支持的接口格式，值必须存在于 `provider.endpoints.paths`。
- `defaultKind`：该模型默认走哪个格式；缺省时用 provider 的 `defaultKind`。
- `modalities.input` / `modalities.output`：模型输入和输出模态。
- `contextWindow`：上下文长度，单位 token。
- `maxOutputTokens`：最大输出长度，单位 token。它表示模型能力上限，也是正常请求的模型级
  输出预算；只有该值缺失时才 fallback 到 32K，再由 AI SDK 映射为对应协议的标准输出字段。
  请求侧策略见 [模型请求输出上限策略](./model-request-output-tokens.md)。
- `options`：透传给具体 provider 的 canonical AI SDK 请求参数。OpenAI-compatible provider
  需要固定 `max_tokens`、`max_completion_tokens` 等扩展字段时直接配置，例如
  `{ "max_tokens": 64000 }`。

不要额外写 `supportsImages` / `supportsVideo`。这些能力可以从 `modalities` 推导：

```ts
const supportsImages = model.modalities.input.includes("image");
const supportsVideo = model.modalities.input.includes("video");
```

如果同一个模型在不同 kind 下必须使用不同上游模型名，再加可选字段
`modelIdByKind`：

```jsonc
{
  "id": "claude-sonnet",
  "modelIdByKind": {
    "anthropic": "claude-sonnet-4-5-20250929",
    "openai-compatible": "anthropic/claude-sonnet-4.5"
  }
}
```

默认情况下不需要这个字段。没有命中 `modelIdByKind[kind]` 时直接使用 `id`。

## Reasoning 结构

`reasoning` 是一个按 level 和 kind 分组的请求参数补丁表。

```jsonc
{
  "reasoning": {
    "defaultLevel": "medium",
    "levels": {
      "off": {
        "anthropic": {
          "set": [
            {
              "path": ["thinking"],
              "value": { "type": "disabled" }
            }
          ]
        },
        "openai-compatible": {
          "set": [
            {
              "path": ["thinking", "type"],
              "value": "disabled"
            }
          ]
        },
        "openai": {
          "set": [
            {
              "path": ["reasoningEffort"],
              "value": "none"
            }
          ]
        }
      },
      "medium": {
        "anthropic": {
          "set": [
            {
              "path": ["thinking"],
              "value": {
                "type": "enabled",
                "budgetTokens": 8000
              }
            }
          ]
        },
        "openai-compatible": {
          "set": [
            {
              "path": ["reasoningEffort"],
              "value": "medium"
            }
          ]
        },
        "openai": {
          "set": [
            {
              "path": ["reasoningEffort"],
              "value": "medium"
            }
          ]
        }
      }
    }
  }
}
```

这里的 `path` 是“字段路径”，不是 URL path。它是字符串数组，表示要设置或删除
的请求参数位置。例如：

```jsonc
["thinking"]
["reasoningEffort"]
["thinking", "type"]
```

运行时根据当前模型实际使用的 `kind` 取对应补丁，然后生成当前 adapter 需要的
provider options。

公开 JSON 不写 `openaiCompatible`。如果当前 kind 是 `openai-compatible`，转换层负责
把它映射到 AI SDK 内部 namespace：

```ts
{
  "openai-compatible": {
    set: [{ path: ["reasoningEffort"], value: "medium" }]
  }
}

// 转换后进入现有 adapter providerOptions：
{
  openaiCompatible: {
    reasoningEffort: "medium"
  }
}
```

## 关闭思考

关闭思考也只是一个普通 level，统一用内部 level id `off`。

如果 `levels.off` 存在，表示模型支持关闭思考；如果不存在，表示这个模型不能显式
关闭思考。

不同供应商关闭方式不同：

```jsonc
{
  "off": {
    "anthropic": {
      "set": [
        {
          "path": ["thinking"],
          "value": { "type": "disabled" }
        }
      ]
    },
    "openai": {
      "set": [
        {
          "path": ["reasoningEffort"],
          "value": "none"
        }
      ]
    },
    "openai-compatible": {
      "unset": [
        {
          "path": ["reasoningEffort"]
        }
      ]
    }
  }
}
```

有些接口关闭思考是“不传字段”，这种情况用 `unset`。有些接口要求传
`disabled` / `none` / `false`，这种情况用 `set`。

## TypeScript 草案

```ts
type ModelProviderKind = "anthropic" | "openai" | "openai-compatible";
type Modality = "text" | "image" | "video" | "audio";

interface ProviderCatalogFile {
  schemaVersion: "zcode.model-providers.v1";
  providers: ProviderSpec[];
}

interface ProviderSpec {
  id: string;
  name: string;
  endpoints: ProviderEndpoints;
  defaultKind?: ModelProviderKind;
  models: ModelSpec[];
}

interface ProviderEndpoints {
  baseURL: string;
  paths: Partial<Record<ModelProviderKind, string>>;
}

interface ModelSpec {
  id: string;
  name?: string;
  kinds: ModelProviderKind[];
  defaultKind?: ModelProviderKind;
  modelIdByKind?: Partial<Record<ModelProviderKind, string>>;
  modalities: {
    input: Modality[];
    output: Modality[];
  };
  contextWindow: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningSpec;
}

interface ReasoningSpec {
  defaultLevel?: string;
  levels: Record<string, ReasoningLevelPatchByKind>;
}

type ReasoningLevelPatchByKind = Partial<
  Record<ModelProviderKind, ProviderOptionsPatch>
>;

interface ProviderOptionsPatch {
  set?: FieldSetPatch[];
  unset?: FieldUnsetPatch[];
}

interface FieldSetPatch {
  path: string[];
  value: unknown;
}

interface FieldUnsetPatch {
  path: string[];
}
```

## 完整示例

```jsonc
{
  "schemaVersion": "zcode.model-providers.v1",
  "providers": [
    {
      "id": "zai",
      "name": "Z.AI",
      "endpoints": {
        "baseURL": "https://api.z.ai",
        "paths": {
          "anthropic": "/api/anthropic/v1/messages",
          "openai-compatible": "/api/coding/v1/chat/completions"
        }
      },
      "defaultKind": "openai-compatible",
      "models": [
        {
          "id": "glm-5.2",
          "name": "GLM-5.2",
          "kinds": ["anthropic", "openai-compatible"],
          "defaultKind": "openai-compatible",
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "contextWindow": 1000000,
          "maxOutputTokens": 128000,
          "reasoning": {
            "defaultLevel": "max",
            "levels": {
              "off": {
                "anthropic": {
                  "set": [
                    {
                      "path": ["thinking"],
                      "value": { "type": "disabled" }
                    }
                  ]
                },
                "openai-compatible": {
                  "set": [
                    {
                      "path": ["reasoningEffort"],
                      "value": "none"
                    }
                  ]
                }
              },
              "high": {
                "anthropic": {
                  "set": [
                    {
                      "path": ["thinking"],
                      "value": {
                        "type": "enabled",
                        "budgetTokens": 16000
                      }
                    }
                  ]
                },
                "openai-compatible": {
                  "set": [
                    {
                      "path": ["reasoningEffort"],
                      "value": "high"
                    }
                  ]
                }
              },
              "max": {
                "anthropic": {
                  "set": [
                    {
                      "path": ["thinking"],
                      "value": {
                        "type": "enabled",
                        "budgetTokens": 32000
                      }
                    }
                  ]
                },
                "openai-compatible": {
                  "set": [
                    {
                      "path": ["reasoningEffort"],
                      "value": "max"
                    }
                  ]
                }
              }
            }
          }
        }
      ]
    }
  ]
}
```

## 和现有代码的映射

- `ProviderSpec.endpoints.paths` 的 key 对应当前 runtime 的 `ModelProviderKind`。
- `ProviderSpec.defaultKind` 和 `ModelSpec.defaultKind` 决定最终传入
  `ModelTargetConfig.kind` 的值。
- `ProviderSpec.endpoints.baseURL` 进入 `ModelTargetConfig.baseURL`。
- `ModelSpec.contextWindow`、`maxOutputTokens`、`modalities` 会投影到
  `ModelCapability`。
- `ReasoningSpec.levels` 只用于投影 reasoning 档位值和默认档位；app 不再把
  `ReasoningSpec.levels[level][kind]` 转换成
  `ModelReasoningCapability.providerOptionsByLevel[level]`。
- 推理强度档位到供应商请求字段的映射由 zcode-cli 维护，app 侧不再维护
  `anthropic` / `openai` / `openaiCompatible` provider options 命名空间转换。

## OpenAI Compatible 流式 Usage

`kind: "openai-compatible"` 的 provider 默认请求流式 token usage。adapter 在创建
OpenAI Compatible SDK provider 时设置 `includeUsage: true`，由 SDK 仅在流式
Chat Completions 请求中生成：

```jsonc
{
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

少数不接受 `stream_options` 的兼容服务可以在 provider 连接配置中显式关闭：

```jsonc
{
  "provider": {
    "legacy-compatible": {
      "kind": "openai-compatible",
      "options": {
        "baseURL": "https://api.example.test/v1",
        "includeUsage": false
      }
    }
  }
}
```

未配置和显式 `true` 都表示开启；只有显式 `false` 才关闭。该设置属于 provider SDK
连接选项，不进入模型级 `providerOptions`，也不改变非流式请求、OpenAI Responses 或
Anthropic 请求。
