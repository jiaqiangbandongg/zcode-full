# M2：Provider 配置与 Registry 实施

> 状态：实现、退役清理与最终分支验证完成；等待上线
>
> 最近更新：2026-08-21

目标设计见 [`../design/registry/registry.md`](../design/registry/registry.md)。本篇记录 M2 的实施目标和切片。普通长期 Provider 的主体生产链路与退役清理已经完成；清理结果、保留的窄兼容边界和最终验证见 [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)，新增代码规模与过渡边界评审见 [`02-provider-config-and-registry-review.md`](./02-provider-config-and-registry-review.md)。Merge Request 静态审查及其修复证据保存在 [`02-provider-config-and-registry-mr-review.md`](./02-provider-config-and-registry-mr-review.md)；其中的上线阻断项已经全部收口。

## 最高优先级迁移原则

Official、Personal 与 Account 三层 Provider Config 是 Provider Registry 的唯一事实来源。现有 Catalog/Preset 分支、Builtin hardcode、Provider Family resolver、旧 CLI Provider Config 和 Runtime Snapshot 中重复表达的静态事实，都必须迁入这三层或删除。

```text
旧静态事实仍然有效
└─ 搬入 Official / Personal Config

旧账号与套餐判断仍然有效
└─ 收敛为 Account ProviderConfigMap

旧动态凭据逻辑仍然有效
└─ 收敛到请求期鉴权 Service

无法证明仍然必要的旧分支
└─ 删除
```

迁移期不建立“旧 Snapshot + 新 Registry”的长期兼容层。允许在物理存储边界做一次性格式迁移，但迁移后的运行链路只能读取新的唯一事实来源。这一原则优先于按旧模块边界逐个兼容，M2 应尽快让生产路径开始消费正式 Config 与 Access Source。

## 实施目标

M2 统一“Model 如何从当前 Environment 的 Provider 事实产生”。M2 启动前，Host Provider Service、Worker Workspace Catalog、CLI Config Parser 和 Runtime Overlay 分别解释 Provider 静态信息，导致 Host 选择的模型与 Worker 真正执行的模型需要靠完整快照和兼容 Overlay 维持一致。

目标链路是：

```text
ProviderConfigService
├─ Official ProviderConfigMap
├─ Personal ProviderConfigMap
└─ Official / Personal ModelConfigRules ──┐
                                            ├─> Registry 输入聚合
AccountProviderService                      │
└─ Account ProviderConfigMap ───────────────┘
                             |
                             v
            ProviderRegistryService
                     ├─ Provider[] / { modelId, config: ModelConfig }[]
                     └─ createModel(selection)
                                  |
                                  v
                             ModelFactory
                                  |
                                  v
                                Model
```

Host、Core Worker、Prompt CLI 和 TUI 复用相同 Config 与 Registry 领域实现，各自在进程内持有实例。

## 已完成的设计准备

当前已经确定：

- Config 使用统一 ConfigOverlay 语义，稀疏层和最终结果使用同一类型；key 有序，覆盖已有 key 时保留位置，新 key 按后层顺序追加。
- ProviderConfig 与 ModelConfigRules 都有 Official 和 Personal 两组有序输入。
- Account Source 直接产生第三层稀疏 `ProviderConfigMap`，与 Official、Personal 复用同一种 Overlay。Account Provider 的 `accessId` 和当前 `models` 都是 kind-specific Config 字段；Registry 不额外验证账号权益，请求鉴权由 Account Service 最终裁定。裁决背景见 [`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md#1-account-access-复用-provider-config-overlay)。
- Registry 分两轮形成 ProviderConfig 和 ModelConfig。
- Provider 与模型对外保持顺序，内部索引支持查询、Selection 校验和 Model 创建。
- 设置页面和模型选择页面使用各自 Facade，不在 Renderer 复制解析逻辑。
- 设置页面只拖动 Personal-only Provider 和 Personal Provider 内模型；保存时按照 Effective 顺序重排 Personal Overlay，不建立独立排序 Preference。
- 每个进程拥有独立 Registry 实例；进程 Registry 启用后，Host Snapshot 不再参与普通长期
  Provider 的成员、属性、执行或展示。
- 闲时任务从进程级 Registry 选择 Official Builtin Provider；执行期只补充 Request Auth 与 Ticket，不建立临时 Provider 静态事实源。

具体设计从 [`../design/registry/registry.md`](../design/registry/registry.md) 逐层下钻。

## 首个实施切片的边界

M2 的第一批代码先建立了一条不依赖文件、网络、React、Electron、Services 或 Provider SDK 的领域链路：

```text
普通 Object / RPC 数据
          |
          v
Config Schema + ConfigOverlay
          |
          v
ProviderConfigResolver
├─ Settings 可用的完整解析结果与问题
└─ Registry 可发布的有效 Provider View
          |
          v
内存 ProviderRegistry
├─ 有序 View
├─ provider/model 索引
├─ ModelSelection 校验
└─ 变化通知
```

这一切片建立在新的纯领域包 `@zcode/provider` 中。后续切片已经让 Host、Worker、Prompt CLI 和 TUI 复用这套代码；文件监听、远端管理配置和账号接口继续由各自 Source Service 负责。

这一节只记录首个领域切片当时的边界，不代表 M2 最终交付范围。后续切片已经接入 Host、Worker、设置页、模型选择和模型执行；Adapter reasoning 映射仍保持原有执行语义。

首个切片开工时的影响面和测试契约保存在
[`02-provider-config-and-registry-impact.md`](./02-provider-config-and-registry-impact.md)；它是历史实施证据，不描述当前完成状态。

## 实施切片与结果

```text
M2.1  @zcode/provider 包                                      [完成]
      + ConfigOverlay、ProviderConfig、ModelConfigRules 与解析测试

M2.2  ProviderConfigResolver
      + 两轮解析、顺序、三层 Provider Config Overlay 和完整性门禁
      + 无 IO 的内存 ProviderRegistry、索引、Selection 校验和变化通知 [完成]
      + Selection 统一校验 Provider/Model、reasoningLevel 和 maxOutputTokens；
        Configured Default 与 Facade 复用同一套 Option 规则 [完成]

M2.2b ProviderRegistryService
      + 注入 Official、Personal 与 Account Config Source
      + revision 去重、并发刷新代际守卫和 last-known-good 失败边界 [完成]

M2.3a Provider Settings / Model Selection 纯投影
      + Settings 查看 Personal / Effective / Issues
      + Selection 只投影 Registry 中可选模型 [完成]

M2.3b ProviderConfigService 与 Personal 持久化边界
      + 可注入 Official Source 与 Personal Repository 的 ProviderConfigService
      + Personal Provider / Model 保存与调序 [完成]

M2.3c 生产 Official / Personal Config Source                         [完成]
      + 开发阶段曾建立带 schemaVersion 的独立 provider-config.json 与物理 Repository
        [完成；最终路径裁决已取代独立文件名]
      + ModelConfigRules 支持 apiFormatMatch 与无状态 reasoningMapping [完成]
      + 只读、可注入的单文件 OfficialProviderConfigSource [完成]
      + 首批 API / Account Provider 与模型静态事实写入 config/provider/official.json [完成]
      + 从旧 config.json 单向导入稀疏 Personal Config，并在原路径完成备份、迁移与原子替换
        [完成]
      + 旧文件只在 Personal Config 不存在时参与首次导入；运行期旧 Provider Store
        不再把完整列表反向同步回 Personal Config；正式 Schema 通过同路径版本检测
        [完成]
      + Provider Config schemaVersion 4 与相邻版本迁移 [未发布开发历史，已完成]
      + 以 `access.type` 表达访问方式，以 `api.type` 表达公开 API；Model Config 使用
        `apiMatch + reasoningMapping` 表达模型/API 组合行为 [完成]
      + Personal Config 使用既有 `~/.zcode/v2/config.json` 路径；迁移前完整备份原文件，
        备份失败不覆盖，转换成功后原子替换同一路径 [完成]
      + 最终完整 Schema 作为首次发布的 `schemaVersion: 1`；未发布的开发期
        v1–v5 迁移分支不进入长期兼容链路 [完成]
      + OpenAI-compatible 始终请求 Usage，Config 不再提供关闭开关 [完成]
      + 设置页新增模型通过 Settings Facade 预览 Official / Personal ModelConfigRules，
        删除 Renderer Catalog 查询、停用的 Catalog Provider 新增入口和旧公共 Catalog API [完成]
      + 旧 Provider Store 读取与迁移不再按 Model ID 注入 Catalog metadata；删除旧 Catalog
        Loader、仓库 JSON 与 Electron 打包资源，模型缺省事实只由 ModelConfigRules 提供 [完成]
      + 旧 Builtin Preset 首次迁移只保留用户 API Key 与 modified 模型覆盖；Preset 生成的
        label、endpoint、模型列表和账号状态不再固化为 Personal Config [完成]
      + 设置页、Shared 工厂、旧 Store 与协议投影停止解释 `[1m]` 模型后缀；通用 200K
        缺省与 `[1m]` 的 1M context 改由 Official ModelConfigRules 提供 [完成]
      + 删除设置页已经停用的 Endpoint 建议与按 Endpoint 探测模型接口；Add Provider
        只编辑显式 Provider Config，不再从 `client/configs` 引入另一套配置候选 [完成]
      + 删除 Renderer 与旧 Store 的 Start Plan 免费模型白名单和占位 Provider；Official
        Config 声明静态模型，Account Overlay 决定当前账号可用成员，断网兜底不再伪造
        Account Provider [完成]
      + 设置页模型连通性测试只使用 Model Config 中的 reasoningMapping，
        退出按 GLM 模型名补齐 thinking / effort 的旧硬编码 [完成]
      + 把现有有效静态事实迁入正式 Config；生产 Registry 不再从 Catalog、Preset 或旧
        Provider Store 补充 Provider/Model 事实 [完成]
      + 删除无消费者的旧 Preset 构建器、远端 Config 拉取与 Store 稳态同步；旧 Store 只保留
        Personal/Account 一次性物理迁移，历史修正规则均为迁移文件私有实现 [完成]
      + 删除 Workspace Snapshot 的重复 `modelCatalog`、旧 Provider 分组投影与无生产调用者的
        App Config→Protocol Provider 转换；模型状态统一由 `settings.model` 表达 [完成]
      + 删除 App 的 Workspace Provider/Model Overlay 写入口、状态与监听器；只保留
        execution-scoped Turn Overlay [完成]

M2.3d Account Provider Config Source                             [完成]
      + 现有登录与套餐判断投影稀疏 Account ProviderConfigMap
      + Official、Personal、Account 使用同一种 Provider Config Overlay [完成]
      + 每个 Access Entry 携带 Model 创建时固定的非敏感 accessId
        [领域类型、Host/Worker 迁移 Source 与 Official Account Config 已完成]
      + Account Model 的 Properties、Option Specs 与 reasoning 映射改用新 Registry [完成]
      + Account Model 固定 accessId，并在每个请求 attempt 传到 Host [完成]
      + Host Request Auth Service 按固定 accessId 解析 Start / Personal / Team 凭据 [完成]
      + Account Request Auth 从旧 ModelProviderService 内部 Resolver 提升为窄服务契约，
        Local Host 进程内持有，Agent 与 Off-Peak 只依赖该契约；跨 Host 路由裁决前
        不通过通用 RPC 暴露 [完成]
      + Local Host 在 composition root 独立装配 Account Request Auth；旧
        ModelProviderService 不再创建或暴露 Resolver；Personal Coding Plan Key 的一次性
        旧 Store 读取收敛为独立窄迁移函数 [完成]
      + Team Plan 请求期 Key 的组织/项目校验、创建与 Secret 复制移入独立 Account Runtime
        模块；新 Request Auth 与旧 Snapshot 兼容调用共享实现，不再由旧 Provider Service 定义 [完成]
      + Account Model 无需旧 Workspace Secret 即可从新 Registry 创建 [完成]
      + Account 权益判定退出旧 ModelProviderConfig，收窄为 providerId、鉴权输入与
        Account 上下文 [完成]
      + 无 IO AccountProviderService 管理 Config 依赖、ready barrier、刷新通知与
        last-known-good Account ProviderConfigMap [完成]
      + 本地 Host 以账号连接 Setting 更新和显式 Account Facts 事件触发刷新，退出
        旧 Provider Registry 全量 change event [完成]
      + Account Connection Result 统一解析 available / unavailable / unknown，按 Provider
        保留已知结果并形成 accessId/models Overlay [完成]
      + Services 适配当前账号域、Family 连接模式、Personal/Team 选择与
        Start/Coding 权益结果，统一产生 Account Connection Result [完成]
      + Start Plan 从同一次 billing/balance 权益查询提取远端模型集合，
        存在时随 Connection Result 进入 Account Config [完成]
      + 本地 Host 使用 AccountProviderService 与 Connection Resolver 直接产生第三层
        Account Config；旧完整 Registry Snapshot 不再参与本地账号 Provider 解析 [完成]
      + Personal Coding Plan Key 按 accessId 迁入 Credential Service，Connection Resolver
        与 Request Auth 共用同一读取入口，旧 Provider Key 只保留一次性迁移 [完成]
      + OAuth logout 删除 Account Credential Store 中的 Personal Coding Plan Key，并刷新
        Account Source；退出旧 Provider Store 的派生 Key 清理 [完成]
      + 旧 `refreshCodingPlanApiKey` / `clearCodingPlanApiKey` 公共 API 与 Store 改写链路退出；
        Start/Coding 互斥、Team Project 与暂时错误语义由独立 Availability 测试保护 [完成]
      + 本地 Host → Worker Registry 删除 Account Secret 投影 [完成]
      + 删除旁路 Account Access/allowedModelIds，直接 Overlay accessId/models [完成]
      + Host 通过独立的进程级协议同步 Account ProviderConfigMap，Worker 不再从
        workspace/updateProviderRegistry 完整快照反向提取 Account Config [完成]
      + desktop-attached remote 不建立跨 Host Auth 路由；Remote Environment 使用自己的
        Config、Credential、Account Source 与 Registry [目标已裁决，实施见 M2.8]
      + 在现有 accessId 传递链上升级账号身份语义：Personal、Start 与 Team accessId
        标识具体账号连接；同账号刷新凭据时稳定，切换账号时变化 [完成]
      + Request Auth 核对 accessId 与当前凭据所属账号，拒绝旧 Model 身份与新账号凭据
        组合；Team 同时核对账号、organization 与 project [完成]
      + Account Credential Store 改用账号级 accessId。当前 provider 级稳定 key 尚未发布，
        不迁移该中间 key；Personal/Team Key 直接按新身份重新取得 [完成]
      + Usage Source 与缓存统一使用账号级 accessId；Team 请求补齐必填 accessId，继续携带
        organization/project 上下文，不增加平行 accountCacheIdentity [完成]

M2.4  Host Settings / Selection Facade 使用唯一 Registry
      + ProviderRuntime 组装 Config、可注入 Account Source、Registry 与 Facade [完成]
      + ProviderRuntime 支持显式注入先创建的 Config Runtime，为 Account Source
        依赖同一 Config Service 建立正式装配顺序 [完成]
      + Host RPC 频道与 Client 代理 [完成]
      + Facade 共用 Runtime ready barrier，消除 Host 异步启动竞态 [完成]
      + 主 Composer 的普通 API Provider 选择切到 ModelSelectionView [完成]
      + Account Provider 模型候选与当前连接改由 ModelSelectionView 直接表达；
        Renderer 仅根据固定 accessId 展示 Start/Individual/Team 徽标 [完成]
      + 设置页 API Provider 静态展示事实切到 ProviderSettingsView [完成]
      + 设置页 Account Provider 的名称、Endpoint、模型属性与 Option Specs 切到
        ProviderSettingsView；常驻设置投影不再携带旧运行凭据或状态字段 [完成]
      + 设置页连通性测试通过 Provider Settings RPC 提交当前未保存草稿；Host 使用最新
        Settings View 识别 Account Provider，并从请求期鉴权边界取得动态凭据，不读取旧
        Provider Snapshot [完成]
      + 新 Settings Service 已装配时，cold start 等待 ProviderSettingsView，手动刷新
        直接刷新 Account Source 与 Registry；不订阅、读取或刷新旧 Provider Snapshot [完成]
      + Provider 显示顺序与 Personal-only 拖动写入切到 Personal Overlay [完成]
      + 页面顺序只来自 Effective Provider View，不再读写旧 display-order Preference [完成]
      + Personal Provider 内模型顺序与拖动写入切到 Personal Overlay [完成]
      + Personal-only Provider 删除切到 Personal Overlay 第一写入 [完成]
      + Personal-only API Provider 创建/编辑切到 Personal Overlay 第一写入 [完成]
      + Welcome API Key 登录只写 Official API Provider 的稀疏 Personal Override [完成]
      + Welcome API Key 登录在新 Host 上从 Settings View 确认 Provider，并在保存后从
        Selection View 选择默认模型；不再写入旧 Provider 镜像 [完成]
      + Provider Settings Service 成为所有生产 Entry 的必备服务；API Key 读取、写入和
        Management URL 只使用 Settings View，失败不再回退旧 ModelProviderService [完成]
      + Custom Model 恢复优先使用 Registry Selection View [完成]
      + 草稿启动门禁优先使用 Model Selection Service [完成]
      + V4 草稿启动门禁删除旧 Provider Registry Snapshot fallback，只使用
        Model Selection View 作为可选模型事实 [完成]
      + ZCode Agent 的最近选择/当前回包 Provider 可用性裁决改读 Model Selection View，
        不再读取旧 ModelProviderConfig 全局快照 [完成]
      + OAuth 登录后与启动恢复的 Family Selection 删除未参与裁决的旧
        ModelProviderConfig 读取，只使用权益、Team Products 与当前选择状态 [完成]
      + 删除 Settings Sync 对旧 Provider Snapshot 的刷新；当前尚未提供 Provider 导入，
        未来导入必须显式写入 Personal Config [完成]
      + 生产 Root 的启动 Provider 可用性与登录门禁只读 Model Selection View；删除
        Renderer 旧 Provider Snapshot 状态、订阅和刷新模块 [完成]
      + OAuth 登录、会话恢复与登出在账号选择状态收敛后统一刷新 Account Source 与
        Registry，不再在 Renderer 按 Provider 调用旧 refreshCodingPlanApiKey [完成]
      + 模型切换提示、时间线与发送埋点只从 Model Selection View 读取 Provider
        label/baseURL，不再使用旧 Provider 快照兜底 [完成]
      + Workspace 模型偏好裁决直接消费 Model Selection View，删除非 ZCode Agent
        分支对旧 ModelProviderConfig Snapshot 的可选性判断 [完成]
      + Workspace reload 删除旧多 Agent Provider 配置裁决器；历史 provider 标识在边界
        归一到当前唯一 ZCode Agent，模型回显只使用 prepare 回包、App Recent 与
        Model Selection View，不再读取 workspace 下的旧 GLM Provider Config [完成]
      + V4 custom provider 恢复删除旧 ModelProviderConfig fallback，只从
        Model Selection View 选择首个模型 [完成]
      + 本地 Host 的 Bot `/model` Provider/Model 候选改读 Model Selection Service；
        workspace runtime configOptions cache 保持独立；Bot Service 不再接受旧
        ModelProviderService 作为候选事实源 [完成]
      + Bot `/status` 的自定义 Provider label 改读所属 Environment 的 Model Selection Service，
        不再从旧 ModelProviderConfig 取得展示事实 [完成]
      + Bot 启动迁移使用所属 Environment 的 Model Selection View 的 Provider/Model 索引，
        并停止旧 Provider Config 缓存预热与持久菜单 fallback [完成]
      + Provider Family Domain 的一次性启动迁移从 Model Selection View 推断
        当前唯一可选 Family，不再从旧 Provider Config 重做可用性判断 [完成]
      + Root 登出和设置页 Plan 解绑在操作发生时读取 Model Selection View，
        仅以可选 API Provider 判断是否保留当前 Family Domain [完成]
      + Composer、Automation、Subagent 与 Repo Wiki 的模型思考档位改读
        Model Selection View 中的 ModelConfig Option Specs；生产 Entry 不再从旧 Provider
        metadata 或 GLM 名称规则补充 Registry 静态事实 [完成]
      + 模型菜单在 Model Selection View 发布后只投影 Registry 候选；被 Registry
        过滤的旧 Provider 不再按 ID 缺口追加，确认空 View 也不回退 [完成]
      + Subagent 设置页删除 useModelProviders 订阅和永远为空的 Legacy Provider 参数；
        模型候选、加载状态及无 Workspace 时的 reasoning Option Specs 只使用进程级
        Model Selection View [完成]
      + Repo Wiki 生成设置删除永远为空的 Legacy Provider 参数；模型菜单只投影
        Model Selection View，reasoning 在 View 未发布时保持未知，不按模型名补事实 [完成]
      + Composer 模型菜单、Provider 存在性、label 与 API Provider 恢复资格只使用
        Model Selection View；View 未发布时保持空，不再订阅旧 Provider Snapshot [完成]
      + Composer 草稿 reasoning 默认值只读 Model Selection View；View 未发布或模型没有
        Option Spec 时保持未知，不再使用旧 Provider metadata 与 GLM 名称规则 [完成]
      + UI 统一 reasoning helper 删除旧 ModelProviderConfig 解析器与 GLM 名称硬编码，
        公共输入收窄为已发布的 Model Selection View [完成]
      + 设置页在 Provider Settings View 发布后只投影 View 中的 Provider；旧快照既不补
        Account 运行字段，也不追加新事实源未收录的 Provider [完成]
      + Coding Plan entitlement Hook 改用 Account Overlay 的 accessId 判断连接并构造刷新身份；
        Renderer 不再读取 API Key 判断套餐可用性，禁用模型入口仍保留 Account Access [完成]
      + Session 提交时的 Plan Identity Snapshot 改用 Account Overlay 的 accessId；套餐身份、
        Entitlement Cache 与提交遥测不再订阅旧 Provider 快照或读取 API Key [完成]
      + 设置页 Usage 套餐来源、查询门禁与缓存身份改用 Account Overlay 的 accessId；
        SettingsPage 不再为 Usage 订阅旧 Provider 列表，Usage 面板只消费最终来源 [完成]
      + 侧栏 Usage 的连接门禁、缓存身份与 Team Products 探测改用 Account Overlay；
        公共余额/升级状态解析器只接收 providerId/label，不再依赖 ModelProviderConfig [完成]
      + Composer Context Usage 的个人套餐候选、加载状态与 Team Products 门禁改用
        Account Overlay；模型菜单也只消费 Model Selection View [完成]
      + Automation 在 Model Selection View 发布后直接投影 Registry 菜单并读取 Registry
        Provider label，不再用旧 Provider 重做 entitlement 过滤或覆盖静态展示 [完成]
      + Automation 编辑表单删除 ModelProviderConfig 输入；模型 label 与 reasoning Option Specs
        只读 Model Selection View，View 未发布时不再回退旧 metadata [完成]
      + Automation 主页面删除旧 Provider 与 Entitlement 订阅；模型菜单在 Registry View
        未发布时保持空，创建/运行遥测从 Provider Settings View 读取 Personal API 静态字段 [完成]
      + 闲时任务首页与购买漏斗从 Provider Settings View 的 Account accessId 判断当前
        Start/Coding Plan，不再从旧 Provider enabled、systemDisabledReason 或 Team ID 反推 [完成]
      + 设置页 Coding/Start/Team Plan 的连接状态、登录完成等待与自动同步
        改用 Account Overlay accessId；生产 UI 不再保留未装配 Provider Settings Service
        时读取旧 Provider API Key 的分支 [完成]
      + 全局 Coding Plan 购买完成后显式等待 Account Source 与 Registry 刷新；
        删除旧 Provider Hook 订阅、Snapshot 刷新与 refreshCodingPlanApiKey 分支 [完成]
      + Root 启动、OAuth 恢复/登录/登出与 Provider Family 迁移的刷新入口，
        新 Host 直接刷新 Provider Settings / Account Source / Registry，不再预热旧 Snapshot [完成]
      + 本地 Host 必须装配 Provider Runtime；Official / Personal / Account Source 成为启动事实，
        不再存在旧 Preset 兼容预热分支 [完成]
      + 删除旧 ModelProviderService 的公共服务面、RPC 注册、Host 代理与旧 Preset Sync；旧物理
        Store 只保留给一次性 Personal/Account 迁移读取，不再形成运行时服务或刷新事实源 [完成]
      + 设置页显式连通性测试从 Host Registry 取得静态模型事实，并通过请求期鉴权边界
        取得动态凭据；未保存的静态编辑草稿随本次 Settings RPC 提交，Start Plan 仅由
        Renderer 补充本次交互产生的一次性安全校验 Header。既有 Probe 暂时只承担网络探测，
        不再解析 Provider 事实或 Account 身份 [完成]
      + 设置连通性测试把鉴权后的单次网络探测提升为窄依赖，不再回调旧
        ModelProviderService 或通过 `requestAuthResolved` 绕过旧 Snapshot 逻辑 [完成]
      + 删除旧 ModelProviderService 的公开 `testModelConnectivity`；连通性测试覆盖迁移到
        独立 Probe 测试，旧 Service 与远端 Host 不再保留该兼容入口 [完成]
      + 删除旧 ModelProviderService 的 `getProviderRegistrySnapshot`、快照缓存和专属测试；
        Repo Wiki 也直接使用 Model Selection View 与统一 Model [完成]
      + 清理 UI 测试中已删除 Snapshot API 的 mock、初始化和断言；Personal Config 首次迁移
        直接读取旧物理 Store，不再经过旧 ModelProviderService View [完成]
      + 其余 Selection 消费者与 Settings 配置读写切换 [完成]
      + Settings 保存入口接收结构化的完整 Effective Provider/Model Config；Facade
        相对 Official Config 计算稀疏 Personal Overlay，并通过一次原子替换写入
        Personal Config。Renderer 使用私有表单状态，不再复用共享旧 Store 类型 [完成]
      + Renderer 编辑态直接承载 `ProviderConfigObject` 与 `ModelConfigObject`，只额外保存
        `providerId/modelId` 和 Registry 投影状态。删除复刻旧 Store 的 endpoints、kind、
        modalities、ProviderOptionsPatch 与时间戳字段；草稿仍由 Renderer 持有，保存继续调用
        `saveEffectiveProvider()` 计算稀疏 Personal Overlay [完成]

M2.5  API Provider 的 Worker Registry 与 ModelFactory 正式装配
      + M2.5a 新 Registry -> AI SDK 执行投影与 ModelFactory 边界 [完成]
      + M2.5b 共享 Node Config 边界；Worker 进程启动并持有 Registry [完成]
      + M2.5c 每个 App 装配 Model Runtime，切换普通 API Provider 生产调用，
              同步切换最终 Personal 迁移/写入口并删除对应旧事实读取 [完成]
              - 新 Settings 入口只写 Personal Config；删除旧 Store 镜像写入和
                旧 Store -> Personal Config 的稳态反向同步 [完成]
              - Expert Workflow 与 Script Workflow 子 Runtime 复用进程 Registry 的
                ModelFactory，不再退回旧 ModelAdapter / Catalog 执行链 [完成]
              - Core 兼容运行配置所需的 context、output、媒体能力和 reasoning 参数，
                对已进入 Registry 的 Provider 统一从 Registry Model Config 投影；旧
                Catalog 只留在首次迁移和当前 Turn 的临时执行输入边界 [完成]
              - 主动初始化与 `setModel` 遵守 Provider 级迁移边界：Registry 已拥有
                Provider 时，缺失 Model 直接报错，不再从旧 Runtime Overlay 拼接；
                Session 恢复仍保留历史 Selection，状态读取也不借旧 Catalog 解释已删除
                Model，直到执行时明确报告不可用 [完成]
              - Bootstrap 的主动 Registry Selection 通过 Registry `validateSelection()`
                校验通用 Options，不再仅凭 Provider/Model 索引创建运行选择 [完成]

M2.6  Prompt CLI / TUI 改用共享 Provider 领域实现                 [完成]
      + 已注入 Official / Personal 路径时启动一份进程级 Registry
      + Prompt CLI 在单次 App 生命周期内借用并释放 Registry
      + TUI 跨 /new、resume 复用同一 Registry，只在 Entry 结束时释放
      + Prompt CLI / TUI 创建 App 时显式使用 registry-only；完成旧配置导入后不再装配
        Workspace Legacy Compatibility Source [完成]
      + CLI/TUI 随包 Official Config 定位与 Personal 路径装配 [完成]
      + 旧 CLI 用户文件中的显式 Provider 一次性差异导入 [完成]
      + Standalone Selection View 与 Session 模型切换改读 Registry [完成]
      + 独立、版本化的 Environment Configured Default 存储 [完成]
      + 新 Session 的 Configured Default / Registry Fallback 退出旧 Runtime Model Config [完成]
      + 已有 Session 优先恢复 Session Selection [完成]

M2.7  现有 Account Provider 与闲时任务执行模型接入统一 ModelFactory [完成]
      + Account Provider 与闲时任务模型统一进入 M1 ModelFactory [完成]
      + 闲时任务编辑器只从 execution-scoped `allowedModelConfigs` 读取
        reasoning 档位，退出 Renderer 按 GLM 模型名补齐静态事实 [完成]

M2.8  退出 Host -> Worker 完整 Registry Snapshot 和旧 Provider 事实链路 [完成]
      + 本地 Worker 的 ModelFactory 退出 Workspace Compatibility Source；旧 Snapshot
        不再参与 Worker Model 创建 [完成]
      + Local Host 停止在 Session、Workspace Read、Generate 与 V4 入口下发完整 Snapshot；
        这些入口只建立 Account Config 顺序屏障 [完成]
      + 设置保存后的 runtime sync target 只收集已连接远端 workspace，本地 tab 不再
        触发 workspace/updateProviderRegistry [完成]
      + 本地 Bot 切换 custom model 只提交 modelRef，不再 apply Provider 或下发旧完整
        Registry Snapshot；desktop-attached remote 暂时保留兼容同步 [完成]
      + Repo Wiki 直接消费所属 Environment 的 ModelSelectionView；旧
        ZCodeProviderRegistrySnapshot 投影、反向解析器与 readiness resolver 已删除 [完成]
      + 闲时任务套餐判断和派发凭据解析退出旧 Provider 列表与完整 Registry Snapshot；
        Account Overlay 提供固定 accessId/baseURL，请求时由 Account Request Auth Resolver
        取得当前动态凭据 [完成]
      + 本地 Host 的启动门禁改读 ModelSelectionView；普通 Session create/resume/set/send
        只提交 ModelSelection，不再从旧 Snapshot 派生 runtimeModel 覆盖 Worker Registry；
        显式 execution-scoped runtimeModel 继续作为一次执行的输入 [完成]
      + V4 本地模型切换收到 provider.notInRegistry 时直接保留 Worker Registry 的拒绝结果，
        不再重推旧 Snapshot 或携带 Host runtimeModel 重试；远端遵守同一规则 [完成]
      + V4 本地与远端草稿预热都只携带初始 ModelSelection/Options，不再由 Host 解析
        runtimeModel [完成]
      + Start Plan 请求前 Runtime Header 从 Provider Settings View 读取
        apiFormat/baseURL 静态事实；官方版本安全校验判定没有旧 Provider Snapshot fallback [完成]
      + 官方版本安全校验材料获取与 request-scoped Header 准备删除旧 Registry Snapshot 契约依赖；
        动态材料、请求级 Header、重试与回执仍由原运行时鉴权链路负责 [完成]
      + 删除旧 `setProviderRuntimeHeaders` 全局可变 Header 与 UI 兼容入口；一次性 Header
        只通过 request/response 进入对应模型请求，静态 Registry 始终剥离历史一次性 Header [完成]
      + Services replayable/Bot 的本地与远端 V4 createSession 都只提交 ModelSelection [完成]
      + Automation 的本地与远端 V4 switchModelConfig 都只提交 ModelSelection/Options [完成]
      + 删除 Host `session/updateRuntimeModelConfig` 热同步协议；冷恢复由 Worker Registry
        创建 Model，请求级凭据与 Header 由 Adapter 在请求时获取 [完成]
      + Remote Workspace Host 的 Bot 注入 Remote Model Selection Service；Bot 模型菜单、
        状态展示与旧状态迁移不再读取 Desktop Local Host 的 Provider 事实 [完成]
      + Remote Host 的 ProviderRuntime 成为 Remote Worker 唯一长期 Model 来源；
        desktop-attached remote 不再禁用自身 Registry [完成]
      + 远端模型就绪、设置与选择读取 Remote Settings / Selection View，不再读取
        Desktop base Host 的模型事实 [完成]
      + 删除 Desktop -> Remote 的 workspace/updateProviderRegistry、runtimeModel、
        Account Config 与 Secret Snapshot 注入主链路 [完成]
      + Remote Account Request Auth 只读取 Remote Credential Store；不建立 Renderer
        Auth 中转或 Local Host -> Remote Host Auth Broker [完成]
      + Session 模型 preflight 在进程 Registry 模式只使用 Registry-backed
        `app.listModels()` 判断成员和选择回退项；未装配 Process Registry 时仍存在旧
        Workspace Model Preferences，只保存交互与持久选择
      + Registry App 创建、Workspace State、V4 模型切换与冷恢复 usage 全部退出旧 Workspace
        Catalog Provider：不再生成 bootstrap config、同步 overlay/limits、混入 Provider View 或
        发布旧 providerRevision；当前模型属性取自 App Runtime 已固定的 Registry Model [完成]
      + Registry 进程收到旧 Host `runtimeModel` 时不再写入 Workspace Provider 状态；长期模型
        仍由 Registry 解析，execution-scoped 临时模型只走独立 Turn Source [完成]
      + `workspace/readState` 收敛为纯投影协议，删除 `runtimeModel` 输入和 Active Session
        thought 写入；草稿准备与 Repo Wiki 不再保留 `preferredRuntimeModel` 入口 [完成]
      + `workspace/setDefaultModel` 只保存 ModelSelection；协议、Services 与 Worker 删除
        `runtimeModel` 输入，不再用 Workspace 偏好写入补充 Provider [完成]
      + V4 create/switch 命令删除普通 `runtimeModel` 回落，只由 Worker Registry 校验
        ModelSelection；Repo Snapshot 旁路不再读取 Workspace State 猜测 Provider [完成]
      + 旧 Session create/resume/send/compact/setModel/setThoughtLevel 协议删除完整
        `runtimeModel` 与派生 revision；普通 Session 只传 Selection，Worker 不再缓存或应用
        Host Runtime Snapshot [完成]
      + 后续独立 Provisioning Sync 把本地 Config/Credential 写入 Remote Store；它不参与
        Registry 构建或请求执行。本步骤只保留接入边界，不实现该同步功能 [后续课题]
      + 更后续允许 App 通过 Remote Settings / OAuth Service 操作远端配置与登录 [后续课题]
```

同一 Environment 内的 Account Config 跨进程同步先从 Workspace Snapshot 中拆出。Host 从自己的 Account
Provider Source 读取当前第三层 Overlay，通过 `provider/updateAccountConfig` 发送普通对象；
Worker 在 Provider 领域边界解析为 `ProviderConfigMap`，替换进程级 Account Source 并刷新
Registry。该协议不携带 JWT、API Key、一次性安全校验材料或请求 Header，也不绑定某个 Workspace。

```text
Host Account Provider Source
        |
        | revision + Account ProviderConfigMap JSON
        v
provider/updateAccountConfig
        |
        v
Worker MutableAccountProviderConfigSource
        |
        v
ProviderRegistryService.refresh()
```

Account Config 最初先从旧完整 Snapshot 中拆出，随后 M2.8 按执行、展示和远端来源分别退出了
Workspace Snapshot。当前 `provider/updateAccountConfig` 是仍然保留的窄同步边界。

`provider/updateAccountConfig` 不跨 Environment 使用。Remote Host 从自己的账号状态形成
Account Config，再把它同步给自己管理的 Remote Worker。Desktop Local Host 不向 Remote Host
或 Remote Worker 发送这份 Overlay。

本地与远端生产 Worker 都拥有 Official、Personal、Account 三层 Registry。普通生产路径的
ModelFactory 查询所属进程的 Registry；协议 Entry 必须装配 Process Registry，缺少 Official 或
Personal Config 路径时启动直接失败，不再回落到 Workspace Provider Catalog。

Local Host 通过自己的 `ModelSelectionView` 判断至少存在一个可选择模型，并在空 Registry 变为
可用时唤醒等待启动的 Worker。这个 View 不携带执行凭据，也不用于构造普通 `runtimeModel`。
Session create/resume/set/send 等本地入口只传 `providerId/modelId/reasoningLevel`；Worker 依据自身
最新 Registry 创建 Model。Worker 的 Official 与 Personal 来自自己的 Config Source，Account 由
独立进程协议同步。M2 实现中仍保留的 execution-scoped `runtimeModel` 只服务闲时任务，是迁移期
兼容输入；最新裁决要求后续把它收窄为 ModelSelection + Request Auth + Ticket，删除其中的 Provider
和 Model 静态配置。它从不表达 Workspace 或另一个 Environment 的长期 Provider 事实。

desktop-attached remote 不再建立动态鉴权的跨 Host 路由。Remote Worker 的请求只到达 Remote Host，
由 Remote Account Request Auth 读取 Remote Credential Store。后续本地到远端的持续同步功能可以更新
Remote Config 与 Credential Store，但同步完成后仍由 Remote Source 重建 Registry、由 Remote Request
Auth 解析请求凭据。它不会恢复 Desktop Snapshot 或跨 Host 请求鉴权。

```text
Local Host ModelSelectionView
        |
        +-- 启动门禁 / 模型选择
        |
        +-- Submission(ModelSelection)
                    |
                    v
             Local Core Worker
                    |
                    v
          Process Provider Registry
                    |
                    v
                  Model

迁移期 execution-scoped runtimeModel
        |
        v
闲时任务兼容输入
```

## M2.8 的来源退出顺序

M2.8 完成时，Worker 仍保留下面两类 Model 来源。这张图记录已经交付的迁移状态，不是最终设计：

```text
一次 Agent Loop 创建 Model
        |
        v
Turn Execution Source
├─ 仅当前执行存在
├─ 当前用于闲时任务兼容 runtimeModel
└─ 命中时覆盖同名 Registry 模型
        |
        | 未命中
        v
Process Provider Registry
├─ Official ProviderConfigMap
├─ Personal ProviderConfigMap
├─ Account ProviderConfigMap
└─ 普通长期 Provider 的唯一事实来源
```

Turn Source 与 Process Registry 分别判断自己持有的 target。二者即使包含相同 `providerId/modelId`，
也不能借另一层的成员判断宣称自己能够创建 Model。M2.8 已经让主要生产路径退出 Workspace
Compatibility Source；上线清理随后删除了它的 Bootstrap fallback 和旧协议类型。后续 M4 再删除
Turn Source 的 Provider 静态配置：闲时任务改从 Process Registry 选择 Builtin Model，只保留
turn-scoped Request Auth 与 Ticket。

切片编号用于当前规划，可以根据代码依赖调整。调整时先更新本篇，不在实现中另造平行架构。

## 后续阶段接续的边界

Config、Registry、主要生产装配和旧事实源退役已经完成，并由 M2 清理门禁持续保护。后续阶段在当前边界上继续：

- M3 把模型选择与 Prompt 原子封装为 Submission，并统一 Session、Draft、Recent 与 Loop 内切换语义。
- M4 删除通用 execution-scoped Provider；闲时任务改用 Registry ModelSelection，并仅携带本 Turn 的 Request Auth 与 Ticket。
- M6 继续整理 Account Provider 的身份、权益、凭据刷新与请求期鉴权内部结构。
- M7 实现 Remote Environment 的 Provisioning Sync 与远端设置操作；远端 Registry 始终读取远端自己的事实源。

旧 Store Reader 的删除以一次性 Personal Config 与 Account Key 迁移停止支持为前提，不再参与任何运行时设计。

相关现状证据见 [`../research/m2-registry-aggregation-and-refresh.md`](../research/m2-registry-aggregation-and-refresh.md)。实施中超出原计划的自主决策见 [`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md)。

## 实施记录与裁决去向

本篇维护 M2 切片的当前状态。实施期间超出原计划的自主决策按时间顺序保存在
[`02-provider-config-and-registry-implementation-log.md`](./02-provider-config-and-registry-implementation-log.md)；需要人裁决的架构、产品和公共契约问题保存在
[`02-provider-config-and-registry-human-in-the-loop.md`](./02-provider-config-and-registry-human-in-the-loop.md)。历史记录可能被后续裁决或实现取代，当前事实以本篇、Design 和 M2 Cleanup 为准。

```text
设计已经回答的问题
└─ 直接按设计实施

实现细节但不改变边界
└─ 自主决策并记录

会改变目标边界的问题
└─ 先回到 design 讨论
```

## 完成条件

- Official/Personal/Account ProviderConfigMap 只有一套 Overlay 逻辑，Official/Personal ModelConfigRules 只有一套解析逻辑。
- Catalog、Preset、Builtin hardcode、Family resolver 和旧 Runtime Snapshot 不再作为额外 Provider/Model 事实来源。
- Host、Core Worker、Prompt CLI 和 TUI 复用相同 Provider 领域实现。
- Registry 维护当前有序 Provider View、查询索引和 Selection 校验。
- 普通 API Provider 的 Submission 只携带 ModelSelection，Worker 使用自己的 Registry 创建 Model。
- 设置和选择 Facade 使用 Registry，Renderer 不解释配置来源。
- Official Provider 顺序稳定，Personal-only Provider 与其模型的拖动结果由 Personal Config 自身顺序表达。
- Registry 更新只影响新 Model，当前 Agent Loop 保持稳定。
- Official/Personal Config Source 只在 content revision 改变时发布 invalidation；
  Personal 进程自写不会被文件 watcher 重复通知，外部编辑仍即时生效。
- 迁移期兼容逻辑已经退出生产权威，并按
  [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md) 删除残留接口、类型和 fallback。

上述条件和 M2 Cleanup 的退役门禁全部满足后，M2 才标记完成。M2 已经建立 Provider/Model Config、账号级 accessId、Usage/Entitlement 事实源、请求鉴权账号核对和 Credential 隔离的统一边界。它不重新定义产品权益规则，不重做 Token 刷新协议、Usage API 行为和闲时任务状态；M4 与 M6 再分别处理 execution-scoped 执行语义和更完整的 Account Provider 状态模型。
