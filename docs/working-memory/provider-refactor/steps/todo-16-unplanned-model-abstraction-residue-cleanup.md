# 16 未规划 Model 抽象残留归零

> 状态：已完成
>
> 日期：2026-08-25
>
> 来源审查：Provider Refactor 完成后的旧抽象差集复查
>
> 相关任务：[`01`](./todo-01-core-model-adapter-boundary-cleanup.md)、
> [`08`](./todo-08-legacy-model-catalog-retirement.md)、
> [`13`](./todo-13-target-host-model-selection-authority.md)、
> [`14`](./todo-14-post-refactor-mechanical-zero.md)
>
> 相关设计：[`../design/model/contract.md`](../design/model/contract.md)、
> [`../design/model/model.md`](../design/model/model.md)、
> [`../design/registry/model-creation.md`](../design/registry/model-creation.md)、
> [`../design/registry/registry.md`](../design/registry/registry.md)、
> [`../design/registry/runtime.md`](../design/registry/runtime.md)、
> [`../design/interaction/interaction.md`](../design/interaction/interaction.md)、
> [`../design/interaction/selection-state.md`](../design/interaction/selection-state.md)

## 0. 任务定位

本文只收纳 2026-08-25 代码复查中确认、且尚未被 Todo 11–15 明确覆盖的旧 Model/Provider 抽象残留。
已经由 Todo 13 规划的目标 Host、结构化 `ModelSelection`、临时 App 和字符串选择旧链，以及已经由 Todo 14
规划的 MCS、`RuntimeModelFactoryInput`、Legacy Provider Store DTO 和已知死文件，不在本文重复规划。

本 Todo 不建立新领域抽象。所有改动都是既有设计的遗漏修复或公共契约归零：

```text
Target Host / Submission
        |
        v
ModelSelection
        |
        v
Required ModelFactory
        |
        v
Active Model.properties/options
        |
        v
Adapter private execution

Legacy serialized config
        |
        v
Importer-private parser/types
        |
        v
Current Personal Provider / Model Config
```

## 1. 已确认问题与裁决

### 1.1 删除 Core 的假 Model Selection 与可选 ModelFactory

当前 `AgentRuntimeDeps.modelFactory` 仍为可选；`AgentRuntime` 在缺少 `config.modelSelection` 时会制造
`zcode-unconfigured/missing-model`，Contracts 仍公开导出同值 `DEFAULT_MODEL`。这与 Todo 01 已确认的生产边界
不一致：所有根执行 Model 必须来自正式 ModelFactory，Core 不得制造假 Model、假 Selection 或 fallback Model。

裁决如下：

- 生产 `AgentRuntime` 构造必须取得 `RuntimeModelFactory`；类型上改为必填；
- 生产 `AgentRuntimeConfig` 必须取得结构化 `ModelSelection`；Todo 13 的目标 Host initial selection 负责提供；
- 删除 `zcode-unconfigured/missing-model`、`DEFAULT_MODEL` 及围绕它们建立的解析、展示和测试断言；
- 删除 Runtime 内“未配置 ModelFactory”才可能触发的延迟运行期分支；
- 低层测试显式注入 Fake ModelFactory 或 Unavailable ModelFactory，并显式提供测试 Selection；
- 不建立新的 `stateOnly`、`unconfigured`、`default` 或 sentinel Model 类型；
- `Model.bind()` 继续是从已有 Active Model 派生绑定 Model 的合法路径，不受本项影响。

本项依赖 Todo 13 先删除生产临时 App/state-only Runtime；若实施时仍发现生产构造无法取得目标 Host Selection，
应回到 Todo 13 修正来源，不能保留假 Selection 兜底。

### 1.2 删除 `reasoning.enabled` 冗余状态

当前 Protocol 的 `ZCodeModelReasoningOptions` 同时具有 `enabled` 和 `levels`，但生产 Mapper 只会在 Reasoning
Option Spec 存在时创建该对象，并固定写入 `enabled: true`。是否存在 Reasoning 选择能力已经由对象/Option Spec
是否存在完整表达，额外布尔值没有独立状态。

裁决如下：

- 从 `zcodeModelReasoningOptionsSchema` 和 `ZCodeModelReasoningOptions` 删除 `enabled`；
- Bootstrap Mapper、Agent Model State、UI Projection 和测试不再读取或生成该字段；
- `reasoning === undefined` 表示没有 Reasoning 选项；存在时使用其 `levels/defaultLevel`；
- 不用空 levels、disabled enum 或另一个布尔字段替代；
- Legacy importer 对已发布旧字段 `reasoning.enabled` 的读取可以保留，但只作为 importer 私有输入，立即投影为
  当前 Personal Model Config Rule；
- 不改变 `ModelSelection.options.reasoningLevel`、Option Spec 默认值和 Adapter `reasoningMapping`。

### 1.3 删除 ZCode Protocol 中零引用的旧 Provider DTO

`packages/shared/src/zcode-protocol/index.ts` 仍公开一套没有生产消费者的旧 Provider 输入/输出 Schema，包括：

- `ZCodeModelProviderKind`；
- `ZCodeModelProviderSource`；
- `ZCodeModelProviderModel`；
- `ZCodeModelProviderConfig`；
- `ZCodeModelProviderInput`；
- 仅被上述 DTO 使用的 Secret Input/Ref、API Format 和 Schema；
- `models-dev`、`apiKeyRequired`、`providerOptions`、`modelsDevProviderId` 等旧字段。

裁决如下：

- 先用 `pnpm dep:refs` 逐 export 复核零引用，再直接删除 Schema、类型和只服务它们的测试；
- 不把它们迁入另一个 Shared 文件，不新增 deprecated alias；
- 保留当前仍在使用的 `ZCodeAccountAccess` 及其独立 Schema；不得因源文件相邻而误删；
- 若发现某个旧 DTO 只被测试 fixture 使用，fixture 改用当前 Provider Config 契约；
- 若发现真实 Legacy importer 消费者，只把所需最小 serialized shape 移入 importer 私有模块，不恢复公共协议。

### 1.4 将 Legacy CLI Model Config 收入 importer 私有边界

Contracts 仍公开 `ModelProviderKind`、`ModelTargetConfig` 和 `RuntimeModelConfig`。它们描述旧 CLI 的
`main/lite/available`、`kind/baseURL/apiKey/apiKeyRequired/headers/providerOptions` 格式，当前只服务 Legacy CLI
Personal Config importer，不属于正式 Runtime 或 Provider Domain。

裁决如下：

- 将 importer 确实需要的最小 serialized DTO、Zod parser 和 normalize helper 移入 Legacy CLI importer 私有目录；
- 私有类型不得从 Contracts、Adapters、Bootstrap 或 Services barrel 导出；
- Legacy 文件读取后立即转换为当前 Personal Provider Config / Personal Model Config Rules；
- Runtime、Registry、ModelFactory、UI 和新持久化不得接触旧 DTO；
- 保留已发布旧 CLI 配置的兼容读取，不在本 Todo 结束兼容窗口；
- importer 测试直接构造旧 JSON fixture，不为测试重新公开旧类型。

### 1.5 删除 Runtime 的第二模型事实通道

Todo 14 已要求从 `RuntimeModelFactoryInput` 删除无效的 `contextWindow/properties/providerOptions` 等字段，但当前
`AgentRuntimeConfig` 仍保存和传播 `modelProviderOptions`，Compact 等执行路径仍会从 Active Model 回退
`AgentRuntimeConfig.contextWindow/maxOutputTokens`。如果只清理 Factory 入参，旧通道仍会留在 Runtime 内部。

既有事实归属已经足够明确：

```text
执行静态事实       -> Active Model.properties
执行绑定选项       -> Active Model.options
未来选择意图       -> ModelSelection
空闲候选/默认展示  -> Target Host ModelSelectionView
```

裁决如下：

- 删除 `AgentRuntimeConfig.modelProviderOptions`、Title/Memory/Compact/Workflow/Subagent 的同名透传、getter、更新器
  和只验证该通道的测试；
- 正常请求、Microcompact、Full/Reactive Compact、Memory、Title、Goal、Child Agent 在取得本次 Model 后，只读取
  `Model.properties.contextWindow` 和 `Model.options.maxOutputTokens`；
- 上述执行路径不得使用 `runtimeConfig ?? model` 或 `model ?? runtimeConfig` 兜底；如果语义要求执行 Model，类型上
  将 Model 改为必填并在调用边界创建；
- `model.selected` 等执行事件从实际创建的 Model 投影模型事实，不从 Runtime Config 复制；
- 空闲态模型展示与 configured default 由 Todo 13 的目标 Host View 提供，不以保留 Runtime 副本解决；
- 完成消费者迁移后，若 `AgentRuntimeConfig.contextWindow/maxOutputTokens` 已无独立非执行语义，直接删除；
- 若仍发现真实非执行消费者，必须证明其权威来源和生命周期，并改为显式、窄范围 DTO；不得继续让它参与模型
  请求、Compact 或 ModelFactory 创建。

这项不改变 `ModelSelection.options.maxOutputTokens`：它仍表达用户明确选择意图；ModelFactory 根据 Option Specs
补齐的最终值只存在于 Active Model.options。

### 1.6 修正仍被当作当前事实的旧设计文档

当前文档有两类问题：一类仍描述 Catalog、models.dev、Provider/modelId 推断或平铺媒体 capability；另一类
虽然已经进入 Provider Refactor Design，却仍把旧的 Registry/Model 关系写成当前契约。

第一类包括：

- `apps/zcode-cli/docs/design/v2/model/model-capability-resolution.md`；
- `docs/chat/manual-model-switch-resolution-chain.md`；
- `docs/model-request-output-tokens.md`；
- `docs/compact-media-capability-projection.md`；
- `apps/dev-docs/src/data/productCapabilityMap.ts` 中的旧 Catalog/Modality 节点。

第二类包括：

- `design/model/model.md` 仍用 `registry.createModel()` 作为直接入口，并让公共 `Model` 暴露
  `providerConfig/modelConfig`；
- `design/interaction/interaction.md`、`design/registry/registry.md` 和 `design/registry/runtime.md` 仍把
  `createModel(selection)` 画成 Provider Registry 索引本身的方法；
- 上述表述与当前 `Model` 契约及 `design/registry/model-creation.md` 已确认的边界不一致。

当前唯一准确关系为：

```text
Provider Registry
├─ lookup
└─ validate
      |
      v
ModelFactory
      |
      v
Adapter private createModel
      |
      v
Active Model
├─ identity
├─ properties
├─ optionSpecs
├─ options
└─ generateText / streamText
```

完整 `RegistryProviderConfig/RegistryModelConfig` 是 ModelFactory 交给 Adapter 的私有创建输入，不是公共
`Model` 的可查询字段。`Model.bind()` 继续是从已有 Model 派生绑定 Model 的合法入口。

裁决如下：

- 仍承担当前设计入口的文档改写为 Provider Config + Model Config Rules + Registry + ModelFactory + Active Model；
- 纯历史文档在标题和开头明确标记 historical/retired，并链接当前 Design；
- 删除会让读者继续实现 Catalog、models.dev fallback、modelId hardcode 或 capability map 的规范性措辞；
- 不全仓删除历史计划、迁移记录和 Git 考古证据；历史材料只需明确不能作为当前实现依据；
- 同步修正开发文档能力图，避免把已退役文件重新列为当前 owner。

### 1.7 收紧当前 Model Option Protocol 的无效投影

旧 Provider DTO 之外，当前 `zcodeModelOptionSchema` 仍保留一组没有形成有效产品语义的字段：

- `providerSource`、`providerLogoUrl` 没有生产者，也没有 Renderer/Services 消费者；
- `supportsTools`、`supportsStructuredOutput` 由 Bootstrap 从完整 Model Properties 平铺生成，但 Renderer 没有
  消费；它们同时形成了 `Model.properties` 之外的第二份 capability 投影；
- 旧 `zcodeModelProviderModelSchema` 中的同名字段仍按 1.3 的旧 Provider DTO 整体删除，不与当前
  `zcodeModelOptionSchema` 混为一个兼容理由。

裁决如下：

- 从当前 `zcodeModelOptionSchema/ZCodeModelOption` 删除 `providerSource`、`providerLogoUrl`、`supportsTools`、
  `supportsStructuredOutput`；
- 删除 Bootstrap 内部重复的 `ZCodeModelOption` DTO 和中间投影；保留从 Registry 到当前 Protocol 所需的唯一直接投影，并删除上述无效字段及其专属测试；
- 不把 `supportsTools/supportsStructuredOutput` 搬到另一套展示 DTO；未来若有真实 UI 场景，先基于当前
  Model Properties 契约设计最小投影；
- 保留 `properties.input_format/output_format` 的同结构 Protocol 契约；本项不退回平铺媒体字段；
- `ref`、`label`、`providerLabel`、Reasoning options、context/output 展示事实等已有真实消费者的字段不受影响；
- 实施前再次用全仓引用扫描确认字段没有被并发工作引入新的真实消费者。

### 1.8 删除 Bootstrap 的 Built-in Provider 展示名硬编码

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-mapper.ts` 仍维护 `BUILTIN_PROVIDER_LABELS`，按
Provider ID 硬编码 Z.AI、BigModel、ZAPI 等展示名。这是 ZCode Built-in Provider Config 之外的第二份静态
Provider 元数据来源。

裁决如下：

```text
Registry Provider Config.label
              |
              v
Protocol providerLabel

label 缺失 -> providerId
```

- 删除 `BUILTIN_PROVIDER_LABELS` 及按 Provider ID 查展示名的逻辑；
- Mapper 优先使用 Registry 已提供的 Provider label，缺失时只回退 `providerId`；
- 不在 Bootstrap、UI 或 Protocol 新建另一张 Built-in Provider label map；
- Coding Plan 商品、购买、用量、账号 family 等产品分支继续按自己的业务 Provider ID 工作，不属于本项；
- 本项只收口展示元数据来源，不改变 Provider ID、候选顺序、可见性、启停、鉴权或模型执行。

## 2. 与 Todo 13、14 的边界

```text
Todo 13
|- Target Host selection authority
|- structured ModelSelection persistence/protocol
|- temporary App removal
`- string selection business-chain retirement
        |
        v
Todo 16.1
`- Runtime constructor can require real Selection + ModelFactory

Todo 14
|- RuntimeModelFactoryInput mechanical narrowing
|- Full Compact MCS force
|- Legacy Provider Store DTO privatization
`- known dead files
        |
        v
Todo 16
|- Core fake sentinel removal
|- reasoning.enabled removal
|- zero-reference ZCode Protocol Provider DTO removal
|- current Model Option Protocol projection narrowing
|- Legacy CLI Model Config privatization
|- AgentRuntime secondary model-fact channel removal
|- Built-in Provider label hardcode removal
`- current Design/document correction
```

- Todo 13/14 已修改同一文件时，本 Todo 以最新实现做零引用复核，不恢复被删除代码；
- Todo 16 不复制 Todo 13/14 的测试、改动清单或完成定义；
- Todo 16.1 依赖 Todo 13；其余项目可在文件冲突可控时独立实施；
- Todo 11 的 Provider Runtime composition/lifecycle 草案不属于本 Todo；
- Todo 15 的真实环境与发布验证不属于本 Todo。

## 3. 补充差集 Impact Brief

### 3.1 Feature Summary

| 字段             | 结论                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Developer intent | 补齐 Todo 16 对正式 Design、当前 Model Option Protocol 和 Provider label 来源的遗漏               |
| Capability       | Model/Provider Config、Registry/ModelFactory、模型候选 Protocol projection                        |
| Change layer     | `presentation`、`option-source`；文档部分属于架构契约修正                                         |
| Operating mode   | planning                                                                                          |
| Primary seeds    | `design/model/model.md`、`zcode-protocol/index.ts`、`zcode-protocol/model-mapper.ts`              |
| Out of scope     | 模型候选状态、Selection 默认值、提交、执行、配置持久化、remote/continuous/replayable 和 Telemetry |

### 3.2 UI Surface Matrix

| 用户场景       | UI 入口       | 共享实现                 | 展示 owner                | 默认/校验/提交                      | 模式边界                | 必须隔离                         |
| -------------- | ------------- | ------------------------ | ------------------------- | ----------------------------------- | ----------------------- | -------------------------------- |
| 查看模型候选组 | 模型选择控件  | `zcodeSessionProjection` | Target Host Protocol View | 本项只收口字段和 label 来源；无提交 | Desktop/Web/Mobile 同构 | Draft、Recent、Session Selection |
| 编辑 Provider  | Provider 设置 | Provider Settings Facade | Effective Provider Config | 无字段、保存或测试连接行为变化      | Local/Remote 不变       | Personal Config 与账号状态       |

### 3.3 Shared And Divergent Behavior

| 关注点         | 共享规则                                             | 保持差异                                       |
| -------------- | ---------------------------------------------------- | ---------------------------------------------- |
| Provider label | 所有模型候选都从 Registry Provider Config 取得展示名 | 商品/用量界面可保留自己的商业文案              |
| Model facts    | 执行事实只由完整 Model Properties/Options 表达       | Protocol 只传当前 UI 实际需要的最小展示投影    |
| Model 创建     | Registry lookup/validate 后由 ModelFactory 创建      | `Model.bind()` 仍合法派生已有 Model            |
| 状态与持久化   | 无变化                                               | 各产品原有 Draft、commit sink 和持久化继续隔离 |

### 3.4 Feature Relationships

| 等级           | From                           | 关系                 | To                            | 原因                                     |
| -------------- | ------------------------------ | -------------------- | ----------------------------- | ---------------------------------------- |
| must-inspect   | Provider Registry/ModelFactory | creates-through      | Adapter private execution     | 修正文档不能再次合并 Registry 与 Factory |
| must-inspect   | Registry Provider Config       | projects-to          | Protocol `providerLabel`      | 删除 Bootstrap 静态名称旁路              |
| must-inspect   | Active Model Properties        | projects-to          | Current Model Option Protocol | 删除未消费的平铺 capability 副本         |
| invariant-only | Model selection products       | must-not-mutate      | Draft/Session/product records | 本项不改变选择意图或提交语义             |
| invariant-only | Local/remote delivery          | must-remain-isolated | continuous/replayable runtime | 无请求、队列、快照或恢复改动             |

### 3.5 State Owners And Commit Sinks

| 事实            | 权威 owner                      | Commit/Persistence                | 本项后边界                        |
| --------------- | ------------------------------- | --------------------------------- | --------------------------------- |
| Provider 展示名 | Registry Provider Config        | Built-in/Personal Provider Config | Protocol 只投影，不再按 ID 硬编码 |
| Model 执行能力  | Active Model properties/options | Model Config Rules                | 不产生未消费的平铺 Protocol 副本  |
| 用户模型选择    | 各产品 Draft/Submission/Session | 各自既有 sink                     | 完全不变                          |

### 3.6 Must-Preserve Invariants

- 不改变候选集合、排序、Provider 分组、enabled/visibility 或 fallback；
- 不改变 `ModelSelection` Schema、默认值解析或 ModelFactory 最终校验；
- 不把完整 Provider/Model Config 暴露到公共 Model 或 Protocol；
- 不改变 Desktop、Web、Mobile、Local、Remote、continuous 或 replayable 行为；
- 不把商品、账号、用量和鉴权分支误当作静态 Provider label 配置清理。

### 3.7 Codegraph Evidence And Graph Delta

- 当前环境没有可调用的 codegraph 工具；以 feature graph seed、`rg`、`dep:refs` 和 `knip` 做深度 2 的静态替代；
- 直接路径为 Registry Provider/Model -> Bootstrap Model Mapper -> ZCode Protocol -> UI Session Projection；
- `supportsTools/supportsStructuredOutput` 只有生产端写入，没有 Renderer 读取；
- `providerSource/providerLogoUrl` 在当前 Model Option 链中没有生产者和消费者；
- feature graph 已正确声明 Model Properties 与 Provider Registry 的权威关系，本轮没有新的产品语义节点，
  graph delta 为 `none`；旧/stale seed 的删除继续由 Todo 14/16 的文档机械归零处理。

### 3.8 Unresolved Questions

无。上述八项均为既有决策的机械收口，不需要新的产品裁决。

## 4. 实施顺序

### Step A：建立归零测试与依赖证据

1. 为 Required ModelFactory/Selection、无 `reasoning.enabled`、Active Model-only Compact 建立失败测试；
2. 用 `pnpm dep:refs`、`rg` 和 `knip` 固定 Protocol DTO、当前 Model Option 字段、Legacy CLI 类型与 sentinel
   的消费者清单；
3. 更新本 Todo 涉及的正式 Design，先固定最终契约再修改代码；
4. 记录 Todo 13/14 已经删除的重叠项，不重复恢复 fixture。

### Step B：收紧 Core Runtime

1. 在 Todo 13 初始 Selection 链完成后，将 ModelFactory 与 ModelSelection 改为生产构造必填；
2. 删除 sentinel Selection、`DEFAULT_MODEL` 和延迟失败分支；
3. 测试统一显式注入 Factory/Selection；
4. 删除 `modelProviderOptions` 整条 Runtime 状态；
5. 执行消费者改为只读本次 Active Model，删除 Runtime Config fallback。

### Step C：收紧 Protocol 与 Reasoning Projection

1. 删除零引用旧 Provider Protocol DTO；
2. 保留并回归 `ZCodeAccountAccess`；
3. 删除 `reasoning.enabled` 的 Schema、Mapper、UI 与测试字段；
4. 删除当前 Model Option 中零消费字段及 Bootstrap 的平铺 capability 输出；
5. 删除 `BUILTIN_PROVIDER_LABELS`，确认 `providerLabel = config label ?? providerId`；
6. 验证 Desktop、Web/Remote 与 Agent 严格协议解析一致。

### Step D：私有化 Legacy CLI Config

1. 提取 importer 最小旧 serialized shape；
2. 迁移 parser、adapter、importer 和专项 fixture；
3. 从 Contracts/Adapters 公共 barrel 删除旧类型和入口；
4. 验证旧配置仍单向生成等价的当前 Personal Config。

### Step E：文档与机械验收

1. 更新当前态文档或标记历史状态，并统一 Registry -> ModelFactory -> Adapter private execution -> Model；
2. 重跑零引用和禁用符号扫描；
3. 执行定向单测、`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
4. 更新 Todo 状态并提交独立 Conventional Commit。

## 5. Accepted Cases

| Case ID | 场景                                    | 预期                                                          |
| ------- | --------------------------------------- | ------------------------------------------------------------- |
| RZ-01   | 生产创建 AgentRuntime                   | 类型上必须提供 ModelFactory 与结构化 ModelSelection           |
| RZ-02   | 测试构造不可执行 Runtime                | 显式使用 Unavailable ModelFactory，不存在 sentinel Model      |
| RZ-03   | 模型无 Reasoning Option Spec            | Protocol/UI 中 `reasoning` 缺失，不出现 `enabled=false`       |
| RZ-04   | 模型有 Reasoning Option Spec            | 只传 levels/defaultLevel，不出现固定 `enabled=true`           |
| RZ-05   | Shared Protocol export scan             | 旧 ZCode Provider DTO 和仅属其字段为零                        |
| RZ-06   | 读取已发布旧 CLI 配置                   | importer 私有解析并生成当前 Personal Config                   |
| RZ-07   | 正常请求、Compact、Memory、Title、Child | context/output facts 只来自本次 Active Model                  |
| RZ-08   | Model Config 默认 max output 更新       | 只影响后来创建的 Model，不反写旧 Selection/Runtime snapshot   |
| RZ-09   | 本地与远程模型执行                      | 各自由目标 Environment ModelFactory 创建，无本地 fallback     |
| RZ-10   | 阅读当前模型设计文档                    | 不再把 Catalog、models.dev 或 capability map 当作当前权威     |
| RZ-11   | 读取当前 Model Option Protocol          | 不包含零消费字段或平铺的 tools/structured capability          |
| RZ-12   | Built-in Provider 有 label              | 候选展示 Registry Config label                                |
| RZ-13   | Provider label 缺失                     | 候选只回退 providerId，不查询 Bootstrap 静态名称表            |
| RZ-14   | 阅读 Model 创建 Design                  | Registry lookup/validate 与 ModelFactory/Adapter 创建边界清晰 |

## 6. 完成定义

1. `AgentRuntimeDeps.modelFactory?`、`zcode-unconfigured/missing-model`、公共 `DEFAULT_MODEL` 为零；
2. 当前 Protocol/Projection 中 `ZCodeModelReasoningOptions.enabled` 为零；
3. 零引用旧 ZCode Provider Protocol DTO 和公共 Schema/export 为零；
4. 公共 Contracts/Adapters 中 Legacy CLI `RuntimeModelConfig/ModelTargetConfig` 为零；
5. `AgentRuntimeConfig.modelProviderOptions` 及其传递链为零；
6. 已取得 Active Model 的执行路径对 Runtime `contextWindow/maxOutputTokens` fallback 为零；
7. Legacy CLI 兼容只存在 importer 私有边界，正式 Config/Registry/Runtime 不读旧结构；
8. 当前态文档不再宣称旧 Catalog/Capability 推断是正式架构；
9. 当前 Model Option Protocol 的 `providerSource/providerLogoUrl/supportsTools/supportsStructuredOutput` 为零；
10. Bootstrap `BUILTIN_PROVIDER_LABELS` 及等价 Provider ID -> label 静态表为零；
11. 正式 Design 不再让公共 Model 暴露完整 Provider/Model Config，也不再把 Model 创建描述成 Registry 索引方法；
12. Todo 13/14 已规划范围没有在本 Todo 中生成第二套实现；
13. 定向测试、类型检查、Lint 和格式检查通过。

## 7. 明确不做

- 不重新设计 ModelSelection、Provider Config、Model Config Rules 或 Access；
- 不修改 Todo 11 的 Host/Agent Provider Runtime composition；
- 不结束已发布 Legacy CLI/Provider Store 的兼容读取窗口；
- 不建立新的 Model identity、capability DTO、Runtime model snapshot 或 fallback model；
- 不修改 Queue、Goal、Off-Peak 调度、desktop continuous、mobile replayable 或 remote recovery 语义；
- 不把历史文档和 Git 考古证据全部删除。

## 8. 实施记录（2026-08-25）

- Core 生产构造已要求真实 `ModelSelection` 与 `ModelFactory`；测试通过显式 helper 注入测试事实，生产
  sentinel、`DEFAULT_MODEL` 与延迟缺少 Factory 分支已删除。
- Runtime 的 `modelProviderOptions/contextWindow/maxOutputTokens` 第二事实链及 Compact、Memory、Child、Workflow
  透传已删除；执行期统一读取本次 Active Model。
- Shared Protocol 已删除零引用旧 Provider DTO、`reasoning.enabled` 和当前 Model Option 的无消费平铺字段；
  Bootstrap 直接从 Registry View 投影当前协议，并从 Provider Config 取得 label。
- 旧 CLI Provider/Model JSON 的最小 Zod Schema 与类型已移入 bootstrap importer 私有模块；Contracts、Adapters
  的公共类型、parser 与 barrel export 已删除。Adapter 测试不再把一次性 importer 当作正式 Config parser。
- 当前 Design 已统一为 `Registry lookup/validate -> ModelFactory -> Adapter private create -> Active Model`；旧
  Model Catalog 文档已明确标记退役，能力图和相关运行文档已切到 Model Config Rules / Active Model。
- 依赖扫描确认被删除 Shared DTO 无生产引用；定向 Protocol、Legacy importer、Adapter Config、Core Runtime
  测试和 Contracts/Adapters/Core/Bootstrap package typecheck 通过。全仓机械验证记录在本 Todo 对应提交中。
