# Provider Config Schema 与 Builtin GLM 草案

> 状态：配置结构已进入 Design；本文保留 GLM API 事实与发布前核对项
>
> 记录日期：2026-08-18
>
> 适用范围：Provider Config、Model Config Rules、Account Access、GLM-5.2、GLM-5.3 与 GLM-5-Turbo

这份草案保存本轮讨论已经收敛的结构，以及仍需用代码和线上行为继续验证的部分。它用于避免后续讨论丢失上下文；实现和评审仍以 Design 中正式接受的结论为准。

## 1. 当前收敛的整体形态

Provider Registry 的静态事实由三层相同形态的 Provider Config Overlay 组成：

~~~text
Official Provider Config
        +
Personal Provider Config
        +
Account Access Overlay
        |
        v
Effective Provider Config
        |
        +---- Model Config Rules
        |
        v
Provider Registry
        |
        | ModelSelection
        v
Model
~~~

三层分别负责：

- Official 保存产品管理的 Provider、模型成员、模型公共性质和协议配置。
- Personal 保存用户创建的 Provider，以及对 Official Provider 的显式覆盖。
- Account Access 根据当前账号、套餐和连接状态，发布当前可用的 Account Provider、模型子集与访问身份。

Official 和 Personal 持久化。Account Access 是内存中的运行时 Overlay。登录 Token、Runtime API Key、一次性安全校验 Header 等请求鉴权材料不进入这三层，也不进入 Registry。

Provider 配置和模型配置是两套互补数据：

~~~text
Provider Config
└─ 如何连接、如何取得访问资格、包含哪些 modelId

Model Config Rules
└─ modelId 对应的 Properties、Option Specs 和协议行为
~~~

## 2. Provider Config Schema 草案

本轮将 Provider 的“访问资格”与“请求协议”拆成两个正交维度。它们在同一个 ProviderConfig 中聚合，但各自使用带判别字段的 Schema。

~~~ts
type ProviderConfigMap = ConfigOverlayMap<ProviderId, ProviderConfig>;

class ProviderConfig extends ConfigOverlay {
  label?: string | null;
  logoUrl?: string | null;
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  models?: readonly ModelId[] | null;
  enabled?: boolean | null;
}
~~~

外层 ProviderConfigMap 的 key 是 providerId，因此 value 中不重复保存 providerId。所有字段保持 optional，使同一类型既能表达一层稀疏 Overlay，也能表达覆盖完成后的结果。字段缺失表示本层沿用前层值；null 表示本层明确清除该字段。

### 2.1 Access

Access 描述“本次调用资格从哪里取得”。

~~~ts
type ProviderAccessConfig =
  | ApiKeyAccessConfig
  | ZhipuAccountAccessConfig;

class ApiKeyAccessConfig extends ConfigOverlay {
  readonly type = "api-key";
  apiKey?: string | null;
  apiKeyManagementUrl?: string | null;
}

class ZhipuAccountAccessConfig extends ConfigOverlay {
  readonly type = "zhipu-account";
  accessId?: string | null;
}

~~~

当前正式范围是 api-key 与 zhipu-account。未来其他厂商 OAuth 等访问方式在出现具体需求后扩展新的 Access 分支。

apiKeyManagementUrl 是设置页面跳转到厂商 Key 管理页面的产品信息。它由 Provider Config 明确提供，不根据 baseURL 推导。

Zhipu Account 的 accessId 标识一条确定的账号连接，而不只标识 Plan 种类。同一账号刷新 Token、Runtime Key 或 Header 时保持稳定；切换账号时必须变化。Model 创建后固定 accessId；请求鉴权服务可以刷新该连接的凭据，但不会把正在运行的 Model 静默切换到另一个账号或另一条个人/团队连接。

### 2.2 API

API 描述“请求发往哪里，并遵循哪一种公开协议”。

~~~ts
type ProviderApiType =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-chat-completions";

class ProviderApiConfig extends ConfigOverlay {
  type?: ProviderApiType | null;
  baseURL?: string | null;
  headers?: Record<string, string> | null;
}
~~~

对外 Config 使用 `api.type`。Adapter 类型是执行实现细节，由 Model 构造链根据 API 配置选择，不进入用户配置。

当前只保留 Provider 级静态 Header。模型级 Header 与任意 model.options 不进入新配置契约。OpenAI-compatible streaming 请求的 include_usage 固定由 Adapter 打开，也不暴露为配置项。

### 2.3 完整性

每层 Overlay 可以稀疏。覆盖完成后，Registry 只接收能够形成完整连接的 Provider：

~~~text
所有 Provider
├─ access.type
├─ api.type
├─ api.baseURL
└─ models

api-key access
└─ apiKey

zhipu-account access
└─ accessId
~~~

完整性由 Config Class 递归检查。设置 Facade 使用同一份检查结果展示待补字段；Registry 过滤未完成配置，不再单独复制一套判断。

## 3. Model Config Rules

模型配置是一组有序规则。每条规则包含匹配条件和一个稀疏 ModelConfig。后面的命中规则继续覆盖前面的结果。

~~~ts
interface ModelConfigRule {
  providerMatch?: string;
  modelMatch: string;
  apiMatch?: string;
  config: ModelConfig;
}

class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  apiAdapter?: ModelApiAdapterConfig | null;
}
~~~

providerMatch、modelMatch 和 apiMatch 使用相同的模式匹配语义。规则按顺序执行，后面的命中项继续 Overlay 前面的结果。

一份模型的通用字段和协议字段分别由不同规则贡献：

~~~text
modelMatch = GLM-5.3
└─ Properties + Option Specs

modelMatch = GLM-5.3, apiMatch = anthropic-messages
└─ Anthropic reasoning mapping

modelMatch = GLM-5.3, apiMatch = openai-chat-completions
└─ OpenAI Chat reasoning mapping + preserved thinking replay
~~~

### 3.1 Properties

当前公共 Properties 至少包括：

~~~ts
class ModelPropertiesConfig extends ConfigOverlay {
  contextWindow?: number | null;
  supportsImages?: boolean | null;
  supportsPdf?: boolean | null;
  supportsVideo?: boolean | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
~~~

supportsNativeWebSearch 可以受到 Provider Endpoint 能力影响，因此通用模型规则可给出保守值，Builtin Provider 的精确规则再贡献最终值。supportsMidConversationSystem 对当前三个 GLM 模型按 true 记录。

### 3.2 Option Specs 与 Options

Option Specs 声明用户可选择的通用选项及缺省值。Options 保存某个 Model 实例实际绑定的选择。

~~~ts
class ModelOptionSpecsConfig extends ConfigOverlay {
  reasoningLevel?: EnumOptionSpec | null;
  maxOutputTokens?: LimitOptionSpec | null;
}

interface ModelOptions {
  reasoningLevel?: string;
  maxOutputTokens?: number;
}
~~~

reasoningLevel 是用户选项。Provider 方言字段、preserveThinking 和 reasoningContentField 都不属于 ModelOptions。

### 3.3 API Adapter Config

API Adapter Config 保存当前模型在某种公开 API 下的固定适配行为。

~~~ts
class ModelApiAdapterConfig extends ConfigOverlay {
  reasoningMapping?: ReasoningMapping | null;
  preserveThinking?: boolean | null;
  reasoningContentField?: string | null;
}

type ReasoningMapping = Record<string, ReasoningParameters>;
type ReasoningParameters = Record<string, unknown>;
~~~

reasoningMapping 把通用 reasoningLevel 映射为该协议所需的参数。preserveThinking 和 reasoningContentField 只在确有该语义的协议中出现。

~~~text
Model.options.reasoningLevel
        |
        v
ModelApiAdapterConfig.reasoningMapping
        |
        v
选中本次请求的协议参数
        |
        v
Adapter 生成最终请求
~~~

OpenAI Chat Compatible 的方言最复杂，因此 reasoningMapping 和 reasoning replay 主要在这一协议下发挥作用。Anthropic Messages 与 OpenAI Responses 应优先遵循各自公开协议的固定语义。

## 4. Provider 类型示例

下面的 JSON 只表达目标结构。字段内容来自当前讨论与现有代码，尚不是可直接发布的最终 Official Config。

### 4.1 普通 API Key Provider

Official 可以提供一个尚未连接的厂商入口，Personal 补入 API Key；用户也可以完全在 Personal 中创建 Provider。

~~~json
{
  "builtin:zai": {
    "label": "Z.AI",
    "access": {
      "type": "api-key",
      "apiKeyManagementUrl": "https://z.ai/manage-apikey/apikey-list"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://api.z.ai/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
~~~

Personal Overlay：

~~~json
{
  "builtin:zai": {
    "access": {
      "type": "api-key",
      "apiKey": "<user-api-key>"
    }
  }
}
~~~

BigModel API Key Provider 使用同样结构，当前 Anthropic Endpoint 为 https://open.bigmodel.cn/api/anthropic。

### 4.2 Start Plan

Start Plan 的 Official Config 保存静态连接：

~~~json
{
  "builtin:zai-start-plan": {
    "label": "Z.AI Start Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://zcode.z.ai/api/v1/zcode-plan/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
~~~

Account Access 根据登录和套餐结果生成同形 Overlay：

~~~json
{
  "builtin:zai-start-plan": {
    "access": {
      "type": "zhipu-account",
      "accessId": "zhipu-account:<account-id>:start-plan:builtin:zai-start-plan"
    },
    "models": ["GLM-5.2", "GLM-5-Turbo"]
  }
}
~~~

这里的 models 是当前账号获准使用的子集。请求时使用的 ZCode JWT 和一次性安全校验 Header 由请求鉴权服务取得。

BigModel Start Plan 使用 providerId builtin:bigmodel-start-plan。它当前与 Z.AI Start Plan 共享 zcode-plan 请求语义；最终 Endpoint 和模型全集需要同远端 Official Config 再对齐。

### 4.3 Personal Coding Plan

Coding Plan 继续使用 zhipu-account access：

~~~json
{
  "builtin:zai-coding-plan": {
    "label": "Z.AI Coding Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://api.z.ai/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  },
  "builtin:bigmodel-coding-plan": {
    "label": "BigModel Coding Plan",
    "access": {
      "type": "zhipu-account"
    },
    "api": {
      "type": "anthropic-messages",
      "baseURL": "https://open.bigmodel.cn/api/anthropic"
    },
    "models": ["GLM-5.3", "GLM-5.2", "GLM-5-Turbo"],
    "enabled": true
  }
}
~~~

Account Access 决定当前 Family 中真正发布的 Coding Plan Provider，并补入 accessId 和模型子集。请求鉴权服务再用 accessId 获取当前有效的 Runtime API Key。

### 4.4 Team Plan

Team Plan 当前可以复用 Coding Plan providerId。Account Access 使用不同 accessId 固定组织、项目和连接身份：

~~~text
personal coding plan
└─ zhipu-account:<account-id>:coding-plan:builtin:zai-coding-plan

team plan
└─ zhipu-account:<account-id>:team-plan:builtin:zai-coding-plan:<product>:<org>:<project>
~~~

Provider Config 和 Model Config 不复制 Team Secret。请求鉴权服务根据 accessId 获取对应 Project Runtime Key。未来若产品决定同时发布 Personal 与 Team 两个可选连接，ModelSelection 是否需要携带连接身份将成为独立设计；M2 先保持每个 Provider Family 只发布当前生效连接。

### 4.5 Temporary Provider

闲时任务等 execution-scoped 场景可以在 Submission 中附加一份临时 Provider Config。它不写入 Official、Personal 或常驻 Registry：

~~~text
Submission
├─ ModelSelection
└─ Additional Provider Config
        |
        v
本次执行的临时解析范围
        |
        v
Model
~~~

临时 Provider 使用相同 ProviderConfig、Model Config 和 Model 构造链。任务结束后，临时解析范围自然释放，不需要修改或恢复 Session 的持久模型选择。

## 5. GLM 模型公共配置

以下属性是本轮暂定的 GLM 公共事实：

| 模型 | Context | Max Output | Image/PDF/Video | Tool Call | Structured Output | MCS |
| --- | ---: | ---: | --- | --- | --- | --- |
| GLM-5.3 | 1,000,000 | 128,000 | false / false / false | true | true | true |
| GLM-5.2 | 1,000,000 | 131,072 | false / false / false | true | true | true |
| GLM-5-Turbo | 204,800 | 131,072 | false / false / false | true | true | true |

这些数值记录当前代码和讨论中的观察值。正式 Official Config 发布前，还需以线上 Provider 配置与实际模型服务为准核对大小写、Context 和 Output 数值。

可以先用通用规则表达 Properties 和 Option Specs：

~~~json
[
  {
    "modelMatch": "GLM-5\\.3",
    "config": {
      "properties": {
        "contextWindow": 1000000,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["low", "high", "max"],
          "default": "max"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 128000,
          "max": 128000
        }
      }
    }
  },
  {
    "modelMatch": "GLM-5\\.2",
    "config": {
      "properties": {
        "contextWindow": 1000000,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["nothink", "high", "max"],
          "default": "max"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 131072,
          "max": 131072
        }
      }
    }
  },
  {
    "modelMatch": "GLM-5-Turbo",
    "config": {
      "properties": {
        "contextWindow": 204800,
        "supportsImages": false,
        "supportsPdf": false,
        "supportsVideo": false,
        "supportsToolCall": true,
        "supportsJsonSchemaOutput": true,
        "supportsNativeWebSearch": false,
        "supportsMidConversationSystem": true
      },
      "optionSpecs": {
        "reasoningLevel": {
          "type": "enum",
          "values": ["enabled", "disabled"],
          "default": "enabled"
        },
        "maxOutputTokens": {
          "type": "limit",
          "default": 65536,
          "max": 131072
        }
      }
    }
  }
]
~~~

Z.AI、BigModel 和 zcode-plan 的 Builtin 精确规则可以把 supportsNativeWebSearch 覆盖为 true。这个字段表达最终 Provider + Model 组合的可执行性质。

## 6. GLM 的 Anthropic Messages 配置

### 6.1 GLM-5.3

GLM-5.3 使用 Anthropic 标准 adaptive thinking + effort，不发送 budget：

~~~json
{
  "modelMatch": "GLM-5\\.3",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "low": {
          "thinking": { "type": "adaptive" },
          "effort": "low"
        },
        "high": {
          "thinking": { "type": "adaptive" },
          "effort": "high"
        },
        "max": {
          "thinking": { "type": "adaptive" },
          "effort": "max"
        }
      }
    }
  }
}
~~~

### 6.2 GLM-5.2

GLM-5.2 的 nothink 显式关闭 Thinking；其他档位使用 adaptive + effort：

~~~json
{
  "modelMatch": "GLM-5\\.2",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "nothink": {
          "thinking": { "type": "disabled" }
        },
        "high": {
          "thinking": { "type": "adaptive" },
          "effort": "high"
        },
        "max": {
          "thinking": { "type": "adaptive" },
          "effort": "max"
        }
      }
    }
  }
}
~~~

### 6.3 GLM-5-Turbo

Turbo 暂时保留当前 fixed-budget 兼容行为。1024 来自现有 Anthropic fixed thinking 的最小预算兼容，不代表新的通用策略：

~~~json
{
  "modelMatch": "GLM-5-Turbo",
  "apiMatch": "anthropic-messages",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "enabled": {
          "thinking": {
            "type": "enabled",
            "budgetTokens": 1024
          }
        },
        "disabled": {
          "thinking": { "type": "disabled" }
        }
      }
    }
  }
}
~~~

本轮不把 Turbo 自动改成 adaptive + effort，也不把 1024 推广给 5.2 或 5.3。

## 7. GLM 的 OpenAI Chat 配置

OpenAI Chat Compatible 允许厂商扩展请求与响应字段。GLM 的 thinking、reasoning effort 和 preserved thinking 因此由 `apiAdapter` 显式描述。

GLM-5.3 的示意规则：

~~~json
{
  "modelMatch": "GLM-5\\.3",
  "apiMatch": "openai-chat-completions",
  "config": {
    "apiAdapter": {
      "reasoningMapping": {
        "low": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "low"
        },
        "high": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "high"
        },
        "max": {
          "thinking": { "type": "enabled" },
          "reasoningEffort": "max"
        }
      },
      "preserveThinking": true,
      "reasoningContentField": "reasoning_content"
    }
  }
}
~~~

GLM-5.2 同样使用固定的 replay 配置，nothink 档位将 thinking.type 设为 disabled。Turbo 继续保持现有 enable/disable 方言，正式参数表还需要结合线上行为再核对。

preserveThinking 是固定协议配置。它不出现在 Composer，也不由 Binding 任意修改：

~~~text
preserveThinking = true
        |
        +---- 请求写入 clear_thinking = false
        |
        +---- 响应读取 reasoning_content
        |
        +---- Tool Loop 后续请求原样回放 reasoning_content
~~~

只有配置 clear_thinking=false 而没有完整回放，会导致后续 Tool Call 请求缺少模型要求的推理上下文。当前旧实现只为部分 DeepSeek/MiMo 模型按名称启用 reasoning_content 兼容；目标实现应由 Model API Adapter Config 驱动，退出模型名称硬编码。

## 8. OpenAI Responses

OpenAI Responses 协议应遵循官方 reasoning item 与 effort 语义。GLM-5.2、GLM-5.3 和 Turbo 在 Z.AI/BigModel Responses Endpoint 上的精确支持范围尚未完成线上核对，因此本草案不填一份猜测性的 reasoningMapping。

如果后续确认某个 GLM Responses Endpoint 完全遵循官方协议，对应规则只需保存其官方 effort 映射；preserveThinking 和 reasoningContentField 不应复制到 Responses 配置。

## 9. Account Access 与请求鉴权边界

三类 Account Provider 的动态材料不同：

~~~text
Start Plan
├─ accessId 固定当前账号的 Start Plan 连接
├─ Request Auth 取得 ZCode JWT
└─ 每个 attempt 按需取得一次性安全校验 Header

Personal Coding Plan
├─ accessId 固定当前账号的个人连接
└─ Request Auth 取得当前 Runtime API Key

Team Plan
├─ accessId 固定账号 / organization / project
└─ Request Auth 取得当前 Project Runtime API Key
~~~

Registry 只保存 Effective Provider Config 和最终模型配置。Model 保存创建时选中的 providerId、modelId、accessId、API 与 Options。每次请求可以取得更新后的同一连接凭据；凭据刷新不会修改 Model 身份。Request Auth 还要核对凭据所属账号与 accessId 一致，不能把旧 Model 与切换后的新账号凭据组合。

## 10. 与现有代码的关系

当前实现仍有多处散落事实：

- Builtin Provider ID 在 packages/shared/src/model-provider-types.ts。
- Start Plan 与 Coding Plan 的 Endpoint fallback 在 packages/services/src/model-provider。
- GLM reasoning 档位与 model-name 判断分散在 shared、services 和 CLI Adapter。
- reasoning_content replay 仍由 apps/zcode-cli/packages/adapters/src/model/reasoning-content-compat.ts 的模型名称列表驱动。
- Anthropic fixed budget 的兼容边界位于 apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts。
- Native Web Search 与 Mid-conversation System 仍部分根据 Provider API、baseURL 和 modelId 推断。

迁移时应先判断每条旧事实是否真实参与当前生产行为。真正生效的事实进入 Official Config 或 Adapter 固定协议逻辑；未生效的 models.dev/bundled catalog 字段不机械搬运。

## 11. 发布 Official Config 前仍需确认

以下问题仍保留为草案边界：

1. GLM-5.3、GLM-5.2 和 Turbo 在 Official Config 中最终采用的大小写、Context、Max Output 与默认输出值。
2. BigModel Start Plan 的最终 Endpoint、模型全集及与 Z.AI Start Plan 的关系。
3. preserveThinking 是否对所有 GLM OpenAI Chat Provider 固定为 true，还是由特定 Builtin Provider 规则启用。
4. GLM OpenAI Responses 的真实模型覆盖范围和精确 reasoning 参数。
5. 未来非智谱 OAuth Access 的正式 Schema，以及是否复用同一个账号访问身份模型。

这些问题不会推翻已经进入 Design 的主要分层：Provider Config 聚合 access 与 api，Model Config 聚合 properties、optionSpecs 与 apiAdapter，Account Access 使用同形 Overlay，动态请求鉴权留在请求期服务。
