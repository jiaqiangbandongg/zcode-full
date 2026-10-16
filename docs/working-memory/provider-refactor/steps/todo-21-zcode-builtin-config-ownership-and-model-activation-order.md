# 21 ZCode Built-in 配置、模型启停、排序与设置页收口

> 状态：已完成（后续 Todo 23 已删除最后的 Compatibility Config）
>
> 日期：2026-08-26
>
> 相关任务：[`02`](./todo-02-ai-sdk-execution-registry-retirement.md)、
> [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md)、
> [`17`](./todo-17-provider-registry-settings-authority-boundary-closure.md)、
> [`18`](./todo-18-zcode-builtin-client-config-sync-and-lkg.md)、
> [`22`](./todo-22-additional-builtin-providers-and-cloud-access.md)
>
> 相关设计：[`design.md`](../design/design.md)、
> [`provider-and-model-configuration-overview.md`](../design/registry/provider-and-model-configuration-overview.md)、
> [`configuration.md`](../design/registry/configuration.md)、
> [`model-membership-and-enablement.md`](../design/registry/model-membership-and-enablement.md)、
> [`settings.md`](../design/registry/settings.md)、
> [`registry.md`](../design/registry/registry.md)、
> [`request-compatibility-and-access-protocols.md`](../design/registry/request-compatibility-and-access-protocols.md)

## 0. 任务定位

本 Todo 负责整理现有 ZCode Built-in Provider Config 与 Built-in Model Config Rules，并把 Provider/Model 设置页
收口到同一套领域事实。目标不是为旧实现增加兼容层，而是让 Built-in Config 成为模型与 API 静态事实的唯一来源，
让 Settings 只编辑 Personal Config，让 Registry 只消费最终解析结果。

本 Todo 是本轮实现期间的权威实施 Spec。开发前不要求先把全部内容机械同步到 Design Tree 与 Feature Graph；实现完成后，
再根据已经落地的最终类型、服务边界和 UI 入口做一次完整同步，并把冲突旧文档明确更新或标记为已被取代。该同步是本 Todo
的完成门禁，不能延期到后续任务。

实现应忠实落地已经裁决的领域与产品设计，不得仅因局部实现方便、复用现有组件或减少当下改动而自行改变设计。目标模式中
遇到普通实现歧义、局部正确性冲突或新事实时，优先选择最贴近既有裁决、影响最小且可逆的方案继续执行，同时记录选择和证据，
在目标完成后再讨论是否需要调整设计；不得把临时权衡自动升级为新设计。只有涉及不可逆破坏、需要新增外部权限，或任何候选
方案都会违背核心目标时才阻塞目标。

不纳入本 Todo：

- Client Config 公共服务重构；Todo 18 只做当前 Built-in Release 的最小接入；
- OpenRouter、OpenCode Zen、Azure、Volcano Ark、AWS Bedrock；见 Todo 22；
- Google Gemini 与 Vertex AI；当前不支持；
- Off-Peak 结构化错误重构；本轮只调整配置归属；
- 重建旧 Catalog、Preset 或 Adapter Registry；
- 逐 commit、逐叶子的重型迁移审计。

### 实施结果（2026-08-26）

- 五个 Source Schema、Provider group、结构化 `provider-model` Rule、Model `enabled`、Builtin-wins 与显式 Provider/Model
  顺序已经进入正式 Config/Resolver/Facade/Repository 链路；Personal 持久化字段已收口为 `modelConfigRules`。
- Built-in Release 已原子切换 `account:` 账号 Provider，Z.ai/BigModel Family 与普通 API Provider 已分离，Off-Peak
  已拆成两个隐藏 Family Provider；Account Overlay 决定连接约束、可用成员与对应 Provider enabled。
- Settings 已直接消费 Host 的 group、添加候选、完整顺序、成员来源与 executable/selectable 结果；Provider ID 只读，
  Model 完整编辑保存为稀疏 Personal 专属 Rule，继承值、覆盖值与恢复继承有明确交互。
- 官方版本请求安全校验与 Off-Peak execution protocol 已归入 Provider Access；旧 reasoning/output-token/Provider-ID
  运行时兼容和 Renderer ID 白名单已删除。后续 Todo 23 进一步删除了最后的 Compatibility Config 与 synthetic
  empty-thinking 投影。
- Design Tree、Feature Graph 与历史 Todo 的 superseded 标注已经同步到最终实现。

本次实现验证：Provider 核心定向测试 255 项通过，根 `typecheck`、`lint`、Desktop E2E typecheck、修改文件格式检查和
`git diff --check` 通过；根单测 12,416 项通过，另有 2 项因当前 Linux 环境缺少外部 `zip` 命令失败，均位于
`zcode-server-cli` Windows ZIP 打包/安装测试，与 Provider 改动无关。真实请求和正式 E2E 按最终 Release Checklist 执行。

## 1. 最终双路配置

```text
Provider Config 路径                         Model Config 路径
====================                       =================

ZCode Built-in Provider Config             ZCode Built-in Model Config Rules
              |                                         +
              v                                         |
Account Built-in Provider Config           Personal Model Config Rules
              |                                         |
              v                                         v
Personal Provider Config                   Effective Model Config Rules
              |                                         |
              v                                         |
Effective Provider Config                              |
├─ group / label / logo                                |
├─ enabled / visibility                                |
├─ api / access                                        |
├─ builtinModelIds / modelIds                          |
└─ modelOrder                                          |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       ├─ reasoningMapping
                       └─ 已确认的窄请求编码事实
                                  |
                                  v
                    完整性与执行资格校验
                                  |
                                  v
                         Provider Registry
                                  |
                                  v
                       ModelFactory -> Model -> Adapter
```

Provider Config 决定 Provider 身份、访问方式、成员和显示顺序。Model Config 决定某个模型是否启用、具有什么能力、
允许哪些选项，以及选项怎样编码。Model Rule 不能创造成员，Provider 成员数组也不能声明模型能力。

Overlay 是一套自然、可复用的配置合成语义与机制，负责同一配置槽位的继承、覆盖和清除。Provider/Model 领域利用它
实现自己的配置空间、成员构成、默认状态和生命周期语义。Overlay 不是能够自然支持所有业务语义的万能抽象；结构必须
先服从领域模型，再复用 Overlay 完成层间组合。

## 2. 五个 Source Schema

五个输入来源各有严格 Schema，但进入领域后共享 Provider Config、Model Config 和 Overlay 语言；不建立五套 Runtime
DTO。

| Source                            | 可写事实                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| ZCode Built-in Provider Config    | Provider group、身份、展示、API/Access 模板、`builtinModelIds`、Provider 默认状态与声明顺序   |
| Account Built-in Provider Config  | 账号 Provider 的 Access/连接约束、Provider enabled、服务端确实返回时的 `builtinModelIds`      |
| Personal Provider Config          | `standard-personal` 新 Provider，或已有 Provider 的 API/Access/状态 Overlay；`modelIds/order` |
| ZCode Built-in Model Config Rules | 完整 Model 默认、模型/API/Provider/Endpoint 特化、官方默认启停                                |
| Personal Model Config Rules       | 用户的单模型专属覆盖，以及用户手写的通用 Match Rule                                           |

强约束：

- Personal Overlay 已有 Provider 时不能改写 `group`；Personal-only 根声明必须 `group=standard-personal`；
- Personal Provider Config 不能写 `builtinModelIds`；
- Account 只约束 Built-in 账号 Provider，不读取或修改 Personal-only Provider；
- Account 不写 Model Config，不提供 context、格式、reasoning 等模型静态事实；
- Personal Provider 的 `modelIds` 禁止包含当前 Effective `builtinModelIds` 中的 ID；手写重复读取时 Built-in-wins，
  保存相关 Provider 时自动从 Personal 数组清掉；
- Source Schema 负责结构与字段归属；服务端是否最终授权仍由真实请求决定。

五个 Source 的目标边界进一步固定为：

| Source                     | 必须/允许                                                                                                                                                           | 明确禁止                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ZCode Built-in Provider    | 每个根声明必须提供 `standard-builtin`、`zai-family` 或 `bigmodel-family` group；允许 label/logo、enabled、visibility、API、Access 模板、`builtinModelIds`           | `standard-personal`、`modelIds`、`modelOrder`、`providerOrder`                 |
| Account Built-in Provider  | 只能覆盖已有 ZCode Built-in Family Provider；允许 enabled、结构化 Account Access、接口确实返回时的 `builtinModelIds`                                                | group、展示字段、visibility、API、Personal 成员/顺序、Model Config             |
| Personal Provider          | 顶层允许 `providerOrder`；已有 Provider Overlay 允许 label、enabled、visibility、API、Access、`modelIds/modelOrder`；Personal-only 根必须 `group=standard-personal` | `builtinModelIds`；已有 Provider 的 group 改写                                 |
| ZCode Built-in Model Rules | `provider-model` 与 `match`；允许完整 Model Config、官方 enabled 默认和经证据确认的 Built-in-only 窄兼容事实                                                        | Provider 成员、顺序、Access、动态凭据                                          |
| Personal Model Rules       | `provider-model` 与 `match`；允许用户可覆盖的 Model Config 稀疏字段                                                                                                 | Provider 成员/顺序、Access、未允许 Personal 覆盖的产品协议或待定 Compatibility |

结构解析与语义校验分两步：单文件 Parser 严格拒绝未知字段；需要知道“该 ID 是否来自 Built-in”的约束由 Source
装配校验完成。当前分支未发布，无 `type` 的开发中间 Rule 直接拒绝，不增加 dual-read 或 schema migration；真正已发布
旧配置只在 Legacy importer 私有边界转换。

## 3. Provider Config

```ts
interface ProviderConfig {
  group?: "standard-builtin" | "standard-personal" | "zai-family" | "bigmodel-family" | null;
  label?: string | null;
  enabled?: boolean | null;
  visibility?: "visible" | "hidden" | null;
  api?: ProviderApiConfig | null;
  access?: ProviderAccessConfig | null;
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
}
```

Provider 顶层 `enabled` 是执行门禁：disabled Provider 不进入 Registry、fallback、选择器或精确创建。
`visibility=hidden` 只隐藏普通 Settings/Selection；完整且 enabled 的 hidden Provider 仍可由内部产品按精确 ID 使用。
Provider 不保存 `selectable`。

`group` 是简单、显式的 Provider 产品组织事实，不是执行能力、Access 类型或可见性替代品：

```text
standard-builtin
└─ ZCode 提供模板、用户自行配置的普通 Provider
   └─ 参与“添加供应商”候选与普通 providerOrder

standard-personal
└─ 用户从零创建的 Personal-only Provider
   └─ 参与普通 providerOrder

zai-family / bigmodel-family
└─ 固定属于对应账号 Family 的产品 Provider
   ├─ 不参与普通 Provider 拖动
   └─ Settings UI 不提供 Provider 启用/停用操作
```

Renderer 不再通过 Provider ID 白名单、Access 类型或 Endpoint 推断分组。ZCode Built-in 根声明必须显式提供非 Personal
group；Personal-only Provider 固定为 `standard-personal`；Account/Personal Overlay 无权改变已有 Provider 分组。
Provider 不再保存额外 `builtin` boolean；完整 `group` 已经同时表达普通 Built-in、Personal-only 和两个账号 Family。
`visibility` 继续独立表达是否对普通用户可见，`enabled` 继续独立表达能否执行。

普通外部 Built-in Provider 默认 `enabled=false`。用户从“添加供应商”选择它时，立即创建 Personal Overlay 并写
`enabled=true`。Built-in 只表示由 ZCode 内置维护，不表示使用 ZCode 账号、已经有凭据或默认可用。

不采用 `enabledModelIds`。Provider 只维护模型成员与顺序，模型启停由 Model Config 负责。

## 4. 模型成员与 Built-in-wins

```text
builtinModelIds
└─ ZCode/Account Built-in 拥有的成员

modelIds
└─ 用户拥有的 Personal 成员
```

成员集合只由两者产生。Builtin 与 Personal 同 ID 时只保留一个 Built-in 成员；单数组重复保留第一次出现。读取时
确定性忽略重复后项，不制造冲突 DTO，也不阻塞 Built-in 模型。正常 UI 禁止创建重复；保存相关 Provider 时自动
规范化重复与失效成员。

删除 Built-in Model 不允许，列表不显示删除按钮。Personal Model 可以删除或修改 ID。Provider ID 在任何情况下都
不可修改；Provider Name/label 可以修改且 trim 后大小写不敏感唯一。

## 5. Model Config `enabled`

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: Readonly<Record<string, ReasoningParameters>> | null;
  requiresMfjsToolSchema?: boolean | null;
}
```

模型不再具有独立 `visibility`。`enabled` 的唯一语义是模型执行门禁：

```text
Effective Provider enabled
AND Provider complete
AND 模型是 Effective Provider 成员
AND Effective Model Config enabled
AND Model Config complete
        |
        v
Executable Model（进入 Registry）
        |
        + Provider visibility=visible
        v
Selectable Model（进入普通选择器）
```

disabled 模型仍留在 Settings，保留配置和排序，但不能测试、fallback、精确创建或被任何内部任务绕过。已经创建的
不可变 Model 不受配置刷新影响；后续创建遵守新状态。

Built-in 通用 Rule 必须提供完整默认 `enabled=true`。官方发布可以用更具体且更靠后的 Built-in Rule 将旧模型设为
`enabled=false`。Personal Rule 始终在 Built-in Rules 之后，用户可以明确覆盖；“恢复默认”删除 Personal `enabled`
叶子并重新继承 Built-in。

正常新增 Personal Model 时，成员、顺序与专属 Rule `enabled=true` 原子保存。这样用户新增的模型立即表达明确启用意图，
而用户手写、未生成专属 Rule 的成员仍按 Built-in 完整兜底解析。

## 6. Provider/Model 专属 Rule 与通用 Match Rule

```ts
type ModelConfigRule =
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    }
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    };
```

`provider-model` 可以属于 Built-in 或 Personal Source：Built-in 用它声明一个精确 Provider/Model 组合的官方事实；
Personal 用它承载设置页对 Built-in 或 Personal Model 的精确覆盖。只有 Personal 专属 Rule 跟随用户生命周期：

- 开关 enabled、编辑 Properties/Options/Reasoning 时创建或更新；
- Personal Model 重命名时与成员和顺序一起原子移动；
- Personal Model 删除时删除；
- 删除 Provider Personal Overlay 时，删除该 Provider 的全部专属 Rule；
- 恢复最后一个覆盖字段后，空 Rule 删除。

`match` 可以属于 Built-in 或 Personal Source，用于一组目标。Provider/Model 删除、重命名、去重均不自动改写或删除
任何 Match Rule，也不修改 Built-in 专属 Rule。专属 Rule 使用结构化 ID，不借正则表达“精确”，也不引入含义模糊的
`exclusive` boolean。

内置 Rules 继续使用 matcher，并可按模型、Provider、API 或规范化 baseURL 的真实差异选择最小充分条件。

## 7. Model 与 Provider 顺序

Model 的基础顺序固定为三段：

```text
未出现在 modelOrder 的 Built-in Model
                  +
modelOrder 中仍有效的全部成员
                  +
未出现在 modelOrder 的 Personal Model
```

因此在线配置新发布但用户尚未排序的 Built-in Model 默认在最前。正常 UI 新增 Personal Model 时会把当前全部有效成员
物化到 `modelOrder`，所以“未排序 Personal”只处理用户手写或异常输入。

每次真实调序保存时：

1. 保留当前有效成员；
2. 删除 stale 与重复 ID，重复保留第一次；
3. 补入所有遗漏成员；
4. 保存完整 `modelOrder`。

disabled 模型仍参与 Settings 顺序；Selection 过滤后保留其余模型相对顺序。

Provider 使用 Personal 顶层 `providerOrder`，不再依赖 Map 插入顺序的 trick。它采用同样的“未排序 Built-in在前、
显式顺序居中、未排序 Personal 在后”原则；每次新增或调序都物化当前完整普通 Provider 顺序。Z.ai/BigModel Family
保持固定产品组织，不参与普通 Provider 拖动。

Personal 持久化外壳目标为：

```ts
interface PersonalProviderConfigFile {
  schemaVersion: 1;
  providerOrder?: readonly string[];
  providers: Record<string, PersonalProviderConfig>;
  modelConfigRules: readonly PersonalModelConfigRule[];
}
```

`providerOrder` 是 Personal Source 自己的集合语义，不参与 Provider 字段 Overlay。ZCode Built-in Provider 基础顺序继续
来自 Release 中 Provider Map 的声明顺序；Account 不提供顺序。当前分支未发布，现有含义模糊的 `models` 存储字段直接
改名为 `modelConfigRules`，不为开发中间格式增加 migration；Legacy importer 输出最终字段。

## 8. Settings：Provider 添加、启停与删除

Provider 导航中的固定顺序为：Z.ai/BigModel Account Family 位于最前；“添加供应商”和“创建自定义供应商”两个固定操作
紧随其后；普通 `standard-builtin` 与 `standard-personal` Provider 列表位于操作之后。两个操作不参与 `providerOrder`
或拖动。

```text
添加供应商
└─ 候选 = visible + group=standard-builtin - Personal Provider Map keys
   └─ 点击后立即创建 Personal Overlay(enabled=true)并进入编辑

创建自定义供应商
└─ 先取得唯一且不可再修改的 providerId 与唯一 label
   └─ 立即创建 group=standard-personal、enabled=true 的 Personal-only Provider
      ├─ access.type=api
      ├─ 不预填 api.type、baseURL 或模型
      └─ 进入完整自定义编辑，不再需要第二次“创建”
```

“已经添加”的权威事实只是 Personal Provider Config Map 是否存在该 providerId。它与 API Key、enabled、executable、
selectable 无关。Provider enabled 是配置页中的独立开关：disabled 仍留在已配置区域；只有删除 Personal Overlay 才会
重新进入添加候选。

UI 中“删除 Provider”的领域语义永远是删除 Personal Overlay：

```text
standard-builtin
└─ 删除 Personal Overlay + 该 Provider 的 Personal 专属 Rules
   └─ Effective Provider 回落到 Built-in，重新进入“添加供应商”候选

standard-personal
└─ 删除 Personal Overlay + 该 Provider 的 Personal 专属 Rules
   └─ 因不存在其他定义而自然消失

zai-family / bigmodel-family
└─ 删除 Personal Overlay + 该 Provider 的 Personal 专属 Rules
   └─ Effective Provider 回落到 Built-in/Account 状态，继续留在固定 Family 区域
```

系统从不删除 ZCode Built-in Config。通用 Personal Match Rules 不随 Provider 删除。Family 不进入普通“添加供应商”候选，
也不在 UI 提供 Provider enabled 开关；底层字段仍供 Built-in/Account 装配使用，用户手工修改配置形成的特殊状态不属于
Settings UI 的产品保证范围。

Host Settings 契约至少提供以下权威结果：

```text
ProviderSettingsView
├─ revision
├─ addableProviders[]
│  └─ visible + group=standard-builtin + 尚无 Personal Overlay
├─ providerOrder[]
└─ providers[]
   ├─ providerId / group / label
   ├─ effectiveBuiltinConfig / personalConfig / effectiveConfig
   ├─ enabled / issues / executable
   └─ models[]
      ├─ modelId / builtin
      ├─ effectiveBuiltinConfig / personalExactConfig / effectiveConfig
      └─ enabled / issues / executable / selectable
```

不再返回 `isZCodeBuiltin`、`canReorder`、成员冲突 DTO 或把 Provider executable 命名为 selectable。Renderer 根据
`group` 组织已配置区域，但候选、顺序、成员来源和所有派生状态均由 Host 产生。

Host Mutation 必须覆盖以下领域操作，具体函数名可以服从代码风格，但不得合并语义：

- `addBuiltinProvider(providerId)`：创建 `enabled=true` 的 Personal Overlay，并物化完整 `providerOrder`；
- `createPersonalProvider({ providerId, label })`：校验身份后立即创建空 API Provider，并物化顺序；
- `savePersonalProvider(providerId, sparseConfig)`：保存 label/enabled/API/Access 等 Overlay，不修改 ID；
- `deletePersonalProvider(providerId)`：删除 Personal Overlay 与该 Provider 的 Personal 专属 Rules；
- `reorderProviders(completeProviderOrder)`；
- `addPersonalModel`、`renamePersonalModel`、`deletePersonalModel`、`reorderModels`；
- `savePersonalModelConfig` 与按叶子恢复默认；
- `previewPersonalModelRename`：先移动专属 Rule，再解析新 Built-in 默认；
- `testModel`：保存并刷新后通过正式 Registry/ModelFactory 执行。

所有 Mutation 成功响应都必须对应已经持久化且被 Registry 观察到的同一 revision。本地和远程使用同一服务契约，但服务
实例属于目标 Environment Host。

## 9. Settings：Model 编辑

模型列表使用紧凑信息行，不再在列表中渲染可编辑 Model ID 输入框，也暂不展示 Built-in/Personal 来源标签。来源仍由 Host
DTO 显式 `builtin` 提供，用于删除权限和领域操作；Renderer 不使用 ID 白名单或 Preset/Catalog 推断。

模型行直接展示 Model ID、必要的紧凑摘要、Effective enabled 状态、测试、编辑铅笔和删除操作。编辑铅笔继续外露；删除
继续在 Personal Model 行外露，Builtin Model 不显示删除。启停控件显示当前 Effective 状态，但列表不强调它来自 Built-in
默认还是 Personal 覆盖。

Provider 可编辑时，所有 Effective Built-in/Personal Model 成员均可排序；Builtin Model 只是不允许删除，不能沿用当前
“仅 Personal Model 可拖动”的限制。可排序模型将整行作为拖动激活区域，不再显示独立拖动块；编辑、删除、启停、测试等
行内控件必须排除在拖动激活范围之外。指针移动阈值用于区分普通点击和拖动，触屏需要避免与列表滚动冲突，键盘仍需提供
等价排序能力。普通点击模型行暂不打开编辑器，也不产生配置操作；只有外露的编辑铅笔进入 Model 编辑器。

模型编辑页允许编辑完整 Model Config 字段集合，但持久化始终形成稀疏 Personal Rule，只写用户明确修改或清除的叶子：

- `enabled`；
- context/max output；
- input/output format；
- tool call、structured output、native web search、MCS；
- option specs 与 reasoning mapping；
- 已确认允许 Personal 覆盖的请求编码字段；
- `requiresMfjsToolSchema` 放在最后。

模型编辑器必须区分以下事实，不能假设每个字段都有 Built-in 默认值：

```text
没有 Personal 叶子 + 上游存在值
└─ 继承该值

没有 Personal 叶子 + 上游不存在值
└─ 未设置；不能显示成“默认关闭”或虚构空值

存在 Personal 叶子
└─ 用户明确覆盖

Personal 显式 clear（字段允许时）
└─ 明确清除上游值
```

字段控件遵守以下统一视觉语义：

| 状态                      | 视觉与交互                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------- |
| 上游有值、Personal 未覆盖 | 显示真实 Effective 结果，但使用低强调文字、填充或描边；无恢复操作                       |
| 上游无值、Personal 未覆盖 | 显示中性短横线或“未设置” placeholder，不能伪装成关闭或空默认值                          |
| Personal 明确覆盖         | 使用正常控件强调；提供低干扰的撤销图标，Desktop 在 hover/focus 时显示，触屏端保持可发现 |
| Personal 显式 clear       | 显示明确的未设置/清除状态；不能与“没有 Personal 叶子”混淆                               |
| 校验错误                  | 使用标准错误文案和语义颜色，不与继承/覆盖的视觉强弱混用                                 |

文本和数值在存在可继承值时将该值显示为 placeholder，不把它复制进 Personal；上游无值时显示“未设置”。清空 Personal
输入恢复继承，字段确实允许显式 clear 时再提供窄、明确的清除操作。枚举继续使用现有 Select 语言：收起时显示 Effective 结果；
菜单内区分“继承现有值”“保持未设置”“显式清除”（字段允许时）和明确枚举值，但不在触发器中堆叠
“默认（当前为 X）”之类长文案。

Model 总 `enabled` 使用紧凑 Switch。Input/Output Format，以及 tool call、structured output、native web search、MCS
等能力 Boolean，使用与现有 Modality 控件协调的 Toggle Chip / Selectable Tag：Outline Button 内含对勾与短标签，可换行排列，
不改成一排 Switch。继承开启使用低强调选中 Tag，明确开启使用正常强调选中 Tag；继承关闭与明确关闭分别使用低强调和正常
描边；上游无值使用中性短横线。选中状态使用对勾，未设置使用短横线，Personal 覆盖还具有撤销入口和可访问名称，因此不能
只依靠颜色区分状态。Text 等锁定事实继续使用现有锁图标与禁用语义。PDF/Audio 暂不展示，但无关编辑必须保留其 Personal 值。

Option Specs 与 Reasoning Mapping 是高级配置，使用多个独立、带语法高亮或至少等宽字体且可自动格式化的 JSON 文本编辑器，
不开发总 `optionSpecs` 编辑器、表格、逐行 Mapping 或可视化 Builder。首版至少包括：

```text
Reasoning Level Option Spec JSON
└─ 直接覆盖 optionSpecs.reasoningLevel

Max Output Tokens Option Spec JSON
└─ 直接覆盖 optionSpecs.maxOutputTokens

Reasoning Mapping JSON
└─ 直接覆盖整个 reasoningMapping
```

每个编辑器对应一个独立配置槽位；编辑器提供 JSON 就直接替换该槽位的上游值，空 Personal 编辑器表示删除该槽位覆盖并重新
继承。Personal 文件中的 `optionSpecs` 外壳可以只包含被覆盖的子字段，但单个编辑器内部不再做更细粒度 Overlay；
`reasoningMapping` 也不得在 UI 内偷偷实现按 key 合并。每个槽位的 Effective JSON 通过只读预览、折叠区或页签查看，不能
先复制 Effective JSON 再保存为 Personal。保存前执行 JSON 解析和对应槽位的严格 Schema 校验，错误尽可能定位到行列或字段
路径。

页面不得在每个字段旁堆放醒目的“恢复默认”按钮。恢复继承通过清空输入、Select 的继承/未设置项、Toggle Chip 的低干扰
撤销入口或 JSON Personal 内容清空完成。

所有上述控件必须复用 `DESIGN.md` 和现有组件的尺寸、圆角、焦点、菜单与语义 Token。禁止用硬编码浅色/深色值或仅靠
透明度猜测主题；至少覆盖 Zai Light、Zai Dark、键盘 Focus、Hover、禁用、错误和触屏无 Hover 状态。界面使用 `text-ui-*`
字体层级，Model ID 和 JSON 使用等宽字体，长中英文文案与窄屏允许合理换行。

Model 编辑继续使用弹窗，不切换为右侧详情或设置页二级页面。现有 `max-w-xl` 空间不足，Desktop 将弹窗扩大一档，以
`max-w-2xl` 附近的现有尺寸档位作为起点，而不是扩展成横向工作台或接近全屏的超宽弹窗。字段增长主要通过纵向分区承载；
弹窗宽高需要保持协调，Header 与 Footer 固定，中间只有一个内容滚动区，避免弹窗与 JSON 编辑器产生多层页面滚动。窄屏和
Mobile 使用安全边距内的可用宽高，但不改变字段、继承和保存语义。实现可在现有尺寸档位内微调实际宽高，不能靠隐藏已要求
开放的字段维持旧尺寸。

Model 编辑弹窗明确采用手动保存，是设置页自动保存心智中的一个有边界例外。打开弹窗时根据当前 Host View 和 revision 建立
本地 Draft；修改 Model ID、Properties、Option Specs、Reasoning Mapping 等字段只更新 Draft，不逐字段持久化，也不触发
Registry 刷新。列表中的启停、排序、删除等单一领域操作继续各自即时、原子保存，不被并入弹窗 Draft。

```text
Host View @ R1
      |
      v
打开弹窗 -> Local Model Draft @ R1
                 |
                 +--> 编辑字段 --------> 只修改 Draft
                 |
                 +--> 取消 / X / Esc ---> 丢弃 Draft，不写配置
                 |
                 `--> 保存
                        |
                        +--> 完整校验失败 ----> 保留弹窗与 Draft，展示错误
                        |
                        `--> 一次原子 Host Mutation
                                  |
                                  v
                          Persist + Registry @ R2
                                  |
                                  v
                              关闭弹窗
```

保存按钮在 Draft 无效或正在提交时不可重复触发。保存必须一次校验并提交完整 Draft 所表达的稀疏 Personal 配置；Model ID
修改所需的成员、顺序与专属 Rule 迁移也属于同一次原子 Mutation。只有 Host 确认持久化结果已被 Registry 观察到后才能关闭
弹窗；保存失败时保留用户输入，不能回退成逐字段自动保存。

修改 Personal Model ID 时，必须先在预览语义中移动该模型的 `provider-model` 专属 Rule，再按新 ID、Effective API 和
Endpoint 重新解析 Built-in Rules，最后叠加原 Personal 稀疏值。这样继承默认会更新，用户明确值不变。

## 10. Built-in 配置写作与整理

Provider 按产品来源连续排列：智谱直接 API 与账号/订阅/Off-Peak在前，外部主流 Provider 在后。普通外部 Built-in
Provider 默认 `group=standard-builtin`、`enabled=false`、`visibility=visible`，提供协议、Endpoint、Access 模板和推荐成员；
Personal Config 填写实际访问材料。

Z.ai/BigModel 各自保留两个不同的 API Key 产品身份：

```text
Family API Key Provider
├─ account:zai-api-key       -> group=zai-family
└─ account:bigmodel-api-key  -> group=bigmodel-family
   └─ 与账号套餐一起由固定 Family UI 管理

普通 API Provider
├─ zai-api           -> group=standard-builtin
└─ bigmodel-api      -> group=standard-builtin
   └─ 从“添加供应商”进入，用户独立填写 API Key
```

两组 Provider 即使 Endpoint、API Schema 和推荐模型相同，也拥有不同 providerId、Personal Overlay、enabled、API Key、
模型成员和排序。它们不能共享或静默复制凭据。重复静态模型事实继续复用 Model Rules 的 matcher；不得为这四个
Provider 在 Runtime/Adapter 中增加 ID 特判。

现有账号 Provider ID 的 `builtin:` 前缀会一次性改为 `account:`，使物理身份与产品语义一致：

```text
builtin:zai-*       -> account:zai-*
builtin:bigmodel-*  -> account:bigmodel-*
builtin:offpeak-idle-plan
                    -> account:zai-offpeak-idle-plan
                     + account:bigmodel-offpeak-idle-plan
```

当前分支未发布，不保留旧 ID alias、dual-read 或持久化 migration；测试、Family Spec、ModelSelection fixture 和精确
Provider 常量必须原子切换。

Off-Peak 不再使用一个执行时动态跟随账号 Family 的共享 Provider，而是拆为两个完整 Provider：

```text
account:zai-offpeak-idle-plan
├─ group=zai-family
├─ visibility=hidden
└─ access.executionProtocol=off-peak

account:bigmodel-offpeak-idle-plan
├─ group=bigmodel-family
├─ visibility=hidden
└─ access.executionProtocol=off-peak
```

Account Built-in Overlay 根据当前结构化 Family/Coding Plan 连接只启用匹配的 Off-Peak Provider，另一个显式
`enabled=false`。Off-Peak 创建入口按当前 Family 取得对应精确 Provider；不存在“共享 Provider 在请求期换 Family”。
已保存任务继续持有原 `ModelSelection`：用户切换 Family 后，旧 Family Provider disabled，任务保留但不可调度；切回且
连接重新有效后恢复。系统不得把已保存任务静默迁移到另一 Family，也不得为其制造替代 ModelSelection。

Model Rules 保持单一有序数组：

```text
完整保守兜底
      |
      v
模型家族 A
├─ 仅 model match 的公共事实
├─ model + API 特化
├─ provider + model 特化
└─ 必要的 Endpoint 特化
      |
      v
模型家族 B ...
```

同一模型家族的相关规则连续放置。Runtime、Adapter、UI 不按具体 modelId、Provider ID 或 URL 再建立第二事实。当前
仓库配置只做轻量正确性复核：所有 Built-in 成员可解析成完整 Model Config，并检查 MCS、Native Web Search、媒体格式、
Reasoning、MFJS 是否已由 Rules 承接；不恢复严格历史对照表。

## 11. Access 与 Adapter 边界

以下事实归 Provider Access：

```text
access.executionProtocol = "off-peak"
```

官方版本请求安全校验的准入同样归 Provider Access，并在 Adapter 最终 HTTP transport 边界执行（具体字段与实现只在官方版本维护）。
它不进入 Model properties，不按 modelId 决定，也不替代 API Key 鉴权。

兼容裁决：

- OpenAI-compatible reasoning 依赖 canonical 历史与 SDK 原生编码，删除 ZCode 特殊回放；
- GitHub Copilot `omitMaxOutputTokens` 删除；
- Snowflake Cortex 当前不支持，删除 `maxOutputTokensRequestField`；
- 官方版本请求安全校验与 Off-Peak failure/execution protocol 从 Model Config 移入 Access；本轮不重构 Off-Peak 字符串错误；
- `requiresMfjsToolSchema` 留在 Model Config；启用时投影 Tool JSON Schema，投影失败直接报错；
- DeepSeek Anthropic 统一执行 canonical replay，不补造 synthetic empty thinking；
- 未进入当前基线的 Z.ai text/tool signature patch 不合入；如需支持必须先取得真实响应证据，并遵守“收到什么就回放什么”。

## 12. Client Config 边界

ZCode Built-in Provider Config 与 Built-in Model Config Rules 作为一个原子 `zcodeBuiltin` Release 发布。仓库/安装包内容
是拉取前和失败时兜底；每个 Environment 使用自己的 Active/LKG 与 Registry。Remote workspace 由 Remote Host 拉取、
解析并返回其配置，Renderer 不把 Local Host 配置冒充远程事实。

本 Todo 只要求新字段沿 Todo 18 的现有最小链路完整 round-trip，不顺手统一全部 `/client/configs` 消费者。

## 13. 实施顺序

1. 测试先行，建立五个 Source Schema、Provider `group`、Personal Rule union、Provider/Model 完整性和排序测试；
2. 调整 Config/Protocol/Repository 类型，删除 `enabledModelIds` 候选与 Model visibility；
3. 实现 `provider-model` 专属 Rule 生命周期和普通 `match` Rule 隔离；
4. 实现模型 enabled、三段 Model/Provider order、Builtin-wins 与保存规范化；
5. 整理 `zcode-builtin.json` 的 Provider 和 Rules 顺序，一次性切换 `account:` ID，拆分 Family/普通
   Z.ai/BigModel API Provider 和双 Off-Peak Provider，补齐模型默认 enabled 与官方停用项；
6. 迁移官方版本请求安全校验与 Off-Peak execution protocol 到 Access，清理已经裁决删除的 Adapter Compatibility；
7. 重构 Settings Facade、Mutation 与 UI，统一 Local/Remote Host 权威来源；
8. 删除 Preset/Catalog 来源推断、旧排序 trick、死字段、死 helper 和过时测试；
9. 根据最终实现将本 Todo 的事实逐项同步到 Design Tree、Feature Graph 和 superseded 旧文档；
10. 执行单测、类型检查、Lint、格式检查和受影响 E2E，提交 Conventional Commit。

## 14. 测试计划

### Config 与 Resolver

- 五个 Source Schema 的允许/拒绝矩阵；
- ZCode Built-in `group` 必填且不能为 `standard-personal`；Personal-only 固定 `standard-personal`，Overlay 不能改组；
- 普通 Built-in、Personal-only、Z.ai Family、BigModel Family 四组完整且互斥；
- 两个 Off-Peak Provider 由 Account Overlay 按当前 Family 互斥启用；
- Personal 禁止写 `builtinModelIds`，禁止正常保存 Built-in 重复 `modelIds`；
- Built-in/Personal 同 ID 时 Built-in-wins，单数组重复保留第一次；
- Model `enabled` 的 Built-in 默认、官方特化、Personal 后置覆盖、恢复默认与 JSON round-trip；
- `provider-model` 专属 Rule 与 `match` 通用 Rule 的顺序、删除、重命名和空 Rule 清理；
- Provider/Model enabled、完整性与 Provider visibility 形成 executable/selectable 的公式。

### 排序与生命周期

- Model/Provider 三段顺序；
- 新 Built-in 自动落在未排序 Built-in 段；
- 正常新增 Personal 原子更新成员、顺序和 `enabled=true` 专属 Rule；
- 调序保存补遗漏、删 stale、去重复；
- Personal Model rename/delete 原子更新成员、顺序和专属 Rule；
- Provider 删除删除 Overlay 和专属 Rules，不修改通用 Match Rules；
- disabled 成员在 Settings 保留位置、从 Selection/Registry 排除。

### Settings 与跨环境

- “已添加”只按 Personal Map membership；Provider disable 不回到添加候选，删除才回到候选；
- 添加 Built-in 与创建 Personal-only 均立即生效并写 `enabled=true`；
- 普通候选只来自 `group=standard-builtin`；两个 Family 不依赖 ID 白名单过滤；
- 两个 Family 不参与普通排序，且 UI 不提供 Provider enabled 开关；删除 Personal Overlay 后仍留在固定 Family 区域；
- 自定义 Provider 创建时不猜 API Schema、Endpoint 或模型；身份确认后立即创建不完整 Provider；
- Family API Key 与普通 Z.ai/BigModel API Provider 的 Personal Config、凭据、enabled 和顺序互相隔离；
- `account:` Provider ID 全链原子切换且无旧 alias；
- 切换 Family 后，旧 Family Off-Peak 任务保留但不可调度，切回后恢复；不得静默迁移 ModelSelection；
- Built-in Model 无删除按钮，Provider ID 全部只读，label 唯一；
- Effective placeholder、明确覆盖和恢复默认；隐藏字段无损保留；
- 上游有默认、上游无默认、Personal 覆盖和显式 clear 四种编辑状态互不混淆；
- Model enabled 使用 Switch，能力 Boolean 使用现有风格的 Toggle Chip/Selectable Tag；选中、未设置和 Personal 覆盖具有
  非纯颜色线索；
- `optionSpecs.reasoningLevel`、`optionSpecs.maxOutputTokens` 与 `reasoningMapping` 分别使用独立格式化 Personal JSON
  编辑器和只读 Effective 预览；每个编辑器直接替换自己的槽位，不在编辑器内部继续 Overlay 或按 key 合并；
- Model 编辑使用比例协调的大一档弹窗而非右侧详情/二级页面；Desktop 不做超宽布局，固定 Header/Footer，只有中间内容区
  滚动，Mobile 使用安全视口范围；
- Model 编辑弹窗使用本地 Draft 和手动保存；字段编辑不得提前写配置，取消/X/Esc 不产生 Mutation，保存只发起一次原子
  Mutation，并在持久化结果被 Registry 观察后关闭；失败时保留 Draft 和弹窗；
- Model 行的启停、排序和删除仍是即时原子操作，不与弹窗 Draft 混合；
- 紧凑 Model 行不渲染 Model ID 输入框或来源标签，保留外露的测试、编辑、启停和 Personal 删除操作；
- 普通点击 Model 行不打开编辑器；编辑只由铅笔进入；整行拖动不被行内按钮误触发，并支持指针阈值、触屏滚动与键盘
  等价操作；
- Provider 固定操作、Model 列表和完整 Model 编辑器覆盖 Zai Light/Zai Dark、Desktop 与 Mobile 布局及中英文；
- 修改 Model ID 先移动 Personal 专属 Rule，再刷新 Built-in Preview；
- Local workspace 使用 Local Host，remote workspace 使用 Remote Host；Renderer 不做本地兜底解析。

### Adapter 与回归

- 官方版本请求安全校验与 Off-Peak 按 Access 路由，Model Config 不再出现对应字段；
- 删除 Copilot/Snowflake/旧 OpenAI replay 后无 Runtime fallback；
- MFJS 开启、关闭和转换失败；
- DeepSeek A/B 真实请求结果形成可复现 fixture 后再决定字段去留；
- 普通请求、Compact、Memory、Child Agent、Off-Peak 都只使用 Active Model/Registry 事实。

## 15. 完成定义

- Design Tree、综述、Feature Graph 与实现一致，不再出现 `enabledModelIds`、Model visibility 或冲突 DTO 作为目标设计；
- Provider 只管理成员与顺序，Model Config `enabled` 是唯一模型执行门禁；
- Built-in 通用 Rule 给出完整默认，官方可以通过具体 Rule 默认停用旧模型；
- 设置页的单模型编辑全部落入结构化 Personal 专属 Rule；通用 Match Rule 不被生命周期操作猜测；
- “已添加 Provider”、Provider enabled 与 Provider 删除三种语义互不混用；
- Built-in 配置覆盖当前已知静态模型/API hardcode，不建立新的 Runtime 第二事实；
- Access 产品协议和 Model 请求兼容归属正确，已裁决删除项没有残留；
- `pnpm typecheck`、`pnpm lint`、相关单测、格式检查与受影响 E2E 通过；
- 使用 Conventional Commit 提交。
