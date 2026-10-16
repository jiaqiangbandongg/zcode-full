# 13 目标 Host 模型选择权威与旧准备链退役

> 状态：已完成
>
> 日期：2026-08-25
>
> 前置任务：[`todo-12-model-selection-validation-boundary-cutover.md`](./todo-12-model-selection-validation-boundary-cutover.md)
>
> 相关设计：[`../design/interaction/selection-state.md`](../design/interaction/selection-state.md)、
> [`../design/environment/environment.md`](../design/environment/environment.md)、
> [`../design/registry/registry.md`](../design/registry/registry.md)

## 0. 任务目标

模型选择的用户候选、模型 Option Specs、Configured Default 与新 Session 初始选择，统一来自**目标
Environment 的 Host**：本地 Workspace 使用 Local Host，远程 Workspace 使用 Remote Host。Renderer 不再从
Base Host 全局快照、临时 Agent App、Session Runtime Catalog 或 `configOptions` 反向推导目标 Environment 的
模型选择事实。

正式链路固定为：

```text
                         Target Workspace
                                |
                  +-------------+-------------+
                  |                           |
             Local Workspace            Remote Workspace
                  |                           |
                  v                           v
       Local Host ModelSelection    Remote Host ModelSelection
                  |                           |
                  +-------------+-------------+
                                |
                                v
                     Entry Draft / App Recent
                                |
                                v
                Sparse Structured ModelSelection
                                |
                                v
                  Target Worker Registry
                                |
                                v
                         Active Model
```

Host 负责选择事实，并在同一 View 中给出 Configured Default/Fallback 解析后的 `preferredSelection`；Renderer
只叠加 Composer/Draft 与 workspace App Recent。Worker Registry / ModelFactory 继续负责最终执行校验和 Model
创建。Host 不是第二个执行 Registry，Renderer 也不因取得 Host View 而获得构造或猜测 Model 的权限。

## 1. 已确认裁决

### 1.1 模型选择读取目标 Host

- 本地 Workspace 的模型候选读取 Local Host `IModelSelectionService`；
- SSH、WSL、Docker 与 Server Workspace 的模型候选读取对应 Remote Host
  `IModelSelectionService`；
- `remote-waiting`、断连或目标 Host 不可用时保持 loading/unavailable，绝不回退 Base/Local Host；
- Remote Host 返回自己的 Provider/Model View，Desktop 不向远端注入本地 Registry Snapshot；
- Worker 在执行时仍使用所属 Environment 的 Registry/ModelFactory 重新校验 Selection，Host 选择结果不能
  绕过最终 fail-closed。

### 1.2 Workspace Key 与 App Recent

App Recent 的隔离范围固定为：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
App Recent scope = App x workspaceKey
```

- 本轮不新增 `environmentId`，也不建立新的 Host identity repository；
- 远程 Workspace 必须贯穿现有 `workspaceIdentity`，本地 Workspace 允许 fallback 到 `workspacePath`；
- `remoteSessionId` 仍用于远程连接/会话路由，但不代替稳定的 Workspace identity；
- 相同 `workspacePath` 但不同 `workspaceIdentity` 的远程 Workspace 不能串用 Recent；
- `workspacePath` 继续只承担文件、命令、Git 和路径展示语义。

App Recent 保存结构化且稀疏的 `ModelSelection`，只在 App 接受普通用户 Submission 时更新。菜单浏览、模型
点击、Goal 自动续轮、Background、Off-Peak 和 Subagent 不写 App Recent。

### 1.3 Host View 原子返回候选与首选 Selection

- Configured Default 继续属于目标 Workspace；
- Desktop/Web Renderer 不直接读取 `.zcode/v2/model-selection.json`；
- 目标 Host 读取 Workspace 自己的 Configured Default，并与当前用户可见 View 原子解析首选 Selection；
- Prompt CLI 与 TUI 不需要启动 Host/RPC，但必须复用同一 provider-domain preferred resolver 和 Workspace
  repository；
- Fallback 只使用当前 Host View 中 visible、enabled、selectable 的模型，hidden Provider/Model 不参与；
- Fallback 只初始化本次 Draft/Session，不覆盖持久 Configured Default。

Host 不新增独立 `resolveInitialSelection()` RPC，而是在同一份 `ModelSelectionView` 中返回候选、Option Specs
和 `preferredSelection`。`preferredSelection` 已经完成 Host Configured Default 与 Fallback 的解析；Renderer
只叠加自己拥有的 Composer/Draft 和 workspace App Recent：

```text
App 新 Session

已有 Composer / Draft
  > 当前 View 中仍可选的 workspace App Recent
  > Host preferredSelection

Prompt CLI / TUI 新 Session

显式 Draft / 参数
  > domain preferredSelection
```

恢复已有 Session 不读取 Configured Default，继续以持久 Session Selection 为准。

### 1.4 正式选择与持久化统一使用稀疏、结构化 `ModelSelection`

以下正式状态、协议与持久化不再用 `model` 字符串和独立 `thoughtLevel` 拼装选择：

- Composer Draft、App Recent 与 Session Selection；
- Automation record；
- Repo Wiki generation settings；
- Bot model preference/config；
- Off-Peak task selection；
- Custom、Workspace 与 Built-in Subagent model override；
- 其他会在未来创建 Model 的产品配置。

目标结构唯一为：

```ts
interface ModelSelection {
  providerId: ProviderId;
  modelId: ModelId;
  options?: {
    reasoningLevel?: string;
    maxOutputTokens?: number;
  };
}
```

- `ModelSelection.options` 只保存用户或调用者显式指定的 option；没有显式指定时不复制 Option Spec 默认值；
- `options` 和每个叶子都可缺省；`options: {}` 归一化为字段缺失；正式 Selection 不保存 option `null`；
- patch/update API 可以用 `null` 表达“清除显式覆盖”，repository 必须删除相应叶子而不是持久化 `null`；
- 用户显式选择一个恰好等于当前默认值的 option，仍是明确 pin，必须保存；只有“使用默认值”才删除叶子；
- `inherit` 使用外层字段缺失或明确的产品 union 表达，不作为伪模型字符串；
- picker 可以在组件内部使用 string key/value，但 `onSelect` 边界立即还原为 `ModelSelection`；
- CLI 参数和已发布 Legacy importer 可以解析字符串，正式 Domain、RPC、Registry、Runtime 与新写入不再保存
  字符串选择；
- `modelSelectionSchema` 是结构化对象的唯一严格 Schema。UI、Services、Provider Node 与 Bootstrap 不各自
  复制 parser；
- 已发布持久格式如需兼容，只在对应 repository/importer 边界单向转换；分支内未发布格式不保留双读、双写或
  所谓 v1/v2 兼容。

ModelFactory 是默认值解析边界：

```text
产品 Draft / Config / Record
        |
        | modelSelection?：产品是否固定模型
        v
ModelSelection
|- providerId + modelId
`- options：只含显式覆盖
        |
        | + 当前 Model Config Option Spec 默认值
        v
Target Worker ModelFactory
        |
        v
Active Model.options：完整、不可变的执行事实
```

解析出的默认值不得反写 Composer、Session、App Recent 或产品 record。Config 默认值变化只影响以后根据
稀疏 Selection 创建的新 Model，不热改已有 Active Model。历史审计若需要证明实际 option，应保存 Active
Model/execution facts，而不是日后用新默认值重新解释旧 Selection。

### 1.5 Subagent 配置属于各自 Environment，本轮 UI 只管理本地

每个 Environment 独立拥有和落盘自己的 Subagent 配置：

```text
Local Environment
|- Local user Subagent config
|- Local workspace Subagent config
`- Local built-in overrides

Remote Environment
|- Remote user Subagent config
|- Remote workspace Subagent config
`- Remote built-in overrides
```

本轮 Settings UI 的边界固定为：

- 只通过 Local Host `ISubagentsService` 管理 Local Environment 配置；
- 候选模型与 Option Specs 只读取 Local Host Model Selection View；
- 不列出远程 Workspace 作为 Subagent 配置编辑 scope；
- 激活远程 Workspace 时不能让用户误以为正在编辑远程 Subagent；入口必须保持明确的“本地配置”语义，或在
  远程上下文中显示远程管理暂不支持；
- 不通过 Desktop 把本地 Subagent Markdown/state 写入 Remote Environment；
- Remote Agent 执行时继续读取 Remote Environment 已经存在的 Subagent 配置，并用 Remote
  Registry/ModelFactory 校验和创建 child Model；
- 远程 Subagent 配置浏览、编辑、同步和冲突处理是后续独立产品能力，不在本 Todo 中设计。

### 1.6 与 Todo 12 的校验边界

本 Todo 不恢复通用 `IModelSelectionService.validate()`：

```text
Host 用户选择面
|- getView()
`- onDidChange()
        |
        `- 同一 View 返回 visible/selectable candidates、Option Specs 与 preferredSelection

执行面
ModelSelection
    |
    v
Target Worker Registry
    |
    v
ModelFactory 最终完整校验
```

- Conversation 将结构化 Selection 提交给 Worker，最终失败由 ModelFactory 报告；
- Renderer 可以根据 Host View 展示 unavailable，但不复制一套权威 option validator；
- Automation、Repo Wiki、Bot、Off-Peak 与 Subagent 在各自 Host 产品 Service 的保存/派发边界进行必要的窄
  提前检查，防止保存明显无效配置或浪费产品资源；
- 产品提前检查不进入公共用户 Facade，也不替代 Worker 最终校验；
- hidden Off-Peak 继续使用 Host 内部 Registry/scoped View，不进入普通用户 View。

### 1.7 与既有阶段性文档的关系

本 Todo 记录的是后续已经确认的新裁决，以下旧文档中的阶段性范围不能阻止本 Todo 收口：

- Todo 09 的“暂不改 Task 数据库形态”只约束 Todo 09 当时的实施范围。本 Todo 已确认正式产品持久化统一使用
  结构化 `ModelSelection`，因此 Off-Peak repository/API 在本 Todo 中一起迁移，不再长期保留
  `model + thoughtLevel` 投影；
- `docs/subagents-built-in-model-overrides.md` 中通过 `workspace/readState` Runtime Catalog 对账模型候选和
  reasoning 的表述属于旧实现事实。本 Todo 实施时必须改为：Settings 读取 Local Host View，Remote
  Subagent 执行读取 Remote Environment 自己的 Registry；
- Todo 12 的最终校验边界继续有效。本 Todo 只增加目标 Host 路由和 Host View preferred 解析，不恢复通用
  `IModelSelectionService.validate()`。

这些覆盖关系只针对模型选择来源、持久化形态和校验边界，不顺带修改 Todo 09 的 Ticket/调度语义，也不设计
远程 Subagent 配置管理。

## 2. 当前问题

### 2.1 全局 Base Host View 污染远程选择

当前 Root 只连接一次 `modelSelectionService`，普通会话、Automation、Subagent 与 Repo Wiki 通过全局
`useModelSelectionView()` 读取同一 Snapshot。`SessionPane` 的 readiness gate 还显式绑定
`baseWorkspaceServices.modelSelectionService`。

这会形成：

```text
Desktop Base Host Registry
        |
        v
Remote Workspace picker
        |
        v
Remote Worker Registry / execution
```

两边配置不同时可能展示不存在的模型、漏掉远端模型，或在发送时才被 Remote Worker 拒绝。

### 2.2 临时 App 被当作无 Session 模型投影器

`workspace/readState` 在没有活动 Session 时创建完整临时 `ZCodeApp`，注入 state-only 假 Adapter，再通过
`mapSessionSettings()` 生成 `model + thought + configOptions`。Conversation 首条消息只是最常见入口；同一
链路还被 Automation preview、Repo Wiki、Subagent reconciliation、Bot、Off-Peak 用户模型与 Git Commit
sidecar 使用。

Host View 已经包含 Model Config 与 Option Specs，不应再启动 Agent App/Session 来查询模型静态事实。

### 2.3 默认值存在重复 owner

当前同时存在：

- Renderer 全局 `localStorage` 模型与 thought 偏好；
- Agent Server `workspaceModelPreferences.defaultModel/lastUsedModel/defaultThoughtLevel`；
- Environment `.zcode/v2/model-selection.json` Configured Default；
- Active/temporary App 当前模型投影。

这些状态分别模拟 App Recent、Configured Default 和 Session Selection，导致初始化优先级、远程隔离和恢复
语义无法机械证明。

### 2.4 字符串选择与重复 Schema 仍在扩散

`provider/model$reasoning` 无法 round-trip `maxOutputTokens`，且 UI、Services、Provider Node、Contracts 与
Bootstrap 存在重复 format/parse/Schema。即使当前普通发送已使用结构化 Selection，产品配置、预览和兼容
mutation 仍会把完整 Selection 拆散后重新猜测。

### 2.5 Effective Option 被反写成显式 Selection

当前 ModelFactory 已经可以在 Selection 未提供 option 时使用 Model Config 默认值，但部分恢复和切换链路会
先解析 Effective Option，再把结果写回 Selection。例如 Session restore 会把缺省
`maxOutputTokens` 物化进 Selection，使“跟随默认值”悄悄变成“固定旧值”。

```text
错误

Sparse Selection
    |
    | + Model Config Default
    v
Effective Option
    |
    `--------------------> 反写 Selection

正确

Sparse Selection --------------------------> 原样保持
    |
    | + Model Config Default
    v
Active Model.options ----------------------> 本次执行完整事实
```

同类风险必须检查 Session restore、Model switch、Automation/Off-Peak dispatch、Compact/Memory/Subagent、
CLI 参数、RPC round-trip 和 Draft 持久化。UI 展示当前默认值不等于用户显式选择；只有真实编辑动作才产生
option override。

### 2.6 同一个类型不等于同一个产品 owner

统一 `ModelSelection` 只统一“如何引用未来 Model”，不能把各产品状态并成一个共享 Selection Store：

| 产品状态          | `modelSelection` 缺失的含义                                   | 解析时机/owner                  |
| ----------------- | ------------------------------------------------------------- | ------------------------------- |
| Composer / Draft  | 按初始化优先级取得初值                                        | Renderer Draft                  |
| Session           | 新 Session 首次执行前可缺省；执行后必须保存已接受的 Selection | Session Store/Core              |
| Automation        | 创建表单时解析目标 Host preferred，并固化具体 Selection       | Automation record/service       |
| Repo Wiki         | 未指定时使用目标 Workspace 首选                               | 每次 generation 提交边界        |
| Bot               | 未指定时使用 Bot context 对应 Workspace 的产品默认规则        | Bot config/task submission      |
| Subagent override | 继承 Parent Active Model，不重新查询 Workspace 默认           | Parent/child execution boundary |
| Off-Peak          | 创建任务时形成自己的精确 provider/model Selection             | Off-Peak record/dispatcher      |

`modelSelection` 整体缺失与 `modelSelection.options` 缺失是两个不同状态：前者表示产品没有固定模型，后者表示
模型身份已经固定但 option 跟随 Model Config 默认值。实现不得用同一个空字符串、`inherit` 伪 ID 或全局
fallback helper 混淆它们。

Automation UI 不保留“跟随 Workspace”或“默认模型”虚拟态。创建表单、缺少 Selection 的旧记录以及切换目标
Workspace 时，使用目标 Host `preferredSelection` 初始化具体 provider/model，并按目标模型 Option Spec 解析出
具体 reasoning；保存时始终写入完整 `modelSelection`。后续 Workspace preferred 改变不影响已经保存的
Automation。

## 3. Impact Brief

### 3.1 Feature Summary

| 字段             | 结论                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| Developer intent | 模型选择读取目标 Host，统一稀疏结构化意图，删除 Base Host 全局候选、临时 App 目录和字符串选择旁路             |
| Capability       | Model Selection、Provider Registry、Environment、Conversation、Automation、Repo Wiki、Bot、Off-Peak、Subagent |
| Change layer     | `option-source`、`draft-default`、`validation`、`persistence`、`recovery`                                     |
| Operating mode   | planning / implementation-handoff                                                                             |
| Primary seeds    | `IModelSelectionService`、`useModelSelectionView`、`workspace/readState`、`ModelConfigSelect`                 |
| Out of scope     | Provider Provisioning、Access/Auth、模型请求编码、Queue/Goal 状态机、远程 Subagent 配置管理                   |

### 3.2 UI Surface Matrix

| 用户场景                  | 候选/默认来源                  | 草稿 owner            | Commit sink                | 最终权威                            | 本 Todo 结果                        |
| ------------------------- | ------------------------------ | --------------------- | -------------------------- | ----------------------------------- | ----------------------------------- |
| Conversation 本地         | Local Host View/preferred      | Composer Draft        | Submission command         | Local Worker Registry/ModelFactory  | 删除临时 App 目录                   |
| Conversation 远程         | Remote Host View/preferred     | Composer Draft        | Remote Submission command  | Remote Worker Registry/ModelFactory | 禁止 Local fallback                 |
| Automation                | 表单选中 Workspace 的目标 Host | Automation form       | Automation Service/record  | 执行 Environment ModelFactory       | 结构化持久化；取消不改 Conversation |
| Repo Wiki                 | 当前项目目标 Host              | generation settings   | Repo Wiki Service          | 目标 Environment ModelFactory       | 删除 deferred Session preview       |
| Bot                       | Bot context 对应目标 Host      | Bot command draft     | Bot config/Task submission | 目标 Environment ModelFactory       | 删除 workspace state 模型投影       |
| Off-Peak                  | Local Host scoped hidden View  | Off-Peak form         | Off-Peak Service/record    | Local Worker ModelFactory           | 保持本地产品边界；结构化持久化      |
| Subagent Settings         | Local Host View                | Subagent form         | Local `ISubagentsService`  | Local Environment config            | 不管理 Remote config                |
| Remote Subagent execution | 无本轮 UI                      | Remote profile/config | Agent tool                 | Remote Worker ModelFactory          | 读取远端自有配置                    |
| Git Commit sidecar        | 请求目标 Host 初始/显式选择    | 单次请求              | text generation service    | 目标 Environment ModelFactory       | 不再读 temporary App                |

### 3.3 State Owners And Commit Sinks

| 状态/事实            | 权威 owner                            | 镜像/缓存                              | 写入事件                             |
| -------------------- | ------------------------------------- | -------------------------------------- | ------------------------------------ |
| Model Selection View | 目标 Host Provider Registry Facade    | 按 Host service 实例缓存的 UI Snapshot | Registry revision 变化               |
| Composer Draft       | Entry/Renderer                        | Draft persistence                      | 用户编辑                             |
| App Recent           | App x workspaceKey                    | Renderer memory/local persistence      | App 接受普通 Submission              |
| Configured Default   | 目标 Workspace repository             | Host View 解析 preferredSelection      | 独立配置写入                         |
| Session Selection    | Session Store/Core                    | UI projection                          | Submission 启动 Loop / Guide 接受    |
| Active Model         | Agent Loop                            | 无持久化                               | ModelFactory 创建                    |
| 产品选择             | 各产品 Service/Repo                   | 各自表单 draft                         | 用户保存或产品创建                   |
| Subagent Config      | 各 Environment 的 Subagent repository | Settings 本轮只看 Local                | Local UI 保存或 Environment 自己写入 |

### 3.4 Feature Relationships

| 等级           | 关系                                               | 要求                                          |
| -------------- | -------------------------------------------------- | --------------------------------------------- |
| must-inspect   | Workspace target -> Host service resolution        | local/remote 精确路由，断连不回退             |
| must-inspect   | Host View -> Conversation/Automation/Repo Wiki/Bot | 候选与 Option Specs 不再读取 temporary App    |
| must-inspect   | App Recent -> workspaceKey                         | 远程 identity 隔离，不按 path 或 session 串用 |
| must-inspect   | Product persistence -> ModelSelection Schema       | 新写入只保留显式 options，不用字符串拼接      |
| must-inspect   | Selection -> ModelFactory defaults                 | 默认值只进入 Active Model，不反写 Selection   |
| must-inspect   | Subagent UI -> Local Host                          | UI 不读取或覆盖 Remote Environment config     |
| must-inspect   | Submission -> Worker ModelFactory                  | Host 选择不替代最终校验                       |
| should-inspect | Configured Default -> Host resolver                | invalid default 进入 fallback，不覆写文件     |
| invariant-only | Queue/Guide/Edit/Retry                             | 保持当前结构化 Selection 与 admission 顺序    |
| invariant-only | desktop continuous/mobile replayable               | 不新增 runtime、queue 或恢复 owner            |
| invariant-only | Provider Provisioning                              | 不借选择路由实现配置/凭据同步                 |

### 3.5 Graph Drift

当前 Feature Graph 仍把部分模型候选边连接到旧 `useModelProviders`/app-global metadata，并把 Workspace
Subagent reasoning 描述为 `workspace/readState` Runtime Catalog。本 Todo 的确认语义是：普通产品候选来自目标
Host；Subagent Settings 只来自 Local Host。实施时更新这些 code seed 和旧条件，不把尚未实现的符号伪装成
当前代码事实。

## 4. Host Contract 目标

### 4.1 用户 View

`ModelSelectionView` 至少提供：

```ts
interface ModelSelectionView {
  revision: number;
  providers: readonly ModelSelectionProviderView[];
  preferredSelection?: ModelSelection;
}
```

Model View 中的完整 Model Config 已包含 `properties` 与 `optionSpecs`。UI 直接读取这些事实展示输入格式、
reasoning 与 max output 选项，不创建 Session 获取同一事实。`preferredSelection` 必须属于同一 revision 的
visible、enabled、selectable View；空 View 时允许缺失。

### 4.2 初始选择解析

Host Service 不增加第二个 resolver RPC：

```ts
interface IModelSelectionService {
  readonly onDidChange: Event<ModelSelectionView>;
  getView(): Promise<ModelSelectionView>;
}
```

Host 在构造 View 时原子解析 Configured Default 与 fallback，得到 `preferredSelection`。Entry 自己持有的
workspace App Recent 不上传给 Host：Renderer 只检查它是否仍属于当前 View；有效则优先，无效或不存在则采用
`view.preferredSelection`。这种 candidate matching 只服务初始展示，不解析 hidden 精确执行选择，也不成为
ModelFactory 的替代 validator。

### 4.3 Target-scoped UI Hook

目标 UI 入口统一通过 workspace target 解析 Service：

```text
workspacePath + workspaceIdentity + remoteSessionId + remoteTarget
        |
        v
useWorkspaceServicesResolution
        |
        +-- local-ready  -> Local Host IModelSelectionService
        +-- remote-ready -> Remote Host IModelSelectionService
        `-- remote-waiting/disconnected -> unavailable（不回退）
```

Snapshot/cache 按 target service 实例与 `workspaceKey` 隔离。切换 target 时取消旧订阅并丢弃迟到 View；
不同 Host 即使 revision 数字相同也不能相互覆盖。

## 5. 删除与修改范围

### 5.1 UI 与 Services

- 删除 Root 单例 `modelSelectionSnapshot` 与 `useRootModelSelectionSnapshot`；
- 将无 target 的 `useModelSelectionView()` 改为 target-scoped 读取；
- `SessionPane` readiness gate 使用当前 pane 的 target Host，而不是 `baseWorkspaceServices`；
- `ModelConfigSelect` 内部 value 与业务 `ModelSelection` 分离，调用方不再重复 decode；
- Automation 在表单切换 Workspace 时原子切换 Host View，迟到结果不得写回新 target；
- Repo Wiki 使用当前项目 Host View；删除 deferred draft Session reasoning preview；
- Bot 使用 Bot context 的目标 Host；远程连接缺失时 fail-closed；
- Git Commit sidecar 由目标 Host 初始/显式 Selection 提供选择，不读取 workspace App 投影；
- Subagent Settings 固定注入 Local Host Model Selection/Subagents Service，并移除远程 scope。

### 5.2 Agent Protocol 与临时 App

- `workspace/readState` 不再返回或承担 Model Selection/Model Option Specs；
- 删除 `workspaceModelPreferences.defaultModel/lastUsedModel/defaultThoughtLevel`；
- 删除 `workspace/setDefaultModel`、`workspace/setDefaultThoughtLevel` 及其 RPC、adapter、mock 和测试；
- 保留非模型的 mode/slash command 需求，但通过自己的最小接口读取；
- 无其他消费者后删除 `createWorkspaceStateOnlyModelAdapter()` 和仅为读取状态创建临时 `ZCodeApp` 的路径；
- Session active projection 继续报告本 Session 实际 Selection，不再兼任 Workspace 默认目录。

### 5.3 结构化持久化

- App Recent 使用 `workspaceKey -> ModelSelection`；
- Automation、Repo Wiki、Bot、Off-Peak 与 Subagent 的 shared types、strict schema、RPC 和 repository 使用
  `ModelSelection`；
- 正式 repository 只保存显式 option；空 `options` 和清除后的空叶子必须归一化掉；
- 删除任何把 ModelFactory/Option Spec 解析出的默认值反写 Selection 的恢复、预览或保存 helper；
- Custom Subagent Markdown frontmatter 与 Built-in override state 使用一个结构化 Selection 字段，删除
  model/thought 双 map；
- 已发布旧存储只在 repository/importer 读取边界转换，写回只产生新结构；
- `formatModelSelection()` 只保留 CLI/picker/legacy 边界所需的明确变体；不得由业务 barrel 继续诱导正常代码
  round-trip；
- 删除重复 `modelSelectionSchema`、`parseModelSelectionValue` 和业务层 local parser。

### 5.4 明确保留

- Provider Registry、ModelFactory、Active Model 和 Adapter 执行主链；
- Session Submission、Queue、Guide、Edit、Retry 当前结构化 intent；
- hidden Off-Peak Provider 的 scoped View 与派发前窄检查；
- App Recent、Configured Default、Session Selection、Active Model 不同写入时机；
- Prompt CLI/TUI 的 in-process Entry，不强制为它们启动 Host RPC。

## 6. 实施顺序

### Step A：先同步正式 Design、Feature Graph 与失败测试

1. 更新 `selection-state.md`、`environment.md`、`interaction.md` 和相关 Subagent/Automation/Repo Wiki spec；
2. 执行 Todo 12 或与其原子协调，先确保不会重新引入通用 Facade `validate()`；
3. 更新 Feature Graph 中目标 Host、workspaceKey、Local-only Subagent 管理和产品持久化关系；
4. 先写 Host View preferred、远程 target 路由、App Recent 隔离、稀疏 option 和结构化 repository 的失败测试。

### Step B：Host View 首选 Selection

1. 将 Configured Default repository 注入 Host Model Selection Service；
2. 在同一 revision 的 `ModelSelectionView` 中原子返回候选、Option Specs 和 `preferredSelection`；
3. Renderer 用 `workspaceKey` 读取 App Recent，并在当前 View 中匹配后决定是否覆盖 Host preferred；
4. Prompt CLI/TUI 复用同一纯 domain preferred resolver；
5. 验证 hidden/disabled、不合法 options、空 View 与 Registry revision 变化；
6. 机械证明没有新增 `environmentId` 或独立 `resolveInitialSelection()` RPC。

### Step C：Target-scoped View 基础设施

1. 实现按目标 Services 订阅的 hook/store；
2. 本地连接 Local Host，远程连接 Remote Host；
3. 切换 Environment 时清除旧 Snapshot，迟到事件按 connection generation 丢弃；
4. remote-waiting/disconnected 不回退；
5. 删除 Root 全局 Snapshot。

### Step D：Conversation 与 App Recent

1. Composer、Toolbar、readiness gate 切到 target Host；
2. Draft 初始化使用 workspace-scoped Recent + Host View preferredSelection；
3. App 接受普通 Submission 后写结构化稀疏 Selection；
4. Registry 更新导致 Draft 失效时保留并展示 unavailable；
5. 验证第一条消息与后续消息使用同一目标 Host/Worker 组合。

### Step E：Selection 稀疏 Option 语义

1. 先为 Schema/repository 增加缺省叶子、partial options、空对象归一化、patch `null` 清除测试；
2. 证明 ModelFactory 对每个缺省叶子使用当前 Model Config 默认值，并在 Active Model 中冻结完整 options；
3. 删除 Session restore 和 Model switch 中把 Effective Option 反写 Selection 的逻辑；
4. UI 将“显示默认值”与“显式选择值”分开；选择“默认”删除叶子，显式选择与默认相同的值仍保存；
5. 切换 provider/model 时不无脑继承源模型 options；新模型只接收用户针对它显式确认且通过 Option Specs 的值；
6. execution history 需要实际 option 时读取/保存 Active Model facts，不物化 Selection 默认值。

### Step F：Automation、Repo Wiki、Bot、Off-Peak 与 sidecar

1. 按各自 target 切换 Host View；
2. reasoning/output options 直接读取 View Model Config；
3. 删除 Automation/Repo Wiki deferred Session preview；
4. 将产品 Service/Repo 改为结构化 Selection；
5. Automation 表单把目标 Host preferred 解析成具体 Selection；没有 preferred 时明确不可提交，不引入
   `inherit`、空字符串或“默认模型”伪 ID；
6. 保持各产品 Draft、取消、保存、调度和执行 owner 不变。

### Step G：Subagent 本地配置边界

1. Settings 只注入 Local Host Model Selection 与 Subagents Service；
2. 从 scope 列表排除 Remote Workspace，补充本地配置/远程暂不支持展示；
3. Local user/workspace/built-in 配置结构化落盘；
4. Remote runtime 继续读取远端已有配置，不新增 Desktop 同步；
5. 删除 Subagent `workspace/readState` catalog reconciliation。

### Step H：旧准备链与字符串归零

1. 删除 model/thought workspace defaults 与相关 RPC；
2. 将 mode、slash commands 从 `workspace/readState` 中拆到最小非模型接口；
3. 删除 temporary App/state-only Adapter；
4. 删除 Model/Thought `configOptions` 目录依赖；
5. 删除重复 Schema/parser/format helper；
6. 用 `rg`、`dep:refs`、Knip 与 TypeScript 确认无生产残留。

### Step I：验证、回写与提交

1. 执行受影响 Provider、Services、Shared、UI、Bootstrap、Desktop 与 Web 单测；
2. 执行 local/remote、同路径不同 workspaceIdentity、重连、首发/后续发送和产品表单代表 E2E；
3. 执行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和 `pnpm knip`；
4. 回写本 Todo 状态、实现结果、删除清单和未覆盖风险；
5. 以 Conventional Commit 提交。

## 7. 已接受用例与剪枝

| Case ID | Setup                                                       | Action                       | Assertions                                                     |
| ------- | ----------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------- |
| HMS-01  | Local Workspace，Local Host 有模型 A                        | 打开新 Draft                 | 候选和初始 Selection 来自 Local Host                           |
| HMS-02  | Remote Host 只有模型 B，Local Host 只有 A                   | 打开远程 Draft               | 只显示 B；不显示或 fallback 到 A                               |
| HMS-03  | Remote Host waiting/disconnected                            | 打开模型菜单/发送            | loading/unavailable；不调用 Local Host                         |
| HMS-04  | 两个远程 Workspace path 相同但 workspaceIdentity 不同       | 分别接受 Submission          | App Recent 按 workspaceKey 隔离                                |
| HMS-05  | App Recent 在目标 Host View 已失效，preferred 有效          | 创建新 Draft                 | 采用 Host preferred，不覆写 Recent/Default                     |
| HMS-06  | Recent 失效且 Host View 无 preferred                        | 创建新 Draft                 | 保持 unavailable；Renderer 不自行选择首项                      |
| HMS-07  | Draft 创建后 Registry 删除当前模型                          | 继续编辑                     | 保留原 Selection 并显示 unavailable，不静默换首项              |
| HMS-08  | 已有 Session Selection 失效                                 | 恢复/下一次执行              | 保留 Session 意图；ModelFactory 明确失败，不读 Default         |
| HMS-09  | Queue/Guide/Edit/Retry 携带部分显式 options                 | admission/执行               | Selection 不丢显式叶子，也不补写缺省叶子                       |
| HMS-10  | Automation 在本地与远程项目间切换                           | 切 target、选模型、取消/保存 | View 随 Host 切换；取消不改 Conversation；保存结构化 Selection |
| HMS-11  | Repo Wiki 选择 reasoning 模型                               | 打开/生成                    | Option Specs 来自目标 Host；不创建 preview Session             |
| HMS-12  | Settings 在远程 Workspace 上下文打开 Subagent               | 查看/编辑入口                | 只表达本地配置或远程不支持；不读写 Remote config               |
| HMS-13  | Remote Agent 已有自己的 Subagent config                     | 触发 child                   | 读取 Remote config，由 Remote ModelFactory 创建 Model          |
| HMS-14  | 产品旧存储含 model + thought                                | repository 读取后保存        | 单向转成 ModelSelection，新写入不再拆分字段                    |
| HMS-15  | Desktop continuous 与 Mobile replayable 控制同一远程任务    | 选择并发送                   | 使用同一 Remote Host；不改变 queue/snapshot/replay owner       |
| HMS-16  | Selection 只固定 provider/model，Model Config 有默认 option | 创建 Model                   | Active Model 得到完整默认值；Selection 保持无 options          |
| HMS-17  | 用户显式选择与当前默认相同的 reasoning                      | 保存并重载                   | 显式叶子保留；后续默认变化不改变该 pin                         |
| HMS-18  | patch 清除最后一个显式 option                               | 保存并重载                   | 不持久化 `null` 或 `options: {}`                               |
| HMS-19  | Session restore 遇到缺省 maxOutputTokens                    | 恢复并创建 Model             | 默认值只进入 Active Model，不反写 Session Selection            |
| HMS-20  | 从模型 A 切到 Option Specs 不同的模型 B                     | 选择 B                       | 不继承 A 的 option；只保存针对 B 的显式选择                    |
| HMS-21  | Automation 新建表单，目标 Host 存在 preferredSelection      | 不手动选模直接保存           | 保存具体 provider/model/reasoning；按钮可提交                  |
| HMS-22  | Automation 已保存具体 modelSelection                        | 修改 Host preferred 并派发   | 继续使用保存的 Selection，不随 Workspace preferred 漂移        |

明确剪枝：

- 不展开 Provider API 类型组合；本 Todo 不改变 Adapter 编码；
- 不实现远程 Subagent Settings CRUD、同步或冲突处理；
- 不把 Off-Peak hidden View 合并进普通 View；
- 不改变 Queue、Goal、Compact、Background、权限或恢复状态机；
- 不为 Prompt CLI/TUI 启动额外 Host 进程；
- 不为未发布分支内格式建立兼容版本矩阵。

## 8. 测试计划

### 8.1 Unit / Service

- workspaceKey fallback、相同 path 不同 remote identity 隔离；
- 同一 Host View 的 preferred/default/fallback/unavailable 优先级与 revision 一致性；
- visible/hidden、enabled/disabled、invalid options 与 revision 变化；
- target services local/remote/remote-waiting 路由；
- 旧订阅迟到、相同 revision 跨 Host 和 target 快速切换；
- App Recent 结构化 round-trip 与 workspaceKey；
- Selection partial options、空对象归一化、patch `null` 清除和显式 default-value pin；
- ModelFactory 缺省 option 解析、Active Model 冻结，以及 restore/switch 不反写 Selection；
- Automation/Repo Wiki/Bot/Off-Peak/Subagent repository 结构化 round-trip；
- Automation preferred 初始化、具体 Selection 保存、展示和派发一致性；
- legacy importer 只读转换与新写入零字符串选择；
- Subagent Settings Local-only scope。

### 8.2 Integration / E2E

- Local Host A / Remote Host B 的差异候选与真实首发请求；
- 远程重连后 workspaceIdentity、Recent、View 与 Selection 保持；
- 不同 workspaceKey 的 Workspace 不共享 Recent；
- 首条消息与已有 Session 后续消息均由目标 Worker 创建 Model；
- Automation、Repo Wiki、Bot 与 Git Commit 使用请求目标 Environment；
- Subagent 本地 CRUD 与 Remote runtime 自有配置隔离；
- Desktop continuous 和 Web/Mobile replayable 代表路径。

### 8.3 机械门禁

实施完成后以下生产概念必须归零或只剩明确兼容边界：

```text
modelSelectionSnapshot
useRootModelSelectionSnapshot
GLOBAL_AGENT_MODEL_STORAGE_SCOPE
workspaceModelPreferences.defaultModel
workspaceModelPreferences.lastUsedModel
workspaceModelPreferences.defaultThoughtLevel
workspace/setDefaultModel
workspace/setDefaultThoughtLevel
createWorkspaceStateOnlyModelAdapter
previewAutomationThoughtLevelOption
prepareRepoWikiThoughtCatalog
useSubagentWorkspaceCatalogReconciliation
```

`formatModelSelection`、`parseModelSelection`、`model` + `thoughtLevel` 不能简单按名称全局归零；CLI 参数、历史
importer、非模型业务字段可能合法存在。必须逐消费者确认它是否表达未来 Model 选择，只有正式选择才强制迁移。

## 9. 完成定义

1. 所有普通模型候选和 Option Specs 来自目标 Host；
2. Remote Workspace 的 UI、默认值和产品入口不再读取 Local/Base Host Registry；
3. App Recent 按 `workspaceKey` 隔离并保存稀疏结构化 Selection，不新增 `environmentId`；
4. Configured Default 与 fallback 由目标 Host 解析并随同一 View 返回 `preferredSelection`，不增加第二个
   resolver RPC；Prompt CLI/TUI 复用同一纯 domain 解析；
5. Conversation、Automation、Repo Wiki、Bot、Off-Peak 与 Subagent 的正式选择使用结构化
   `ModelSelection`，并只持久化显式 option；
6. Subagent 配置由各 Environment 独立落盘，本轮 Settings 只管理 Local Environment；
7. `workspace/readState`、临时 App 和 `configOptions` 不再承担模型目录、模型能力或模型默认值；
8. Todo 12 的 ModelFactory 最终校验边界保持成立，不恢复通用用户 Facade validator；
9. local/remote、重连和跨 workspaceKey 缓存不存在 Local fallback 或身份串用；
10. Desktop continuous、Mobile replayable、Queue、Goal、Session 恢复与 Provider Provisioning 不变；
11. 相关 Design、Feature Graph、测试、实现日志与删除审计已经回写；
12. `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和相关测试全部通过，并完成 Conventional Commit。

## 10. 非目标

- 不实现远程 Provider/凭据 Provisioning；
- 不实现远程 Subagent 配置 UI、同步或冲突合并；
- 不改变 Account Access、Request Auth 或服务端最终授权；
- 不改变 Adapter 请求编码、Retry、Stream Recovery 或 Telemetry；
- 不改变 Model Properties、Provider 成员、enabled/visibility 语义；
- 不把 Host View、workspaceKey 或 remoteSessionId 写入 Session Selection；
- 不建立新的 Model Catalog、Runtime capability DTO、Execution Registry 或 ModelIdentity。

## 11. 实施结果

本 Todo 已按最终裁决完成，补充裁决文档中的 Select/Submission 两阶段也已吸收进实现：

- `ModelSelectionView` 由目标 Local/Remote Host 提供候选、Option Specs 与
  `preferredSelection`；Remote unavailable 不回退 Local Host；
- Conversation 在 `SessionPane` 只解析一次目标 Host View，Composer、行展示与提交共享该事实；App Recent
  按 `workspaceKey` 保存稀疏 Selection，并且只在普通用户 Submission 被接受后更新；
- Workspace presentation 只保留 mode 与 slash commands，删除临时 Session/App 模型准备、Runtime Catalog
  对账和 Renderer 侧第二套默认值推导；
- Automation、Repo Wiki、Bot、Off-Peak 与 Subagent 的正式配置、协议和 repository 已迁为结构化
  `ModelSelection`。旧字符串仅在各自已发布持久格式 importer 内单向读取；
- Automation record 仍是可缺模型的 Select；每个 `automation_runs` row 在首次派发时原子固定 Submission
  Selection，调度重试只能读回该值，不会再次读取 Host preferred；
- Subagent Settings 只连接 Local Host；无 override 的 Child Submission 继承 Parent Active Model，显式
  override 通过 Worker ModelFactory 创建并冻结自己的 Model；
- `modelSelectionSchema` 只在 Shared 定义；Provider Node、Contracts、Protocol 与产品 schema 均复用它；
- 同一模型编辑保留未展示但已显式保存的 option 叶子；跨模型切换重新构造 Selection，不继承旧 options；
- Todo 12 的边界保持不变：用户 Facade 不承担通用执行校验，Target Worker Registry/ModelFactory 最终
  fail-closed。

已删除的旧生产入口包括 Root 全局 Snapshot、Workspace 模型偏好、Draft Global Seed、Repo Wiki Runtime
Thought Catalog、Subagent Workspace Catalog reconciliation，以及相应 helper、tests 和 exports。Feature Graph
和正式 Design 已同步到目标 Host、workspaceKey、稀疏 Selection 与 Select/Submission owner。

验证证据包括 Provider/Services/UI/Desktop 的目标 Host、App Recent、Automation retry、产品 repository、
Subagent 继承与显式 override、CLI Contracts/Bootstrap/Core 的结构化解析和执行测试；最终门禁结果记录在本
Todo 所在提交中。
