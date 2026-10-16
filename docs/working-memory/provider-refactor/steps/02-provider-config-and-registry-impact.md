# M2 Provider Config / Registry Impact Brief

> 状态：历史实施契约
>
> 适用范围：M2 首个纯领域切片开工时的影响面、边界和测试交接
>
> 本文保留当时的规划证据，因此正文中的“本批次”“后续接入”和未决项不代表 M2 当前状态。
> 当前实施状态见 [`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)，剩余退役项见
> [`02-provider-config-and-registry-cleanup.md`](./02-provider-config-and-registry-cleanup.md)，当前设计见
> [`../design/registry/registry.md`](../design/registry/registry.md)。

## Feature Summary

| Field            | Value                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Developer intent | 建立 Host、Worker、Prompt CLI 与 TUI 可复用的 Provider 配置解析和 Registry 领域核心                               |
| Capability       | Provider registry、model capabilities、model selection option source                                              |
| Change layer     | option-source、validation、persistence boundary                                                                   |
| Operating mode   | planning                                                                                                          |
| Primary seeds    | `IModelProviderService`、`ModelProviderConfig`、`ModelConfigSelect`、Workspace Model Catalog、M1 `Model` contract |
| Out of scope     | UI 改动、物理配置存储、watcher、账号网络请求、Submission、Adapter、远端同步迁移                                   |

## UI Surface Matrix

本批次不接入 UI。下表记录后续接入时必须保持的消费边界。

| User scenario | UI entry                                          | Shared implementation                        | Display/draft owner     | Default/inherit source              | Validation/gating       | Commit action            | Authority/persistence            | Mode boundary                  | Must remain isolated from            |
| ------------- | ------------------------------------------------- | -------------------------------------------- | ----------------------- | ----------------------------------- | ----------------------- | ------------------------ | -------------------------------- | ------------------------------ | ------------------------------------ |
| 编辑 Provider | Model Provider Settings                           | ProviderConfigResolver；未来 Settings Facade | 设置页 draft            | Official + Personal + draft overlay | Resolver issues         | 未来 Config Service save | Personal Provider Config         | Host 所属 Environment          | 模型选择状态、活动 Agent Loop        |
| 选择模型      | Conversation/Automation/Subagent/Repo Wiki picker | Registry View；各 Surface 自己组织候选       | 各 Surface 自己的 draft | 各 Surface 自己的默认/继承规则      | Registry 只提供可选模型 | 各 Surface 原有提交链路  | 各自的 Selection owner           | local/remote Registry 各自独立 | 其它 Surface 的 draft 与 commit sink |
| 执行模型      | Core Worker / Prompt CLI / TUI                    | Registry lookup；后续 ModelFactory           | Agent Loop              | Submission/Session ModelSelection   | Registry Selection 校验 | create Model             | Worker 所属 Environment Registry | Worker 不依赖 Renderer         | Host draft、App Recent、设置页面状态 |

## Shared And Divergent Behavior

| Concern              | Shared across surfaces                        | Deliberately different                                    | Why it matters for this change            |
| -------------------- | --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------- |
| Option source        | ProviderConfigResolver 与 Registry View       | 设置页还需要无效项和显式 Personal 值                      | Registry 不能为了设置页保留灰色不可用模型 |
| Validation           | Schema、三层 Overlay 与完整性校验             | accessId 鉴权、额度、网络错误仍由执行链路处理             | Registry 不承担账号权限判断               |
| Commit effect        | 无                                            | 设置保存、模型选择、Agent 执行各自保持原有 owner          | 共享解析不能统一掉不同产品语义            |
| Persistence/recovery | Config 类型与普通 Object 序列化格式           | 物理文件、远端服务、缓存和 watcher 由 Source Service 决定 | 纯领域包不拥有 IO                         |

## Feature Relationships

| Rank           | From                   | Semantic edge           | To                           | Condition              | Why inspect it                          | Evidence                                                               |
| -------------- | ---------------------- | ----------------------- | ---------------------------- | ---------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| must-inspect   | Provider Config        | resolves-through        | ProviderConfigResolver       | 所有入口               | 避免 Host、Worker 各写一套 Overlay/过滤 | Working Memory registry design；`packages/services/src/model-provider` |
| must-inspect   | ProviderConfigResolver | publishes-valid-view-to | ProviderRegistry             | 静态事实完整且允许选择 | Registry 只包含可绑定候选               | `design/registry/registry.md`                                          |
| should-inspect | ProviderRegistry       | options-from            | 各模型选择 Surface           | 后续 UI 接入           | 共享候选源但不共享 draft/commit         | feature graph `capability.model-selection`                             |
| conditional    | ProviderRegistry       | creates-model-through   | ModelFactory                 | M2.4 起                | 本批不创建执行 Model                    | `design/registry/model-creation.md`                                    |
| invariant-only | Registry 更新          | must-not-mutate         | 已创建 Model / 活动 Loop     | 所有进程               | 新配置只影响以后创建的 Model            | `design/registry/runtime.md`                                           |
| invariant-only | Provider 领域包        | must-not-own            | file/network/account runtime | 所有模式               | 保持领域核心无 IO、可独立测试           | 用户确认的 M2 边界                                                     |

## State Owners And Commit Sinks

| State/fact                      | Draft/display owner | Authoritative owner               | Commit command/service | Persistence/cache                  | Evidence                          |
| ------------------------------- | ------------------- | --------------------------------- | ---------------------- | ---------------------------------- | --------------------------------- |
| Official/Personal Config Object | Source Service      | 所属 Environment 的 Config Source | 后续 Config Service    | 当前 v2 config / 管理服务；M5 细化 | M2 design                         |
| Account Provider Access         | Account Service     | 当前账号/权益 Source              | 账号刷新链路           | Source 自有缓存                    | M2 design；plan entitlement graph |
| Effective Provider resolution   | Resolver 返回值     | 可重建派生事实                    | 无                     | 不持久化                           | M2 design                         |
| Registry View / index           | 进程内 Registry     | 当前 Registry 实例                | `replace()`            | 仅内存                             | M2 runtime design                 |
| Surface draft / Selection       | 各产品 Surface      | 各自状态 owner                    | 原有 command/service   | 各自持久化                         | feature graph surface edges       |

## Must-Preserve Invariants

| Invariant                                                               | Surfaces/modes             | Proof needed           | Evidence               |
| ----------------------------------------------------------------------- | -------------------------- | ---------------------- | ---------------------- |
| Official key 保留 Official 顺序；Personal-only key 按 Personal 顺序追加 | Config、Settings、Registry | Overlay 单测           | configuration design   |
| 嵌套 ConfigOverlay 递归覆盖，普通字段整体替换，输入不被修改             | 所有消费方                 | 单元测试               | configuration design   |
| Account Source 只为 account kind 产生第三层 ProviderConfig；API Provider 没有该层 | Host/Worker/CLI/TUI | Resolver 单测 | registry design |
| Registry 只发布完整、启用、静态可选的模型                               | 模型选择与执行             | Resolver/Registry 单测 | 已确认产品结论         |
| Registry 替换 View 不改变调用方已经持有的旧 View/Model                  | 活动 Loop                  | 不可变快照单测         | runtime design         |
| 本批代码不读写文件、不发网络请求、不依赖 UI/Services/SDK                | 所有进程                   | 包依赖审查             | 用户确认的纯领域包边界 |

## Codegraph Evidence

当前环境没有可调用的 codegraph 工具，按技能约定退回功能图声明的 seeds 与 `rg` 直接调用方核对，深度限制为 2。

| Seed                                           | Query                     | Direct callers / key path                            | Depth | Interpretation                                                |
| ---------------------------------------------- | ------------------------- | ---------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `IModelProviderService`                        | declarations / callers    | Settings、模型选择 hook、Host registry snapshot      | 2     | 当前服务混合配置、Registry 和运行时投影，后续逐步接入新领域包 |
| `ModelProviderConfig`                          | references                | shared schema、services storage、protocol projection | 2     | 当前完整副本结构是迁移输入，不直接成为新 Overlay 类型         |
| `ModelConfigSelect` / `buildModelSelectGroups` | graph seeds + references  | Conversation、Automation、Subagent、Repo Wiki        | 2     | 候选源可共享，draft/commit 必须分离                           |
| M1 `Model`                                     | declarations / references | Core、Bootstrap、Adapter wrapper                     | 2     | M2-A 不改变执行契约；M2.4 才接 ModelFactory                   |

## Graph Drift Candidates

| Candidate          | Live-code evidence           | Missing/stale graph relation                    | Proposed follow-up                                         |
| ------------------ | ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| 纯 Provider 领域包 | 本批新增 `packages/provider` | `capability.provider-registry` 尚无该 code seed | 代码落地后把 package seed 加到现有 capability/service 节点 |

## Graph Delta

| Status    | Node/edge                                                                 | Semantic reason                                | Evidence       | Action                                    |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------- | -------------- | ----------------------------------------- |
| confirmed | `capability.provider-registry` 增加 `packages/provider/src/index.ts` seed | 新包承载共享 Config/Resolver/Registry 领域核心 | 用户确认与实现 | 实现后更新 graph seed，不新增产品 surface |

## Unresolved Questions

| Question                           | Candidate answers                           | Scope difference                                                                       | Owner             |
| ---------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------- |
| `reasoningMapping` 最终静态 Schema | 延续当前兼容结构 / Adapter 专题后换正式结构 | 不阻塞 Properties、Option Specs、Resolver 与 Registry；阻塞 M2.4 ModelFactory 完整接入 | 后续 Adapter 设计 |
| Source 失败时发布策略              | 保留 last-known-good / 发布部分结果         | 属于 Source 与 Registry Service 装配，不属于本批纯 Registry                            | M2 后续实施       |

## Planning Handoff

| Item             | Destination                          | Status     |
| ---------------- | ------------------------------------ | ---------- |
| Spec update      | `02-provider-config-and-registry.md` | complete   |
| Case catalog     | 本文下方 accepted cases              | complete   |
| Coverage matrix  | 纯领域包单测                         | complete   |
| Decision backlog | M2 step 未决项                       | complete   |
| E2E handoff      | 无 UI/协议行为变化                   | not-needed |

## Clarification Log

| Round | Question                  | User answer                                                 | Boundary fixed               | Follow-up needed |
| ----- | ------------------------- | ----------------------------------------------------------- | ---------------------------- | ---------------- |
| 1     | 共享代码放在哪里          | 新建纯领域包                                                | Host/Worker/CLI/TUI 共享实现 | no               |
| 2     | JSON 与运行时形态         | JSON/RPC 普通 Object；解析后 ConfigOverlay Class + 有序 Map | 序列化与运行时边界           | no               |
| 3     | Account Personal override | 领域层不特殊限制；设置页预期不提供部分交互                  | Resolver 不硬编码 UI 策略    | no               |
| 4     | Registry 是否无 IO        | 是；Source Service 负责 IO，Registry 维护内存 View          | IO 所有权                    | no               |

## Boundary Decisions

| Boundary              | Decision                          | Includes                                             | Excludes / prunes                                   | Source      |
| --------------------- | --------------------------------- | ---------------------------------------------------- | --------------------------------------------------- | ----------- |
| M2-A                  | Config + Resolver + 内存 Registry | schema、overlay、order、filter、issues、index、event | storage、watcher、account request、UI、ModelFactory | user/design |
| Registry availability | 只包含配置完整且启用的模型        | complete、enabled、三层 Provider Config             | accessId 是否可鉴权、网络健康、额度、瞬时 token    | user/design |
| View ownership        | Registry 原子替换不可变 View      | 新查询使用新 View                                    | 修改旧 View / 活动 Model                            | user/design |

## Accepted Cases

| Case ID          | Setup                                      | Action               | Assertions                                             | Evidence layers  | E2E status |
| ---------------- | ------------------------------------------ | -------------------- | ------------------------------------------------------ | ---------------- | ---------- |
| M2A-OVERLAY-01   | Official `[A,B,C]`，Personal `[Y,C',X,A']` | overlay              | 结果 `[A',B,C',Y,X]`；输入不变                         | unit             | not-needed |
| M2A-OVERLAY-02   | 嵌套 Properties + 普通数组/Record          | overlay              | 嵌套 Config 逐字段继承；数组/Record 整体替换           | unit             | not-needed |
| M2A-MODEL-01     | Official/Personal 多条 regex 规则          | resolve model        | 全串匹配；后命中规则覆盖前规则                         | unit             | not-needed |
| M2A-ACCESS-01    | API 与 Account Provider 同时存在           | overlay Account Config | 只补齐 Account Provider 的 accessId/models；API 不变 | unit             | not-needed |
| M2A-VALID-01     | 不完整、禁用、完整 Provider/model          | resolve              | Registry View 只含完整启用项；问题保留给 Resolver 结果 | unit             | not-needed |
| M2A-REGISTRY-01  | Registry 已持有 v1                         | replace v2           | revision/event 更新；旧 v1 快照保持不变                | unit             | not-needed |
| M2A-SELECTION-01 | provider/model 存在或缺失                  | validate             | 返回稳定的成功/错误结果                                | unit             | not-needed |
| M2B-SOURCE-01    | Config/Account Source 均有当前快照         | service start        | 先订阅后读取；发布一份完整 Registry Snapshot           | unit             | not-needed |
| M2B-REFRESH-01   | 读取 v1 期间 Source 更新为 v2              | source invalidation  | 丢弃过时代际，只发布 v2                                | unit             | not-needed |
| M2B-REFRESH-02   | 两个 Source revision 均未变化              | 重复 invalidation    | 不重建 View、不增加 Registry revision                  | unit             | not-needed |
| M2B-FAILURE-01   | 已发布 v1，下一次 Source 读取失败          | source invalidation  | v1 保持可用；报告刷新错误；后续成功可恢复到 v2         | unit             | not-needed |
| M2C-SETTINGS-01  | Official、Personal、无效和 Account 过滤项  | project settings     | 返回 Personal 显式值、Effective 值、问题与可调序标记   | unit             | not-needed |
| M2C-SELECTION-01 | Settings 仍包含不可发布项                  | project selection    | Selection View 只包含 Registry 已发布的 Provider/Model | unit             | not-needed |
| M2D-CONFIG-01    | Official 或 Personal Source 更新           | config source event  | Config Service 通知 Registry 读取两路最新快照          | unit             | not-needed |
| M2D-CONFIG-02    | Settings 保存、删除或重排 Personal 配置    | repository update    | 在 Repository 原子边界内只修改 Personal 层             | unit             | not-needed |
| M2D-CONFIG-03    | 保存带正则元字符的精确 Provider/Model ID   | settings model save  | 精确规则转义；不意外匹配其他 ID                        | unit             | not-needed |
| M2E-MIGRATE-01   | 新 Personal Config 文件不存在，旧配置存在  | repository read      | 单向导入、校验并原子写入当前 schemaVersion 文件        | unit/integration | not-needed |
| M2E-MIGRATE-02   | Personal Config 是受支持的旧 schemaVersion | repository read      | 按相邻版本逐级迁移并写回最新版                         | unit             | not-needed |
| M2E-MIGRATE-03   | 文件版本高于当前程序支持范围               | repository read      | 报错且不覆盖原文件                                     | unit             | not-needed |
| M2E-MIGRATE-04   | 旧配置转换或新文件原子写失败               | repository read      | 报错并保留旧文件；不发布半迁移 Snapshot                | integration      | not-needed |

## E2E Handoff Notes

- Provider fixture: not-needed
- File-system fixture: not-needed
- Timing strategy: synchronous pure-domain unit tests
- Docker preset: not-needed
- Review risks: 当前生产链路尚未接入；后续接入必须重新做 Host/Worker/remote impact scan
