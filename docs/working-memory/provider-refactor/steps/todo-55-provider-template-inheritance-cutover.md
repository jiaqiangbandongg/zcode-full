# Todo 55：Provider Template 继承与普通 Built-in Provider 退役

> 状态：已完成
>
> 日期：2026-09-01
>
> 取代范围：Todo 49/50/51 中关于普通 Built-in Provider placement、Family 固定“按量 API”槽位、Welcome
> 固定 API Provider Overlay 与 Provider 顶层 `enabled` 的阶段性设计。Z.ai/BigModel Account Family、
> Account Access、`entitled`、请求期凭据和 Off-Peak 鉴权边界继续有效。

## 0. 当前裁决速览

- Provider Template 不是 Provider，只是创建 Personal Provider 时引用的 Built-in 配置基线；同一 Template
  可以创建多个独立实例。
- 全部非 Account Built-in Concrete Provider 退役；Z.ai API、BigModel API 与其他第三方供应商一起改为
  Provider Template。
- Z.ai/BigModel Family 继续保留，但只组织 Start、Individual、Team、Off-Peak Account Provider；不再包含
  “按量 API”连接项。
- Account Provider 的定义由 Built-in Release 提供，并固定进入对应 Family 的 Settings 结构；用户不负责创建或
  删除它们。Account Overlay 的 `access.entitled` 只决定当前账号是否拥有访问资格。
- Provider 顶层 `enabled` 已最终裁决为彻底删除；Settings placement、账号权益、配置完整性和 Model
  `enabled` 各自表达单一事实。
- Account Access 的身份字段本轮确定由 `access.family` 改名为
  `access.accountType = "zai" | "bigmodel"`；现有 Provider Family 产品结构继续保留。
- Welcome 中每次选择 Z.ai/BigModel API Key 并提交，均从相应 Template 创建一个新的 Personal Provider
  实例并写入 Key；不查找、复用或维护所谓 canonical API 实例。
- Template 实例创建统一复用通用 `createPersonalProvider`，Provider、初始 Personal Overlay、唯一 label 与
  `providerOrder` 在一次 Repository 更新中原子写入；Welcome 不拥有专用 Provider 创建接口。
- 账号登录只处理 Account Provider，不创建按量 API Personal Provider；`providerSetupCompleted` 只控制自动
  引导是否再次出现，不参与 Provider 创建去重、Registry 或 Family Selection。
- Settings 不把 Template 继承来源与 `effectiveBuiltinConfig` 合并成同一个概念；`templateConfig`、
  `effectiveBuiltinConfig`、`personalConfig` 与 `effectiveConfig` 各自保留准确语义。
- Provider 级 `enabled` 字段、Facade DTO 和“已启用”胶囊一并删除；不得用 `executable`、`entitled` 或 API Key
  是否存在伪装成新的 Provider enabled。

### 0.1 术语边界

| 名称                      | 唯一含义                                                      |
| ------------------------- | ------------------------------------------------------------- |
| Provider Template         | Built-in 发布的 Provider 配置继承来源；不能直接执行           |
| Account Concrete Provider | Built-in 发布的账号产品 Provider；由 Account Overlay 约束     |
| Personal Provider         | 用户创建的真实 Provider 实例；具有唯一 `providerId`           |
| Personal Provider Overlay | 用户对真实 Provider 实例保存的稀疏配置                        |
| Effective Provider Config | Resolver 组合全部适用来源后供 Registry 使用的最终配置         |
| Account Family            | Z.ai/BigModel 账号产品的 Settings 导航与连接选择边界          |
| `access.entitled`         | 当前账号是否拥有对应 Account Provider 的访问资格              |
| executable                | Provider/Model 当前是否配置完整且满足执行条件的 Resolver 结果 |

Template、Family、entitlement、Settings placement 与 executable 互不替代。

## 1. 目标与不变量

普通第三方供应商不再以“尚未添加但已经存在”的 Built-in Concrete Provider 发布。它们改为可复用的
Provider Template；用户从同一 Template 创建一个或多个具有独立 `providerId` 的 Personal Provider。

```text
Provider Template
├─ DeepSeek
├─ Moonshot Kimi
├─ MiniMax
└─ ……
        |
        | 创建 Personal 实例；不复制官方配置事实
        v
Personal Provider
├─ providerId = deepseek-work
├─ templateId = deepseek
└─ Personal Overlay
        |
        v
Effective Provider Config
        |
        v
Provider Registry
```

Template 不是 Provider：它不进入 Registry、模型选择或已创建 Provider 列表，没有运行时 `providerId`，
也不能直接执行。Template 只是 Provider Config 的 Built-in 继承基线。

本轮保留 Z.ai/BigModel Family，但将其职责收窄为只组织 Account Provider；按量 API 与 Family 解耦：

```text
Z.ai Account Family                      BigModel Account Family
├─ Start Plan                            ├─ Start Plan
├─ Individual Coding Plan                ├─ Individual Coding Plan
├─ Team Coding Plan                      ├─ Team Coding Plan
└─ Off-Peak                              └─ Off-Peak

普通 Provider Templates
├─ Z.ai API
├─ BigModel API
├─ DeepSeek
├─ Moonshot Kimi
└─ ……
```

因此：

- `zai-api`、`bigmodel-api` 从固定 Built-in Concrete Provider 迁入 Provider Templates；
- 两者和其他 Template 一样进入普通“添加供应商”菜单，允许创建多个 Personal Provider 实例；
- Start、Individual、Team、Off-Peak Account Provider 继续由对应 Family 组织；
- 保留 `ProviderFamilyDomain`、Account Family Header/Connection UI、套餐、额度、升级、账号凭据与 Off-Peak
  消费链路；
- `ProviderFamilyConnectionSelection` 删除 `kind: "api-key"` 分支，只保留 Start、Individual、Team Account
  选择；
- 本轮不新增 `family: "zhipu" | "others"`，设置页继续使用现有分组结构；
- 不把“保留 Family”解释成保留旧的、已经删除的 `oauth | apiKey` 平行 mode helper。正式连接选择仍以
  收窄后的 Account `ProviderFamilyConnectionSelection` 为准。

## 2. Config 与 Built-in Release

### 2.1 复用现有 Provider Config 值结构

不增加另一套完整的 `ProviderTemplateConfig` 值对象。Template Map 的值直接复用
`ProviderConfigOverlay`；Built-in Concrete Provider、Provider Template 与 Personal Provider 共享同一套字段
Schema、Overlay、嵌套 API/Access Config 和 JSON round-trip。

```ts
type ProviderTemplateMap = ReadonlyMap<TemplateId, ProviderConfigOverlay>;
```

这里单独存在的是以 `templateId` 为键的 Map 容器，不是第二套 Provider Config 值类型。

Provider Config 增加：

```ts
readonly templateId?: string | null;
```

本轮不增加新的展示 `family` 字段。现有 `ProviderGroup` 暂时保留：

- `zai-family`、`bigmodel-family` 继续只表达 Account Provider 的 Family 配置归属；
- Template 创建的普通 Personal Provider 继续进入现有 Personal Provider 分组；
- 普通 Built-in Concrete Provider 清零后，`standard-builtin` 随对应旧生命周期一起删除；机械扫描只用于证明
  零残留，不再决定是否保留；
- 不在本轮另起“智谱 / 其他”分栏或重新命名现有 Family。

复用同一个值结构不代表 Template 获得 Provider 身份。Template、Built-in、Account 与 Personal Source
分别使用严格 Source Schema；各 Source Schema 可以从共享字段 Schema 扩展或收窄，解析后统一构造
Provider Config。

Template Source Schema 必须从共享 Overlay Schema 收窄，而不是直接接受任意 Provider Overlay 字段：

```text
允许
├─ label / logoUrl
├─ api（type / baseURL / headers）
├─ access 的官方静态结构与 apiKeyManagementUrl
└─ builtinModelIds

拒绝
├─ templateId（Template 不递归继承）
├─ group
├─ modelIds / modelOrder
├─ enabled / visibility
└─ 真实 apiKey、entitled、账号凭据或请求期材料
```

- API Key Template 没有真实 API Key 是正常状态；
- Template 只做 Source 结构校验，不调用面向最终可执行 Provider 的完整性校验；
- Template 的官方成员只使用 `builtinModelIds`，用户成员仍只存在于 Personal Provider 的 `modelIds`；
- Template Map 的 JSON 书写顺序就是 Settings 创建菜单顺序，本轮不增加另一套 Template order 字段。

Template 集合使用以 `templateId` 为键的独立 Map；Provider 集合继续以 `providerId` 为键。两个容器复用
内部 Provider Config Overlay，但容器 API 和变量名必须明确区分 Template ID 与 Provider ID。

### 2.2 Built-in Release 结构

```ts
interface ZCodeBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ZCodeBuiltinModelConfigRules;
}
```

```text
providers
├─ Start / Individual / Team Account Provider
└─ Off-Peak Account Provider

providerTemplates
├─ Z.ai API / BigModel API
├─ DeepSeek
├─ Moonshot Kimi
├─ MiniMax
└─ 其他普通第三方供应商
```

- `providerTemplates` 不是 Catalog，不引入市场、发现、安装或独立版本语义；
- `providers`、`providerTemplates` 与 `modelConfigRules` 属于同一个 Built-in revision；
- 三者共同解析、共同发布、共同 Active/LKG 回退，禁止分版本应用；
- `zai-api` / `bigmodel-api` 的固定 Concrete Provider 身份和 Family 槽位退出；对应字符串可以继续作为稳定
  Template ID，但不能继续作为运行时固定 Provider ID；
- Family 与 Template 不建立桥接关系：Family 解析 Account Provider，Template 创建 Personal Provider。

### 2.3 Provider Overlay 顺序

Resolver 先按正常 Overlay 语义得到 Concrete Provider 的 Effective `templateId`，再组装配置：

```text
Provider Template
        |
        v
Built-in Concrete Provider
        |
        v
Account Overlay
        |
        v
Personal Overlay
        |
        v
Effective Provider Config
```

三类实际路径：

```text
Template 创建的 Personal Provider
└─ Template -> Personal

可选继承 Template 的 Built-in/Account Provider
└─ Template -> Built-in -> Account -> Personal

完全自定义 Personal Provider
└─ Personal
```

Built-in Provider 的 `templateId` 约定由 Built-in Source 声明，Personal-only Provider 的 `templateId` 约定由
Personal Source 声明；不新增 Source 所有权门禁。Personal 显式值与 `null` 继续遵循普通 Overlay
覆盖/清除语义。

Template 自身不递归继承 Template。Resolver 只读取 Concrete Provider 的 Effective `templateId`，不继续解释
Template 值中的 `templateId`，避免引入继承图、循环检测和多级解析器。

Template 与 Concrete Provider 的 Access 判别可以不同。后一层 Access discriminant 不同时，继续使用现有
`overlayProviderAccess()` 的整体替换语义。

Resolver 和 Settings 必须保留下面四类事实，不能用一个含义模糊的 `inheritedConfig` 替代：

```text
templateConfig?
└─ templateId 指向的官方 Template Overlay；不含 Concrete/Account/Personal

effectiveBuiltinConfig?
└─ 仅 Concrete Built-in Provider 路径存在
   └─ 若它引用 Template，则是 Template -> Built-in -> Account 的结果；不含 Personal

personalConfig?
└─ 当前真实 providerId 对应的 Personal 稀疏 Overlay

effectiveConfig
└─ 最终 Effective Provider Config
```

因此，Template 创建的纯 Personal Provider 有 `templateConfig`、`personalConfig` 和 `effectiveConfig`，但没有
`effectiveBuiltinConfig`；完全自定义 Personal Provider 可以只有 `personalConfig` 与 `effectiveConfig`。继承是
Resolver 的组合关系，不是新增的持久化 Config Source。

这里描述的是 Provider Settings Provider View。Model Settings View 原有的 `effectiveBuiltinConfig` 仍表示
Built-in Model Rules 解析出的无 Personal Rule 基线；即使模型属于纯 Personal Provider，该模型基线也可能存在，
不能因为 Provider 层没有 `effectiveBuiltinConfig` 而删除或伪造 Model 层事实。

`templateId` 只参与 Config Resolver、Model Rule 和 Settings baseline。Effective Config 产生后，
Registry、Selection、ModelFactory、Adapter 与请求协议不依赖 Template ID；正式执行始终使用真实
`providerId`、Effective API 与 Effective Access。

### 2.4 Provider 顶层 `enabled`

Provider 顶层 `enabled` 已最终裁决为彻底删除，不保留兼容字段或阶段性双读。它原有的 placement 职责随普通
Built-in Provider 生命周期一并退役：

- Template 本身不需要 Provider `enabled`；
- Personal Provider 的定义存在，即表示用户已创建该实例并在 Settings 中可见；
- API Key、Endpoint 等配置可以暂时不完整，实例仍可保存并留在 Settings，但不会成为可执行 Registry
  Provider；
- Account Provider 固定出现在各自 Family，不再依赖 Provider `enabled` 表达 placement；
- Account `access.entitled` 继续只表达当前账号是否拥有对应访问资格；
- Model Config 的 `enabled` 保留，继续控制具体模型。

这里的“Account Provider 固定出现”只描述定义来源和 Settings placement：Built-in Release 声明 Account
Provider 身份及其所属 Family，用户不创建、不删除。它不表示该 Provider 必然可执行；Account Overlay 仍需
提供当前账号事实，最终由 `entitled` 与配置完整性共同决定是否进入可执行 Registry。

```text
Settings placement
├─ Account Provider：Family 结构声明
└─ Personal Provider：Personal 定义存在

Executable
├─ Effective Provider 配置完整
├─ Account Provider 还需 access.entitled
└─ 目标 Model enabled 且完整
```

`enabled` 删除必须一次收口 Resolver、Config Service、Facade、Settings 与测试，不能保留第二套 placement
fallback。

## 3. Model Config Rules

### 3.1 Template 精确 Rule

在现有 `match | provider-model` Rule union 中增加：

```ts
interface TemplateModelConfigRule {
  readonly type: "template-model";
  readonly templateId: string;
  readonly modelId: string;
  readonly config: ModelConfig;
}
```

```text
match
└─ 按 provider/model/api/baseURL 等通用事实匹配

template-model
└─ 按 templateId + modelId 匹配 Template 官方默认值

provider-model
└─ 按真实 providerId + modelId 匹配 Concrete Provider/实例
```

Resolution Input 增加可选 `templateId`，不能把 Template ID 冒充成 Provider ID：

```ts
modelRules.resolve({ providerId, templateId, modelId, apiType, baseURL });
```

### 3.2 Rule 按配置字段分层

不同 Rule 类型不依靠一个混合 JSON 数组的偶然位置表达跨层优先级：

```ts
interface ZCodeBuiltinModelConfigRules {
  readonly matchRules: readonly MatchModelConfigRule[];
  readonly templateModelRules: readonly TemplateModelConfigRule[];
  readonly providerModelRules: readonly ProviderModelConfigRule[];
}

interface PersonalModelConfigRules {
  readonly matchRules: readonly MatchModelConfigRule[];
  readonly providerModelRules: readonly ProviderModelConfigRule[];
}
```

每个字段内部仍严格按书写顺序 Overlay。Source Decoder 只按字段固定顺序连接成现有
`ModelConfigRules` 有序序列；Resolver 继续逐条遍历，不增加按 Rule type 动态排序、分桶或优先级推断。

```text
Built-in match
        |
Built-in template-model
        |
Built-in provider-model
        |
Personal match
        |
Personal provider-model
        v
Effective Model Config
```

- Template 官方差异写 Built-in `template-model`；
- Account Concrete Provider 的官方差异继续写 Built-in `provider-model`；
- 用户编辑具体实例只写 Personal `provider-model`；
- Personal Source 不接受 `template-model`，避免用户修改共享 Template 基线；
- Personal 精确 Rule 写入 API 继续只操作 `providerModelRules`。

### 3.3 模型成员与启停

不增加 Template 专属 `models: [{ modelId, enabled }]` 或第二套 Model Config：

```text
Template.builtinModelIds
└─ Built-in Source 拥有的模型成员与初始物理顺序

Built-in template-model.config.enabled
└─ Template 实例中模型的官方默认启停

Built-in provider-model.config.enabled
└─ Account Concrete Provider 的官方默认启停

Personal provider-model.config.enabled
└─ 用户对真实 Provider 实例的最终覆盖
```

Template 的 `builtinModelIds` 进入实例后仍作为 Built-in-owned 成员；Personal `modelIds` 继续作为用户成员。
现有成员所有权、Built-in-wins 重名处理和 `modelOrder` Overlay 继续复用。

## 4. 创建、更新与删除

### 4.1 创建

普通第三方 Provider 的旧 `addBuiltinProvider(providerId)` 退役，空白创建、Settings Template 创建和 Welcome
API Key 创建统一为：

```ts
createPersonalProvider(input?: {
  readonly templateId?: string;
  readonly initialConfig?: ProviderConfigOverlay;
}): PersonalProviderCreation;
```

- 无 `templateId`：创建空白自定义 Provider；
- 有 `templateId`：确认当前 Release 存在该 Template，生成唯一 `providerId`，只写 `templateId` 与必要
  Personal 初始 Overlay；
- 不复制 Template API、成员或 Model Rules；
- 不为每个实例生成重复 Template Rule；
- 同一 Template 可以创建多个实例；
- Template `label` 只是创建菜单文案和新实例名称种子；创建时写入唯一 Personal label，如 `DeepSeek`、
  `DeepSeek 2`；之后 label 归用户实例所有，Template 改名不会重命名既有实例；
- Provider Config、`templateId`、`initialConfig`（包括 Welcome 提交的 API Key）、唯一 label 与
  `providerOrder` 必须在同一次 Repository 更新中写入；不得先创建空 Provider，再通过第二个 API 补 Key；
- `templateId` 只接受顶层创建参数；`initialConfig` 不得再次携带 `templateId`、`providerId` 或
  `providerOrder` 等身份/容器字段；
- 创建失败不得写入 `providerSetupCompleted`、半成品 Provider 或孤立 order 成员；
- 本轮不改变 Welcome 已有的“创建成功后设置可用默认模型”产品行为，该动作继续走现有模型选择 API，不并入
  Provider Config Repository。

Z.ai/BigModel 按量 API 与其他 Template 使用同一创建操作：

- Welcome/API Key 表单每次提交时，都选择对应 Template，并把 API Key 作为 `initialConfig` 交给同一个
  `createPersonalProvider` 原子创建操作；
- 不按 Template、品牌或 API Key 查找并复用旧实例，也不维护“Family canonical API 实例”；
- `providerSetupCompleted` 只在实例创建成功后写入，只约束 Welcome 是否自动出现，不限制用户显式进入 API
  Key 流程后再次创建实例；
- 账号登录不触发 Template 实例创建；
- 设置页允许用户从相同 Template 继续创建更多实例；
- 创建按量 API 实例不写 `ProviderFamilyConnectionSelection`，也不改变 Account Family 当前选择；
- 不增加“哪个 Template 实例属于 Family”的绑定字段或恢复逻辑。

### 4.2 更新

实例保存继续使用通用 Personal Provider Overlay API。Template 更新通过 Built-in revision 传播给所有引用
实例；Personal 显式叶子最后覆盖。

Registry 更新只影响之后创建的 Active Model；已创建的 Active Model 保持冻结。

### 4.3 删除

删除 Personal Provider 必须在同一 Repository 更新中原子删除：

```text
Personal Provider Config
Personal providerOrder 成员
所有精确绑定该 providerId 的 Personal provider-model Rules
```

不删除通用 `match`、Built-in `template-model`、Template 本身或其他 Provider 的 Rule。现有
`deletePersonalProvider -> deleteExactForProvider` 原子边界必须保留。

Template 创建的 Z.ai/BigModel API Provider 与其他 Personal Provider 使用同一删除语义；删除时原子清理其
Provider、排序成员与精确 Personal Model Rules。Account Family Provider 不进入普通删除入口。

## 5. Settings、Family 与 Welcome

### 5.1 Settings Template Menu

普通第三方的 `addableProviders` 不再投影 disabled Built-in Provider，改为独立 `providerTemplates` 候选投影。
该 DTO 只服务 Settings 创建菜单，不进入 Registry Provider View。

```text
Built-in providerTemplates
        |
        v
Settings Template Menu
        |
        | createPersonalProvider({ templateId })
        v
Personal Provider Instance
        |
        v
Settings Provider List / Registry（完整时）
```

Settings Facade 必须投影同一 Resolver 中彼此独立的事实：

```text
templateConfig?          Template 官方来源
effectiveBuiltinConfig? Concrete Built-in + Account 的无 Personal 结果
personalConfig?          当前 providerId 的稀疏 Personal Overlay
effectiveConfig          最终结果
```

不新增一个把这些事实压扁的 `inheritedConfig` 字段。Settings 的恢复默认、修改标识和成员来源根据当前路径读取
相应事实：

- Template Personal 实例的 Provider 默认基线来自 `templateConfig`；
- Built-in/Account Provider 的 Provider 默认基线来自 `effectiveBuiltinConfig`；
- 完全自定义 Personal Provider 没有 Provider 官方基线；
- Model 默认值始终由同一个 Model Rule Resolver 在排除该实例 Personal exact Rule 后解析，不能只看 Provider
  Template 或另写 UI fallback。

这些投影必须保证：

- “恢复默认”回到正确基线；
- Template 模型显示为 Built-in-owned；
- Personal 修改样式只反映 Personal Overlay；
- 新增模型默认配置与真实 Registry 一致；
- Template 缺失或配置不完整时实例仍可见并显示 Config issue。

### 5.2 Family 保留

Family 是保留的 Account 产品组合与连接选择边界：

```text
ProviderFamilyDomain = zai | bigmodel
        |
        v
对应 Family 页面
├─ start-plan
├─ individual-coding-plan
└─ team-coding-plan
        |
        v
ProviderFamilyConnectionSelection
```

继续保留并验证：

- Family Header、Account 连接方式菜单和当前选择持久化；
- Start、Individual、Team 的切换与恢复；
- `providerFamilyDomain` 与登录账号体系同步；
- 套餐、额度、升级、账号凭据和 Off-Peak 对 Z.ai/BigModel 身份的消费；
- `ProviderFamilyConnectionSelection` 的 `api-key` variant、固定 Provider ID 与对应 App Settings 数据退出；
- Z.ai/BigModel API Templates 进入普通“添加供应商”候选，但不出现在 Account Family 连接方式菜单；
- 不重新建立已经删除的第二份 `oauth | apiKey` mode 状态。

Off-Peak 仍属于对应 Account Family 的账号与套餐产品链，但它是隐藏执行 Provider：不作为
`ProviderFamilyConnectionSelection` 候选，不出现在普通 Settings Provider 列表，也不提供用户编辑入口。它继续
由内部闲时执行通过真实 Provider ID 和普通 Registry/ModelFactory 精确使用。

Account Access 内部在本轮将原 `access.family` 确定改名为
`access.accountType = zai | bigmodel`；
它描述账号访问身份。`ProviderFamilyDomain` 和 Connection Selection 描述产品 UI 与用户连接选择。两者值域
相同但职责不同，不能互相替代，也不能因为改名而删除 Family 状态。

### 5.3 现有分组保持不变

本轮不新增 `family: "zhipu" | "others"`，也不新增 `brandGroup`、`settingsSection` 等替代字段。

```text
现有设置页
├─ Z.ai / BigModel Account Family 入口（现有 preset/family 路径）
└─ Personal Provider 列表
   ├─ 空白创建
   └─ Template 创建（包含 Z.ai API / BigModel API）
```

Template 只改变普通第三方 Provider 的创建来源，不顺便重做左侧导航信息架构。

### 5.4 Welcome

保留已裁决的独立设置事实 `providerSetupCompleted`，只表达启动引导已完成或跳过，不参与 Registry、
Template 继承、Family Connection Selection 或 Account 权益。

自动打开 Welcome 的基本条件：

```text
providerSetupCompleted = false
AND 当前没有可执行 Provider
```

Welcome 每次提交 Z.ai/BigModel API Key：

```text
选择 Z.ai / BigModel
        |
        v
定位对应 Provider Template
        |
        v
createPersonalProvider({
  templateId,
  initialConfig: { access: { type: "api-key", apiKey } }
})
        |
        v
原子写入 Personal Provider + order
```

它不复制 Built-in Provider，不写 Account Overlay，也不写或修改 Account Family Connection Selection。
账号登录不走这条链路。`providerSetupCompleted` 只控制自动引导，不参与实例复用或去重。

## 6. Built-in 同步与持久化

- Built-in Release Schema 增加 `providerTemplates` 后提升 Schema Version；
- Bundled、Remote、Active、LKG、Endpoint-scoped cache 和 materializer 携带同一份 Templates；
- Remote Release 原子替换 `{ providers, providerTemplates, modelConfigRules }`；
- Template ID 是稳定引用键；Personal 实例可能长期引用它；
- Publisher 删除 Template 时，引用实例保留在 Settings、产生 `missing-template` issue 且不进入 Registry；
- 本轮不增加 Template 退役元数据，先采用不删除已发布 Template 的发布纪律；
- Personal `provider_config.json` 继续保存 providers、modelConfigRules、providerOrder，只增加 `templateId`；
- Family Connection Selection 继续留在现有 App Settings，不迁入 Personal Provider Config；
- 本分支尚未上线，不为未发布过渡形态增加 alias、兼容读取或迁移器。

## 7. 实施切片

### A0. 先同步当前 Design 与 Feature Graph

在测试和生产代码之前，先把本 Todo 已裁决语义写回当前事实文档与 Feature Graph，至少覆盖：

- `design.md`、`configuration.md`、`provider-and-model-configuration-overview.md`；
- `zcode-builtin-provider-config.md`、`model-membership-and-enablement.md`、`settings.md`；
- `request-compatibility-and-access-protocols.md` 中固定 API Provider / Account Type 边界；
- Feature Graph 中普通 Built-in placement、Provider enabled、Family 按量 API 与 Welcome 固定 Provider seed。

历史 Todo 只作决策轨迹；实现和测试以更新后的当前 Design 为准。

### A. Config 与 Built-in Release

1. Provider Config/Object/Input/Overlay/JSON 增加 `templateId`；
2. 增加独立 Template Map 与严格 Template Source Schema，Map 值复用 `ProviderConfigOverlay`，并执行字段
   白名单；
3. Built-in Release 版本提升并原子贯穿 Bundled/Remote/Active/LKG；
4. `providers` 只保留全部 Account/Off-Peak Concrete Provider；
5. Z.ai API、BigModel API 与其他普通第三方 Provider 全部移入 `providerTemplates`；
6. 不新增 `family = zhipu | others`，保留现有 Family 与设置分组；
7. 删除 Provider 顶层 `enabled`，保留 `access.entitled` 和 Model `enabled`；
8. 将 Account Access 的 `family` 改名为 `accountType`，但不删除 Provider Family 产品结构。

### B. Model Rules 与 Resolver

1. 增加 Built-in-only `template-model` Rule；
2. Built-in/Personal Rule JSON 拆成按类型命名的数组字段；
3. Resolution Input 携带真实 `providerId` 与可选 `templateId`；
4. 实现 Template -> Built-in -> Account -> Personal Overlay；
5. Source 按显式字段顺序连接 Rule，Resolver 保持逐条 Overlay；
6. 保留成员所有权、顺序、完整性、entitlement、visibility 与 Active Model 冻结语义；
7. Template 缺失时产生 issue，不猜测 fallback Template。

### C. Config Service 与 Facade

1. 通用 `createPersonalProvider({ templateId?, initialConfig? })` 支持 Template、空白自定义和 Welcome API Key
   创建，并在一次 Repository 更新中写 Provider、label、order 与初始 Overlay；
2. 删除普通第三方 `addBuiltinProvider` 和 disabled Built-in 复活逻辑；
3. Settings View 用 `providerTemplates` 取代普通第三方 `addableProviders`；
4. Account Provider 继续走现有 Family/Account Facade；Z.ai/BigModel API 实例走普通 Personal Facade；
5. Template 实例删除沿用 Provider + order + exact Rules 原子删除；
6. Facade 分别投影 `templateConfig`、`effectiveBuiltinConfig`、`personalConfig` 与 `effectiveConfig`；Reset、模型
   编辑与连接测试复用同一 Resolver，不新增统一 `inheritedConfig`；
7. 删除 Provider Settings DTO 的 `enabled` 和普通 Provider“已启用”胶囊；Account 套餐状态继续由状态卡表达。

### D. UI 与产品入口

1. 保留 Account Family Select、Family Header 与 Account Connection Selection；
2. 删除 Family“按量 API”选项及 `ProviderFamilyConnectionSelection.kind = "api-key"`；
3. 普通“添加供应商”菜单从 Templates 创建实例，包含 Z.ai API / BigModel API 并支持多实例；
4. Welcome 每次提交 API Key 都通过同一 Template 创建入口建立新的 Personal Provider，并用通用 Personal
   Overlay 作为 `initialConfig` 原子保存 Key；
5. 引入 `providerSetupCompleted`；Welcome API Key 路径不改变 Account Family 选择事实；
6. 保持桌面、Web、手机、主题与国际化一致；
7. 不改变模型选择、Automation、Subagent、Repo Wiki、队列或恢复状态归属。

### E. 清理边界

删除：

- 全部非 Account Built-in Concrete Provider，包括固定 `zai-api` / `bigmodel-api` Provider；
- 普通第三方 Provider 顶层 `enabled` placement 与 Built-in 复活判断；
- 普通第三方 `addBuiltinProvider`、`addableProviders` 和 Overlay recreation；
- 普通 Built-in/Personal 两套表单权限判断；
- 对应过时测试、Fixture、文档和 Feature Graph seed；
- Provider Settings View/DTO 中的 Provider `enabled`、普通 Provider“已启用”胶囊及由它派生的 UI 分支；
- 删除 `standard-builtin` group 值；机械扫描用于证明零残留，不再作为是否删除的产品裁决。

明确不删除：

- `zai-family`、`bigmodel-family` 与当前 Personal 分组；
- `ProviderFamilyDomain`、收窄后的 Account `ProviderFamilyConnectionSelection` 及其持久化；
- Account Family Header/Connection UI；
- Account 套餐、额度、升级、凭据与 Off-Peak Family 消费链路。

## 8. 测试与验收

### Config / Release

- `templateId` Overlay、`null` 清除和 JSON round-trip；
- Template Source 接受无真实 Key 的官方基线，拒绝不合法结构；
- Template Source 字段白名单拒绝 `group/modelIds/modelOrder/enabled/visibility/templateId` 与真实凭据；
- Built-in Release 原子解析、版本拒绝、Remote/LKG 回落；
- Template 不直接进入 Provider 集合或 Registry；
- missing Template 实例保留 Settings issue 且不进入 Registry；
- Template 不递归继承；
- Release 的 Concrete `providers` 只包含 Account Provider；Z.ai API / BigModel API 存在于 Templates。

### Provider / Model Resolver

- 同一 Template 两个实例获得相同官方基线且 Personal 覆盖互不污染；
- Built-in/Account Provider 可以选择继承 Template；
- Personal `templateId` 覆盖和 `null` 清除遵循 Overlay；
- `template-model` 只按 Template ID + Model ID 命中；
- 字段内保持书写顺序，跨字段顺序由 Config Schema 固定；
- Account `provider-model` 晚于 Template Rule，Personal Rule 始终最后；
- generic match、API Schema、baseURL 和 Active Model 冻结不回归。

### Lifecycle / Settings

- 同一 Template 可创建多个唯一 Provider ID 与 label；
- Template label 只作为创建名称种子；既有实例不随 Template 改名；
- 创建在一个 Repository 事务中原子写入 Provider、initialConfig 与 providerOrder；失败不留下半成品；
- 删除实例原子清除 order 与 exact Personal Rules；
- 空白自定义 Provider 无 Template 仍可配置、保存、测试和执行；
- 配置不完整时实例可见但不可执行；
- Template baseline 正确驱动默认值、恢复默认、修改标识和成员来源；
- Template Personal 实例没有伪造的 `effectiveBuiltinConfig`；四类 Settings Config 投影语义准确；
- Template 菜单包含 Z.ai API / BigModel API，且可分别创建多个实例；
- Family 页面只包含 Start、Individual 与 Team，不再包含按量 API；
- Off-Peak 不进入 Family Connection Selection 或普通 Settings 列表，但内部精确执行不回归；
- Welcome 每次保存 Key 都创建新的正确 Template 实例，且不复用旧实例、不修改 Account Connection
  Selection；
- 账号登录不创建按量 API Template 实例；`providerSetupCompleted` 不参与实例去重。

### Family / Account 回归

- `providerFamilyDomain` 切换与登录恢复正确；
- Start、Individual、Team Connection Selection round-trip 正确；旧 `api-key` variant 零残留；
- Z.ai API / BigModel API Template 实例不被 Family 导航或 Account Resolver 消费；
- Start 模型成员、Individual/Team entitlement 与状态不回归；
- 套餐、额度、升级、账号凭据和 Off-Peak 读取正确 Account Type；
- 不存在第二份 `oauth | apiKey` mode 状态。
- Provider Settings DTO 和 UI 不再存在 Provider 级 enabled 或“已启用”胶囊；Model enabled 保持不变。

### Runtime / 机械验证

- 连接测试与真实请求使用实例真实 `providerId` 和 Effective Config；
- 同 modelId 的不同实例不串 Provider；
- Automation、Subagent、Repo Wiki 不感知 Template；
- Desktop continuous、Web/Mobile replayable 和 remote workspace 不新增运行时状态；
- Provider、Provider Node、Services、UI 定向单测与 typecheck；
- Template 多实例与 Account Family 设置隔离 E2E；
- `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、格式检查与 `git diff --check`；
- `rg`/`dep:refs` 证明普通 Built-in 生命周期和 Provider enabled 清理完整；
- `rg`/测试证明 Account Family 没有被误删，同时固定 API Provider 和 Family `api-key` 分支清理完整。

## 9. Review 风险与实施约束

### 9.1 Template 校验时机

```text
Provider Template              只做 Source 结构校验
        +
Concrete/Personal/Account 层
        |
        v
Effective Provider Config      才做完整性/可执行校验
```

不得给 Template 填假 Key、放宽最终完整性或增加 fallback 绕过边界。

### 9.2 Template Map 与 Provider Map 分型

`providerTemplates` 使用 `templateId`；`providers` 使用 `providerId`。Template Map 的值直接复用
`ProviderConfigOverlay`，不另建一份完整 Template Config 值类型；同时不能让 Template ID 在 API 或变量中被称为
Provider ID。

### 9.3 Settings 来源事实来自唯一 Resolver

Template 继承关系不等于 `effectiveBuiltinConfig`。唯一 Resolver 必须分别保留 `templateConfig`、
`effectiveBuiltinConfig`、`personalConfig` 与 `effectiveConfig`，Settings 只读投影这些事实；不能新增一个
`inheritedConfig` 抹平来源，也不能让 Registry、Settings 和 Preview 各自拼一次 Template，否则恢复默认、成员
来源、修改标识和新增模型默认值会分叉。

### 9.4 Account Family 是明确保留的不变量

```text
Template 改造路径                         Account Family 保留路径
================                         =====================
普通 Provider Template                   Z.ai / BigModel Account Family
（含 Z.ai/BigModel API）                          |
        |                                 Account Connection Selection
Personal Provider Instance                       |
        |                                 Account Provider
        +------------------+---------------------+
                           |
                           v
                    Provider Registry
```

本轮把按量 API 从 Family 移到 Template，但不能顺手删除或重建 Account Family。

### 9.5 Z.ai/BigModel API Template 不与 Family 绑定

Z.ai/BigModel API 进入 Template 后就是普通 Personal Provider 来源。不能保留固定 Provider ID、canonical
实例、Family 槽位或“当前 Family API 实例”等桥接概念。Family 只消费 Account Provider；Template 实例只通过
标准 Settings/Registry 路径执行。

### 9.6 Provider `enabled` 与 Family placement 解耦

Account Provider 的展示来自 Family 结构，Personal Provider 的展示来自 Personal 定义存在。删除
`enabled` 后，不能用 API Key 是否存在或 `executable` 反推是否显示；配置不完整但可见是合法状态。

Facade 与 UI 同时删除 Provider 级 `enabled`：普通 Provider 不显示“已启用”胶囊；Account Provider 的产品状态由
套餐/连接状态卡表达；配置问题由 issue 与 executable 结果表达。三者都不得重新命名为 enabled。

### 9.7 Rule 分类由 Config 表达

`composeEffective()` 继续作为共享组合入口。新增 Template 后仍只构造一条有序 Rule 序列，不允许三处各自
排序或拼接。

### 9.8 Release 与工具链原子扩展

`providerTemplates` 会影响 Release codec、remote client、Endpoint cache、materializer、正式 bundle、完整性
测试、publisher evidence、E2E fixture 和 helper。开发环境成功不能替代正式包和 Remote Workspace 证明。

### 9.9 Template ID 不进入运行时

Template ID 是配置继承来源，不是请求路由身份。Selection、任务持久化、ModelFactory 和 Adapter 不新增
Template 分支。

### 9.10 Template ID 与 Provider ID 不混用

两个 Map 允许 `templateId = deepseek` 与 `providerId = deepseek` 同名。独立 `template-model` /
`provider-model` Rule 必须保证身份不会因字符串相等而混淆。

## 10. 完成标准

- Template 与 Provider 身份严格分离，但配置值复用现有 Provider Config；
- Template Map 值直接复用 `ProviderConfigOverlay` 且 Source 字段白名单明确；
- 同一 Template 可以创建多个互不污染的 Personal Provider；
- Built-in/Account Concrete Provider 可以选择继承 Template；
- Built-in Config 原子包含固定 Providers、Provider Templates 与分层 Model Rules；
- 普通第三方 Built-in Concrete Provider、placement enabled 和 addable 生命周期全面退出；
- Z.ai/BigModel API 以 Template 形式进入普通 Personal Provider 创建链，固定 Concrete Provider 身份清零；
- Z.ai/BigModel Account Family、收窄后的 Account Connection Selection 与 Account 产品链完整保留；
- Family `api-key` 连接项、固定 API Provider ID 特例和 Welcome 固定 Overlay 链清零；
- 不新增 `family = zhipu | others` 或另一套设置页分组字段；
- Settings、Registry、ModelFactory 与 Runtime 不存在第二套 Provider/Model 事实；
- Settings 不混淆 Template 来源、Effective Built-in、Personal Overlay 与最终 Effective Config；
- Provider 级 enabled 字段、DTO、胶囊与隐式替代物清零，Model enabled 保留；
- Account entitlement、套餐、请求期凭据、Off-Peak 与 Active Model 冻结语义保持正确；
- 所有定向、全量与 E2E 证据通过后提交 Conventional Commit。

## 11. 实施记录

2026-09-01 已完成 Provider Template 切换：

- Built-in Release 升级为 `providers + providerTemplates + modelConfigRules` 的原子版本；
- 普通第三方 Provider 全部迁为 Template，只有 Account/Off-Peak 保留 Built-in Concrete Provider；
- Settings 与 Welcome 统一通过 `createPersonalProvider(templateId, ...)` 创建独立 Personal Provider；
- Z.ai/BigModel 按量 API 退出 Family Connection Selection，Template ID 不再充当运行时 Provider ID；
- Account Registry Access 使用 `accountType`，请求期账号访问事实继续使用 `family`；
- Provider 顶层 `enabled`、固定 API Provider 特例和相关 UI/测试残留已删除；
- Personal Rule 与 Provisioning Envelope 统一使用分层 Rule 结构；
- Z.ai/BigModel 的 Endpoint 专属能力按 `baseURL + api.type` 匹配，不依赖固定 Provider ID。

验证证据：Provider/Provider Node 定向测试、受影响 Services/UI 测试、根 `typecheck`、`lint` 与全量
`test:unit`；CLI Bootstrap 的 Provider 定向测试与独立 `typecheck` 通过。CLI Bootstrap 全量共 106 个测试文件，
Todo 55 相关用例全部通过；剩余 8 条失败分别属于既存 v4 边界/stale revision、官方插件资源和依赖真实网络的
Marketplace 基线，不属于 Provider Template。实际 Electron/WDIO 证据由 Todo 57 统一补齐。
