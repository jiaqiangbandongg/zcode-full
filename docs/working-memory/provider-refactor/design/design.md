# Provider 目标设计

> 状态：当前有效设计
>
> 最近更新：2026-09-01

Provider 系统完成一件事：把目标 Environment 中的 Provider 配置、Model Config Rules 和一次
ModelSelection 转化为能够稳定封装模型 API 调用的 Model。

```text
Provider Config 路径                         Model Config 路径
====================                       =================

ZCode Built-in Provider Config             ZCode Built-in Model Config Rules
              |                                         |
              v                                         +
Account Built-in Provider Config           Personal Model Config Rules
              |                                         |
              v                                         v
Effective Built-in Provider Config         Effective Model Config Rules
              |                                         |
              v                                         |
    Personal Provider Config                           |
              |                                         |
              v                                         |
    Effective Provider Config                           |
    ├─ providerId / group                              |
    ├─ final api.type                                  |
    ├─ final endpoint                                  |
    ├─ final access                                    |
    ├─ final builtinModelIds                           |
    ├─ final modelIds                                  |
    ├─ final modelOrder                                |
    ├─ final enabled                                   |
    └─ final visibility                                |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  | providerId / modelId / api.type / baseURL
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       │  └─ per-option raw-body map
                       └─ 必要的请求编码事实
                                  |
                                  v
                    Provider / Model 完整性校验
                                  |
                                  v
                         Provider Registry
                                  |
                                  | ModelSelection
                                  v
                            ModelFactory
                                  |
                                  v
                                Model
                                  |
                                  v
                      ModelRequest -> Adapter -> API
```

左路决定最终有哪些 Provider、每个 Provider 有哪些模型、使用什么 API 和访问方式；右路决定每个
模型具有什么能力、选项如何映射为请求参数。两路在最终
`providerId + modelId + api.type + baseURL` 上汇合。

## 配置语言

Provider Config 固定按以下顺序解析：

```ts
effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

优先级是 `Personal > Account Built-in > ZCode Built-in`。Account Built-in 只处理 ZCode Built-in 已声明
的账号 Provider；其结果是 Effective Built-in Provider Config。Personal 保存用户自定义 Provider 和最终
覆盖。

普通配置项继续使用整体替代或逐叶 Overlay；Provider 模型成员因所有权不同拆成
`builtinModelIds` 与 `modelIds`，并由 `modelOrder` 表达顺序。Model Config 的 `enabled` 表达模型启用意图；同 ID
双来源时 Built-in-wins，重复后项确定性忽略；Model Config 不保存成员或可见性。完整语义见
[`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md)。

Model Config Rules 固定按以下顺序组合：

```ts
effectiveModelRules = ModelConfigRules.composeEffective(zcodeBuiltinModelRules, personalModelRules);
```

其内部顺序是 `ZCode Built-in + Personal provider-model`。Personal JSON 只保存精确 Rule，物理排列
不改变精确 Rule 最后覆盖的语义。

Rules 解析 Effective Provider Config 中的模型，不能先解析模型再追加 Account 或 Personal Provider
Overlay。`Effective` 只表示 Overlay/解析已经完成，不产生第二套公开 DTO。

完整字段、Overlay、可见性、Access、存储和迁移见
[`registry/configuration.md`](./registry/configuration.md)。

ZCode Built-in Release 的 Provider/Rule 排列、Match/Exact Rule 写作层级、Endpoint 特化、证据边界和默认
启用目录维护规范见
[`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md)。

模型历史回放、请求编码兼容与 Provider Access 产品协议的归属见
[`registry/request-compatibility-and-access-protocols.md`](./registry/request-compatibility-and-access-protocols.md)。

Model Option 值域、受限 CEL Map、原始 Request Body 注入点和唯一请求字段权威见
[`model/model-option-map.md`](./model/model-option-map.md)。

当前 Provider/Model 配置体系的完整决策叙事见
[`registry/provider-and-model-configuration-overview.md`](./registry/provider-and-model-configuration-overview.md)。该综述用于
先建立整体心智；字段精确契约仍以本设计树各专题文档为准。

## Provider Config 与凭据

Provider Config 是模型 API 调用的装配输入，可以保存静态访问凭据或稳定凭据引用；它不是统一凭据
中心，不负责所有动态凭据的生命周期，也不承担服务端最终授权裁决。

```text
api-key
└─ Config 保存静态 apiKey

zhipu-account
└─ Config 保存 family、mode
   └─ 请求期 Account Request Auth Service 从当前兼容连接解析 scope 与动态凭据
```

Request Auth 缺失时，Model/Adapter 在网络请求前返回类型化鉴权错误。账号 Token、Runtime Key、
一次性安全校验 Header、Off-Peak Ticket 等动态材料不进入 Provider Config 或 Registry View。普通 API Key
Provider 仍可以由 Personal Config 保存 API Key。

账号 Access 类别由 ZCode Built-in 声明；Account Overlay 只写入 `access.entitled`，并在服务端返回
账号模型集合时约束对应 Provider 的模型成员。
`productId`、`organizationId`、`projectId`、账号身份与动态凭据由 Account Connection Service 拥有，
在请求期按静态 `family + mode` 解析，不进入 Provider Config 或 Active Model。

同一 Family 的 Start、Individual Coding Plan、Team Coding Plan 是三个固定类型的独立 Built-in Provider。
Account Overlay 分别记录每个固定 Provider 当前是否具备套餐资格，不允许同一 Coding Plan Provider 在
Individual 与 Team 之间运行时变形，也不通过 Built-in Provider ID 字符串推断 Plan。顶层 `enabled`
始终只表达该 Provider 定义是否参与配置解析，不承担账号资格语义。

Provider 的 `visibility` 只控制用户是否能在 Settings 和 Model Selection 中看到它。Hidden Provider
仍然使用普通完整性校验、Registry 和 ModelFactory；可见性不表达鉴权或安全权限。

## 一次普通执行

用户在 Composer 选择模型并提交后：

```text
1. Entry 固定本次 ModelSelection
2. Core 原子接收完整 Submission
3. Registry 查找 Effective Provider / Model Config
4. ModelFactory 创建 Model
5. Agent Loop 持有 Active Model
6. 每个 ModelRequest 通过 Adapter 调用 Provider
7. Usage、Trace 和错误归因到实际 Model
```

Selection 只保存 `providerId`、`modelId` 和通用 Options。Endpoint、Access、模型 Properties、
Option Spec Map 和 Provider API 协议来自 Registry、ModelFactory 和请求期依赖。Config 更新只影响
后来创建的 Model，不热改正在执行的对象。

## Registry、Settings 与 Selection

Registry 保存当前 Environment 中所有完整、enabled 的 Provider，以及其中 Effective Model Config 完整且
`enabled=true` 的模型，包括 visible 与 hidden Provider：

```text
Provider Registry
├─ complete visible Provider
└─ complete hidden Provider
       |
       +--> Provider Settings Facade：只投影 visible
       +--> Model Selection Facade：只投影 visible
       `--> 内部精确 lookup/create：共用同一 Registry
```

Settings Facade 同时提供 Effective Built-in、Personal 显式字段、Effective Config、成员来源、启用状态、顺序和
完整性问题。Selection Facade 只组织 visible Provider 中 executable 的模型。Built-in/Personal 重名时只返回
Built-in candidate，后项在下一次 Provider 保存时规范化。Renderer 不读取物理配置、不重复 Overlay、成员、排序或
候选算法，也不按 modelId 推断模型能力。

完整 Registry 设计见 [`registry/registry.md`](./registry/registry.md)，设置页见
[`registry/settings.md`](./registry/settings.md)，运行装配见 [`registry/runtime.md`](./registry/runtime.md)。

## Model 执行边界

Model 是业务代码唯一使用的模型调用对象：

```text
Model
├─ providerId / modelId
├─ immutable ProviderConfig / ModelConfig / ModelOptions
├─ bind(options)
├─ generateText(request)
└─ streamText(request)
```

通常一个 Agent Loop 从开始到结束持有同一个 Active Model。Guide/“立即”是明确的 Step 切换边界；
已经发出的请求继续使用旧 Model，后续 Step 使用新 Model。Automatic Compact 使用 Loop 当前 Active
Model。Subagent 根据明确的 Selection 通过 Registry 创建自己的 Model。

输入输出能力直接来自 `Model.properties.input_format/output_format`，Config、Model、Runtime、Adapter
和协议不建立第二套 capability DTO。详见 [`model/input-output-format.md`](./model/input-output-format.md)。

## 特殊执行

特殊执行不会携带完整 ProviderConfig 或 ModelConfig，也不建立临时 Provider：

```text
Core Submission
├─ prompt / attachments / mode
├─ ModelSelection
└─ optional execution context
   ├─ Request Auth
   ├─ Ticket / attribution
   └─ Subagent Model override
             |
             v
       Registry / ModelFactory
             |
             v
       Loop Active Model
```

闲时任务根据当前账号 Family 精确使用用户不可见的 Built-in `account:zai-offpeak-idle-plan` 或
`account:bigmodel-offpeak-idle-plan`；两者都是普通、完整 Provider，不在执行时互相变形。闲时 Loop 不修改再恢复
Session Selection；Permission approve/deny 后同一个自动 Turn 继续使用 idle Model；Foreground Subagent 通过通用
override 使用 idle Selection 并创建自己的 Model。完整语义见
[`execution/execution.md`](./execution/execution.md)。

## 状态层级

```text
Composer Selection
└─ 当前草稿下一次提交的完整模型与 Reasoning 选择

App Recent
└─ 按 workspaceKey 隔离的新建 App Session 最近选择

Session Selection
└─ 当前 Session 后续普通主执行的选择

Loop Active Model
└─ 当前 Loop 真正调用的不可变 Model
```

这些状态不能互相模拟。闲时任务、Subagent 和 Background 不回写 App Recent；闲时任务也不改写
Session Selection。普通选择的 Reasoning 在 Host Selection 边界按有序档位补全为具体值；ModelFactory 只校验并
冻结 Active Model，不再拥有 Option default。详见 [`interaction/interaction.md`](./interaction/interaction.md)。

## Environment 边界

Provider Config 和 Registry 归实际执行模型请求的目标 Environment 所有：

```text
Local Environment  -> Local Config / Registry / Execution
SSH Environment    -> Remote Config / Registry / Execution
Cloud Environment  -> Cloud Config / Registry / Execution
```

这是长期所有权蓝图，不意味着 Remote Provisioning、远端设置或登录属于本次 Provider Refactor。
Desktop continuous、Mobile replayable、Queue、snapshot 和 workspace identity 也不是 Provider 语义；共享
协议变化只做不变量回归。详见 [`environment/environment.md`](./environment/environment.md)。

## 分层阅读

- [`registry/registry.md`](./registry/registry.md)：Config 如何成为 Registry 和 Model。
- [`registry/configuration.md`](./registry/configuration.md)：字段、Overlay、Visibility、Access、Rules 和存储。
- [`registry/zcode-builtin-provider-config.md`](./registry/zcode-builtin-provider-config.md)：Built-in Provider/Model Rule 的发布维护规范。
- [`registry/model-membership-and-enablement.md`](./registry/model-membership-and-enablement.md)：模型成员所有权、重名冲突、启停与 UI。
- [`registry/model-creation.md`](./registry/model-creation.md)：ModelFactory、Adapter 和请求期鉴权。
- [`model/model.md`](./model/model.md)：Model、ModelRequest、Options、生命周期和归因。
- [`interaction/interaction.md`](./interaction/interaction.md)：Submission、Session Selection 和 Active Model。
- [`execution/execution.md`](./execution/execution.md)：Compact、Subagent、Goal、Background 和闲时任务。
- [`environment/environment.md`](./environment/environment.md)：长期 Environment 所有权蓝图。

Design 只描述目标系统。迁移顺序和实施结果进入 [`../steps/steps.md`](../steps/steps.md)，当前代码事实
进入 [`../research/research.md`](../research/research.md)。
