# ox-alpha 系列 OpenRouter Reasoning 适配设计

> **2026-08-22 M3 收口：** 本文记录 staging 合入前的设计背景。当前实现不再消费
> `/client/configs.magic_name`，也不在源码中按具体模型 ID 构造 reasoning 策略；有效行为已经写入
> ZCode Built-in Model Config Rules，并由通用 Adapter 序列化。冲突处以
> `docs/working-memory/provider-refactor/steps/03-staging-integration.md` 为准。

## 背景

`ox-alpha`、`GLM-x-preview-f` 与 `x-preview-f-free` 是通过 OpenRouter 路由的同一保密多模态模型的
公开 ID。产品只公开并持久化用户实际配置的 ID，不得在源码、配置、日志或
文档中记录底层真实模型名称，也不在这些公开 ID 之间改写请求。

模型设置已经提供上下文窗口、最大输出 Token 和输入/输出类型配置，因此本适配不为
这些公开 ID 增加 context、output、模态、tool call 或 structured output
专属默认值。缺失值继续
使用现有设置与通用 runtime fallback；输入类型完全由用户或权威远端事实显式声明。

当前未知模型在 OpenAI-compatible 与 Anthropic transport 下会回退为通用
`enabled` / `disabled` thinking toggle。这些 ID 实际支持 `low` / `high` / `max`
三档，默认
`max`，需要在模型身份命中后按真实 transport 重建 reasoning capability。

另一个未提前确定的公开 ID 由 `/api/v1/client/configs` 的
`data.configs.magic_name` 动态下发。该字段当前是普通字符串：测试环境下发
`GLM-Flash`，生产环境下发空字符串。客户端不能硬编码这两个环境值，只消费服务端事实。

## 已确认产品语义

- 模型 ID 大小写不敏感地包含 `ox-alpha` 即命中；允许 provider path、前缀和后缀。
- `GLM-x-preview-f` 的每个字母都大小写不敏感；允许 provider path，但最后一个 path
  segment 必须精确等于 `glm-x-preview-f`，不接受额外前后缀。
- `x-preview-f-free` 与 `GLM-x-preview-f` 使用相同的匹配边界：大小写不敏感，允许 provider
  path，但最后一个 path segment 必须精确等于 `x-preview-f-free`，不接受额外前后缀。
- `magic_name` 按 JavaScript 正则表达式处理：trim 后为空则不启用；非空时以 `iu` flags 编译。
  一个表达式可以用 `|` 匹配多个名字；语法非法时忽略该 matcher，不能阻断 Provider 同步。
- 用户可选择 `low`、`high`、`max`，默认 `max`。
- OpenAI-compatible Chat Completions：映射到
  `openaiCompatible.reasoningEffort`，最终 wire 为 `reasoning_effort`。
- Anthropic Messages：映射到 `anthropic.thinking.type="adaptive"` 与
  `anthropic.effort`，最终 wire 为 `thinking.type="adaptive"` 和
  `output_config.effort`。
- Anthropic 不发送 `thinking.budget_tokens`，不复用 GLM-5.3 官方 API 的固定预算。
- OpenAI Responses 当前不启用这些 ID 的专属 reasoning 映射，避免误发 Chat Completions
  的 `openaiCompatible` option。
- 不改写最终请求中的原始模型 ID。
- 不新增这些 ID 专属 context、max output、模态、tool call、structured output 或
  temperature 默认策略。

## 请求映射

```text
modelId matches a built-in pattern
or carries reasoningProfile="ox-alpha" from magic_name matching
        |
        v
reasoning levels = low / high / max
default = max
        |
        +-- openai-compatible
        |      `-- openaiCompatible.reasoningEffort
        |                  `-- wire: reasoning_effort
        |
        `-- anthropic
               +-- anthropic.thinking.type = adaptive
               `-- anthropic.effort
                           `-- wire: output_config.effort
```

| UI 档位 | OpenAI-compatible wire    | Anthropic Messages wire                                   |
| ------- | ------------------------- | --------------------------------------------------------- |
| `low`   | `reasoning_effort="low"`  | `thinking.type="adaptive"`, `output_config.effort="low"`  |
| `high`  | `reasoning_effort="high"` | `thinking.type="adaptive"`, `output_config.effort="high"` |
| `max`   | `reasoning_effort="max"`  | `thinking.type="adaptive"`, `output_config.effort="max"`  |

## 实现边界

1. Shared 使用 `OX_ALPHA_REASONING_MODEL_ID_PATTERNS` 保存内置正则规则，并由
   `isOxAlphaReasoningModelId` 通过 `some(test)` 判断任一规则是否命中；调用方可额外传入由
   `magic_name` 编译的远程正则，不再为每个公开 ID 新增独立判断函数。
2. reasoning policy 提供 OpenAI-compatible 与 Anthropic 两个 factory；仅共享档位与默认值，
   provider options 按 transport 分离。
3. 默认模型策略只补 reasoning capability，并作为宽泛模型家族规则之后的最终 reasoning
   覆盖；不携带 context/output/media 等能力值。
4. standalone CLI configured model 在通用 thinking toggle 之前识别所有内置公开 ID。
5. App 下发的 dynamic provider 即使缺少 reasoning metadata，或携带过时的
   `enabled` / `disabled`，workspace overlay 仍按统一推理身份重建三档。
6. 模态继续读取 `ModelProviderModelConfig.modalities`；不进入 GLM provider-aware media
   fallback。
7. model-provider service 从 `client/configs.data.configs.magic_name` 构造额外 matcher；命中的
   远端模型标记稳定的 `reasoningProfile="ox-alpha"`。该 profile 随模型配置持久化并通过现有
   provider registry 协议投影给 Agent；Agent 仍在 workspace dynamic overlay 内按真实
   transport 重建 provider options。
8. `magic_name` 只影响同一份 `client/configs` 下发的远端模型，不改变用户自建 provider，
   不改写 model ID，也不新增独立网络请求、全局 singleton 或跨进程可变正则状态。
9. `reasoningProfile` 是远端权威模型事实：后续同步不再命中 `magic_name` 时，必须清除此前
   持久化的 profile，不能由本地旧配置或上一版 `zcode` 扩展反向补回。用户已修改的本地模型
   继续遵循现有 `modified` 保护，不接受远端覆盖；无需迁移，下一次权威同步会自愈旧数据。
10. 生产运行时代码不直接内嵌上述保密公开 ID 的字符串字面量或新增对应的语义化 token 常量名；
    内置匹配 token 使用中性编号和字符码在运行时构造。中文注释可以说明编号对应的模型族，便于维护。该约束
    只针对静态源码/构建产物的朴素文本扫描，不改变协议中的 `modelId`、远端 `magic_name` 或
    实际供应商请求值。

## 非目标

- 不把 `ox-alpha` 作为 GLM-5.3 别名。
- 不加入公开 models.dev 或中国模型 catalog。
- 不自动注册 OpenRouter provider、API Key、entitlement 或默认模型。
- 不修改设置页 context/output/type 默认值。
- 不扩展 audio/video/PDF 运行时附件协议。
- 不修改模型选择、session、task、desktop continuous 或 web remote replayable 语义。
- 不为 OpenAI Responses 推断未确认的 reasoning 参数。
- 不支持服务端在字符串中携带 `/pattern/flags` 包装；`magic_name` 只表示 pattern source，客户端固定
  使用 `iu` flags。

## 测试

- shared matcher：一个正则列表按“任一命中”归类；`ox-alpha` 保持大小写、provider path、
  前后缀语义；`GLM-x-preview-f` 与 `x-preview-f-free` 覆盖全小写、全大写、混合大小写和
  provider path，并拒绝近似 ID；额外远程正则可命中一个或多个远程名字。
- remote config：`magic_name="GLM-Flash|x-preview-f-free"` 大小写不敏感地命中任一远端模型；
  空白值、缺失值和非法正则不打 profile。
- persistence/protocol：`reasoningProfile` 在预置同步写盘、读回和 provider registry 投影后保留；
  远端随后撤回匹配时，返回值与持久化配置都清除旧 profile，同时保留本地 `modified` 模型。
- default policy：只生成 reasoning；不生成 context、max output 或 image/PDF 能力。
- reasoning factory：三档、默认 `max`、provider options namespace 正确。
- OpenAI-compatible wire：三档分别生成顶层 `reasoning_effort`，不生成 `thinking`。
- Anthropic wire：三档分别生成 `thinking.type=adaptive` 与
  `output_config.effort`，不生成 `thinking.budget_tokens` 或 `reasoning_effort`。
- standalone config：Anthropic 与 OpenAI-compatible 都重建三档。
- configured wire：以混合大小写的 `GLM-x-preview-f` 从 config 合成 capability，再进入 AI SDK
  最终请求，同时断言原始 model ID 保留。
- workspace dynamic overlay：无 metadata 和过时 toggle 均重建三档，原始模型 ID、
  context/output/modalities 保持不变。

## 影响简报

### Feature Summary

| Field            | Value                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 为内置公开 ID 与 `client/configs.magic_name` 命中的远端 ID 增加由多正则统一匹配的 transport-specific reasoning 档位映射 |
| Capability       | Model capabilities / provider runtime config                                                                            |
| Change layer     | option-source、validation、commit-effect                                                                                |
| Operating mode   | planning / implementation                                                                                               |
| Primary seeds    | shared matcher、remote client configs、provider persistence/protocol、workspace catalog overlay                         |
| Out of scope     | context/output/media 默认、UI 模型选择、session/replay                                                                  |

### UI Surface Matrix

| User scenario              | UI entry            | Shared implementation             | Display/draft owner  | Default/inherit source | Validation/gating         | Commit action             | Authority/persistence             | Mode boundary            | Must remain isolated from                  |
| -------------------------- | ------------------- | --------------------------------- | -------------------- | ---------------------- | ------------------------- | ------------------------- | --------------------------------- | ------------------------ | ------------------------------------------ |
| 对话选择公开 ID 的思考等级 | 共享模型/思考选择器 | model capability reasoning levels | session model config | CLI overlay 默认 `max` | 档位必须属于 low/high/max | 既有 model/thought switch | session runtime + provider config | desktop/web 复用既有链路 | context/output/media 与其他 surface commit |

### Feature Relationships

| Rank           | From                    | Semantic edge                 | To                             | Condition       | Why inspect it                        | Evidence            |
| -------------- | ----------------------- | ----------------------------- | ------------------------------ | --------------- | ------------------------------------- | ------------------- |
| must-inspect   | shared model identity   | classifies                    | CLI config + workspace overlay | 命中任一公开 ID | 两条入口必须一致                      | matcher tests       |
| must-inspect   | thought level           | projects to                   | provider request options       | low/high/max    | transport namespace 不得串用          | wire tests          |
| should-inspect | default policy          | supplies missing reasoning to | standalone CLI catalog         | metadata 缺失   | 不得顺带补其他能力                    | adapter tests       |
| invariant-only | model settings metadata | must remain isolated from     | shared reasoning matcher       | all transports  | 用户 context/output/type 配置不被覆盖 | negative assertions |
| invariant-only | provider registry       | must not mutate               | session/replay semantics       | all clients     | 只扩展模型 metadata，不改变消息状态机 | diff review         |

### State Owners And Commit Sinks

| State/fact           | Draft/display owner   | Authoritative owner    | Commit command/service    | Persistence/cache    | Evidence                    |
| -------------------- | --------------------- | ---------------------- | ------------------------- | -------------------- | --------------------------- |
| reasoning 档位候选   | shared model UI       | CLI capability overlay | 既有 session model config | runtime catalog      | adapter/bootstrap tests     |
| 当前 thought level   | composer/session      | session runtime        | 既有 thought switch       | session settings     | existing model switch tests |
| context/output/types | model settings draft  | provider registry      | model provider service    | config.json          | invariant-only              |
| `magic_name`         | remote client/configs | model-provider service | preset sync               | config-version cache | service tests               |
| reasoning profile    | none (hidden fact)    | remote model config    | provider registry         | config.json          | storage/protocol tests      |

### Must-Preserve Invariants

| Invariant                                    | Surfaces/modes       | Proof needed               | Evidence             |
| -------------------------------------------- | -------------------- | -------------------------- | -------------------- |
| 只有 low/high/max，默认 max                  | all model selectors  | capability equality        | unit/integration     |
| 两个 transport 使用各自 namespace            | request runtime      | final wire body            | wire tests           |
| 原始 model ID 不改写                         | all requests         | catalog key/request model  | bootstrap/wire tests |
| 不补 context/output/media                    | settings/CLI/runtime | defaults absence           | default-policy test  |
| 空 `magic_name` 不匹配任何模型               | production config    | no reasoning profile       | service tests        |
| 远端撤回匹配会清除旧 reasoning profile       | provider refresh     | returned + persisted state | service tests        |
| 本地 `modified` 模型不受远端撤回影响         | provider refresh     | local branch preserved     | service tests        |
| desktop continuous 与 mobile replayable 不变 | all clients          | no protocol/state diff     | diff review          |

### Codegraph Evidence

当前环境没有可用 codegraph 工具，使用 feature graph seeds 与 `rg` 深度 2 回退：

```text
OX_ALPHA_REASONING_MODEL_ID_PATTERNS.some(test)
  -> isOxAlphaReasoningModelId
  -> default-policy / config schema
  -> workspace-model-catalog
  -> runtime thought level providerOptions
  -> AI SDK request body

client/configs.data.configs.magic_name
  -> trim + RegExp(pattern, "iu")
  -> isOxAlphaReasoningModelId(modelId, [remotePattern])
  -> matched remote model.reasoningProfile = "ox-alpha"
  -> config.json -> provider registry protocol
  -> workspace-model-catalog -> existing transport mapping
```

### Graph Delta

| Status    | Node/edge                                  | Semantic reason                         | Evidence             | Action        |
| --------- | ------------------------------------------ | --------------------------------------- | -------------------- | ------------- |
| confirmed | `capability.model-capabilities` docs/seeds | 多个公开 ID 共享独立 reasoning 能力入口 | user decision + spec | graph updated |

### Accepted Cases

| Case ID | Setup                                    | Action                              | Assertions                                                             | Evidence layers                                        | E2E status |
| ------- | ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ | ---------- | ---------- |
| OXA-001 | standalone OpenAI-compatible provider    | 加载 `ox-alpha`                     | 三档/default 与 reasoning_effort mapping 正确                          | shared + adapter                                       | not-needed |
| OXA-002 | standalone Anthropic provider            | 加载 `ox-alpha`                     | adaptive + effort mapping，无 budget                                   | adapter + wire                                         | not-needed |
| OXA-003 | dynamic provider，metadata 缺失/过时     | upsert registry                     | 按 transport 重建三档且其他能力不变                                    | bootstrap integration                                  | not-needed |
| OXA-004 | standalone 两种 transport                | 加载任意大小写的 `GLM-x-preview-f`  | 与 `ox-alpha` 得到完全相同的三档映射，不注入其他默认                   | shared + adapter                                       | not-needed |
| OXA-005 | dynamic provider / OpenAI Responses      | upsert `GLM-x-preview-f`            | 前两种 transport 重建三档；Responses 显式不启用专属映射                | bootstrap integration                                  | not-needed |
| OXA-006 | `magic_name="GLM-Flash"`                 | 同步远端混合大小写匹配模型          | 持久化并投影 `reasoningProfile="ox-alpha"`                             | service + shared                                       | not-needed |
| OXA-007 | `magic_name=""` / 缺失                   | 同步任意远端模型                    | 不生成 profile，不改变既有 reasoning                                   | service                                                | not-needed |
| OXA-008 | dynamic provider 携带 ox-alpha profile   | 按 Anthropic/OpenAI-compatible 加载 | 与内置公开 ID 相同 low/high/max 映射，原始 ID 保留                     | bootstrap integration                                  | not-needed |
| OXA-009 | standalone 两种 transport                | 加载任意大小写的 `x-preview-f-free` | 与既有公开 ID 得到完全相同映射，并拒绝近似 ID                          | shared + adapter                                       | not-needed |
| OXA-010 | `magic_name="foo                         | bar"`                               | 同步包含任一名字的远端模型                                             | 两个名字均写入同一 reasoning profile，非法正则安全忽略 | service    | not-needed |
| OXA-011 | 首次 `magic_name` 命中，后续权威配置撤回 | 使用同一 home 依次同步两个配置版本  | 普通远端模型的返回值与写盘均移除 profile；本地 `modified` 模型保持不变 | service                                                | not-needed |
