# Todo104 影响边界与用例

## B5 最终迁移证据校正

跨平台验收补充：缓存目录用 `node:path` 构造和分段断言，不能在测试里把 POSIX `/` 当作 Windows 文件路径分隔符。保持环境、平台、版本、Endpoint hash 及文件名全部断言；这只修测试可移植性，不等于已经在 Windows 运行过。

重建全部 CLI 依赖后，App/Protocol 冷恢复测试不能通过新版 `saveSessionEntry` 播种旧身份：该接口现已写入 `data.modelSelection`，此时旧 ID 不应再被重新迁移。旧版分支必须直接播种 SQLite 平铺 `providerId/modelId/thoughtLevel`，再验证完整 App/Protocol 恢复；当前选择分支继续走正式 writer，不改其失效/清空/消息不回退断言。普通默认选择覆盖测试使用新 `options.reasoningLevel`，不把旧档位字段喂给新逻辑接口。此项修测试数据来源，不新增未发布兼容。

## B4 路径与来源标识（2026-09-10，实施前补充）

与 B2/B3 共用最终构建和 Pro 回归。下载/刷新路径统一到环境 `runtime/provider/<platform>/<version>/<endpoint-key>/`，分发记录为 `runtime/provider/provisioning.json`；随包释放入口统一复用 Node materializer，接收环境配置根目录，固定写 `runtime/provider/bundled/zcode-builtin.json`。正常退出旧程序后升级；不迁移未发布缓存、不删除旧目录，也不重做刷新 lease。

来源标识沿用已注入的 Active 文件路径：该路径含规范化 Endpoint 的隔离 key。Node Source 对绝对规范化路径取 hash，与数值发布 revision 组成运行时 revision；Host 和读取同一 Active 文件的 Worker 使用同一个算法，不加第二份账号字段或传输协议。直接文件 Source 同样按其路径确定范围。文件内发布 revision 仍为原安全整数，不按路径重新编号。

```text
Endpoint → 平台/版本/规范化来源路径 → Host Source revision
                                      |
                             现有路径注入 Worker
                                      |
                             相同路径 → 相同 revision
Endpoint A/B 同发布序号 → 不同路径范围 → Config/Account/Registry 正确区分
```

| Case  | 验证合同                                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------------------------- |
| B4-01 | 三层路径隔离与 Origin 规范化保持；文件名/分发记录路径符合最终裁决                                                          |
| B4-02 | 固定随包文件内容相同不写；变化原子替换；并发读取只见完整旧/新文件；写失败保留旧文件且清理临时文件                          |
| B4-03 | 两个 Endpoint 相同发布序号、不同模型，Config 与 Registry 不能复用旧结果；Account 依据标识跟随，Worker 读同一文件得到同标识 |
| B4-04 | CLI SEA 与 Server 复用相同物化接口，不再复制 hash 文件逻辑；新目录启动、刷新控制与最终五个 schemaVersion=1 配套            |

GLM 完整性旧测试修正依据 §6.3.1：账号测试使用 Provider 实际 Endpoint，不能用不在声明范围内的 `/api/coding/paas/v4` 代替；模型本身与站点覆盖分开断言。同 Endpoint 的普通 API Key 也应用媒体覆盖是已批准行为，不是为测试新增能力。

## B2/B3 完整规则读写批次（2026-09-10，实施前补充）

本批一起接通 Todo104 §6.1–6.9 的规则集合、名称/模板归属及 Personal 文件。新增严格数据 schema 先用定向测试验证，随后同批替换现有 codec、行为规则、Resolver、设置写入与导入/分发消费者；不能只增加一份无人使用的新 schema 就宣布完成。旧的宽泛 Match schema、按字段猜分组、固定模式布尔值及嵌套身份字段在最终读写入口移除。

```text
来源文件 → 所属集合严格 schema → 保留层次的规则/索引
                                 → 原优先级 Resolver → 设置视图/Registry
设置保存/导入 → 同一来源规则 schema → Personal 文件锁内原子更新
                                      └─ 名称去重/默认选择/其他配置一起保留
```

| Case   | 要证明的合同                                                                                                        | 证据                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| B2R-01 | Match 三层严格隔离；API/URL 正则非法、旧字段/type 均拒绝；原合法匹配范围保留                                        | schema + Resolver 定向测试       |
| B2R-02 | 完整 Manual 只放宽 enabled；逐叶缺省/null、非法数值/Map 拒绝；智能允许稀疏；同模型跨两组声明拒绝                    | schema + 保存/重启测试           |
| B2R-03 | Provider/Template 身份在规则外层，同层重复拒绝；Template 密钥、Builtin 个人成员、Personal Account access 均不可越权 | 数据入口测试                     |
| B2R-04 | 各集合顺序往返保留，不根据字段重新猜层；Manual 不继承参数，仅继承 enabled；切换集合不残留另一组                     | codec + Resolver + ConfigService |
| B2R-05 | 模板当前语言/en-US/ID 的命名回退、大小写/空白去重，锁内并发创建不重名；后续语言变化不改已存名                       | 真实 Repository 更新与设置验收   |
| B2R-06 | 四条 providerMatch 转精确 Endpoint，普通 API Key 可命中媒体；Off-Peak 和 Start 搜索不无故扩大                       | 实际 Builtin 解析对照            |
| B2R-07 | 最终空数组/文件包装严格；Provider 修改保留默认选择，清默认保留其他配置；旧已发布导入输出最终结构                    | 文件/分发/并发测试               |

本批消费者补充：Settings 表单区分展示名与本次改名补丁；只改 API 时不保存继承名称，只改名时不物化连接字段或丢 headers。模板创建传 locale，由服务依据当前模板命名；Account 同步仍使用原有 Provider 字典协议，不沿用磁盘规则数组。CLI 启动与登录共用 Personal 文件，首次导入一次读取旧 Provider 与默认模型；Protocol 不自行导入旧 CLI 配置。案例落在 `providerRuleForm`、`providerRuleFileIntegration`、`personal-config-default-integration`，原 `process-provider-registry-runtime`、`account-config-delivery`、`auth-login` 回归承接旧生命周期。现有 SC90/F98/W89 E2E 仍需同步最终结构后批量执行，不以纯函数测试代替桌面验收。

B3 分发收口：Source 从唯一 Personal Repository 读取完整快照，再核对磁盘内容 hash，坏文件/读期间变化不得以内存降级值覆盖远端。Target 复用同一 Repository 的持锁 update；前向替换和失败回滚均在锁内比较整份 Personal 内容，默认选择不再单独读写。回滚恢复的是完整配置语义（与普通写入一样由 codec 格式化），不改已发布旧输入；若用户已写入不同的 C 则跳过该域回滚、明确 rollback_failed，不能把 C 中的新默认选择或 Provider 改回 A。状态/凭据保持原有域边界，不增加全局事务系统。

```text
完整 Personal A → Source 校验内容 → 信封 Personal B（内含默认选择）
                                      ↓
Target 同文件锁：确认当前仍是 A → 整份替换 B → 刷新/验证
                                               ↓ 失败
同文件锁：当前为 B → 恢复 A；当前已为 C → 保留 C，报告回滚冲突
```

分发用例：信封无旧 sourceRevision/外层 configuredDefault，结果 configRevision 对应实际 Config 来源；应用一次和重复 syncId；缺省默认清除；失败恢复 Provider 与默认；失败时并发写入 Provider/默认分别保护；同文件通知到达默认消费者；两个真实进程分别修改 Provider/默认不互相覆盖。

图谱边界沿本文件原有 Surface Matrix；没有新 UI owner、消息时序或账号同步机制。codegraph 工具仍未提供，按精确符号检索到 ConfigService / Facade / Resolver / Node codec 和 Repository；深度 2，跨层保存与分发补到落盘 sink。中途不跑全仓回归、不构建 Pro；上述链路全部接通后共享最终验证。

## Feature Summary

| 字段       | 内容                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 意图／能力 | 保留既有 Provider 与 Selection 产品语义，落实最终持久化 Schema                                                                           |
| 层级／模式 | persistence、validation、draft-default、option-source；planning                                                                          |
| 主入口     | ProviderSettingsFacade / ProviderConfigResolver / createNodeModelSelectionFacade / OffPeakTaskRepo / RepoWikiStorage / SessionRepository |
| 不做       | 多账号同时连接、CLI账号装配重构、发送同步门禁、Subagent Markdown重新定格式、旧预算功能                                                   |

## UI Surface Matrix

| 场景／入口               | 共享实现                             | 草稿／默认         | 校验                    | 提交／权威落点                 | 模式及隔离                              |
| ------------------------ | ------------------------------------ | ------------------ | ----------------------- | ------------------------------ | --------------------------------------- |
| Provider设置             | SettingsFacade/ConfigService         | 表单草稿、推荐规则 | 来源schema/完整性       | PersonalRepository单次更新     | 本地/远程注入服务；不能写Session        |
| Composer                 | SelectionFacade                      | 草稿/Recent/默认   | 有效选择/最终Factory    | 成功提交后的Session选择        | 不提前持久化、不改已冻结运行            |
| 自动化/Bot/Subagent      | 共享Selection数据                    | 各自继承规则不变   | 各自现有提交边界        | 任务/绑定Session/用户MD        | 不因共享字段而共享保存时机              |
| Wiki/Draft               | RepoWikiStorage                      | 生成设置草稿       | 新选择权威              | 既有文件锁内保存               | 不恢复手动输出上限                      |
| 闲时编辑 OffPeakEditView | OffPeakTaskService.updateTask → Repo | 表单草稿           | queued/paused、完整选择 | off_peak_tasks.model_selection | 只保留旧列，不改Ticket、Session或工作区 |

## Shared And Divergent Behavior

共享模型身份、能力和选项schema；各业务分别拥有草稿、提交与保存边界。默认选择落点改变，不改变默认选择与会话持久化的区别。普通Account有效选择仍沿用当前规则；Off-Peak绑定票据不跨账号重新解析。

## Feature Relationships / State Owners And Commit Sinks

| 优先级         | 关系                           | Owner／落点              | 证据与原因                                                    |
| -------------- | ------------------------------ | ------------------------ | ------------------------------------------------------------- |
| must-inspect   | 闲时编辑 → 唯一Repo保存        | OffPeakTaskRepo / SQLite | updateEditableFields目前主动清旧列；Service只规范化已提交字段 |
| must-inspect   | Wiki保存 → 文件原子更新        | RepoWikiStorage          | 运行对象不能携带旧值成为第二权威；保存层保留原值              |
| must-inspect   | Session选择 → entry.data       | Agent SessionRepository  | 恢复/更新/fork必须一致识别新包装                              |
| must-inspect   | 配置来源 → Resolver → Registry | Provider层；Node层负责IO | 单向schema依赖、完整配置准入、相同source快照                  |
| must-inspect   | 默认选择/Provider更新 → 同文件 | PersonalRepository       | 不能相互覆盖，分发失败只回滚本次未被并发替换的结果            |
| conditional    | 新路径 → 打包/宿主启动         | 各宿主注入Node层路径     | Desktop/CLI/Server均需要实际产物验证                          |
| invariant-only | 手机/桌面消息交付              | 同一Session owner        | 不改continuous/replayable与workspaceIdentity隔离              |

## Must-Preserve Invariants

- 已发布旧值只作回滚快照；存在新版选择后不因无效/清除重新读旧字段。
- 读写通过现有owner，UI不直接访问Repo，Service不引用具体Runtime；IO不进入Provider领域。
- Off-Peak新旧列不同不意味着重新迁移，Ticket、队列认领、远程禁用均不变。

```text
表单提交 → Service既有校验 → Repo更新新选择/业务字段 → SQLite
                              └─ 旧model/thought_level原值不动
新版读取 ────────────────────────→ model_selection
旧版回滚读取 ─────────────────────→ 旧列快照
```

## Codegraph Evidence / Graph Drift / Graph Delta

当前工具未提供codegraph入口，仓库package scripts也未配置；使用精确符号检索作为替代，不把文本命中当作语义依赖。首组展开深度2：OffPeakTaskService.updateTask唯一调用Repo.updateEditableFields，Repo行转换只读新版选择，旧列由迁移问题诊断读取。完整Schema组后续补实际调用证据。

图谱中若干 Provider字段及旧分层描述将由B2修改后更新；当前不把未来字段写成已实现事实。B1a仅补保留旧列的不变量，其余现有产品边不变。

## Unresolved Questions / Clarification Log

用户本次明确授权实现最终裁决。B1a无新产品问题；B1b/B1c的清除表示必须沿用已有上层约束，调查后记录，不擅自新增通用null schema。其他范围如需新裁决只停相关事项。

## Planning Handoff / Domain Scope / Dimensions

本文件与Todo104为spec/case入口。首组仅存储与迁移，不改交互；数据库集成测试覆盖真实写入和重启。设置UI组单独补E2E交接，不能用此组通过代替全端验证。

维度：有/无旧列，标题/新版选择编辑，queued/paused/其他状态，重启前/后；不展开网络和主题组合，因为本组不改请求或显示。Ticket字段按不变量核对。

## Candidate Combinations / Pruning Decisions / Accepted Cases

| ID     | 状态与动作                     | 断言／证据                                               | 裁决                        |
| ------ | ------------------------------ | -------------------------------------------------------- | --------------------------- |
| B1a-01 | 存量双格式记录；只改标题       | 原始旧列逐值不变，新选择/Ticket不变                      | accepted，SQLite集成        |
| B1a-02 | 同记录改新版模型、档位并重启   | 新读者使用新选择；冻结staging列形状仍可读旧值            | accepted，SQLite集成        |
| B1a-03 | 新建后修改选择                 | 旧列保持NULL，不捏造旧格式                               | accepted，SQLite集成        |
| B1a-04 | null选择/运行态编辑            | 沿用现有拒绝，不新增清空语义                             | accepted，既有服务/Repo测试 |
| B1a-P1 | 模型请求、额度、网络、主题组合 | 保存层变化不触及这些状态；沿用既有证据，不重新验收旧功能 | pruned                      |

## Matrix Backfill / E2E Handoff Notes

B1b补充：当前Wiki已有Todo97的一次落盘迁移及null空标记，Todo104原文“每次读取内存转换”过时。沿用该标记即可满足清除不复活，无需新的通用schema裁决。迁移、正常保存、删除继续共用文件锁，正式reader过滤旧字段。

| ID     | 场景                                | 断言                                                               | 裁决                    |
| ------ | ----------------------------------- | ------------------------------------------------------------------ | ----------------------- |
| B1b-01 | Wiki/Draft首次迁移与后续修改        | 旧模型/档位/预算原值保持，正文/图表/新选择更新，reader不返回旧字段 | accepted，真实临时文件  |
| B1b-02 | 双格式文档清除/非法新选择后保存重启 | 空标记保持权威，旧选择不复活                                       | accepted，真实文件      |
| B1b-03 | 新文件夹带旧字段                    | 不写入伪造的旧值，不恢复预算                                       | accepted                |
| B1b-04 | 保存rename失败、迁移/保存/删除并发  | 原文不损坏、锁内重读遵守最新事实                                   | accepted，屏障/故障注入 |

无新UI交互或生成规则，B1b不新增E2E；已有Service模型Limit断言随组回归。涉及的私有存储类型不泄漏到协议和UI。

B1a测试落在services/test/offPeakTaskRepo.test.ts；无UI行为修改，不新造E2E。使用临时SQLite，不碰真实数据、不需要模型fixture、不使用时间等待。其余组实施前追加用例与所需E2E矩阵。

## B1c Session 存储边界（实施前确认）

唯一持久化 owner 为 SQLite SessionStore adapter。`SessionEntryInfo.data` 是 port 的逻辑 payload：模型选择仍为公共 ModelSelection（fork 无选择沿用 null）；磁盘 `session_entry.data` 才是保留旧快照的包装。沿用现有 codec 边界完成包装/解包，不让 core/bootstrap 为 SQLite 回滚字段各写一套处理。普通保存、runtime 保存、原子 fork bundle 共用 `saveSessionEntry`，恢复统一经 `decodeSessionEntryRow`。不改变 table/schema、提交时机、协议或消息行。

```text
core/bootstrap 当前选择 → SessionStore.saveSessionEntry
                        → 单条 UPSERT：旧 JSON + 新 modelSelection
冷恢复/fork 读取 ← codec 仅解包 modelSelection ← SQLite
首次旧数据迁移 → 事务重查原候选 → 同一 UPSERT
```

UPSERT 在数据库内部只替换新成员，避免应用层 read-modify-write 窗口；保留磁盘对象的所有其他成员。新记录只写新成员。迁移只读取已发布平铺 providerId/modelId/thoughtLevel，含无 thoughtLevel 的自定义 Provider；不把未发布 options 格式变成兼容合同。新成员存在（包括 null、非法值）即阻断旧字段/消息回退。codec 不把旧快照暴露给业务，未迁移旧记录不能当作正式选择。fork 子记录只携带自己的当前选择，不复制父回滚字段。

| ID     | 场景                                           | 断言                                                                           | 裁决                                      |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| B1c-01 | 旧 Account/custom entry，含或不含 thoughtLevel | 原 id/type/旧字段/未知成员逐值保留，新成员正确，迁移幂等                       | accepted，真实 SQLite                     |
| B1c-02 | 迁移后普通保存、清空、重启                     | 只改变新成员；新 null/坏值不复活旧值；不触碰 session 活动时间                  | accepted                                  |
| B1c-03 | 从旧消息迁移                                   | 新 entry 仅新成员，旧消息字节不变                                              | accepted                                  |
| B1c-04 | runtime 切换、冷恢复、fork bundle              | 既有 ModelSelection port 合同往返不变，子选择与父隔离                          | accepted，adapter/core/bootstrap 联合回归 |
| B1c-05 | 迁移/后续写入并发与写入失败                    | 单事务/单 UPSERT，无旧读覆盖，失败旧数据仍完整                                 | accepted，事务/故障注入                   |
| B1c-P1 | UI/网络/主题/queue 全排列                      | 不改 interaction、continuous/replayable 或输入 admission，以现有运行层回归代表 | pruned                                    |

补充架构工具事实：`architecture:check --changed` 无违规；`cli-adapters` 尚非 architecture-policy 托管模块，context 命令返回未知模块，改用现有 SessionStorePort 和 CLI AGENTS 作为边界依据，不为此扩建治理模块。

B1c E2E 合同同步：现有 unbound-resume 通过原始 SQL 播种当前选择、OffPeak 已有会话用例通过原始 SQL 检查选择；二者必须读写磁盘 `data.modelSelection`，不走逻辑 port。用例语义不变，仅修 fixture/断言路径。仍为 pending，不把静态合同更新算成实机通过；最终共享 Pro 构建后合并复验。

## B2a Model 数据 Schema 单一来源

先将 Model 数据约束从带 class transform 的 codec 拆出。完整数据 schema 声明叶子；稀疏覆盖由它派生（可缺省/可null，嵌套也保持稀疏）。构造输入/序列化类型从相应 schema 推导；行为类保留 overlay/freeze，validateComplete 只调用完整 schema，并翻译现有问题路径。Registry完整类型复用同一推导结果。没有新的IO、状态owner、订阅、执行选型或UI交互。

```text
纯数据 schema → 推导类型 + 完整/稀疏校验
       ↑                  ↑
行为类 overlay/freeze    codec parse → 行为类
       └──── 完整准入 → Registry
```

这一步不单独发布格式变更；后续B2字段改名/分组直接修改同一schema及消费者，不兼容临时格式。当前完整配置包含enabled；手动模式的enabled例外由后续manual规则schema派生。parse允许稀疏，但不能接受非法值；完整准入必须拒绝缺失嵌套叶子、非正/非安全整数、空白/重复档位和无效map。错误分类区分缺字段、非法选项和其他非法配置，保留现有路径；不修改网络失败等业务策略。

| ID     | 设置/动作                                 | 断言                                                          | 裁决                      |
| ------ | ----------------------------------------- | ------------------------------------------------------------- | ------------------------- |
| B2a-01 | sparse parse 与完整实例准入传同样非法叶子 | 两者均拒绝；不得依靠类型断言通过                              | accepted，单测            |
| B2a-02 | 完整数据逐叶删除/置null                   | 完整准入拒绝；稀疏overlay允许并按原清除语义应用               | accepted，schema/overlay  |
| B2a-03 | 合法完整配置、数组、map                   | class/toJSON/parse往返、freeze、Registry结果不变              | accepted，现有规则回归    |
| B2a-04 | 模块依赖与推导类型                        | 基础schema不import行为类；codec/类/Registry不维护平行字段类型 | accepted，类型检查+review |

Provider context已生成：当前模块unmanaged/无独立contract，继续沿现有config公共入口，不扩建治理模块。新schema文件仅Provider内部使用，领域层无IO。

## B2b Provider 数据 Schema 单一来源

延续 B2a 单向依赖，Provider/API/Access 的字段和枚举在纯数据 schema 定义，行为类输入/JSON/Registry 类型派生。
Provider 完整性保持既有必需范围：group、api.type/baseURL、Access 对应分支的执行字段；label/logo/成员/headers/管理URL不新增必填要求。
entitled=false 是完整但无权益，不因完整性检查伪装成有权益；hidden 仍不免除检查。Access 切换类型整体替换，不混合两种凭据。
Provider 的来源写权限通过同一 schema 的 pick/omit/extend 限定，保留 Account 仅成员/权益、Template 无真实 Key、Personal 不拥有固定账号 Access 的约束。
Personal endpoint 仍可暂存尚未填写正确的文本，最终 Registry 拒绝；不能因统一 schema 让单个坏 endpoint 阻断整份 Personal 文件。
不改账号服务/同步、Provider 状态或消息时序；当前基础批次仍不改变发布字段名字。

| ID     | 场景                                              | 断言                                                     | 裁决                   |
| ------ | ------------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| B2b-01 | 类型边界以外构造未知 API type/group、非法管理 URL | 完整检查拒绝，不能只检查非空就收进Registry               | accepted，先红测       |
| B2b-02 | 两种 Access 的完整/稀疏/清除/切换                 | 只要求本分支必填，optional仍可缺省/null，false权益不变   | accepted               |
| B2b-03 | Personal 无效 endpoint + 同文件合法 Provider      | 错项保留可编辑，只阻断自己的Registry准入；有效项仍可执行 | accepted，保留现有回归 |
| B2b-04 | 来源配置权限与序列化                              | 共用schema派生、拒绝越权字段，class/JSON/freeze行为不变  | accepted               |

## B2c 删除 OptionSpec 冗余 type

执行 §5.5：reasoningLevel 由成员名固定为 values/map，maxOutputTokens 固定为 max/map，删除各自 type，不删除 Provider API/Access 或外层规则尚在使用的 discriminator。
唯一字段定义沿 B2a 数据 schema；行为类不再保留/写回冗余字段。已发布旧 Provider 导入仍按原入口转换，未发布 Config 中旧 type 不作兼容。
CLI ModelOptionSpecs 合同与 Provider 保持结构一致，设置表单不再新建该字段，默认 Built-in 同批升级内容 revision；真实请求的 reasoning/max token map 行为不变。

```text
设置草稿 / Built-in / 旧格式导入
              → 无冗余 type 的 OptionSpec
              → 同一完整性校验 → Registry → 原 Map → 原请求字段
```

| ID     | 场景                                     | 断言                                                         | 裁决                            |
| ------ | ---------------------------------------- | ------------------------------------------------------------ | ------------------------------- |
| B2c-01 | 新版完整 OptionSpec 没有type             | parse/class/serialize/Registry可用，map请求值不变            | accepted，红测+配置/请求回归    |
| B2c-02 | 旧未发布type仍在Config                   | strict parse拒绝，不偷偷strip，不改已发布迁移输入合同        | accepted                        |
| B2c-03 | SC90-01添加手动配置、编辑回智能配置      | 保存的两个选项均无type，原失败草稿/禁用保持/恢复推荐断言不变 | accepted，现有pending E2E补断言 |
| B2c-P1 | 新做所有客户端UI、主题、请求协议笛卡尔积 | 不改变布局、事件、消息时序；复用共同表单和已有请求层矩阵     | pruned                          |

当前Model设置入口仍由ProviderModelMetadata提交稀疏或完整个人配置；无需新增UI状态、订阅或异步请求。本批不接管默认选择持久化、不更改Session提交边界。SC90/F98现有case-local none-provider fixture继续复用，不自动转正；Pro用隔离目录构建当前代码验证。

## B2d Model 最终字段与跨层单一数据合同

执行 §5 剩余字段：inputFormat/outputFormat、supportsText/Image/Video/Audio/Pdf；requiresMfjsToolSchema移到properties。完整/稀疏含义不变，未发布旧名不接受、不双读。所有当前配置、UI表单、CLI模型属性和协议媒体投影同步更新；SDK原始请求body、tool Schema及外部命令的同名字符串不是重命名目标。

数据合同归属：Model纯数据schema需要被Provider、CLI contracts及shared协议共同使用，将B2a的单一schema移到shared的独立model-config子路径（不引入Provider行为类）。shared只新增对纯表达式编译库model-option-map的依赖；该库无Provider/shared依赖，无IO。原Provider内部定义删除，不留平行schema或中转兼容。Provider行为类继续唯一负责overlay/freeze/Registry准入，CLI Model数据类型和协议格式投影从同一schema派生。

```text
shared/model-config（纯schema + 内容校验；依赖无IO的表达式编译库）
       ├─ Provider行为类 / Config codec / Registry
       ├─ shared协议媒体字段投影
       └─ CLI contracts（类型推导）→ core / adapters
```

该依赖方向避免shared反向import Provider实现和包级循环；不改变状态owner、订阅、effective selection、同步频率、任务派发/持久化时机。ModelRequest.maxOutputTokens仍为真实请求选项，不属于Selection迁移。

| ID     | 场景                                        | 断言                                                      | 裁决                            |
| ------ | ------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| B2d-01 | 最终ModelConfig完整/稀疏输入及每叶缺省/null | 新结构完整准入；null保持清除，旧名/top-level MFJS严格拒绝 | accepted，红测/节点配置         |
| B2d-02 | 显式MFJS true/false覆盖、手动/智能保存      | 唯一写入properties；布尔控件/个人覆盖标记与重开值不变     | accepted，表单单测+SC90         |
| B2d-03 | CLI媒体过滤/PDF/生成/stream及协议模型候选   | 从新属性读同样能力，请求map和消息内容不变                 | accepted，合同/adapter/core测试 |
| B2d-04 | 新版Builtin落盘与内容对照                   | 仅字段重命名/移动和revision变更，map/上限/能力值逐值保持  | accepted，语义JSON对照          |
| B2d-P1 | 重做UI、账号连接、远控同步、发布旧配置兼容  | 非本项语义变更，保留当前边界；未发布旧Config不兼容        | pruned                          |

实施分成两个可验证步骤：B2d-合同先移动纯 schema 并消除 CLI/协议重复定义，保持字段和值完全不变；B2d-字段再同时更新各消费端和 Built-in。前一步不宣告最终字段完成，不升级 Built-in revision。公共子路径测试验证真实协议使用相同的字段 schema 对象、稀疏/完整约束、表达式校验、Provider 往返；CLI 类型用双向类型相等断言约束。无新增业务状态或 UI 交互，不另造桌面用例；字段步骤继续更新并实跑 SC90。

共同的 sparseShape 原语移至 shared/config-schema 子路径，Model 与 Provider schema 都引用它；该模块只派生 nullish 字段，不包含来源权限或业务规则。共享层导出推导后的 Model 数据类型，CLI 用 type-only 别名保持原公共类型名；不要求使用 Zod 3 的 CLI contracts 对 Zod 4 schema 再做一次本地推导。

实际锁文件中 shared=Zod4.3.6，provider/provider-node=4.4.3，相同 ^4.3.6 声明并不保证可组合的 Schema 类型。类型检查已证明两者的内部版本类型不兼容。仅将这三个直接组合配置 Schema 的包固定为 shared 已使用的 4.3.6；不升级全仓依赖、不修改 CLI 的 Zod3、不使用 any/强转或第二套 Schema 规避。完整配置和错误分类回归必须在最终锁文件上重跑。

B2d字段继续按合同粒度收口：先将媒体格式的七个旧字段替换为最终命名（Builtin revision14→15），各端/当前fixture同批更新；MFJS结构移动随后单独处理布尔覆盖语义，不能用简单文本替换混入本批。已发布迁移输入不变，脚本里的当前Model fixture才更新。旧未发布格式用明确负例拒绝。UI输入/输出Draft类型也引用共享推导类型，避免再次手写同义接口；不改布局和控件文案。

Pro重建发现B2d-合同新增的两个shared子路径遗漏CLI esbuild精确alias，通用前缀会错误拼成index.ts/model-config。本轮补齐现有build入口及其alias合同测试，不重做构建系统；真实Agent重建成功后才继续E2E，不用桌面Renderer构建通过代替Agent闭包验证。

共享纯表达式库新增依赖同时影响裁剪Docker构建上下文：所有显式COPY shared的Dockerfile必须同时COPY model-option-map manifest和源码。v4已有，Share和旧remote模板缺失，本轮仅补新增依赖，不顺带修旧模板的其他既有缺项。Share不导入Provider行为，故其generic shared alias尚不消费新子路径，不无依据改配置；实际本地Share构建与静态依赖边界测试核验，Docker镜像实构建未替代为通过。

### B2d-MFJS：唯一属性归属

`requiresMfjsToolSchema` 从ModelConfig顶层移到properties，完整ModelProperties必填boolean，稀疏properties仍允许缺省/null。Builtin仅移动原值（revision15→16），不新增能力。ModelConfig不再单独overlay/序列化该字段，由ModelPropertiesConfig统一处理。CLI Adapter不再在ResolvedAiSdkModel复制第二个MFJS值，generate/stream两条工具投影均从固定执行Model的properties读取；工具transform的私有选项仍保留原布尔参数，不改真正的MFJS schema内容。

UI将MFJS纳入属性组的来源标记和稀疏写入；智能模式未触碰的false不得凭空产生覆盖，显式true/false和null均保留各自语义。关闭智能配置仍物化完整properties，不因归位启用模型；切回智能后的清理与再编辑仍走既有草稿流程。测试先证明false/true/null、完整缺失、旧顶层拒绝，以及智能/手动保存、重开、高亮和请求工具schema真假分支。Pro SC90补实际MFJS切换与重开断言，F98已有边框/排版行为保持。

### B2e：Provider 成员与 endpoint 命名

新配置统一使用personalModelIds、api.baseUrl；Builtin/Personal/Account/Registry/设置页按相同数据合同消费。成员所有权不变：builtinModelIds是不可删改的来源成员，personalModelIds仅为用户添加的成员，modelOrder为两者显示顺序。SDK创建参数baseURL、已发布旧Provider endpoints.baseURL/options.baseURL及业务局部排序参数modelIds不属于改名对象；旧迁移输入原样读，转换出的新ProviderConfig使用新字段。Model规则的查询参数/Match结构留给规则组统一重接，不在此混改。

先测新字段完整/稀疏往返、null清除、旧未发布字段严格拒绝，再修改所有消费者。复用成员增删改/动态账号成员/排序/表单headers保留及迁移测试；增加真实SDK出站URL断言，证明新api.baseUrl仍映射到SDK要求的baseURL。设置页沿用已有交互与Pro用例，配置合同改名不改变页面文案和布局。Builtin内容对照仅移动字段及revision16→17，不能改模型名单、Map或endpoint值；标签/template归属及规则数组另组处理，不宣告Provider最终结构完成。
