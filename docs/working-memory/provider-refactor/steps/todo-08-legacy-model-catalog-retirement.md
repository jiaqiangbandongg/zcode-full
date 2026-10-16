# 08 Legacy Model Catalog 与衍生兼容逻辑退役

> 状态：已完成
>
> 日期：2026-08-24
>
> 来源审查：[`../research/model-abstraction-unification-cleanup-audit.md`](../research/model-abstraction-unification-cleanup-audit.md)
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)

## 1. 任务目标

彻底删除旧 Model Catalog 作为模型事实、reasoning 配置和请求兼容策略的第二套系统。所有仍有意义的模型
事实进入 ZCode Built-in / Personal Model Config Rules；历史输入只在明确 importer 边界转换；Provider API
请求兼容由 Effective Model Config 显式驱动，不能继续按具体 modelId 推断。

本 Todo 同时收口旧 Catalog 退役过程中已经确认的三个衍生问题：

1. 删除无实际 importer 消费者的 Legacy `modelCatalog.overrides`；
2. 删除独立 `ZCodeModelReasoningState`，Reasoning UI 复用 Registry 模型选择候选项；
3. 用 `requiresMfjsToolSchema` Model Config 字段替代 Kimi K3 modelId Tool Schema 特判。

```text
当前残余

Legacy modelCatalog.overrides --------> Catalog parser / capability merge
Catalog reasoning --------------------> providerOptionsByLevel -> Protocol/UI
modelId == kimi-k3 --------------------> Tool Schema $ref workaround

目标

Built-in / Personal Model Config Rules
                 |
                 v
       Effective Model Config
       |- properties
       |- optionSpecs.reasoningLevel
       |- reasoningMapping
       `- requiresMfjsToolSchema
                 |
                 +--> Registry Selection View -> UI -> ModelSelection.options
                 `--> Adapter 请求装配 -> Provider API
```

## 2. 核心裁决

### 2.1 旧 Model Catalog 可以整体退役

Provider/Model 的正常运行事实只来自：

```text
ZCode Built-in Provider Config
        -> Account Provider Config
        -> Personal Provider Config
        -> Effective Provider Config

ZCode Built-in Model Config Rules
        + Personal Model Config Rules
        -> Effective Model Config Rules
```

旧 `ModelCatalogConfig`、`ModelCapability`、`ModelCapabilityProvider`、`ModelCatalogService`、
`ModelCatalogSource`、bundled models.dev snapshot/source、Catalog capability/default/reasoning policy 不再是运行
时事实源，也不为兼容保留同形替代 DTO。

能够确定属于模型或接入组合的事实写入 Built-in Model Config Rules；Personal Rule 继续后置覆盖。属于 Adapter
请求编码的行为由明确 Model Config 字段或正式 API 实现驱动。不能从 Catalog、Provider kind、Endpoint 或
具体 modelId 重新推断模型能力和请求参数。

### 2.2 删除 Legacy `modelCatalog.overrides`

旧 `modelCatalog.overrides` 能表达的有效内容均可由 Personal Model Config Rules 替代：

| Legacy 内容                 | 当前归属                     |
| --------------------------- | ---------------------------- |
| context window              | `properties.contextWindow`   |
| input format                | `properties.input_format`    |
| Tool / Structured Output    | `properties`                 |
| reasoning 档位和默认值      | `optionSpecs.reasoningLevel` |
| reasoning Provider 请求参数 | `reasoningMapping`           |
| Provider/Model/API 组合差异 | Model Config Rule matcher    |

正式 Legacy importer 没有消费 parser 返回的 `runtimePatch.modelCatalog`，因此不为该字段补写新的迁移：

- 删除 Schema、parser、merge/helper、Catalog 投影和专用测试；
- 新 Config 不接受该字段；
- 不建立 Personal Model Config importer；
- 旧 `provider.*.models.*` 中 importer 已明确支持的常规字段继续按既有行为迁移；
- `name`、`family` 等展示元数据不构成保留 Catalog 的理由。

### 2.3 Reasoning UI 复用模型选择候选项

`ZCodeModelReasoningState` 不是运行状态，而是旧协议为选择器重新包装的一份模型选项规格。目标链固定为：

```text
Effective Model Config.optionSpecs.reasoningLevel
                         |
                         v
            Registry Model Selection View
                         |
                         +--> Composer
                         +--> Subagent
                         +--> Off-Peak
                         `--> Repo Wiki
                                  |
                                  v
              ModelSelection.options.reasoningLevel
```

裁决如下：

- 模型选择候选项直接提供 `optionSpecs.reasoningLevel.values/default`；
- Option Spec 是否存在已经表达是否提供 reasoning 选择，不再保留 `enabled`；
- 删除独立 `ZCodeModelReasoningState` 类型、schema、builder 和映射 helper；
- 不新增 reasoning 专用 fetch、Store、Context 或同步协议；
- `ModelSelection` 只保存用户明确选择的 `options.reasoningLevel`，不复制档位全集和默认值；
- `providerOptionsByLevel` 不进入 Protocol/UI；Provider 参数只保留在 Effective Model Config 的
  `reasoningMapping`，由 ModelFactory/Adapter 正向消费；
- UI 标签与本地化是 Selection View 的展示投影，不重新建立模型事实。

### 2.4 `requiresMfjsToolSchema` 替代 modelId 特判

在 Model Config 根部增加可 Overlay 的布尔字段：

```ts
interface ModelConfigInput {
  properties?: ModelPropertiesConfigInput | null;
  optionSpecs?: ModelOptionSpecsConfigInput | null;
  reasoningMapping?: ReasoningMappingConfig | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

稀疏 Rule 可以缺省或覆盖该字段；Built-in 通用 Rule 提供完整默认值 `false`，需要当前兼容行为的精确
Provider/Model/API 组合规则覆盖为 `true`。Registry 完整 Model Config 中该字段必须是 boolean。

它不进入 `Model.properties`，也不需要进入 Protocol/UI。Todo 02 已确定 Adapter 创建 Model 时直接接收完整
Registry Model Config，因此执行闭包可以直接读取该字段。

```text
requiresMfjsToolSchema = false
`- 原样使用 Tool Contract.inputSchema

requiresMfjsToolSchema = true
`- 发送前复制并投影 Tool Schema
   |- 可解析的非 #/$defs 本地 $ref -> 提升到根 $defs
   |- 投影成功 -> 发送投影副本
   `- 无法解析/改写 -> InvalidModelRequest，网络请求不得发出
```

本字段在当前阶段只启用已经存在的本地 `$ref` 根 `$defs` 投影，不代表 ZCode 实现或验证完整 MFJS 方言。
本轮不处理 `oneOf`、`anyOf`、`pattern` 等其他 MFJS 规则，也不建立通用 Tool Schema dialect 系统。

原始 `ModelToolContract.inputSchema` 始终保持不变，并继续作为工具参数校验与执行的权威。投影只存在于
Adapter Provider 请求装配边界。删除 `isKimiK3ModelId()` 和所有按具体 K3 modelId 触发该转换的逻辑。

## 3. 删除与修改范围

### 3.1 Catalog 与 Legacy Config

- 删除剩余 `ModelCatalogConfig`、Catalog Service/Source/Capability Provider；
- 删除 bundled models.dev snapshot、loader、只验证 Catalog 查询/合并的测试和打包配置；
- 删除失去调用方的 `default-policy`、`reasoning-policy`、Catalog capability helper；
- 删除 `modelCatalog.overrides` Config Schema、parser、merge 和 runtime patch；
- `runtime-thought-level` 若仅剩 Catalog 反向匹配则删除；现有 Telemetry 只能读取明确的 Model options/映射，
  不为保留观测重新建立 Catalog。

### 3.2 Protocol 与 UI

- 模型候选协议直接表达 reasoning Option Spec；
- 删除 `ZCodeModelReasoningState`、`buildProtocolReasoningState()` 和旧 Provider reasoning 投影；
- 删除 `providerOptionsByLevel` 跨进程字段；
- Composer、Subagent、Off-Peak、Repo Wiki 统一从当前候选项读取 values/default；
- 不改变各产品入口自己的草稿、保存和提交状态归属。

### 3.3 Adapter Tool Schema 投影

- `toAiSdkTools()` 从创建时完整 Model Config 取得 `requiresMfjsToolSchema`；
- 保留并准确命名现有本地引用提升实现；
- 无法解析的目标引用不再原样漏到 Provider，而是在请求前抛出类型化 `InvalidModelRequest`；
- generate/stream 共用同一投影与失败路径；
- 错误包含 Tool 名称和失败的 `$ref`，不得包含 Secret 或无关请求内容；
- 删除 `default-policy.ts` 中 Kimi K3 Schema 判断及其 modelId variant 列表。

## 4. 明确不在本 Todo 中处理

- 完整 MFJS validator/projector 或通用 Tool Schema dialect 架构；
- Off-Peak `ModelProviderModelConfig` 整体退役；
- 公共 `ModelRef`、Result/Event identity 和历史 provenance；
- Telemetry、Status、Context、Observation 的整体设计；
- Account Request Auth、runtime header refresh；
- 严格逐叶对照旧 Catalog 与 ZCode Built-in Config 的迁移审计；
- 模型选择、Queue、恢复或 desktop/mobile realtime 语义。

## 5. 测试先行

### 5.1 Config 与 Registry

1. `requiresMfjsToolSchema` 支持 Rule 缺省、`true`、`false`、`null` 和 Personal 后置覆盖；
2. Built-in 通用 Rule 提供 `false`，完整性校验拒绝最终缺失/null；
3. ZCode Built-in Config 的目标 Provider/Model/API 组合解析为 `true`，非目标组合保持 `false`；
4. Config JSON round-trip 保留该字段；
5. Registry/ModelFactory 不按 modelId 补齐或覆盖该字段。

### 5.2 Legacy Catalog

1. 新 Schema 不接受 `modelCatalog.overrides`；
2. Legacy importer 不读取、迁移或保留该字段；
3. 旧 `provider.*.models.*` 已支持的迁移回归保持不变；
4. 正常启动、模型选择和请求执行不构造 Catalog；
5. 删除 models.dev/Catalog 后 Official/Personal 模型事实保持可解析。

### 5.3 Reasoning Selection View

1. 有 Option Spec 的候选项发布 values/default；无 Option Spec 时不发布 reasoning 选择；
2. Composer、Subagent、Off-Peak、Repo Wiki 读取相同候选事实；
3. 提交只写 `ModelSelection.options.reasoningLevel`；
4. Protocol/UI 中无 `enabled` 和 `providerOptionsByLevel`；
5. Adapter 仍按 `reasoningMapping[level]` 产生 Provider 请求参数。

### 5.4 Tool Schema 投影

1. 字段为 `false` 时 Schema 保持原样；
2. 字段为 `true` 时可解析的 `#/properties/...` 引用提升到根 `$defs`；
3. 同一引用复用同一 `$defs` 项，已有 `$defs` 不被覆盖；
4. 原始 Tool Contract 深度相等且未被修改；
5. 无法解析的本地引用在网络前抛出 `InvalidModelRequest`；
6. 错误包含 Tool 名和引用路径；
7. generate/stream 行为一致；
8. 相同 modelId 在字段为 false 时不转换，不再存在模型名隐式行为。

## 6. 实施顺序

### Step A：Config 契约与测试

- 先增加 Model Config Overlay、完整性、ZCode Built-in Rule 和 JSON round-trip 失败测试；
- 增加 `requiresMfjsToolSchema` Schema/Config/Registry 字段；
- 在 Built-in 通用 Rule 和目标精确 Rule 中声明值。

### Step B：Tool Schema 显式驱动

- 先增加投影成功、失败、原对象不变和 modelId 不再生效的 Adapter 测试；
- Adapter 改读完整 Model Config 字段；
- 删除 Kimi modelId 特判和旧测试假设。

### Step C：Catalog 与 Reasoning 协议退役

- 删除 Legacy `modelCatalog.overrides` 输入面；
- 删除剩余 Catalog 数据、Service/Source、policy 和调用方；
- Selection View 直接发布 reasoning Option Spec；
- 迁移 UI 消费者并删除独立 Reasoning State。

### Step D：验证与提交

- 运行 Provider Config、Registry、Bootstrap、Adapter、Protocol 和 UI 受影响单测；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 对 Tool wire 与模型选择协议运行代表性回归；
- 独立 Conventional Commit。

## 7. 机械归零与完成定义

- 正常生产代码无 `ModelCatalogConfig`、`ModelCatalogService`、`ModelCapabilityProvider`；
- 无 bundled models.dev snapshot/source 和对应生产打包项；
- Config Schema/Runtime patch 无 `modelCatalog.overrides`；
- Protocol/UI 无 `ZCodeModelReasoningState`、`enabled`、`providerOptionsByLevel`；
- Adapter 无 `isKimiK3ModelId()` 或其他 Tool Schema modelId hardcode；
- `requiresMfjsToolSchema` 只来自 Effective Model Config；
- 投影失败在网络请求前 fail-closed，不能静默删除 Tool 或原样发送已知无法转换的引用；
- 不新增 Catalog alias、Runtime capability map、Reasoning State 或 Tool Schema compatibility Registry。

完成后，Provider/Model 静态事实只存在于当前 Config/Registry/Model 链；Reasoning UI 只消费模型选择候选
事实；已知 K3 Tool Schema 兼容由显式 Model Config 驱动，不再依赖旧 Catalog 或具体模型名称。
