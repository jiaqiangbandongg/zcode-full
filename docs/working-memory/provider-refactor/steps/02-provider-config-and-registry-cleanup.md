# M2 退役清理

> 状态：实现与最终分支验证完成，可以进入上线评审
>
> 最近复核：2026-08-21

本轮清理完成了 M2 的最后一个目标：普通长期 Provider 的配置、展示、选择与执行均回到同一条事实链路。

```text
Official Provider Config
        +
Personal Provider Config
        +
Account Provider Config
        |
        v
Process Provider Registry
        |
        v
Model
```

物理迁移模块仍可读取旧文件，闲时任务仍可通过 `turnRuntimeModel` 提供单次执行输入；两者均位于明确边界内，不参与普通长期 Provider 的稳态事实。

通用 `RuntimeConfigPatch` 也已经退出旧模型字段。旧 CLI 文件中的 `provider`、`model` 和
`modelCatalog` 只由显式命名的迁移投影读取；普通文件配置、环境变量配置与 Config Merger 不再生成、
合并或公开模型事实。旧 `ZCODE_MODEL` / `ZCODE_BASE_URL` 因而不会形成一条隐藏的运行配置路径。

普通 CLI 文件的运行配置 Schema 也不再声明 `provider`、`model`、`modelCatalog` 或 `small_model`。
这些字段即使残留或格式错误，也不会让同文件中的 MCP、权限、网络等正式配置整体加载失败；只有
一次性 Personal Importer 使用的 Legacy Schema 会读取并严格校验它们。

## 完成的清理

### Repo Wiki

Repo Wiki 直接消费 `ModelSelectionView` 并通过统一 `Model` 发起请求。中间的 `ZCodeProviderRegistrySnapshot` 投影、反向解析器、旧 readiness resolver 及其测试已经删除。

### 设置连通性与安全校验

连通性测试接收正式 Provider/Model Config 草稿。安全校验链路读取正式 Provider Settings View 中的 API 格式与地址。两条路径不再重新解释旧 endpoint/defaultKind 结构。

### 模型选择与辅助代码

模型菜单、Bot 选择、Workspace Prepare、套餐展示和模型排序中已经没有生产消费者的旧 helper、包装模块、再导出和专项测试已经删除；仍在使用的文件只保留新 Registry/View 所需的一半。

### 旧 Services Provider 存储草稿

全仓引用审计进一步删除五个已经没有消费者的旧文件：套餐入口状态文件缓存、GLM workspace Provider
配置仓库、未接入正式 Repository 的原子文件草稿，以及旧 Provider settings JSONC 解析器。它们曾经分别
承载旧套餐可用性、Workspace Provider 配置和另一套物理 Config 读取方式；继续保留会让代码看起来仍可
绕开 Official、Personal、Account Source 建立 Provider 事实。

同时删除了未被任何入口读取的旧模型覆盖 Header 常量。它只剩一个孤立文件，没有请求注入、
协议或配置消费者；保留它会暗示仍存在另一条模型覆盖入口。

Services 现在有结构测试固定这些文件已经退出。该门禁不会禁止后续新增通用 IO 工具，但旧文件名和
职责不能在没有新架构裁决的情况下恢复。

### Process Registry

生产协议 Entry 现在必须成功启动进程级 Registry。缺少 Official 或 Personal Config 路径会直接暴露装配错误，不再静默创建第二套 Provider 事实。

```text
Protocol Entry
    |
    | required
    v
Process Provider Registry
    |
    +-- create / resume / switch
    +-- workspace model view
    +-- context window
    +-- model fallback
    +-- execution
```

`hasProcessProviderRegistry` 分叉和 Workspace Provider Catalog fallback 已退出。测试 Harness 也显式装配 Registry，因此测试不会继续掩盖生产依赖缺失。

### Workspace 模型状态

原来的 `workspaceModelCatalogs` 已收缩并更名为 `workspaceModelPreferences`。它只保存交互与持久选择：

```text
Workspace Model Preferences
├─ defaultMode
├─ defaultModel
├─ defaultThoughtLevel
├─ lastUsedModel
└─ revision
```

Provider 列表、模型 Properties、Option Specs、凭据和 Provider revision 均由进程 Registry 提供。Workspace 状态不再承担 Provider Catalog 职责。

Renderer 中遗留的 `workspaceModelMirror` 队列也已删除。它曾把模型选择异步镜像回旧
`setWorkspacePreferredModel` 入口，但所有消费者已经迁移到 Session-aware 的 Selection 控制链路；
继续保留无调用者的队列会暗示 Workspace 仍有另一份待追平的模型事实。

最终收口同时删除了 `workspace/readState.modelCatalog`、`ZCodeWorkspaceModelCatalogState`、
Worker 侧 Provider 投影和已经没有生产调用者的 App Config→Protocol Provider 转换。模型列表与
当前选择统一从 `settings.model` 返回；Workspace `state.updated` 也发送同一 Settings 形状，旧的
`{ modelCatalog }` Patch 不再存在。闲时首次派发直接继承 `settings.model.current`，并用同一份
`settings.model.available` 验证选择仍然有效。

App 内部残留的 Workspace Overlay 写入口也已经删除。`setModelCatalogOverlay`、Workspace Overlay
状态与监听器没有生产调用者，却仍能把完整 Provider/Model 快照混入模型列表和旧 Adapter Registry；
保留它会让旧 Host Snapshot 随时重新成为第二事实源。单轮 `setTurnModelCatalogOverlay` 继续保留，
它只服务 execution-scoped 临时模型，结束后清除。

### 普通执行与临时执行

普通 Session 命令只携带 `ModelSelection`，Worker 使用所属 Environment 的 Registry 创建 Model。Host 派生的普通 `runtimeModel`、旧 revision CAS 和 Workspace Provider 回写已经退出。

`createModelAdapter()` 也只接受显式 AI SDK Registry 容器，不再公开从旧 `RuntimeModelConfig` 创建普通
执行 Registry 的分支。正式 Provider Runtime 在 App 启动后管理该容器；旧 Runtime Config 转换仅由
Turn Execution Source 内部使用。

闲时任务的 `turnRuntimeModel` 暂时保留。它只形成当前 Turn 的临时 Model Overlay，不写入 Registry，也不修改 Workspace Preferences；其正式 Provider 与请求期鉴权设计属于 M4。

### Model 与请求鉴权

Model 创建时固定 Provider 的静态执行配置。账号 API Key 或 Header 刷新只覆盖当前请求 attempt 的动态
鉴权材料，不再让已创建 Model 回到当前 Adapter Registry 重新解析完整 Provider：

```text
Model 创建
└─ 固定 Provider 静态执行配置

请求 attempt
├─ 读取最新动态鉴权材料
└─ 在固定配置上覆盖 API Key / Header
```

因此 Registry 热更新只影响以后创建的 Model；当前 Loop 不会在请求重试或一次性安全校验 Header 刷新时静默切换
Endpoint、API Format、Provider Factory、Provider Options 或静态 Header。物理路由、代理和请求安全校验仍由
Adapter 的请求设施管理，不作为 Provider 静态事实写入 Model。

Bootstrap 中原来用于在 Registry 热更新后原地修改 Active Session 容量、再补发 ModelSelected 的死链
已经删除。Active Session 持有自身 Model；新的 Properties 与 Option Specs 只进入以后创建的 Model。

账号登出会在 OAuth 主会话清理前捕获账号身份，并删除对应账号作用域的 Personal Coding Plan Key；
兼容窗口内同时删除旧无作用域 Key。重新登录则强制使用新 OAuth Token 重新取得并覆盖 Key。Account
Provider 从 Registry 消失、请求鉴权失效和派生凭据清理因此遵循同一次账号生命周期。

## 设置页面的表单边界

设置页面保留一份 Renderer 私有的编辑会话状态。它的配置字段直接使用正式 Config 类型：

```text
ProviderSettingsView
        |
        v
ProviderSettingsFormProvider
├─ config: ProviderConfigObject
└─ models[].config: ModelConfigObject
        |
        | saveEffectiveProvider()
        v
Personal Config Overlay
```

这层投影只负责表单编辑与保存：

- 不读取 Provider 文件；
- 不构建 Registry；
- 不决定模型是否可选；
- 不创建 Model；
- 不成为执行事实来源。

设置页需要判断 Provider 是否可选时，直接使用 Settings View 中由 Registry 发布的 `selectable`。
保存操作返回写入后刷新完成的新 Settings View，因此保存后的 Provider Family 修正和 Plan 同步补偿也使用
同一份最新 Registry 结论；Renderer 不再根据 API Key、Endpoint 和模型字段复制一套启动可用性算法。

套餐连接状态只读取 Account Overlay 发布的 `accessId`。Provider 表单中的旧 API Key、Endpoint 和模型
列表不会在缺少 Account Access 时把 Coding/Start/Team Plan 重新判定为已连接；导航状态点则直接使用
Registry `selectable`。设置页因此不再保留“未装配新 Service 时回退旧表单”的隐式模式。

编辑会话不再复刻旧 Store 的 endpoints、kind、modalities、ProviderOptionsPatch 和时间戳字段。
Renderer 只在正式 Config 之外附加 `providerId/modelId`、Registry 投影状态和 Personal 来源标记；
未展示的 Model Config 字段会随编辑态保留。旧 `ModelProviderConfig` 只留在一次性物理迁移读取中。
设置体验未来可以继续调整控件，但不会改变正式 Config、Registry 或执行事实。

API 类型同样只属于 Provider Config。设置页使用 `ProviderApiType` 编辑 Provider 连接；已经没有模型级
API kind、Endpoint Path 或多协议选择旁路。Repo Wiki 和连接探测也直接消费该正式类型，不再把当前
Config 反向翻译成旧 Provider Store kind。

Desktop E2E 的 Direct Seed 和 WDIO 全局 Provider 夹具都已退出旧物理 Store 与 CLI Provider Config。
DeepSeek、Output Budget、Repo Wiki、Context Window 和 Provider 过滤用例只写版本化 Personal Config；
Environment 默认模型写入独立 `model-selection.json`。CLI Config 只保留 `modelStream` timeout 等非
Provider Harness 设置，不再复制 Provider、Model 或默认 Selection。Coding Plan 夹具也不再写 Builtin
Provider 副本，继续由 Official 与 Account Source 构建。

Restart E2E 使用同一边界：Replay Provider 只写 Personal Config，Environment 的冷启动默认模型只写
版本化 Model Selection Config。测试不再通过 Project/CLI Config 复制 Provider 或 reasoning 参数，也
不再人为制造 Host Snapshot 与 Worker CLI Catalog 不一致的旧竞态。

Team Plan Usage E2E 也只写 Personal Config；Personal/Team 账号身份由场景中的 Account Source 提供，
测试通过正式 Overlay 顺序形成可用 Provider，不再写旧 CLI Provider Config 或旧 Provider Store。

Reasoning manual-review E2E 的 replay endpoint 发现也已经退出各用例私有的旧 Store/CLI Config 回退。
它们使用显式 replay runtime 信息或统一的 Personal Config 测试投影；旧物理格式只留在集中迁移边界。

设置详情到额度重置服务的 Account Access 作用域也已闭合：Renderer 只透传 Registry View 中的非敏感
`accessId`，不回读 API Key；Personal/Team 同 Provider 的请求仍由服务端按连接身份解析动态鉴权。

Bootstrap 内部的通用 `RuntimeModelOverlayManager` 也已退出。唯一保留的 Overlay 对象明确命名为
`TurnModelOverlayState`，只承载当前 Turn 的 execution-scoped 临时模型；不再提供暗示 Workspace、Session
或普通 Runtime Provider 层的重复 API。

## 明确保留的 Legacy 边界

以下兼容代码仍有单一、可删除的职责：

- Personal Config 首次导入：新 Personal Config 尚未建立时读取旧物理文件；
- Account Key 一次性迁移：把旧 Personal Coding Plan Key 移入 Account Credential Store；
- Renderer 编辑会话状态：直接承载正式 Config，并隔离草稿与 Registry 运行状态；
- `turnRuntimeModel`：闲时任务在 M4 前的 execution-scoped 输入。

它们不会被 Registry 稳态路径反向调用。

M2 的完成边界由跨包结构测试机械保护。生产源码中，旧 `ModelProviderConfig` 只允许出现在 Shared 的
历史 DTO 定义、Personal 首次导入、Account Key 一次性迁移和它们的装配入口；旧
`model-providers.json` 只允许由 `legacyModelProviderStoreReader` 读取。旧完整 Registry Snapshot、
`workspace/updateProviderRegistry`、通用 Runtime Overlay 和旧设置投影名称在生产源码中必须保持为零。
新增兼容点需要先更新本篇并说明明确退场条件，不能通过换文件名绕过边界。

裸 `createZCodeApp()` 的测试与内部工具旧模型装配路径已经退出。正式 Prompt CLI、TUI 和
Protocol Entry 使用相同的必填 Registry 依赖。Bootstrap Session Persistence、MCP、Hook 与 Workflow 测试
通过 Registry-backed Harness 构造实际可执行 Model；Compact/Memory E2E 和 Prompt Trajectory
工具也显式创建各自的测试 Registry。`ZCodeAppOptions.providerRegistry` 已改为必填，缺失时立即
暴露装配错误。旧 `bootstrapModelConfig`、`includeLegacyProviderModels` 与无 Registry App Factory
分叉已经删除。

进一步审计也删除了 Adapter Factory 的旧 Runtime Model Config 分支：`createModelAdapter()` 必须显式
接收由调用方管理的 AI SDK Registry 容器。Prompt Trajectory 与 WebSearch Probe 改为显式提供执行模型；
旧 CLI Config 的模型选择写入口已删除。旧 Config Parser 只在 Personal 首次导入和非 Provider Harness
设置中保留，不能为稳态模型执行提供事实。Turn 的 execution-scoped Runtime Model Config 只在
`TurnExecutionModelSource` 内部转换，不再进入公共 Adapter Factory。

通用 `RuntimeConfig` 与 `ConfigPort` 随后删除了 `model`、`modelCatalog` 及对应 Config Key。
旧文件和 `ZCODE_MODEL` 的兼容解析目前仍保留为带弃用标记的迁移输入，但 Config Factory 不会再把
这些字段投影到运行配置；`hasModel` 来源元数据也已删除。正式 App 初始化只能从 Process Registry
和显式 Session/Submission Selection 取得模型。

## 验证

本轮已完成：

- 根目录 `pnpm typecheck`；
- 根目录 `pnpm lint`，0 error；
- rebase 后 Services/UI 与新 MCP/Usage 功能针对性测试：15 个文件、258 条通过；
- Bootstrap 针对性测试：6 个文件、219 条通过；
- Bootstrap 独立 typecheck 通过；
- `git diff --check` 通过。

Workspace Snapshot 最终收口后，新增一轮 Shared、Services、Bootstrap 与 UI 针对性验证，共
299 条通过；根 typecheck 与 lint 再次通过，lint 保持 0 error。

Bootstrap 全量测试还暴露了与本轮无关的既有债务：Session Persistence 测试 mock 缺少新方法、Native Boundary 已存在跨域导入，以及若干历史 timeout。它们不构成本轮定向回归失败，也不能被误报为全量通过；上线验证应继续保留这项说明。当前验证使用 Node 22，而仓库声明 Node 24，正式流水线仍需在标准运行时复核。

最终分支已 rebase 到 `staging` 的 `cf009a3b19`。Workspace Overlay 删除后的 Bootstrap 回归共
51 条通过；根目录 TypeScript、Bootstrap 独立 TypeScript 与 lint 再次通过，lint 为 0 error、
36 条基线 warning。Human in the Loop 复核没有未确认裁决。当前分支相对最新 `staging` 为
0 behind。

裸 App Factory 收口后，Bootstrap Registry、Runtime Config、Session、MCP、Hook、Workflow、
Telemetry 与 Overlay 针对性回归 12 个文件、160 条通过；ZCode Protocol 专项 109 条通过。根目录
typecheck、Bootstrap 独立 typecheck、Prompt Trajectory typecheck 与根 lint 通过，lint 仍为
0 error、36 条基线 warning。Compact E2E dry-run 与 Memory evidence 测试通过；当前 Node 22 无法
直接加载最新 staging 中引用根 `@zcode/shared` 源码的 Bootstrap build，实际 Compact fake suite
留给仓库声明的 Node 24 / CI 运行时复核。

Bootstrap 全量运行中，本轮相关的 Runtime Config 与 Telemetry Harness 失败已经修复；剩余失败
位于既有 `v4-native-boundary`、oversize V4 Gateway 时序和 Session Resident Pool 用例。本轮没有
借 Provider 收尾改动这些独立语义。

上线前最后一轮清理又完成了 Desktop E2E Provider Seed/读取边界迁移、Provider 与 Provider Node 的
Knip 审计，以及 Account Access 额度重置作用域补全。根 `pnpm typecheck` 再次通过；根 `pnpm lint`
保持 0 error、35 条与 M2 无关的基线 warning；Coding Plan 与 Model Selection 定向测试 205 条通过，
Desktop E2E TypeScript 和改动文件 Lint 通过。Human in the Loop 的 16 项裁决全部确认，分支相对最新
`origin/staging` 仍为 0 behind。

Turn Overlay 收窄后再次执行根 `pnpm typecheck` 与 `pnpm lint`：TypeScript 通过，Lint 为 0 error、
33 条当前 `staging` 基线 warning；Turn Overlay、Runtime Model Factory、Session Facade 与 M2 结构门禁
共 16 条测试通过，Bootstrap 独立 typecheck 通过。分支相对最新 `origin/staging` 仍为 0 behind，
Working Memory 与代码工作区均无未提交内容。

Desktop E2E 的 Provider 诊断也已退出旧 Store 与旧版 CLI Config 的读取回退。普通 E2E 只使用版本化
Personal Config；历史物理格式只由一次性迁移器及其专门测试读取，不能再帮助普通场景错误通过。

最终分支验证再次通过根 `pnpm typecheck` 与 `pnpm lint`；Lint 为 0 error、33 条当前 `staging` 基线
warning。Provider、Provider Node 与 M2 结构门禁 19 个文件、96 条测试通过；Shared Protocol 与旧物理迁移
边界 3 个文件、53 条测试通过。旧 Store Schema 与迁移函数同时退出 ZCode Protocol 再导出，只保留在
Shared Provider 迁移类型和 Services 一次性 Reader 中。分支相对最新 `origin/staging` 为 0 behind。

旧 Provider Store 最终收敛为纯读取适配器，并改名为 `legacyModelProviderStoreReader`。生产调用只剩
Personal 首次导入和 Account Key 一次性迁移；旧路径不再写回 `config.json`、不再恢复备份，也不再保留
旧格式反向序列化与原子写代码。三组迁移测试共 7 条通过，根 typecheck 与 lint 再次通过；lint 为
0 error、33 条当前 staging 基线 warning。

最后一轮 E2E 基础设施审计把普通 WDIO seed 改为直接写正式 Personal Config，并以明确的
`E2EModelProviderSnapshot` 观察结果替代旧 Store 顶层 DTO。Desktop E2E 结构门禁递归扫描全部测试源码，
防止夹具重新引入 `ModelProviderConfig`。Provider、Provider Node、Services 迁移边界与 Desktop Config
边界共 24 个文件、114 条测试通过；根 `pnpm typecheck` 通过，根 `pnpm lint` 为 0 error、33 条当前
`staging` 基线 warning，改动文件为 0 warning。当前分支相对 `origin/staging` 为 0 behind。

非迁移测试夹具随后也退出旧 Provider 顶层 DTO，M2 结构门禁开始同时约束生产源码和测试源码。Usage、
Repo Wiki、Bots 与 Provider Runtime 定向回归 6 个文件、135 条通过；Provider 与 Provider Node 全量单测
分别为 14 个文件、89 条和 2 个文件、13 条通过。根 `pnpm typecheck` 与 `pnpm lint` 再次通过，Lint 为
0 error、33 条当前 `staging` 基线 warning。最终反证审计确认剩余旧顶层 DTO 只属于一次性物理迁移，
旧模型 DTO 另只服务 M4 前的闲时 execution-scoped 输入。分支基于 `origin/staging` `6b4f6fc636f5`，
相对该基线为 0 behind。

要求级审计随后删除 Session Settings 与请求期鉴权 callback 中已经失效的 Provider revision 字段。完整
Snapshot revision CAS 退出后，这些字段没有生产写入或行为消费者；现在共享协议、Bootstrap Session
Mapper、Core Invocation Context 和 Adapter Request Auth 只保留实际生效的请求鉴权材料。Core 源码也已
加入 M2 跨包结构门禁，防止旧 revision 名称从更内层重新出现。

最后的 Entry 覆盖审计把 `@zcode/provider`、`@zcode/provider-node`、Prompt CLI 与 TUI 也纳入同一结构
门禁。扩展扫描确认这些入口没有旧 Provider Snapshot、Workspace Catalog 或 Runtime Overlay 回退。
Workspace 交互状态的实现术语统一为 Model Preferences；一个零调用者的 legacy reasoning 迁移函数也已
删除。M2 门禁、Runtime Model Metadata 与 ZCode Protocol 定向回归共 151 条通过，Bootstrap 独立
typecheck 与根 typecheck 通过。

设置页排序的最后一份 Builtin Provider ID 硬编码也已删除。Provider 的初始与最终顺序只来自有序
Effective View；用户拖动继续写 Personal Overlay。旧 Display Order Preference 的 `updatedAt` 空壳和
Shared DTO 已退出，UI 只保留由当前 View 投影的 `ProviderOrderView`。

Bootstrap 与 Prompt CLI 中仅供文件内部使用的 Provider 迁移/Registry 辅助类型和函数不再导出。
正式跨模块入口保持不变；Knip 复核后，这两个包中 Provider、Model、Registry 相关的无调用者导出为零。

Services 中按旧 `enabled/systemDisabledReason` 推断 Coding Plan 禁用来源的两个零调用者 helper 已删除，
Account/Request Auth/Connectivity 等模块的文件内部实现也不再作为公共扩展点导出。Account Source 当前只以
available/unavailable/unknown 结果形成 Account Overlay。

Services 路径模块中仅供内部复用的 workspace key 与外部 Agent 配置隔离目录 helper 也已收回导出；
外部 Agent 的技能、插件和运行状态路径行为保持不变。

上线前最终反证逐条核对了 M2 完成条件。21 个关键测试文件、181 条测试以及根 typecheck 通过；根 lint
为 0 error、33 条当前 staging 基线 warning。分支相对 `origin/staging` 为 0 behind，没有把 staging
回退前已经删除的历史提交重新带回。

公共 Adapter Factory 与设置表单 DTO 收口后，Provider 全量 14 个文件、110 条测试，Provider Node 全量
2 个文件、13 条测试，Services Registry/Config/Request Auth 定向 4 个文件、19 条测试，以及 Bootstrap
Registry Runtime 定向 4 个文件、45 条测试通过；M2 跨包结构门禁 37 条通过。根 typecheck 通过，根 lint
为 0 error、33 条 staging 基线 warning。分支相对 `origin/staging` `6b4f6fc636` 为 0 behind。

## 完成结论

M2 的正式 Entry 和内部 Harness 已经具备单一事实源和强制 Registry 装配。Renderer 编辑会话直接承载
正式 Config 类型；一次性 Legacy 导入和闲时任务 Overlay 位于明确边界，不参与普通生产 Registry。
共享旧 Store DTO 已退出生产 UI。M2 上线后的已知退场项只剩一次性物理迁移、M4 的 execution-scoped
任务语义，以及 M6 内部的账号与套餐状态整理。

上线前的最后一轮类型审计进一步固定了旧 `RuntimeModelConfig` 的允许位置：它只能服务旧 CLI 文件的
一次性导入，以及 M4 尚未重构的 execution-scoped Turn Overlay。跨包结构测试枚举这些文件，普通
Session、Registry、Settings、Selection 与 ModelFactory 一旦重新引用该类型会直接失败。旧
`ZCODE_MODEL`、`ZCODE_BASE_URL` 与 `ZCODE_API_KEY` 也不会进入普通 Runtime Config；其中
`ZCODE_API_KEY` 的剩余读取仅属于旧 CLI Provider 的一次性导入。

Execution-scoped Turn Overlay 与进程 Registry 出现相同 `providerId/modelId` 时，本次 Turn 的 Overlay
拥有执行优先级。ModelFactory、Session Facade 的模型元数据以及 transient 模型切换必须共同遵守这一
顺序；Registry 继续负责普通长期模型，Overlay 不进入设置、选择列表或持久化。
