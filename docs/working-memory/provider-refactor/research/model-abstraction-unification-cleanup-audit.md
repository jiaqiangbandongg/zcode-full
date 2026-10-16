# 模型抽象统一清理审查

> 状态：M4 完成后的清理预审；M4 项已归零，其余问题待逐项裁决
>
> 日期：2026-08-24
>
> 目标设计：[`../design/design.md`](../design/design.md)
>
> 当前并行阶段：[`../steps/04-model-execution-cutover.md`](../steps/04-model-execution-cutover.md)

## 1. 文档定位

Provider Refactor 已经建立新的 Provider Config、Model Config Rules、Registry、ModelFactory 和 `Model`
调用边界，并删除了大量旧 Provider / Model 实现。M4 已把闲时任务与 Subagent 等特殊执行迁入同一条
标准模型调用链。

本次审查不再只判断某个阶段是否按计划完成，而是检查整个系统是否仍存在第二套模型抽象、第二条模型
装配路径或第二份模型事实源。审查结果先记录代码事实和结构风险；需要设计裁决的内容保留为开放问题，
后续逐项讨论后再进入正式设计和实施计划。

本审查与并行的新增代码审查分工明确：

```text
并行新增代码审查
`- 检查 M4 新实现是否正确、完整，是否引入行为或质量问题

本模型抽象统一清理审查
`- 检查新链建立后还有哪些旧代码、旧抽象和兼容路径可以物理退出
```

因此，本审查不对 M4 新增代码做一般性的实现 Review。只有在判断某段旧代码是否已经被新链完整替代时，
才读取新增实现作为删除证据。这里的核心产出是旧代码清理清单、依赖关系、删除前提与机械归零条件，
不是另一份 M4 新代码问题列表。

本次审查回答以下问题：

1. 业务代码是否仍能绕过 `ModelFactory`，直接使用旧 Adapter 或旧请求 DTO 执行模型请求；
2. `ModelSelection`、`Model`、模型身份、请求和结果是否仍被旧 `ModelRef` 混合表达；
3. Provider / Model Config 之外是否仍有 Catalog、Runtime Config、Endpoint 或 modelId hardcode 提供模型事实；
4. Core、Service、Protocol 和 UI 是否仍消费旧 Provider / Model 完整 DTO；
5. 哪些旧实现应物理删除，哪些只是需要限制在 Adapter、Protocol 或一次性 importer 边界；
6. M4 完成后还需要哪些机械检查，才能证明系统抽象真正收口。

更直接地说，本审查持续追问的是：

> 新设计已经提供了什么替代能力；依赖旧设计的代码为什么还存在；现在能否删除；如果还不能删除，
> 缺少的最后一个迁移前提是什么。

## 2. 审查目标架构

目标系统只有一条模型形成与执行链：

```text
持久化 / Protocol
    ModelSelection
          |
          v
Effective Provider Config + Effective Model Config Rules
          |
          v
    Provider Registry
          |
          v
      ModelFactory
          |
          v
      Active Model
      |- identity
      |- properties
      |- optionSpecs
      |- options
      `- generateText / streamText
          |
          v
 Adapter 内部执行投影
          |
          v
     Provider API
```

各概念的目标职责为：

| 概念                      | 唯一职责                                                                         |
| ------------------------- | -------------------------------------------------------------------------------- |
| `ModelSelection`          | 表达未来创建模型的用户或产品意图，可以持久化和跨进程传输                         |
| Effective Provider Config | 决定 Provider、API、Access、模型成员和用户可见性                                 |
| Effective Model Config    | 决定模型 Properties、Option Specs 和请求参数映射                                 |
| Provider Registry         | 聚合 Effective Config，并按 Provider/Model 身份提供解析与 View                   |
| `ModelFactory`            | 把 Selection、Registry 事实和请求依赖装配成完整 `Model`                          |
| `Model`                   | 当前执行使用的不可变模型事实与唯一模型调用接口                                   |
| Adapter                   | 把 `ModelRequest` 编码为具体 Provider API 请求；不向业务层输出第二套模型抽象     |
| Model Identity            | 如事件、Telemetry 确实需要，只记录实际模型身份，不承担 Selection 或 Options 语义 |

Core 最终只应认识 `ModelSelection` 和 `Model`；如有必要，可以认识只读的最小 Model Identity。Core 不应
认识 AI SDK Adapter、Provider Connection、baseURL、providerKind、旧 Catalog capability 或按具体 modelId
推断出的能力。

## 3. 审查分类原则

发现旧符号或旧 DTO 时不能仅按名称判断是否删除。本次使用以下四类归属：

| 分类           | 含义                                                            | 处理原则                                                 |
| -------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| M4 已退出      | 属于 M4 且已经删除的特殊执行双轨                                | 保持归零门禁，禁止重新引入                               |
| 运行时第二抽象 | 仍参与正常模型选择、装配、能力判断或请求执行                    | 必须迁入统一链并删除旧入口                               |
| 合法边界实现   | Adapter 内部执行、严格 Protocol schema 或一次性 legacy importer | 可以保留，但不能反向渗透到 Core、Registry、Service 或 UI |
| 后续领域边界   | 已知不属于 M4、需要后续阶段重新归属的职责                       | 记录依赖和最终方向，不在 M4 中顺手改造                   |

`AiSdkModelAdapter` 本身不是需要删除的“旧模型抽象”。它可以继续作为具体执行实现。真正的问题是 Core
是否直接依赖它，以及它是否通过公共 DTO、Connection 或可变 Registry 重新成为第二个业务模型入口。

## 4. 当前总体结论

主要业务模型调用已经大多通过 `Model.generateText()` / `Model.streamText()`；直接调用 OpenAI、Anthropic
或其他 Provider SDK 的实现基本收敛在 Adapter。这说明新的公共调用边界已经形成。

但是系统尚未完成抽象统一。当前仍存在几组会参与正常运行时的旧结构：

```text
正式路径
ModelSelection -> Registry -> ModelFactory -> Model

并存路径
Runtime Config -> modelAdapter -> Compatibility Model
Old Catalog / Connection / modelId hardcode -> 再次推断 Properties 和 Options
ModelRef -> 同时承担 Selection、Identity、Variant、Request 和 Result 归属
New Registry Model View -> 反向投影为旧 ModelProviderModelConfig -> Service / UI
```

因此，M4 是必要收口，但仅完成 M4 还不能证明系统只剩一套模型抽象。M4 后仍需要一次专门的模型抽象
清理阶段。

## 5. 已发现问题

### 5.1 Core 仍同时依赖 ModelFactory 与旧 Model Adapter（已裁决删除）

详细实施 Todo：[`../steps/todo-01-core-model-adapter-boundary-cleanup.md`](../steps/todo-01-core-model-adapter-boundary-cleanup.md)

`AgentRuntimeDeps` 和 `AgentRuntime` 当前同时持有：

- `modelFactory`；
- `modelAdapter: any`；
- `modelConnectionPort`；
- `resolveRuntimeModelLimits`；
- `resolveModelProviderOptions`；
- `providerRuntimeHeadersPort`。

`createRuntimeModel()` 在存在 `modelFactory` 时创建正式 Model；缺少 Factory 时会自动使用 `modelAdapter`
创建 Compatibility Model。这个 Compatibility Model 自己补齐 context window、max output、输入格式、Tool、
Structured Output、WebSearch 和 Mid-conversation System 等事实。

当前 Compatibility Model 的代表性默认值包括：

- context window `200_000`；
- max output `32_000`；
- Text、Image、Video、PDF 为支持；
- Audio 为不支持；
- Tool Call、Structured Output 为支持；
- WebSearch 和 Mid-conversation System 再根据 Connection、Endpoint 或 modelId 推断。

这不是单纯的兼容命名，而是一份与 Effective Model Config 平行的模型事实源。只要 Core 允许缺少
Factory 时隐式进入这条路径，生产装配遗漏就无法被类型或启动完整性检查发现。

静态扫描显示，当前仍有 17 个 Core 生产文件引用 `modelAdapter`，约 15 个 Core 生产文件引用
`modelConnectionPort`。部分标题、Memory、Compact、Subagent 和模型型工具支线仍以 Adapter 或 Connection
是否存在判断能力可用性。

已确认的设计裁决：

- Core 删除 `modelAdapter` 依赖和 Compatibility Model；
- 缺少 ModelFactory 时不得回退到 Adapter 或由 Core 拼装模型事实；
- 所有生产模型执行入口必须取得正式 ModelFactory；
- 测试模型调用改用 Fake Model / Fake ModelFactory，不为测试保留生产兼容入口；
- Adapter 仍可作为 Bootstrap / ModelFactory 下游的执行实现，不要求从整个仓库删除 `modelAdapter` 概念；
- `modelFactory` 是否在 `AgentRuntimeDeps` 类型上对纯 state-only Runtime 也设为必填，可以按真实构造形态决定，
  但任何无 Factory Runtime 都必须无法执行模型请求。

实施评估：这项清理边界明确、风险可控，但不是一次 trivial 删除。M4 后的静态扫描仍发现 17 个 Core 生产
文件引用 `modelAdapter`，Workflow Child 的 Factory 类型仍为可选，约 29 个 Core / Bootstrap 测试文件只
提供 Adapter 而没有 Factory。实施需要先迁移测试装配和生产 Child Runtime，再删除 Core fallback、字段和
功能门禁。它应作为独立、测试先行的清理提交，不能与并行 M4 Review 的未提交测试修改交叉编辑。

### 5.2 M4 的特殊执行模型链已物理退出

M4 已删除以下旧概念：

- `turnRuntimeModel`；
- `TurnExecutionModel`；
- `ExecutionScopedModelSource`；
- `createRuntimeModelFactory`；
- Runtime Provider 临时 Overlay；
- 临时切换并恢复 Session model 的状态机。

闲时任务、Compact、Subagent 与普通会话现在使用相同的 Selection、Registry、ModelFactory 和 Active
Model，不再产生第二份完整 Provider/Model 快照。生产源码扫描中上述符号均为零；协议测试中仅保留一个
`turnRuntimeModel` 字面量，用来证明旧字段不能进入新命令契约。

### 5.3 死的 ModelPort 接口仍保留

旧 `ModelPort` 仍定义以 `ModelTextRequest` 为输入的 `generateText` / `streamText` 接口，另有
`ModelPortOptions`。当前静态引用审查没有发现有效生产调用。

它与新 `Model` 是重复的 Core-facing 执行接口，应作为明确死代码删除。删除时不能把
`modelAdapter: any` 重新类型化成 `ModelPort`，否则只是恢复旧抽象。

### 5.4 新 Model 的 Result/Event 仍建立在旧 ModelRef 协议上

新的 `Model` 已经定义统一的 Properties、Option Specs、Options 和调用方法，但 `ModelResult` 与
`ModelEvent` 暂时仍是旧 `ModelTextResult` 和 `ModelStreamEvent` 的别名。

旧协议中的 `ModelRef` 同时携带：

- `providerId`；
- `modelId`；
- 可选 `variant`。

它目前仍广泛用于：

- 旧 `ModelTextRequest`；
- `ModelTextResult`；
- Stream Event；
- Network Status；
- Telemetry；
- 消息和执行归属；
- Runtime 选择与兼容转换。

静态扫描中 `ModelRef` 仍出现在约 48 个生产文件。这里不能直接批量删除，因为其中一部分确实需要记录
已执行模型身份；问题在于同一类型混合了选择意图、执行身份、reasoning variant 和请求参数。

需要讨论：

1. 是否正式建立只包含 `providerId + modelId` 的 `ModelIdentity`；
2. `ModelSelection` 是否是唯一允许携带 Options 的序列化选择类型；
3. Result、Event、Telemetry 分别保存 Identity、完整执行 Options，还是一份执行 Observation；
4. `variant` 如何退出，历史持久化数据如何只在恢复边界转换；
5. 新 `ModelResult` / `ModelEvent` 是否应脱离旧 DTO 后再删除 `ModelRef`。

### 5.5 旧 Model Catalog 仍是一套平行事实系统

详细实施 Todo：[`../steps/todo-08-legacy-model-catalog-retirement.md`](../steps/todo-08-legacy-model-catalog-retirement.md)

当前仍保留以下完整结构：

- `ModelCatalogConfig`；
- `ModelCapability` / `ModelCapabilityProvider`；
- `ModelCatalogService` / `ModelCatalogSource`；
- `models-dev` / `models-dev-snapshot`；
- `default-policy` / `reasoning-policy`；
- `runtime-thought-level`。

其中 bundled `models-dev-snapshot.ts` 约 2.3 MB。当前发现的正常生产构造基本显式设置
`modelsDev: false`，说明 bundled 数据库已经不再承担主要生产事实；但 Catalog 类型、合并逻辑和策略仍被
Bootstrap、Adapter 和旧配置链引用。

目标边界应当是：

```text
正常运行时
Built-in / Personal Config -> Effective Rules -> Registry -> Model

历史迁移
Legacy Config -> 私有 Importer -> 新 Config
                              `-> 到此终止
```

已确认的 Legacy Config 裁决：

- 删除旧 `modelCatalog.overrides` 的 Schema、解析、合并和测试；不为它补写 Personal Model Config importer；
- 该结构曾表达的 context、输入格式、Tool/Structured Output、reasoning 档位、默认值和请求参数映射，均可由
  Personal Model Config Rules 完整表达，不存在必须保留的独有运行能力；
- 审查时 Legacy parser 虽然解析 `modelCatalog.overrides`，正式 importer 并不消费该结果，因此删除它不会取消
  一条当前有效的迁移行为；
- 旧 `provider.*.models.*` 中 importer 已明确支持的常规 Provider/Model 配置继续迁移；不得为删除
  `modelCatalog.overrides` 而扩大或缩小这条既有迁移边界；
- `name`、`family` 等旧展示元数据不构成保留 Catalog 的理由；未来若有产品用途，应进入当前展示配置，而不
  能恢复 Catalog 权威。

上述裁决及剩余 Catalog 数据/source、capability/default policy、Reasoning Selection View 和 Tool Schema
兼容特判的物理清理由 Todo 08 统一实施；不能继续散落在已经完成的 Todo 02 中。

### 5.5.1 Reasoning 选择器复用模型选择链

`ZCodeModelReasoningState` 不是模型运行状态。它当前随 `ZCodeModelOption` 跨进程发送，主要为输入框、
Subagent、闲时任务和 Repo Wiki 等模型选择界面提供 reasoning 档位和默认值。目标不是建立独立 reasoning
查询或状态链，而是复用模型选择候选项：

```text
Effective Model Config.optionSpecs.reasoningLevel
                         |
                         v
            Registry Model Selection View
                         |
                         v
                当前选中的模型候选项
                         |
                         +--> Composer reasoning selector
                         +--> Subagent / Off-Peak / Repo Wiki
                         `--> 提交 ModelSelection.options.reasoningLevel
```

已确认裁决：

- 可用档位和默认值属于模型选择候选项的 `optionSpecs.reasoningLevel`，前端从当前选中候选项直接读取；
- `ModelSelection` 只保存用户明确选择的 `options.reasoningLevel`，不复制整个档位规格；
- 删除独立的 `ZCodeModelReasoningState` 概念和误导性的 `State` 命名；不建立第二个 reasoning fetch、store
  或同步通道；
- `enabled` 是冗余字段：是否存在 `optionSpecs.reasoningLevel` 已经完整表达该模型是否提供此选项；
- `providerOptionsByLevel` 不进入 Protocol/UI。Provider 请求参数映射只保留在 Effective Model Config 的
  `reasoningMapping`，由 ModelFactory/Adapter 在执行侧消费；
- Protocol 可以严格序列化选择候选项所需的 Option Spec，但它是 Registry Selection View 的一部分，不是
  新的模型事实源。

### 5.6 Model Properties 之外仍有能力推断路径

新的 `ModelProperties` 已经包含 input/output format、Tool、Structured Output、Native WebSearch 和
Mid-conversation System 等能力。但是 Core 与 Adapter 中仍存在根据以下信息推断能力的路径：

- providerKind；
- baseURL / Endpoint host；
- 具体 modelId 或 modelId prefix；
- 特定 Provider ID。

当前代表性 hardcode 包括 `claude-opus-4-8`、DeepSeek Endpoint、DeepSeek V4、MIMO、Kimi K3、
GitHub Copilot 与 GPT 字符串组合。

这里需要区分两个问题：

```text
模型是否支持某种能力
    -> Effective Model Config / Model.properties

某个 API type 怎样把能力编码到 wire request
    -> Adapter 实现或显式 Adapter compatibility 配置
```

当前部分 helper 混合了“能力事实”和“编码限制”。例如 Config 可以声明 Native WebSearch 为支持，Adapter
又可能因为 Endpoint 不在 allowlist 中不编码工具，从而产生两个裁决源。

需要讨论：

1. 哪些 hardcode 是模型能力，应迁入 Built-in Model Config Rules；
2. 哪些是 API 协议兼容，应改为按 `api.type` 或显式 compatibility flag 驱动；
3. Adapter 是否允许知道具体模型 ID；如果允许，边界和集中位置是什么；
4. 一次性 legacy importer 中的模型名推断是否作为唯一例外保留。

### 5.7 闲时模型又被投影回旧 Provider Model DTO

闲时任务已经可以从新的 Provider Config resolution 读取模型，但 Service 随后把每个模型重新构造成旧
`ModelProviderModelConfig`，包括旧 `modalities` 和旧 reasoning patch 结构。Subscription Provider 和 UI
继续消费这份 DTO。

这条链不会改变 Registry 的事实来源，却让旧完整 Provider Model Schema 继续成为活跃的 Service/UI 接口，
并可能诱导后续功能继续依赖旧字段。

需要讨论：

1. 闲时页面真实需要哪些字段；
2. 是否建立最小的 `OffPeakModelOption` / View，而不是返回完整 Model Config；
3. reasoning 展示应直接读取新的 Option Specs，还是由 Selection View 统一提供；
4. `ModelProviderModelConfig` 是否最终只允许出现在 legacy importer。

### 5.8 动态鉴权仍通过 Core Runtime Header 兼容链刷新

API Key Provider 可以由 Provider Config 直接保存静态访问材料。账号类型 Provider 的动态凭据不由 Config
管理；请求执行时需要由账号服务解析当前访问材料。

新的方向是由 ModelFactory 在创建 Model 时装配 `ModelRequestDependencies`。但现有账号 Provider 仍通过
Core 的 `providerRuntimeHeadersPort` 和 Model Invocation Context，在每次物理请求前刷新 Header。Title、
Compact、Memory、Verifier 和 Subagent 等支线因此需要显式传播刷新回调。

这使 Core 仍知道 Provider 鉴权生命周期，但 Account Provider 的完整改造不属于 M4。当前将其分类为后续
领域边界，而不是要求 M4 同时删除。

需要讨论：

1. Account Provider 阶段是否统一把账号 Request Auth Source 装配到 ModelFactory；
2. Core 是否只保留 Trace、Status 等调用上下文，不再持有凭据刷新能力；
3. 动态凭据刷新后是否只更新访问材料，禁止重新解析完整 Provider/Model；
4. 这项清理属于 M5、M6，还是单独的 Auth 收口阶段。

## 6. 当前确认可以保留的边界

以下结构不是本次审查要求直接删除的对象：

### 6.1 Adapter 内部 Provider SDK 实现

AI SDK、OpenAI、Anthropic 等具体客户端可以继续存在于 Adapter。业务层不能直接依赖它们，Adapter 也不能
向 Core 暴露第二套 Model Selection 或 capability 体系。

### 6.2 Adapter Execution Infrastructure

Adapter 内部可以维护 API factory、transport、签名缓存等执行基础设施，但不再维护 Provider 列表或可查询
Execution Registry。baseURL、API type、静态 Header 与 Model Config 在 Model 创建时一次性绑定，不能接受
业务层临时 Overlay 后反向成为模型事实源。

### 6.3 严格 Protocol Schema

跨进程协议需要独立的 runtime schema 校验。协议类型不必与进程内 TypeScript 类型共享同一个声明，但其
语义必须与 `ModelSelection` 对齐，不能重新引入完整 Runtime Model、Provider 快照或另一种 Options 表达。

### 6.4 一次性 Legacy Importer

Importer 可以识别已发布旧字段、旧 modalities 和历史 reasoning 配置，但转换结果必须立即进入新 Config。
旧类型不得从 importer 泄漏进 Registry、Runtime、Service View 或 UI。

## 7. 建议的逐项讨论顺序

后续讨论建议按依赖关系进行，不先把所有问题塞进同一实施分支：

1. **M4 归零门禁**：持续确认旧特殊执行符号保持为零；
2. **Core Model-only**：裁决 ModelFactory 是否成为所有可执行 Runtime 的强制依赖；
3. **Selection / Model / Identity**：明确三个概念以及 Result、Event、Telemetry 的身份表达；
4. **旧 Catalog 退役**：确认 legacy importer 的最小保留范围；
5. **能力与 wire compatibility**：逐个归类现有 modelId、Provider 和 Endpoint hardcode；
6. **Service/UI 旧 DTO 退役**：从闲时模型 View 开始消除反向投影；
7. **Account Request Auth**：在账号 Provider 阶段删除 Core Header 刷新兼容链；
8. **最终机械门禁**：把禁止重新引入旧抽象的规则固化为测试或静态检查。

第 2 至第 6 项共同构成候选的“M4 后模型抽象统一清理”。是否设为独立里程碑、如何编号，需要在逐项
裁决完成后再决定。

## 8. 候选机械验收条件

以下是当前审查提出的候选归零条件，不代表未经讨论即可执行删除：

```text
Core 中 modelAdapter                         = 0
Core 中 modelConnectionPort                  = 0
ModelPort / ModelPortOptions                  = 0
TurnExecutionModel                           = 0
ExecutionScopedModelSource                   = 0
turnRuntimeModel                             = 0
ModelRef.variant                             = 0
正常运行时中的 ModelCatalogConfig            = 0
Service/UI 正常链路中的 ModelProviderModelConfig = 0
Config 外按具体 modelId 判断模型能力          = 0
```

除此之外还需要行为验收：

- 普通会话、闲时任务、Compact、Memory、Title、Goal、Subagent、Workflow 和模型型工具全部从 ModelFactory
  获得 Model；
- 当前 Loop 只读取自己的 Active Model，不回退到 Session 默认选择或可变 Registry；
- Registry 更新只影响之后创建的 Model；
- Model Properties 是 Core 能力判断的唯一事实；
- Adapter 编码限制不会暗中覆盖 Config 的模型能力声明；
- Protocol、Telemetry 和持久化可以记录真实执行模型，但不会重新承担模型选择或配置职责；
- Legacy Config 只能单向导入，不能继续成为运行时 fallback。

## 9. 置信边界与后续维护

本次结论来自生产代码静态调用扫描、旧导出引用审计、Config/Registry/ModelFactory 调用链检查，以及对
当前 M4 工作树的只读观察。完整 `knip` 结果包含大量仓库既有噪音，因此只将经过符号级复核的结果写入
结论；“未发现静态引用”也不等于证明不存在字符串或动态导入。

M4 项已经按当前生产代码重新扫描并标记完成。其余符号数量和调用位置仍是预审快照；进入下一清理阶段前
需要重新扫描剩余生产引用，再将经过逐项裁决的结论同步到正式 design 和后续实施文档。本文件不替代正式
设计，也不把尚未讨论的建议提前固化成目标契约。
