# Model Provider OpenCode Config

## 状态

> 历史实现说明，已被 Provider Refactor 的 Config/Registry/ModelFactory 设计取代。文中的
> `config.json`、Runtime Model 和 Registry Snapshot 下发只用于理解迁移前代码，不是当前事实。
> 当前设计见 `docs/working-memory/provider-refactor/design/`。

该历史方案曾取代 `zcode.model-providers.v1` catalog 和 `model-providers.v2.json` store，随后又被
当前 `.zcode/v2/provider_config.json`、ZCode Built-in Release 和每 Environment 自有 Registry 的方案取代。

## 文件边界

| 文件                                             | 语义                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `~/.zcode/v2/config.json`                        | app 模型供应商权威源，包含 `provider` 字段（见 Provider Schema）。 |
| `~/.zcode/v2/model-providers.json`               | 一次性迁移来源，只读取有效旧内容，迁移后保留原文件不改。     |
| `~/.zcode/v2/model-providers.v2.json`            | 完全忽略，不读取、不删除、不迁移。                           |
| `~/.zcode/cli/config.json`                       | standalone CLI 使用的配置文件，不参与 app provider 迁移。    |
| `models_catalog_china_llm_zcode_2026-06-03.json` | legacy `model-providers.json` 迁移时的模型 metadata 补齐源。 |

`config.json` 已经存在且包含有效 `provider` 时，不用旧文件覆盖用户的新配置。

## Provider Schema

Provider 结构兼容 opencode config 的 provider 形态，并向 agent 的 provider 定义靠齐。
ZCode 写回时不再写顶层 `$schema`，也不再写 `zcode` 扩展对象、provider 顶层
`api`、`npm`、`endpoints` 等内部推导字段。请求地址只写在 `options.baseURL`。

provider 的 transport 类型使用 `kind`：

```jsonc
{
  "provider": {
    "deepseek": {
      "name": "DeepSeek",
      "kind": "openai-compatible",
      "options": {
        "apiKey": "sk-...",
        "baseURL": "https://api.deepseek.com/v1",
      },
      "models": {},
    },
  },
}
```

迁移兼容规则：

- 读旧文件时仍接受顶层 `$schema`，写回时会移除。
- 读旧文件时仍接受 provider 顶层 `api`，只作为 `options.baseURL` 缺省来源。
- 读旧文件时仍接受 `npm`，并转换成无 `@ai-sdk/` 前缀的 `kind`。
- 读旧文件时仍接受 provider/model 的 `zcode` 扩展对象。
- 当 `config.json` 已有 `kind` 或 `options.baseURL` 时，运行态以新结构字段为准；
  残留的 `endpoints`、`apiFormat`、`defaultKind`、`zcode` 只作为缺少新字段时的迁移输入。
- 写回时统一移除 provider 顶层 `api`、`npm`、`endpoints`、`apiFormat`、`defaultKind`、
  `providerMappings`、`createdAt`、`updatedAt`、provider/model 的 `zcode` 扩展对象，以及
  `providerMappings` 里旧的 `zcode*` 前缀 key。
- app 内部需要的 `endpoints`、`apiFormat`、`defaultKind` 等字段由 storage 读入时从
  `kind + options.baseURL` 推导。
- 设置页 Base URL 输入和 `options.baseURL` 读写必须保留用户配置的路径段；不得因为
  `kind` 是 `openai` / `openai-compatible` / `anthropic` 就自动删除 `/v1`、
  `/responses`、`/chat/completions` 等后缀。历史 catalog / legacy endpoint 可以在迁移时
  继续做“完整 operation URL -> runtime base URL”的兼容归一化，但不能作用到用户当前输入。
- ZCode 自家内置/计划类 provider 当前统一使用 `anthropic` runtime，不再用 model-level
  `kinds` 表达单 provider 下的多协议能力。

## Model Schema

模型继续保留以下主字段：

- `name`
- `reasoning`
- `limit`
- `modalities`
- `options`
- `headers`

`reasoning` 面向 UI、配置页和 ZCode Protocol，表示模型是否支持思考以及可展示的推理强度
档位。App 只保存并下发档位值，例如 `high`、`max`；这些值对应供应商请求里的哪些字段由
zcode-cli 维护，app 不再在 `config.json` 里保存 provider-specific `model.variants`。

```jsonc
{
  "deepseek-v4-pro": {
    "name": "DeepSeek V4 Pro",
    "reasoning": {
      "enabled": true,
      "variants": ["high", "max"],
      "defaultVariant": "max",
    },
    "limit": {
      "context": 1000000,
      "output": 384000,
    },
    "modalities": {
      "input": ["text"],
      "output": ["text"],
    },
  },
}
```

## 请求参数合并

app 侧只投影 provider、model、context/output limit、当前 thought level 和当前模型可用
reasoning variants。一次模型请求中推理强度到 provider options 的映射在 zcode-cli 内完成，
不从 app config 下发。

```text
provider.options
  -> model.options
  -> zcode-cli 根据 selected reasoning level 生成供应商请求字段
```

`reasoning.variants` 是 app 侧唯一的 reasoning 档位列表来源。历史 `model.variants` 仅作为旧
配置残留被 schema 接受，读入后不会生成 app 内部 provider patch，写回时会被清理。

读取 `config.json.provider[].models[]` 时，`model.limit.context` 和 `model.limit.output`
是标准来源。为兼容早期测试配置和历史残留，读取边界也接受顶层
`model.contextWindow` / `model.maxOutputTokens` 作为 fallback；一旦重新持久化，仍统一写回
`model.limit.context` / `model.limit.output`，不继续扩散顶层字段。

## 迁移

迁移只从 `~/.zcode/v2/model-providers.json` 读取。支持两类历史形态：

1. 旧裸数组 `ModelProviderConfig[]`。
2. 历史误写入旧文件的 `{ schemaVersion, providers }`。

迁移规则：

- `id` -> `provider` map key。
- `name` -> `provider[id].name`。
- 默认运行协议 -> `provider[id].kind`，值为 `anthropic`、`openai` 或 `openai-compatible`。
- `apiKey` -> `provider[id].options.apiKey`。
- 默认 endpoint runtime base URL -> `provider[id].options.baseURL`。
- `headers` -> `provider[id].headers`。
- `models[]` -> `provider[id].models`。
- `contextWindow` -> `model.limit.context`。
- `maxOutputTokens` -> `model.limit.output`。
- `modalities` -> `model.modalities`。
- 旧 `reasoning.levels[level][kind]` -> `model.reasoning.variants`；provider-specific patch
  不再写入 `config.json`。

模型 ID 以 `[1m]` 结尾时，App 在存储归一化、设置页保存和 ZCode Protocol 投影阶段都会把
`contextWindow` / `model.limit.context` 强制收敛为 `1000000`。这样可以让设置页、桌面
continuous 链路、手机远控 replayable 恢复链路和 agent context meter 使用同一个 1M 分母，
不会被旧配置里保存的 128k 或用户手动输入的较小值覆盖。

旧 `model-providers.json` 的模型经常只有字符串 id，没有 `contextWindow`、
`maxOutputTokens`、`modalities`、`reasoning` 等模型事实。迁移时会用本地
`models_catalog_china_llm_zcode_2026-06-03.json` 按模型 id 补齐缺失 metadata；
例如 `deepseek-v4-pro` 会从 catalog 得到 `contextWindow: 1000000`，避免落到旧
128k 兜底值。`model-providers.v2.json` 不参与读取或迁移。

迁移成功后原子写入 `~/.zcode/v2/config.json`，不修改旧文件。

## App 与 Agent 边界

App 设置页读写 `~/.zcode/v2/config.json`，并投影出：

- UI 兼容 DTO，供设置页和聊天页展示。
- `ZCodeProviderRegistrySnapshot`，供 app service 在本进程内解析当前选中模型。

Agent 的 `--stdio` 模式不读取 app config 文件。它只消费 app 通过协议下发的 runtime
model config：当前 provider、当前模型、context/output limit、当前 thought level、当前模型
可用 reasoning variants。生成请求所需的 reasoning provider options 由 zcode-cli 根据档位值
维护。UI 的 provider/model 列表以 app 侧 `modelProviderService` 为准，不依赖 agent snapshot
返回完整 catalog。

远控链路继续遵守 shared-host attachment 边界：手机 `/remote` 不为 provider 配置另起独立
agent runtime，也不读取远端机器自己的 provider 配置。

## 验证

必须覆盖：

- 只有 `model-providers.json` 时能迁移到 `config.json.provider`。
- 写出的 config 不包含顶层 `$schema`。
- 写出的 provider 使用 `kind`，且不包含 provider 顶层 `api`、`npm`、`endpoints`、
  `apiFormat`、`defaultKind`、`providerMappings`、`createdAt`、`updatedAt` 和 `zcode`
  扩展对象。
- legacy 字符串模型迁移时能从本地 catalog 补齐 `contextWindow` 等 metadata。
- 只有 `model-providers.v2.json` 时不迁移，结果等同没有旧 provider 配置。
- `config.json.provider` 已存在时不会被旧配置覆盖，但会被清洗成新 schema。
- 设置页保存 provider 后只修改 `config.json`。
- agent `--stdio` 初始化和 `session/send` 不接收完整 provider registry，只接收当前模型 runtime config。
- UI 模型选择列表来自 app provider 数据源，agent snapshot 只需要提供当前模型状态。
- standalone CLI 仍只受 `~/.zcode/cli/config.json` 影响。
