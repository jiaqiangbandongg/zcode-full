# 03 Provider 模型成员、启停、可见性与 Registry 完备性收口

> 状态：已完成
>
> 历史说明：本 Todo 当时完成的 `builtinModelIds/modelIds` 与 Properties 完整性仍有效；Model
> `enabled/visibility`、重复成员冲突和设置交互已由
> [`Todo 21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md) 重新裁决。
>
> 日期：2026-08-24
>
> 来源审查：[`../provider-implementation-architecture-conformance-review.md`](../provider-implementation-architecture-conformance-review.md)
>
> 目标设计：[`../design/registry/model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md)、
> [`../design/registry/configuration.md`](../design/registry/configuration.md)、
> [`../design/model/input-output-format.md`](../design/model/input-output-format.md)

## 1. 目标

本任务收口 Provider Refactor 新实现中的三组同源问题：

1. 用 `builtinModelIds` 与 `modelIds` 分开表达管理模型和 Personal 模型成员，避免 Personal 保存的旧列表
   遮蔽以后新增的 Built-in/Account 模型；
2. 为 Model Config 增加 `enabled` 与 `visibility`，分别表达执行门禁和用户入口可见性；
3. 在 Resolver 向 Registry 发布时关闭 Config 稀疏边界，让 Registry、Selection、ModelFactory 和 Runtime
   只观察完整的模型事实。

```text
ZCode Built-in Provider Config
              |
              v
 overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config          ZCode Built-in Model Config Rules
              |                                           +
              v                                  Personal Model Config Rules
 overlay Personal Provider Config                         |
              |                                           v
              v                              Effective Model Config Rules
    Effective Provider Config                            |
    ├─ builtinModelIds                                   |
    └─ modelIds                                          |
              |                                           |
              +---------------------+---------------------+
                                    |
                                    v
                     source-aware Model Inventory
                     ├─ executable candidate
                     ├─ disabled / incomplete / duplicate
                     └─ Built-in candidate + Personal id-conflict diagnostic
                                    |
                                    v
                 RegistryProviderConfig / RegistryModelConfig
                                    |
                  +-----------------+-----------------+
                  |                                   |
                  v                                   v
             Selection Facade                    ModelFactory
                                                      |
                                                      v
                                          Active Model.properties
```

本任务不增加兼容 DTO、Runtime capability map、Renderer Overlay 或新的配置权威。

## 2. 已确认决策

### 2.1 模型成员字段

Provider Config 使用两个字段：

```ts
interface ProviderConfig {
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
}
```

正常装配遵循以下心智模型：

| 配置来源                         | 通常维护的字段    | 语义                                       |
| -------------------------------- | ----------------- | ------------------------------------------ |
| ZCode Built-in Provider Config   | `builtinModelIds` | ZCode 声明的 Built-in 模型及顺序           |
| Account Built-in Provider Config | `builtinModelIds` | 账号接口提供时覆盖 Built-in 模型集合       |
| Personal Provider Config         | `modelIds`        | 用户添加、删除、重命名和排序 Personal 模型 |

这是字段含义和代码维护原则，不是权限系统。本任务不建立 Source 专用 Provider Config 类型、严格 Source
Schema、跨层字段拒绝逻辑或 Config Service 来源权限检查。

Resolver 保留两个集合，并按 Built-in 在前、Personal 在后的顺序生成成员 Inventory。Personal-only Provider
自然使用空的 `builtinModelIds`；设置页只修改 `modelIds`，不提供删除或重排 Built-in 成员的交互。

字段在 Config Overlay 中保持三态，在 Inventory 边界归一化：

```text
undefined = 本层不覆盖
null      = 本层显式清空该来源集合
array     = 本层提供成员和顺序

最终缺失或 null -> Inventory 中的 []
```

因此空集合合法，不属于 Provider 配置不完整；Personal-only Provider 不必持久化无意义的
`builtinModelIds: []`。Model ID 在写入边界 trim，空值非法，Registry 身份使用大小写敏感的精确字符串。

当前分支的 Provider Config Schema 尚未发布，不存在内部 `models[]` 的 v1 → v2 兼容任务：

- 直接把当前领域 Schema、`official.json`、Personal 写入和测试 fixture 改成最终字段；
- 不增加相邻 schema migration，不双读当前开发中的 `models[]`；
- 已存在的重构前 legacy importer 直接输出最终字段；它不构成当前 Provider Config 的版本历史。

### 2.2 同 ID 冲突

同一个 Provider 的 `builtinModelIds` 与 `modelIds` 含有相同 ID 时形成 `id-conflict`：

- 不静默删除 Personal 冲突，但执行身份采用 Built-in-wins；
- Built-in X 继续解析、进入 Registry、Selection/fallback 和 ModelFactory；
- 解析时只排除冲突 Personal X 所拥有的精确 Rule，其他通用 Personal Rules 继续参与；
- Provider Settings 显示冲突，用户通过重命名 Personal 模型或删除 Personal 模型解决；
- 已保存 Selection 指向 X 时继续解析为 Built-in X。

普通模型选择器不展示特殊冲突诊断项，不为 Automation、Subagent、Repo Wiki 增加占位候选，也不扩张
Selection Protocol 来承载 Settings 跳转信息。

单个集合内部重复 ID 形成 `duplicate-membership`：不静默去重，重复 ID 合并为一个 Settings 诊断项，
修复前不解析、不选择、不执行；同 Provider 其他模型继续工作。成员重复和跨集合冲突都是 Model 级问题，
不能进入 Provider 通用完整性 issues 后拖死整个 Provider。

### 2.3 Model `enabled` 与 `visibility`

Model Config 顶层增加稀疏 Overlay 字段：

```ts
interface ModelConfig {
  enabled?: boolean | null;
  visibility?: "visible" | "hidden" | null;
  // properties / optionSpecs / reasoningMapping
}
```

Built-in 通用 Rule 提供 `enabled=true`、`visibility="visible"` 完整默认值，Personal Rule 可以覆盖或恢复
继承。Effective 两个字段都必须完整。

`enabled=false` 表示模型被用户停用：

- Settings 仍显示并允许编辑、重新启用；停用期间不能测试；
- 不进入选择候选、默认选择或 fallback；
- 不进入 Registry 可执行索引，精确 ModelFactory 创建和内部任务不能绕过；
- 已经创建的 Active Model 不因 Config 更新中途终止，后来创建的 Model 遵守新状态。

Model `visibility` 与 Provider visibility 对称：只过滤用户 Settings/Selection Facade，不阻止完整、enabled
模型进入 Registry 或被内部精确创建。成员关系、Provider/Model visibility、Provider/Model enabled、
完整性和账号授权是不同基础事实，不能互相推导；`executable` / `selectable` 是 Resolver 派生结果。

### 2.4 Settings 只提交稀疏 Personal Overlay

Settings View 返回 Effective 基线、Personal 显式配置、Resolver 计算的 Inventory、冲突和完整性问题。
Renderer 只维护 Personal Draft，不复制 Overlay、成员组合或冲突算法，也不把 Effective Config 反向投影成
Personal Config。

删除正常设置链中的 `saveEffectiveProvider()` / Effective → Personal 反向投影；Legacy importer 可以在
自己的读取边界使用一次性差异投影，不进入正式保存协议。

正常候选的 Renderer Draft 只复制稀疏 Personal Config；Effective Config 只是只读继承基线。用户首次修改
某配置项时才物化该项，恢复默认删除 Personal 字段。冲突候选没有普通 Effective Draft，只提供只读
Built-in 候选摘要、旧 Personal 精确配置和两个原子解决操作。

## 3. Registry 完整类型边界

### 3.1 稀疏只存在于配置输入

```text
稀疏 Model Config Rule
├─ undefined = 本 Rule 不覆盖
├─ null      = 本 Rule 显式清除
└─ value     = 本 Rule 提供值
             |
             v
       resolve + validateComplete
             |
       +-----+------------------+
       |                        |
       v                        v
Settings candidate       Registry publish
允许不完整并带 issues     只接收完整类型
```

以下字段在 Registry 及下游必须完整：

- Model `enabled`；
- Model `visibility`；
- `contextWindow`；
- `input_format` 的 Text/Image/Video/Audio/PDF boolean；
- `output_format.support_text`；
- `supportsToolCall`、`supportsJsonSchemaOutput`、`supportsNativeWebSearch`、
  `supportsMidConversationSystem`；
- `optionSpecs.maxOutputTokens`；
- Reasoning Spec 存在时非空、default 在 values 中，且每个公开 level 有 Mapping；顺序与避免重复由配置发布者负责。

Reasoning Mapping 可以保留未出现在公开 values 中的 `disabled`、`off`、`nothink`、`none` 等执行映射。

### 3.2 Registry 类型

保留现有稀疏 `ProviderConfig`、`ModelConfig` 作为 Overlay 类型。新增的只是 Registry 发布类型：

```ts
interface RegistryProviderConfig extends ProviderConfig {
  readonly access: CompleteProviderAccessConfig;
  readonly api: CompleteProviderApiConfig;
}

interface RegistryModelConfig extends ModelConfig {
  readonly enabled: boolean;
  readonly visibility: "visible" | "hidden";
  readonly properties: RegistryModelProperties;
  readonly optionSpecs: RegistryModelOptionSpecs;
}
```

它们不是新 Config Source、持久化 Document、Overlay 层或 Runtime DTO。`requireComplete` 成功后返回同一个
Effective Config 对象，只收紧静态类型，不复制一份新的配置事实，也不额外增加深层 freeze。

完整类型必须同时收紧序列化返回值。不能让继承的稀疏 `toJSON(): ModelConfigObject` 把 optional
Properties 再泄漏给 Selection/Protocol；实现应覆盖完整返回类型或提供唯一 `toRegistryJSON()`，但不复制
第二份配置权威。

Provider Registry 发布 `enabled=true` 且完整的 Model，包括 hidden 和与 Personal 重名的 Built-in Model；
Settings Resolution 保留 disabled、incomplete、duplicate 和暂停的 Personal conflict。Registry 后的消费者
不能再观察 optional Properties 或 Option Specs。

Provider 完整性只收紧执行所需事实：合法 Access 分支、API Type 和非空 Endpoint。`label`、`logoUrl`、
`visibility`、Headers 等合法可选字段继续保留原语义；成员集合已经投影为 Registry `Provider.models`，执行
消费者不重新读取成员字段决定成员资格。

Todo 03 只按开工时已经存在的 Provider Access Schema 建立这条唯一完整性边界。Todo 07 引入结构化 Account
Connection 时，在同一个 `CompleteProviderAccessConfig` / `requireComplete` 上加强 `zhipu-account`；本任务
不提前实现 connection，也不宣称 Account Access 已经最终收口。

### 3.3 Settings candidate 是分支契约

```ts
type ProviderModelSettingsItem =
  | {
      kind: "candidate";
      modelId: ModelId;
      source: "builtin" | "personal";
      effectiveConfig: CompleteModelConfigObject;
      personalConfig?: ModelConfigObject;
      effectiveEnabled: boolean;
      effectiveVisibility: "visible" | "hidden";
      providerEnabled: boolean;
      providerVisibility: "visible" | "hidden";
      personalMembershipConflict?: {
        kind: "id-conflict";
        personalExactConfig?: ModelConfigObject;
      };
      issues: readonly ProviderConfigIssue[];
      executable: boolean;
      selectable: boolean;
    }
  | {
      kind: "membership-conflict";
      modelId: ModelId;
      sources: readonly ("builtin" | "personal")[];
      conflict: "duplicate-membership";
      personalExactConfig?: ModelConfigObject;
      issues: readonly ProviderConfigIssue[];
      executable: false;
      selectable: false;
    };
```

跨集合重名是 Built-in candidate 上的 `personalMembershipConflict`，Built-in 仍有真实 Effective Config；
单集合重复才使用不可执行冲突分支。Provider/Model enabled、visibility、完整性和成员身份是基础事实，
`executable` / `selectable` 是派生结果；UI 可以派生主标签，但领域层不压成唯一 `status`。

### 3.4 下游删除的未知态

正式主链删除：

```ts
properties?.input_format?.support_image ?? false;
properties?.input_format?.support_text ?? true;
input_format?: ModelInputFormat;
properties?: ModelProperties;
if (allPropertiesPresent) protocol.properties = properties;
```

同时删除：

- Bootstrap 的 `requireCompleteProperties()`、`requireCompleteOptionSpecs()` 和 Provider 必填字段重复证明；
- Selection/Protocol 对完整 Properties 的静默省略；
- Settings 从缺失 Effective Property 补 `true/false`；
- Runtime capability map，以及按 Catalog、Provider 类型、Endpoint 或 modelId 推断能力的 fallback。

一次性 legacy importer 可以解析任意旧 JSON，但只能迁移旧文件明确表达的事实；没有声明的能力不写
Personal Override，继续由 Built-in Rule 补齐。Importer 不能使用迁移专用能力常量或按模型名、Provider、
Endpoint 猜值。

## 4. Todo 02/03 分工

Todo 03 负责业务 Provider Registry 的事实完整性：

- 最终成员字段、Inventory、冲突和 Model `enabled` / `visibility`；
- `RegistryProviderConfig` / `RegistryModelConfig`；
- Resolver 发布门禁；
- Settings、Selection、Protocol 和 ModelFactory 消费完整或诊断视图；
- 删除 Bootstrap 对业务 Registry Config 的重复完整性证明；
- 切断新 Provider/Model 主链对能力 fallback 的依赖。

Todo 02 负责 Adapter 内旧执行 Registry 的物理退役：

- 可变 Provider map 与 revision subscription；
- `replaceRegistryConfig()`；
- Adapter Registry 的默认 Provider、裸 Model ID fallback 和 Connection 反向查询；
- Adapter 私有旧类型、资源和生命周期。

Todo 03 可以让旧 Adapter Registry 暂时继续存在，但它只能接收业务 Registry 已验证的完整事实。Todo 03
不把 Todo 02 的旧 Registry 字段搬进新业务抽象。

## 5. 实施范围

### Step A：Config 与成员 Inventory

- 将当前 `models` 字段直接替换为 `builtinModelIds` / `modelIds`；
- 更新 Official、Account、Personal 正常装配和 legacy importer 的最终输出；
- 增加 Model Config `enabled` / `visibility`，由 Built-in 通用 Rule 补齐默认；
- Resolver 在 Inventory 边界把缺失/null 集合归一化为空数组，组合成员并检测单集合重复和跨集合同 ID
  冲突；Account 投影不提前去重；
- 跨集合重名发布 Built-in 身份，并排除冲突 Personal 精确 Rule；单集合重复不进入 Registry。

### Step B：完整类型与 Registry

- 在 Provider 包定义 Registry 完整类型和唯一 `requireComplete` 边界；
- 完整类型的 JSON/Protocol 序列化返回完整静态类型，不重新暴露稀疏 Config；
- 保留 Settings diagnostics，Registry 接纳完整、启用的 Built-in/Personal 模型及 hidden 模型；
- Registry/ModelFactory 精确创建、Selection 和 fallback 共享同一索引门禁；
- 删除 Bootstrap 的重复证明、non-null fallback 和静默省略。

### Step C：Settings、Protocol 与 UI

- Settings View 在正常 Built-in candidate 上附加 Personal 重名冲突；单集合重复使用冲突分支；分别返回
  Provider/Model enabled、visibility、issues 和派生门禁；
- 删除 Effective → Personal 正常保存入口，保存接口直接提交稀疏 Personal Overlay；
- `builtinModelIds` 在 UI 只读，`modelIds` 支持新增、删除、重命名和排序；
- `renamePersonalModel()` 只按 Personal `modelIds` 判断所有权，并与精确 Rule 原子移动；新增
  `deletePersonalModel()` 原子删除成员与其精确 Rule；
- enabled 开关保存 Personal 精确 Rule，恢复默认删除该叶子；
- Provider 页面保持 Built-in 运行状态和测试，配置编辑在冲突期只读，并提供 Personal 冲突解决；选择器
  继续提供正常 Built-in，排除 disabled/hidden；
- Connectivity Test 使用模型 `executable` 门禁，不能只检查 Settings 列表中是否存在 ID；
- 正常 Protocol Model Option 的 input/output Properties 必填；
- Settings Draft 从完整 Effective Properties 初始化，隐藏 PDF/Audio 原样保留。

### Step D：Runtime 主链清理

- Registry Model 到 ModelFactory 的 Properties 全程必填；
- Active Model 原样持有完整 Properties；
- 正常请求、Compact、Memory、Subagent、闲时和 Adapter 编码只读取 Active Model；
- 删除新主链的 Catalog/runtime 能力合并和 `?? true/false`；
- Video 仍同时受 Model Property 和 Adapter 编码能力约束；Audio 不因此获得未实现的编码入口；
- Adapter 旧 Registry 的物理退役由同步实施的 Todo 02 完成。

## 6. 测试先行

### 6.1 Config 与 Inventory

1. Built-in/Account 更新 `builtinModelIds` 后，Personal `modelIds` 保持不变；
2. Personal-only Provider 使用 `modelIds`，空 Built-in 集合正常工作；
3. 两个集合保持各自顺序，最终 Inventory 为 Built-in 在前、Personal 在后；
4. 单集合重复 ID 产生不可执行 `duplicate-membership`；双集合同 ID 发布 Built-in 并暂停 Personal；
5. 当前未发布的 `models` 字段不被正式 Schema 双读；legacy importer 直接输出最终字段；
6. Config JSON round-trip 保留空集合、null 和稀疏 Rule；Inventory 把最终缺失/null 集合归一化为 `[]`；
7. Model ID trim 后精确、大小写敏感；Account 模型列表不静默去重。

不测试“某 Source 写入另一字段必须报错”，因为成员归属是正常代码维护原则，不是 Source 权限系统。

### 6.2 Resolver、Registry、enabled 与 visibility

1. 双来源重名时 Built-in X 继续解析、选择和创建，冲突 Personal 精确 Rule 不参与；
2. `enabled=false` 模型保留在 Settings，但不进入 Selection、fallback 或精确创建；
3. 恢复默认后重新继承 Built-in `enabled` / `visibility`；hidden 可内部精确创建但不进入用户 Facade；
4. Model 缺任一必填 Property/Option 时不进入 Registry；
5. Provider 缺 Access/API/Endpoint 时不进入 Registry；
6. Registry 公开类型静态表达完整 Config；Config 更新只影响后来创建的 Model；
7. Reasoning Mapping 覆盖全部公开 level，并允许保留额外 disabled 映射。

### 6.3 Settings、Protocol 与 Runtime

1. Settings 返回 candidate/conflict 分支和正交门禁事实，UI 派生 ready、disabled、incomplete、conflict，
   并只提交稀疏 Personal Overlay；
2. Built-in 不显示删除/拖动；重名时 Built-in 配置只读但可测试，冲突 Personal 可原子重命名或删除；
3. Personal 冲突只在 Settings 解决，不形成普通候选；已有 X Selection 继续指向 Built-in X；
4. enabled 自动保存、失败回滚、恢复默认；disabled/incomplete/duplicate 禁用测试，重名时测试 Built-in X；
5. Protocol 正常候选始终携带完整 input/output Properties；
6. UI 不为缺失能力补默认，PDF/Audio 隐藏字段在编辑后保留；
7. 普通请求、Compact、Memory、Subagent、闲时模型均读取本轮 Active Model Properties；
8. Image/PDF/Video 允许与拒绝保持一致，Audio 不误触发未实现编码。

Desktop、Web、手机共用同一 Settings/Selection Service；本任务不改变 remote workspace 配置同步产品能力，
也不改变 continuous/replayable、队列、恢复或 workspace identity。

## 7. 非目标

- Account availability 的 `unknown` 与 last-known-good；
- 账号鉴权、Request Auth 和 Credential 生命周期；
- Todo 07 的结构化 Account Connection，以及 `zhipu-account` 最终完整性加强；
- Telemetry、ModelRef、ModelConnectionPort 清理；
- remote workspace 配置同步产品能力；
- `modelContextBudget.strategy`、队列和恢复；
- Audio 内容块、附件入口或 Provider 编码实现。

## 8. 完成条件

机械归零：

```text
正式 Provider Config 中 models[]                                      = 0
当前未发布 Provider Config 的 schema migration                         = 0
Source 专用 Provider Config 类型/跨层权限校验                           = 0
Effective/Registry Model 的 enabled optional                           = 0
Effective/Registry Model 的 visibility optional                        = 0
Registry/Selection/Protocol/Runtime 的格式能力 optional                 = 0
正式执行链 support_* 的 ?? true / ?? false                              = 0
Settings 从缺失 Effective Property 补默认值                             = 0
Registry 后重复 requireCompleteProperties                              = 0
Bootstrap 对 Registry Provider Config 重复 requiredString/字段校验       = 0
Renderer 计算 Overlay、成员冲突或 Effective -> Personal                  = 0
成员列表进入 Inventory 前静默 Set 去重                                  = 0
Settings 为暂停的 Personal 冲突伪造第二份 Effective Model Config         = 0
完整 Registry Config 序列化返回 optional Properties                     = 0
普通模型选择器冲突诊断候选                                              = 0
Legacy importer 为缺失能力补兼容常量或运行时推断                        = 0
```

行为验收：

- Built-in/Account 新增模型不被旧 Personal 成员列表遮蔽；
- 用户可以管理 Personal 模型，并通过 Model `enabled` 停用 Built-in 模型；
- 同 ID 重名时 Built-in 继续执行，冲突 Personal 精确 Rule 暂停且只在 Settings 解决；
- 单集合重复只隔离对应 ID，不拖死 Provider；
- Model visibility 与 Provider 对称，只影响用户 Facade，不改变 Registry 执行资格；
- 稀疏只存在于 Rule、Personal Overlay 和 Settings draft/candidate；

## 9. 实现结果

- Provider 成员已改为 `builtinModelIds` / `modelIds`，Account 只约束 Built-in 集合，Personal 只维护用户集合；
- Resolver 已实现 source-aware Inventory：跨集合重名保留 Built-in 执行身份并暂停 Personal 精确 Rule，
  单集合重复只隔离对应模型；
- Model `enabled` / `visibility`、完整 Registry 类型和唯一完整性门禁已经落地；Registry 后的 Model、
  Selection 与协议不再接受可选格式事实；
- Settings 已改为直接编辑稀疏 Personal Overlay。Built-in 成员不能删除或调序；冲突 Personal 成员只能
  原子重命名或删除；模型 enabled 可以覆盖并恢复继承；
- Legacy importer 只迁移旧文件显式声明的成员、格式、限制和 reasoning 映射，不再按模型名、Provider 类型
  或 Endpoint 推断能力；
- Config 更新只影响后来创建的 Model，已创建 Model 继续持有创建时的完整静态事实。
- Registry、Selection、ModelFactory 和 Runtime 只观察完整模型事实；
- 已创建 Model 不被 Config 更新热改；
- 同步实施的 Todo 02 已删除 Adapter Registry 抽象；Todo 03 没有把其字段或查询面复制进业务 Registry。

## 10. 验证

至少执行：

```bash
pnpm test:unit:affected
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm knip
```

UI 改动还需执行 Provider Settings/Model Selection 相关 Desktop E2E，并验证手机 Web 响应式布局。使用
`pnpm dep:refs` 与 `rg` 复核 optional capability、Catalog fallback、旧 `models[]` 和 Effective → Personal
入口是否归零。若全量 `knip` 含仓库既有噪音，仍需独立记录本任务相关符号的审计结果。
