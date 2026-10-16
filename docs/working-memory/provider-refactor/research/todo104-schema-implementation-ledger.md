# Todo104 实施与复审账本

## 授权、来源和隔离

- 2026-09-10 用户授权：合入远端 m2 的 Todo，审阅决策、可行性、过时表述；执行已有裁决及能够决定的部分，保留真正未决部分，充分 review 和测试。
- 固定来源：`origin/provider-refactor-m2@02dfc1b45819626dc6d1614a8e528c72eaed31af`。相对共同基线 `583d140dec` 为 17 个纯文档提交、5 个文件；不是只有一个文件，但没有产品代码。
- 起点：`869f87a0da`，包含真实 staging merge `e1c611be98`。原 staging 候选分支保留不动，本轮分支 `provider-schema-refinement-20260910`。Todo103 的 Windows / 隔离 SSH 最终验收缺口不因这次 Schema 工作而完成，也不在此扩修。
- [完整任务与目标结构](../steps/todo-104-pre-release-schema-review.md)：m2 原 Todo99，因本分支 Todo99/100 均已占用，编号改为104。保留历史来源，不覆盖旧任务。
- 当前 Goal 以任务文档和本账本为完整范围；不自动推送、不修改真实用户数据。

## 当前执行粒度（2026-09-10 用户纠正）

后续不再沿 B2d/B2e 的细碎字段批次各跑全套回归及 Pro。剩余规则/名称/模板/保存入口按完整链路整合，强耦合的 Personal envelope 与默认选择/分发一起验证；运行路径/来源 revision 另按完整链路处理。开发中只跑定向测试和必要局部类型检查，收口后共享广泛回归；Pro 在完整候选静态/定向验证稳定后批量跑。已完成提交、证据保留；已有通过证据没有新的证明需求时不重复制作。详细约束见 Todo104 顶部“执行粒度补充”。

本轮最新实现提交：`fb627de8f6`（B2/B3/B4 统一 Schema 切换，131文件；含真实迁移 fixture 修正）。此前 MFJS归位 `351ec06cfb`、Provider成员/endpoint命名 `ae319e715e` 等提交全部保留。没有推送或合回 recovery。Goal仍覆盖制品验收未完成事项，不因扩大批次缩减复审或最终验收要求。

### 当前整批验收：B2/B3/B4（2026-09-10）

规则结构、Personal 同文件读写/分发、运行路径和来源标识已实现并提交。B5 整批代码复审和核心回归已完成，剩余制品验收限制见专节；以下早期实施段落仅为历史轨迹，不能继续把其中“尚未接完／尚未测试”当作当前状态。

- B4：下载及刷新文件位于环境 `runtime/provider/<platform>/<version>/<endpoint-key>/`；分发记录为 `runtime/provider/provisioning.json`；Desktop/CLI/Server 共用 materializer，在环境 `runtime/provider/bundled/zcode-builtin.json` 固定释放随包资源。复用文件锁与公共原子写入，不另建 IO 或同步系统。
- Source revision 包含 active 文件绝对路径身份；active 路径本身包含规范化 Endpoint。Host 将同一 active 路径注入 Worker，二者得到同一 revision。真实临时文件上的 Endpoint A/B 同 publication revision、Source/Config/Registry 切换及 Worker 直接 Source 已验证；没有增加协议字段。
- 同文件更新已补真正两个 OS 进程写 Provider/默认选择的屏障测试；分发已补真实文件 CAS/故障回滚，期间写入的 C 不被回滚覆盖。Repository 写后返回 codec 规范化快照，修正写后下一次读 revision 无故变化；undefined providerOrder 不再凭空写成空数组。
- 核心配置/存储/设置批次：50 文件 488 测试通过；CLI 4 文件 25 测试、入口 Node 测试 4 条通过。更广消费面 155 文件 1296 测试初跑 1286 通过、10 条旧 fixture 失败；七个文件按最终外层名称、规则数组及 Account 字典协议更新后，合并重跑 244 条全部通过。未为这 10 条失败增加产品兼容代码。
- 根 typecheck、lint 通过（43 条既有 warning，0 error）。Pro 用隔离副本重建最新 Agent/Desktop，SC90-01、F98-03、W89-05/W89-08 共两 spec 三 case 全部通过；不为微小类型/fixture 调整重复 Pro。报告：`/Users/dev/zcode-todo99-e2e.1lO3PN/packages/desktop/.e2e-artifacts/desktop-e2e-20260910-052901-362/summary.md`。
- 整批复审补齐账号连接类型从现有 schema 推导；dep-refs 确认独立默认选择文件 codec 及分发旧默认 DTO 无生产引用后移除。没有更改账号连接行为、Session 提交时机或 Off-Peak Ticket。
- 证据：`/tmp/todo104-b234-{final-tests,cli-final-tests,cli-entry-tests,typecheck-final,lint,pro-e2e}.log`；`/tmp/todo104-{provider-cross-surface-tests,cross-surface-fixed-tests}.log`。最终构建产物启动、B1 跨组回归和全项复审仍在进行；不据这三条桌面用例宣告 Todo104 完成。

### B2/B3 早期实施记录（历史）

工作从 `c0c018cd9c` 继续，仍在同一独立 worktree/分支。以下是**进行中的工作区实现，不是已经完成或可以交付的批次**，暂未提交，不运行 Pro/全仓回归：

- 新 `rule-data-schema.ts` 从公共 Model/Provider 数据 schema 派生各来源规则。三种 Match 严格分层，手动仅放宽 enabled；拒绝旧 type、providerMatch、旧匹配字段、模式布尔；拒绝智能/手动跨组同身份和同层重复 Provider/Template。配置类型由 schema 推导，不另建平行字段表。
- ModelConfigRules 改为内存明确层标识，文件编码时没有 type；不再按字段猜所属集合。`setExact` 从目标规则 schema 验证整条记录；普通/手动互转移动所属集合，普通启停不改模式。Facade 仅为 UI 从所属类型投影原智能开关 DTO，不写回模式布尔。原手写固定完整性检查删除。旧档位迁移用模型层类型判定，不再依赖已删除的 providerMatch/API/URL 有无。
- ProviderConfig 删除 templateId/label；ProviderConfigMap 内部唯一保存完整外层规则，get/entries 仍投影配置，新增 getRule/mapConfigs/setRule 管理元数据而不复制配置状态。普通成员保存/排序保留外层名称和模板关系；Resolver 保留规则元数据后叠加模板/Account，Registry/Settings/Selection 视图外层携带名称/模板。
- 创建实例从当前语言 templateNameMap → en-US → templateId 生成并持锁去重；metadata 缺省不清旧值，null 仍显式清除。已发布自定义 Provider 名称、API模板关系导入到外层；旧输入不变，builtin账号依旧不是 Personal import 来源。
- Builtin 已改五个 Model 数组及 templateRules/providerRules，四条越层规则移入已裁决的精确 Endpoint，revision17→18；本大批次后续改动共享该未提交 revision，不逐个字段递增。schemaVersion3→1；其余规则 Map/参数不改。实际 Builtin 往返及 Endpoint 正/反例已定向验证；最终与基线的完整行为对照仍要在批次验收做。
- Personal codec 已改最终 config 外壳与三空数组，defaultModelSelection 同层可选非null。Repository 的 revision、snapshot、严格写入都携带默认选择；普通 Provider/Model/排序更新保留默认，全量 replace 则按来源整体覆盖，可清掉默认。坏手动规则文件读取降级但保留原文，写入拒绝。
- NodeModelSelectionConfigRepository 已删除独立文件/watcher/删除坏文件逻辑，改为共享 Personal Repository 字段适配器；Runtime 通过同一实例注入。Host 装配已接回 Personal Repository，移除第二条 configured-default 分发触发及独立文件环境参数；CLI 与分发剩余消费者还未接完。
- 证据：规则 schema/集合/真实 Builtin/新外壳共4文件17测试通过；实际临时文件上的 Personal 两实例并发、命名、坏文件、已清除不再导入和默认字段适配器共5条通过；已发布 importer 新增1条定向通过。先红后实现的日志分别为 `/tmp/todo104-{rules-red,rules-codec-red,provider-rules-red,envelopes-red,personal-rules-red,default-port-red,rule-import-red}.log`；通过日志 `rules-envelopes`、`default-port-tests`、`rule-import-tests`。其中并发目前是同进程两个 Repository，不冒充已完成两个 OS 进程验证。
- 局部 Provider/ProviderNode 类型检查阶段性通过；未执行根typecheck/lint、共享构建或Pro。`dep:refs` 确认旧 MatchModelConfigRule 无外部消费者，旧 parseModelConfigRules 只由旧测试使用，删除后要将这些测试迁到各来源集合入口，不留未发布格式兼容壳。检索证据 `/tmp/todo104-{match,parse-rules}-refs.json`。

#### 同批消费者接入进展（2026-09-10，仍未提交）

- CLI Process Runtime 的默认选择适配器始终复用 Runtime 的 Personal Repository；不再依赖独立文件环境参数。Standalone 一次读取已发布 CLI 输入，同时生成 Provider、Model 与默认选择；原文件不变，正式文件存在但清空默认时不再导入。旧单独读取默认值的 IO helper 无调用后移除，纯旧值转换仍限定迁移入口。
- CLI 登录更新默认值改写同一个 Personal 文件，优先使用显式路径/已有 Personal 环境变量；默认路径为凭据同目录的 provider_config.json。首次创建仍经过旧 Provider 导入，修改默认不丢其他配置。移除旧默认文件 env 与路径成员；CLI Entry 和 Node Runtime 路径测试随之调整，程序资源路径的 B4 改造尚未开始。
- Settings/Selection 相关显示消费者读取外层 providerName/templateId，包括 Composer、Automation、Bot、Wiki、CLI 模型选项和账号展示。设置表单只在显式改名时提交 providerNameUpdate；未修改名称的操作不把继承名物化成个人覆盖。Facade Service 参数从领域 Facade 推导，服务透传 metadata，不复刻另一份 DTO。模板创建传当前 locale，服务在锁内从当前模板生成名称，UI 不把显示的模板名称再充作指定名称。
- Services createProviderRuntime 也共享同一个 Personal 默认选择源。定向测试先复现默认被忽略、误选列表首项，再确认读取正确选择和设置改名后默认不丢。
- 交集复审发现 Account 信封的 providers 必须仍是协议字典，而 ProviderConfigMap.toJSON 现在是磁盘规则数组。Host 发送边界明确从 entries 投影字典，不修改 Account 协议，不将模板/名称写入动态账号事实。实际 Worker 协议往返和 current 切换测试更新为原协议格式并通过。
- 本次定向证据：`/tmp/todo104-cli-runtime-tests.log` 三文件18项通过（Process Runtime、Account delivery、同文件新集成）；`/tmp/todo104-auth-login-tests.log` 登录7项通过；`/tmp/todo104-service-rules-tests.log` 表单/Services 5项通过。共30项，和上一小节的23项是不同测试范围。新失败复现日志 `cli-default-red`、`cli-login-red`、`rule-form-red`、`service-rules-red`；并未重复运行全仓回归或 Pro。
- 引用调查：`/tmp/todo104-default-env-refs.json` + 跨仓精确搜索覆盖 Node 与 CLI 入口。dep:refs 的项目未加载 CLI 文件，不能声称其覆盖 CLI；旧默认 IO helper 的 CLI 检索仅剩定义后删除。待批次结束统一 lint/typecheck，其他旧 fixture 仍需更新；上述局部通过不代表全仓已编译。

#### 同批分发、并发及版本修正（2026-09-10，仍未提交）

- Source 改从唯一 Personal Repository 取全量快照并验证磁盘内容 hash；合法空且尚未落盘与坏文件明确区分。Target 持锁比较整个 Personal 内容，整份替换和整份回滚；不再双写默认选择。信封去掉 sourceRevision/独立 configuredDefault；结果使用 configRevision。两个入口复用正式 codec，不复制规则字段清单。
- 失败回滚恢复 A；若并发用户已经写入不同 C，则保留 C 并报告 rollback_failed。Provider/默认选择均受相同 CAS 保护。凭据/设置保留原来的域内回滚，不增加全局事务系统。
- Repository 修正两个真实版本问题：缺省 providerOrder 不再被快照强加 []；写入后快照使用 codec 规范化后的同一内容，避免对象字段顺序造成“刚保存再读取 revision 就不同”。前者由 Source/CAS 测试暴露，后者有独立先红后绿复现。
- `/tmp/todo104-provisioning-batch-tests.log`：Source/Target/整合/同文件并发共24项通过；新增版本复现后的 `/tmp/todo104-personal-revision-tests.log` 两文件14项通过。后者包含两个真实 Node 子进程在 IPC barrier 后各写20次，最终 Provider 与默认选择均保留；不再仅是同进程双 Repository。
- 根 typecheck 已按批次执行一次，发现 findLast 的目标库交集及8处 E2E 旧字段/独立默认文件夹具；findLast 已改普通倒序查找，E2E helper 正在统一。没有为每次修正重跑根检查或 Pro。
- 规则包既有单测批量检查：`/tmp/todo104-rules-existing-tests.log` 共408项，259通过、149失败。主要是旧格式夹具、旧名称投影和以数组下标固定旧规则位置的预期，正在逐类迁接；不能将149项自动当成既有产品 Bug，也不能删除断言来变绿。Todo95表达式基线保持原文，以语义身份定位规则后继续比较请求行为。

**接下来在同一批次继续（不能丢失）**：余下旧测试及设置 E2E fixture 改成最终数组与外壳，保留原有行为断言；删除无调用的独立默认文件 codec；再统一类型/lint/跨域回归与 Pro。B4 程序路径、来源 revision、B5 最终审计仍全部保留。当前更改不可发布，不合回 recovery，不把局部通过转为 Goal complete。

## 文档合入与决策复核

| 项目                           | 复核结论                                                                      | 处理                                      |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------- |
| 唯一显式冲突：steps.md         | 两侧入口都有效；本地仍将已完成95C/97/98列为开发中，m2仍写未授权               | 保留两侧入口，纠正状态及编号              |
| 核心 Schema 改名／重组         | 已有具体最终结构；基础 schema → 类型/行为类单向依赖可实施，不能只做字符串替换 | 归 B2；API SDK 自身参数名不随配置字段改名 |
| 未发布格式不兼容               | 与既有裁决一致；不等于可以破坏已发布 staging 数据                             | 新格式严格校验；独立测试旧 staging 导入   |
| Session/Off-Peak/Wiki 旧值保留 | 明确取代旧保存行为；保留只供旧版回滚，不能回读复活新选择                      | 归 B1；验证原始数据及新版本权威           |
| 默认选择合并                   | 已批准同文件单次更新；涉及锁、通知、分发及回滚，不能分开双写                  | 归 B3，与新 personal schema 联动          |
| 路径、revision、分发           | 已给出来源隔离及固定路径目标；不能重做账号同步系统                            | 归 B4；真实文件／进程证明和打包验证       |
| “仅讨论／未授权实施”           | 已被本次用户请求取代，不是产品边界                                            | 顶部统一声明新授权，保留历史段落          |
| “可构造测试所以风险不高”       | 是可行性判断，不是通过证据，也不能省略并发、跨进程和构建验收                  | 每组分开记录已实现／已验证                |
| Bot / Subagent / CLI           | Bot 保持 v3 文件；Subagent 原字段语义不改；不实施 CLI 账号架构统一            | 不扩项，只适配共享结构的必要调用方        |

## 分组状态（不以文档合并代表实施）

| 组  | 对应条款       | 内容                                                                   | 裁决   | 实现                         | 验证／复审                                                                   |
| --- | -------------- | ---------------------------------------------------------------------- | ------ | ---------------------------- | ---------------------------------------------------------------------------- |
| B0  | 文档           | m2真实合并、编号、授权与过时状态                                       | 已复核 | 完成：1e4953e300             | 唯一冲突按段处理；产品代码零增量                                             |
| B1a | 6.18.1         | Off-Peak保留旧列                                                       | 已批准 | 完成                         | 56测试通过，原始SQLite列、标题／选择编辑、新建记录、重启；typecheck/lint通过 |
| B1b | 6.18.2         | Wiki/Draft保留旧模型／档位／预算                                       | 已批准 | 完成                         | 100测试通过；文件故障/并发/重启/生成Limit，typecheck/lint通过                |
| B1c | 6.18.3         | Session entry新增modelSelection                                        | 已批准 | 已提交                       | 存储/恢复/fork及Pro冷恢复通过；最终CLI真实旧记录fixture已校正                |
| B2  | 1.1、2–6.7     | 唯一Schema、配置字段/规则分组/名称/Match、Selection移除maxOutputTokens | 已批准 | 已提交fb627de8f6             | 最终规则矩阵、跨层消费者、Pro SC90/F98/W89及整批复审通过                     |
| B3  | 6.9、6.13      | 默认选择与personalConfig合并、分发及回滚联动                           | 已批准 | 已提交fb627de8f6             | 真实双进程并发、登录/重启/清除、真实文件分发故障/CAS及批次回归通过           |
| B4  | 6.8、6.10–6.13 | 路径/五格式v1/端点revision/configRevision/sourceRevision               | 已批准 | 已提交fb627de8f6             | 文件/来源/原子替换、CJS Server及CLI Worker通过；其他制品启动受阻，见下       |
| B5  | 7–8            | 全部要求核对、跨组回归、最终review与提交                               | 已批准 | 代码复审及提交完成；未全验收 | 等待独立打包修复范围决定；Windows实机未验证                                  |

## 待裁决／验证限制

没有新增产品语义待裁决。最终制品启动有下列独立既有阻碍，尚未扩大修改；已异步询问是否另开打包修复批次。Goal 不标记全部完成，也不将这些项目冒充通过。

| 项目                        | 运行时证据与归类                                                                                                                                                                      | 本轮处理                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| HTTP Server 启动            | 实际 bundle 进入 `@larksuiteoapi/node-sdk` 的 getSdkVersion，ESM 没有 \_\_dirname；出错早于本轮资源物化。tsup 配置及该依赖/入口引用相对实施基线未变                                   | 记录既有闭包问题；构建成功不等于启动成功                                        |
| Standalone Server Core 启动 | 实际 bundle 的 yazl 动态 require(fs) 失败；tsup external 在固定候选869f87a0da已经漏掉它，日志归档已在基线导入 yazl                                                                    | 同上，未自行扩修依赖/打包规则                                                   |
| SEA                         | Linux 下载内网 ugrep 超时；改用 Pro 后工具下载成功，但正式依赖构建及 shared tsc 后仍要求不存在的 shared dist/index.js。共享包当前以源码出口和声明构建为主，收集器仍要求旧 JS 制品布局 | 两条安全构建路径均试过；不造假空文件、不能用普通 CJS CLI 成功代替 SEA 验收      |
| Windows                     | 当前没有可用的 Windows 实机验证                                                                                                                                                       | 路径走 node:path、替换复用公共原子 IO；不能把 Linux/Pro 结果写成 Windows 已通过 |

Todo103 的 Windows/隔离 SSH 候选合回门禁仍独立保留；本轮没有改真实用户数据、合回 recovery 或推送。

## B5 整批复审结果（2026-09-10）

### 推送门禁补查批次（2026-09-10，已修复并推送）

用户授权修复 pre-push 全量运行发现的 10 文件 / 22 项失败，再正常推送。原红测证据为 Todo103 推送记录中的 14420 项全量运行；不重复制造同一红灯。本批按以下合同核对后修复，保持原行为断言：

1. Selection View 的名称是 Provider 条目的 `providerName`，不在 `config.label`。Bot、Composer、Automation、时间线的测试数据须模拟正式 View；不为未发布旧字段加兼容读取，也不把名称断言改成 ID。
2. Built-in 与 Personal 文件使用最终 schemaVersion=1 及各自分组规则。远端服务装配、远端配置下载的 fixture 须满足正式合同；真正测试已发布 staging 导入的旧数据保持不动。
3. Account 同步协议的 `providers` 仍是 ID → 配置字典；内部 ProviderConfigMap 的 `toJSON()` 是持久化规则数组，不能用它生成协议期望。保持状态字段完整、两个 Worker 首次交付、去重与重建交付断言。

不调整产品语义、不改推送钩子、不跳过失败用例；若上述修正后仍有真实回归，先补区别性测试再修实现。测试修复统一定向运行，最后共享 typecheck、lint 与正常 pre-push 全量门禁；没有生产交互变更时复用现有 E2E，不重复 Pro。

补强真实生产链路后发现独立漏接：Resolver 已投影 `providerName/templateId`，但 `ProviderRegistry.freezeView()` 重建对象时丢掉两个元数据字段，Facade 即使读取新字段也拿不到名称。新增 Facade 红测实际得到 undefined 而非 Personal API；这不属于旧 mock。修复要求 Registry 构造和 replace 都保留同份解析结果的元数据，旧快照不可被后续更新改变，清除名称/模板关系也不得沿用上一份；不从 Settings 或其他异步来源拼接。复用 I13 增加首发前后工具栏完整名称断言，在 Pro 一次验证跨 Provider 身份、显示与真实请求。

本批实现／复审：生产仅在 `freezeView` 保留两个现有字段，无新增来源、协议或选择策略。旧 fixture 导致的原 22 项失败修正后，10 文件206测试通过；增强 Registry/Facade 的两个生产红测先失败，修复后与 Runtime/Draft 共同运行4文件47测试通过。元数据改名、清除与旧快照隔离均有断言；对原测试的名称/状态/远端装配断言没有删除或降级。根 typecheck（含 E2E）、lint 通过，43既有warning/0error。

Pro 隔离副本核对 Built-in/Facade hash 后同步 Registry 与 I13 spec，正常重建 Desktop 和 Agent。`desktop-e2e-20260910-062834-748`：I13 1/1通过，首发前后 title 为实例名/模型名，currentValue 保留 alternate 身份，真实回放请求使用 alternate 模型，回复后回 idle。沿用显式 `E2E_PROVIDER_THOUGHT_LEVEL=max`，符合主动选模最高档裁决；没有把旧默认 high 的测试预期宣称为已修。fixture check通过（既有标题marker warning），未自动晋级、未使用真实用户数据。日志 `/tmp/todo104-push-{gate-focused,metadata-red,metadata-green,gate-typecheck-final,gate-lint,e2e-fixture,metadata-pro}.log`。最终全量由正常 pre-push 门禁统一执行，结果另记。

最终结果：修复提交 `8cfb2f82ce`，正常 pre-push 的 lint / architecture 均通过，全量 1647 文件通过 / 2 文件跳过，14395 测试通过 / 26 跳过 / 0 失败（232.35s，`/tmp/todo104-push-final.log`）。无新增跳过或放宽断言。双分支 atomic push 成功：m2 与 e2e-recovery 均快进至该提交；未 force、未绕过钩子。用户接手的 Windows / 隔离 SSH 与上述其他打包限制仍单独保留，本批收口不等于整个 Todo104 制品验收完成。

- 提交后补查：两个路径测试原来把 POSIX `/` 写死，Windows 上会误报。改为 `node:path` 分段断言，仍严格检查环境/平台/版本/Endpoint hash/文件名，不改实现。仅运行相关16条发布测试及4条CLI入口测试，均通过；不重复整批回归/Pro，也不冒充Windows实测。日志 `/tmp/todo104-portable-{path,cli-path}-tests.log`。当前独立工作已收口，打包扩修请求仍未收到答复；本轮不擅自修改既有打包系统，Goal 保持未完成。

- 按 §6.19 的 13 项核对：1–3 保留旧版回滚快照，正式 reader 不回读；4/11 默认字段与个人规则同文件事务和同信封 CAS；5–8 路径及固定资源一致；9 五处版本1、Bot3；10 Host/Worker 共用来源身份；12 结果语义仍 Config revision；13 schema 推导类型。没有新增 selection 持久化时机、账号切换或发送同步门禁。
- 反向核对旧 Builtin 与最终 Builtin：所有 Model config/map/limit 的多重集合逐值相等；Provider 与 Template 仅按批准字段外移，顺序与内容保持；revision17→18、schemaVersion1。四条规则的范围/层级变化另由命中矩阵验证，不能用集合相等冒充范围等价。证据 `/tmp/todo104-final-builtin-equivalence.log`。
- 最终跨面回归：155文件1296测试全部通过。Wiki/闲时九文件156测试全部通过。CLI Session 七文件150测试初跑145通过/5失败；原因是测试用新版 writer 伪造旧 entry，以及给新接口传旧 thoughtLevel。修改为真实 SQLite 旧版记录和正确新接口后，三个受影响文件32测试全部通过，保留迁移、两种 delivery、空选择、fork 及消息不回退断言。旧适配器/存储四个文件118测试无失败，不需要重新跑无变化的部分。
- Pro 新 Agent/Desktop：设置三case通过；最终 `conversation-session-unbound-resume` 单case通过（冷恢复缺档位、失效档位、失效Provider；重选后继续原Session）。后者报告 `desktop-e2e-20260910-053911-852/summary.md`。测试不自动晋级、不借用旧构建或真实账号数据。
- 真实构建启动：CLI全部九包依赖顺序构建通过（首次仅构建叶包时旧dist失败已解决）；远端CJS Server构建、hello/ack、资源释放及stdin关闭退出0通过；两个真实构建 CLI Worker 接收各自Host Source revision，向隔离本地HTTP服务发出精确model-a/model-b请求，均成功。该检查不消耗真实额度，也不宣称同一Worker热切端点或手机SSH联合验证。
- 根typecheck、lint通过（43既有warning/0error），architecture 0违规。静态旧字段/旧默认环境变量/旧codec引用检查无生产残留；真实请求层 maxOutputTokens 和 SDK baseURL 保持，不误删。文档 Design V2 已更新最终事实，历史阶段记录仍可追踪。
- 根 lint 默认排除 CLI，另以同一规则移除该路径排除后检查14个改动文件：有原 `auth-login.ts` 超400行问题（基线471行，当前484行）及原同步装配的无用spread警告，不能声称CLI独立lint全绿。对基线运行相同规则确认既有超限；没有放宽仓库规则或借本轮整理整个登录模块。日志 `/tmp/todo104-final-cli-lint-scoped.log`、`/tmp/todo104-cli-lint-baseline.log`。
- 主要日志：`/tmp/todo104-final-{cross-surface-tests,b1-services,b1-cli,b1-cli-fixed2,whole-typecheck,whole-lint,architecture,pro-session,cli-build-full,server-build,server-cli-build,sea-build,pro-sea-build-ready}.log`；`/tmp/todo104-built-{worker-check,server-startup,http-startup}.log`。实现批次已提交，构建限制见上表；不能据此宣称整个Goal/全部制品验收完成。

## 执行证据

- 基线新鲜度：通过，未跟踪远端分支；相对 main behind 6，阈值50。
- `git merge-tree`：仅 steps.md 文档冲突；随后已在独立分支开始真实 `git merge --no-commit --no-ff`，不是选择性移植。

### B1a 2026-09-10

- 先补测试，存量场景准确失败：标题更新后旧model/thought_level从原值变为NULL。移除UPDATE中的两个清空赋值，不新增存储机制。
- 4文件56测试通过：offPeakTaskRepo / offPeakTaskService / offPeakRuntimeModel / offPeakModelSelectionView。原始SQLite读证据对照固定staging@790884b1ce的rowToTask旧列读取形状；不宣称旧App实机回滚。
- `pnpm typecheck`通过；`pnpm lint`通过（43既有警告、0错误）；architecture检查0违规。未改UI交互，不新增E2E。
- 图谱检查344节点无重号；4条悬空边在HEAD已存在，本次仅追加Off-Peak存储不变量，不扩修图谱。相关5个代码seed文件/符号均存在；codegraph工具不可用，记录文本核对限制。
- 复审：唯一调用方仍为OffPeakTaskService.updateTask；null拒绝、queued/paused门禁、Ticket不变。新记录旧列仍NULL；不会合成旧值或把新值回写旧列。其他已有invalidation路径不在本项UPDATE修复范围内。

### B1b 2026-09-10

- 发现过时描述：m2文档描述读取内存转换，但当前候选已由Todo97改为首次读取落盘且删除旧字段；因此仅修改正常save不足以保留旧值。本轮同时调整首次迁移和正常保存。
- 先更新期望／测试，15个断言红灯准确覆盖旧字段删除、预算丢失及无快照的新文件伪造旧值；随后修改存储层。
- 首次迁移只补modelSelection，旧值不动；needsMigration以新字段是否存在为边界，保留旧字段不导致重复迁移。正式reader去掉旧模型/档位/预算。
- writeWiki/writeDraft共用私有writeModelDocument，mkdir后取原有文件锁、重读磁盘三项旧快照、一次atomicWriteText（关闭内层重复加锁）。清除沿用Todo97已有null标记，不扩展共享ModelSelection；新文件没有旧值则不捏造。损坏JSON读取失败保留文件并上抛，未添加自动删除。
- 五文件100测试通过：StorageMigration、SelectionAuthority、Service、ModelClient、EffectiveSelection。含迁移幂等、保存后重启、非法/空新字段不复活、迁移与保存/删除的屏障竞态、rename失败保留原文。真实生成Service测试证明磁盘旧8192预算保留，但Catalog/Page均实际传32768模型Limit。
- `pnpm typecheck`、`pnpm lint`通过；architecture检查0违规。无UI及消息交付逻辑修改。本地临时文件测试不等于真实旧App回滚；固定staging@790884b1ce的Wiki reader本身直接JSON读取，保留字段以原始磁盘断言核对。
- 复审未发现新的产品裁决需求。只读返回对象与回滚文件明确分开，WorkspaceKey与目标Host路由不动。移除旧字段的既有测试按最新已批准语义修改，并保留其原有幂等/并发断言，不删除失败用例。

### 后续调查起点（历史记录，B1c 已由下节收口）

- B1c：当前 `model-selection-migration.ts` 把 selection 平铺写入entry.data；`session-entries.ts` 的普通UPSERT替换整份data；所以不仅迁移要加新成员，后续保存也必须保留旧快照。正式写入口为 core `turn-model.ts`、`session-fork.ts` 和 bootstrap `session-facade.ts`；恢复入口为 bootstrap `session-store.ts`，codec位于 adapters `session-store/codecs.ts`。不能只改迁移而让下一次发送删掉旧值，也不能只包装磁盘而忘记测试真实恢复/fork。
- B1c现有测试：adapters `session-model-selection-migration.test.ts` / `session-store-model-selection-codec.test.ts` / `session-store.test.ts`，core `runtime-persistence.test.ts` / `session-fork.test.ts`，bootstrap `app-unbound-resume.test.ts` / `protocol-unbound-resume.test.ts` / `provider-registry-app-runtime.test.ts`。其中旧未发布平铺格式fixture不能被当成继续兼容的产品要求；真正staging原记录应以原始SQL fixture注入。
- B4来源revision：已核实 NodeZCodeBuiltinProviderConfigSource.snapshotFromRelease 只有数值revision。EndpointScopedSource的规范化Endpoint已进入active文件路径；Host通过 `resolveZCodeBuiltinActiveFilePath` 把文件路径交给Worker的直接NodeSource。修复必须保证二者得到相同来源标识，不能只在Endpoint包装层加前缀、导致Worker与Account依据永远不匹配。当前只调查，未选择未验证的实现。
- 当前已提交：m2合并 `1e4953e300`；B1a `ffb871b9db`；B1b `480441ca7e`。其余B1c/B2/B3/B4/B5仍未完成，Goal保持active，不以局部测试通过宣告整个Todo完成。

### B1c 实施与复审（2026-09-10）

- 收敛决定：前一轮列出的 core/bootstrap 三个写入口无需逐个包磁盘结构。现有 SessionStorePort 是逻辑 entry 合同，统一在 adapter 编解码更符合边界；已在接口注释/影响文档明确。所有生产读写及原子 fork bundle 确认复用该入口。新选择仍为公共 ModelSelection；不建立第二套身份类型或迁移后运行别名。
- 保存层使用单条 SQL UPSERT 的 json_set，只更新 `modelSelection`；旧对象其他成员逐值保留，无应用层先读后写窗口。首次迁移仍 begin immediate + 候选复查，沿用 id/type，不改消息行/活动时间。不新增 SQL table/schema。
- codec 正式读取只解包新成员：旧值未迁移则不可用，新成员空/坏值不借旧字段补齐。无档位的旧自定义 Provider 也完成一次迁移。未发布 options 中间态不列为兼容目标。
- 红测：正确 CLI Vitest 入口 12失败/16通过；最初根 Vitest 未包含CLI目录属于命令范围问题，不算产品红测。实现后 adapters/core/bootstrap 10文件266测试通过；新增 fork 原始JSON断言后存储3文件72测试通过。包含正常保存/清空/重开、旧字段及未知成员保持、消息不变、失败 trigger 回滚、幂等、冷恢复及fork隔离。
- 旧版证据：固定 `790884b1ce` 的 `server-operations.ts:3931-3953` reader纯字段投影用于真实迁移后JSON，验证原Provider/model/thought仍可读；不是旧App实机回滚。
- 全仓精确检索发现两个E2E直接SQL路径：unbound-resume播种、offpeak-existing读取；均已同步新包装。两个fixture check通过，分别仍有既有标题无marker/编辑标题无matcher警告；不自动promotion。E2E typecheck通过，实机待B5共享新Agent构建复验，不借旧包结果。
- 根typecheck通过，CLI contracts/adapters/core/bootstrap四包独立typecheck通过。根lint 43既有warning/0error；CLI changed-file lint只有既有 `session-store.port.ts` max-lines（1065有效行，当前只加注释未增加有效行），无新增诊断。架构context未托管情况见影响文档。
- 日志：`/tmp/todo104-b1c-{red,tests,final-storage,typecheck,cli-typecheck,lint,cli-lint,e2e-typecheck,fixture-unbound,fixture-offpeak}.log`。
- B1c完成不等于Todo104完成：B2/B3/B4/B5继续保持未完成，不推送、不合回recovery。

### 下一组 B2 调查起点

- B1c提交 `2e5c223700`；当前源码、用例及记录已收口，无需重复实现core/bootstrap包装。局部CLI lint排除单个已知max-lines规则复跑无诊断：`/tmp/todo104-b1c-cli-lint-baseline-aware.log`；未放宽仓库规则。
- §2 ModelSelection 已有等价实现：`packages/shared/src/model-selection.ts` 从 strict schema 推导类型，options仅reasoningLevel。Provider与CLI contracts均复用；`packages/shared/test/modelSelection.test.ts` 3测试通过，其中明确拒绝maxOutputTokens。不能误删实际 ModelRequest/ModelOptions 的maxOutputTokens，它仍承载模型Limit及请求执行值。
- B2基础入口：`packages/provider/src/config/schema.ts`（489行）当前import行为类并transform；`model-config.ts`（812行）、`provider-config.ts`（545行）仍独立手写数据字段及validateComplete字段列表。应先拆纯数据schema作为唯一依据，再让行为类/codec单向消费，不能倒向import造成循环。当前尚未修改这些文件。
- B2外层规则/名称/手动模式与B3 Personal envelope有关，必须按最终schema配套接入，不能让中间格式落盘成为兼容负担。共享typecheck/build按一组实施后执行，不为每个改名重复验收。

### B2a Model 单一 schema 基础（2026-09-10）

- 先补 spec/测试：正确红测7失败/15通过，定位到完整性检查遗漏非法 contextWindow/不安全整数、保存 schema 遗漏空白/重复档位。未把编译报错算成产品红测。
- 新增纯数据 Model schema；完整字段单点定义、逐层派生稀疏 nullish schema。Model 构造输入、JSON类型及 Registry 完整类型由 schema 推导；行为类继续负责不可变 overlay/freeze，不把 IO 或运行时逻辑放入 schema。完整性检查仅翻译 schema 的问题协议，不维护另一份字段表。
- 每个嵌套字段/对象逐项缺省与null测试：稀疏存储合法，但 Registry 不完整；同一值经 parse/class/JSON 保持一致。测试发现 literal 缺失的Zod错误码不同，已在公共问题翻译中保留原required-field-missing分类。
- Provider + ProviderNode 25文件361测试通过；CLI模型创建、运行时选择、bootstrap恢复三个文件22测试通过（附加runner文件自身8通过，不混入这三个文件的计数）。root typecheck通过；lint43既有warning/0error。
- 附加CLI runner-options测试54条中46失败：测试工厂把不完整partial强转为ResolvedAiSdkModel、缺properties，实际实现直接读supportsNativeWebSearch；另两条仍假设已删除ZCODE_PLAN_OPENAI_BASE_URL导出/按baseURL识别Start。相关测试、实现与本批HEAD无差异，失败现场未经过新schema；记录为已有过时测试，未通过增加执行层兜底绕过严格配置合同。未声称该文件已绿，也未运行旧App验证。
- 本批不改持久化名字或发布格式，不创建临时格式兼容；仍保留旧type、input_format等名字，待B2最终全链路一次改名。Provider/rule的单一schema、最终分组、手动完整配置及B3/B4/B5未完成。
- 证据：`/tmp/todo104-b2a-{red,all-tests,typecheck-final,lint-final,architecture,cli-tests}.log`。

### B2b Provider 单一 schema 基础（2026-09-10）

- B2a提交 `539494691c`。B2b先补 spec 和测试，3红/2绿确认原构造实例完整性遗漏未知API type/group及非法管理URL。
- Provider/API/Access/Template元数据类型与JSON从纯数据 schema推导；API Key与账号两种Access保持原分支，不改OAuth、权益、current或同步。完整Provider只收紧group、api和Access执行成员，headers/展示/成员/管理URL等原可选语义不变。
- 保存来源schema由同一数据schema派生：Builtin仅账号分组；Template拒绝真实Key；Account仅成员/entitled；Personal禁写builtin成员和固定账号Access，坏endpoint可暂存。未增加第二套Provider/Registry、存储或订阅。
- 新增必填字段缺省/null矩阵、两类Registry序列化、optional显式null、Access替换与false权益完整性测试。已有Resolver用例使用不存在的group=account，补强校验后被正确拒绝；仅把fixture改为bigmodel-family并去掉废弃enabled，保留非current/隐藏闲时行为断言。
- Provider/ProviderNode 26文件382测试、服务层6文件32测试、CLI3文件22测试通过。最终来源子集派生后两个文件35测试再通过；root typecheck/lint通过（43既有warning、0error）；CLI四包类型检查通过，architecture无违规。没有新增UI交互，最终改名/规则/落盘仍需B2后续和B5共享E2E，不用本批单测代替它们。
- 证据：`/tmp/todo104-b2b-{red,all-tests,services-tests,cli-tests,typecheck,cli-typecheck,lint,architecture}.log`。

### B2c OptionSpec 去除冗余 type（2026-09-10）

- B2b提交 `7f5a10cc9d`。先补B2c spec、新结构完整准入/旧type拒绝红测，3失败/23通过；SC90-01追加真实保存后的两项无type断言，原交互断言不减。
- schema、构造/overlay/toJSON、CLI Model合同及设置提交删除冗余字段。Builtin仅删除104处OptionSpec type，内容revision从13到14；不改任何map字符串、值域、上限或请求字段。Provider API/Access及外层规则type未动。
- 用TypeScript AST定向删除对象中的enum/limit属性（73文件237处，主要是已有测试当前配置fixture），未改已发布迁移输入或字符串内容；两个mjs E2E/helper同样更新。新拒绝用例仍保留旧type作为负例，不新增兼容路径。
- 32文件500条配置/节点/设置/服务回归初跑499通过，唯一失败是旧硬编码revision13；更新期望14后Built-in14条及设置/节点4文件94条复跑通过。CLI请求/compact/memory/恢复等8文件205测试通过。root及CLI四包类型检查通过，E2E类型检查通过；CLI初次类型检查受contracts旧dist声明影响，重新执行正式contracts build后通过，没有放宽源码类型。
- Pro从本工作树同步源码和新Builtin，WDIO正常重建desktop与Agent；隔离运行 `desktop-e2e-20260910-023030-912`，SC90-01 / F98-03 两条通过（14.3s），含手动保存/失败保留/重开/转智能、Map原文、1200/390宽度。测试自行清理隔离app数据，没有操作用户真实.zcode。Pro目录无.git，所以build-meta commit=unknown；来源由同步路径和源码校验确认，不冒充commit版本打包发布验收。
- settings域fixture checker返回不支持该目录，与102既有记录一致；none-provider manifest仍保留，不扩修checker、不自动转正。WDIO出现已有Browser.getWindowForTarget滚动降级警告，两个行为用例实际通过。
- 日志：`/tmp/todo104-b2c-{red,all-tests,builtin-final,final-focused,cli-tests,typecheck,cli-typecheck-final,e2e-types,fixture,pro-e2e,lint,architecture}.log`。其他B2字段/分组、B3/B4/B5仍未完成；Pro本批通过不代表最终全量Schema验收。
- 提交前扩大到本批全部非CLI/非E2E修改用例：39文件853测试通过；JSDOM有已有canvas未实现提示，不影响断言。CLI changed-file lint通过，仅有既有未使用变量/参数warning；root lint仍43warning/0error，架构0违规。
- Builtin语义对照：以HEAD原始JSON为基准，仅去除104个enum/limit type并revision+1，与工作树结果deepEqual；确认map字符串、值域、上限、其他配置完全不变（`/tmp/todo104-b2c-builtin-equivalence.log`）。本地与Pro的Builtin、Model schema、表单提交文件SHA256一致，实机不是旧schema产物。

### 后续实施接点（B2c 后）

- B2剩余：Model格式字段驼峰化/MFJS移入properties；Provider个人成员/baseUrl/名称和template身份外移；规则分组、来源限制、providerMatch→明确站点、手动完整配置；最终所有类型从schema推导。当前CLI `contracts/src/model/model.ts` 仍有独立ModelProperties/OptionSpec数据接口，不能以Provider内已收口宣告全域唯一来源完成。
- 公共协议 `packages/shared/src/zcode-protocol/index.ts` 的Model格式字段还有独立schema；后续应明确共享纯数据合同，禁止 Shared 反向依赖 Provider 行为实现形成循环。现有Provider只通过类型引用shared/model-selection；不可为改名增加任意运行时跨域依赖。
- 剩余32个生产源文件涉及Model格式/MFJS（已定向查到UI草稿/设置、Provider、CLI合同/adapter/core、公共协议）。其中SDK真实请求字段、日志/生成脚本里的同名字符串需按语义区分，不全仓机械替换。Provider API的baseUrl裁决同样不涉及SDK baseURL。
- Pro隔离目录已包含B1/B2a/B2b/B2c代码和新Agent构建，可继续复用；最终规则/envelope调整后仍须按新代码重建。当前spec/Builtin revision已变，不发布、不推送、不合回recovery。

### B2d-合同：跨层唯一 Model 数据定义（2026-09-10）

- 从 `5032dd2019` 继续。B2d分合同/字段两个步骤，本批只完成合同归属，最终驼峰字段/MFJS位置尚未改，不宣称整个B2d完成。
- 按 spec 将纯Model schema移到 `@zcode/shared/model-config`；Provider/codec/Registry引用公共入口。CLI六个数据类型从共享schema的推导类型别名导出；协议媒体格式用 `.pick()` 复用字段对象，传输字段和值不变。null/optional、完整校验、expression编译、overlay/freeze仍是原逻辑。共用sparseShape移动到shared/config-schema，旧内部文件删除而非保留兼容壳；静态引用扫描已覆盖两个消费文件。
- 先新增公共入口/协议字段复用测试和CLI类型相等断言。初跑因公共子路径未提供而失败，属于缺合同的红灯，不作为已复现产品Bug证据。实现后发现真实跨包Zod 4.3/4.4类型不兼容：仅将shared/provider/provider-node固定在现有shared的4.3.6，CLI Zod3与其他包不变，不靠强转绕过。
- 最终锁文件离线冻结安装成功（无新下载）；28文件442测试通过，包含Model每字段缺省/null、严格来源、序列化、完整性、Builtin以及协议；CLI五文件22条通过，涵盖媒体策略、模型创建与运行时/恢复。CLI首次从根目录启动未匹配到用例，改为CLI真实root后执行，不记作产品失败。新增 `expectTypeOf` 另用真实tsc核验，不把Vitest运行时无操作的类型断言误算成类型证明。
- root typecheck最终通过；改动依赖版本后旧增量声明曾留下错误推导，重新构建三个合同包后全仓通过，没有修改Service代码。CLI四包typecheck通过、contracts build通过。root lint43既有warning/0error；architecture0违规。Linux桌面生产构建成功，既有chunk-size警告保留。
- 本批没有UI交互、消息时序、IO或账号同步改动；协议投影范围测试证明未扩大desktop/mobile载荷。最终字段步骤继续运行Pro SC90，不将上一批Pro证据冒充本批新产物实测；Builtin仍revision14且内容零变更。
- 日志：`/tmp/todo104-b2d-contract-{red,tests-final,cli-tests-final,type-assertions-final,typecheck-final2,clean-types,cli-typecheck,cli-build,desktop-build,lint,architecture,install-final}.log`。
- 复审：单一数据定义方向无Provider反向依赖；CLI仅type-only引用，ModelRequest/ModelOptions真实maxOutputTokens未删。B2最终字段/规则、B3默认文件与provision、B4运行路径/身份、B5整体验收继续保持未完成。此前调查段落记录的是当时状态，以本段和顶部矩阵为现状。

### B2d-媒体字段（2026-09-10）

- 共享合同批次已提交 `44761219b5`。本批先更新测试到正式七个媒体字段，25红/4绿确认旧实现不能读新结构；随后统一schema、行为类、Registry序列化、协议候选、UI提交/展示、CLI媒体策略/Read PDF/compact/生成/stream消费。UI Draft媒体类型同样取共享schema，不再手写两份接口。正式代码不留旧字段alias，负例明确拒绝未发布旧格式。
- Builtin只改227个对象键与revision14→15，逐值deepEqual确认所有map字符串、档位、Limit及能力值完全保持。未改SDK真实body、公开tool schema、账号同步、Selection及回滚快照。MFJS仍在原位置，下一步专门处理properties下的布尔覆盖，未谎称已完成。
- 原Builtin完整性测试按任意层key禁止supportsPdf/Video，与新的inputFormat正式字段同名；改为拒绝旧格式名而非删除用例，hardcoded revision同步15。第一次34文件483条中481通过/2失败均归于这两处过时期望；更新后本批全部非CLI变更测试37文件722条通过。CLI媒体/PDF executor/压缩/请求/选择13文件189条通过。root typecheck、CLI四包typecheck与root lint通过（43既有warning/0error）；CLI受影响文件lint仅既有未使用参数warning。
- Pro新建构建首次在Agent打包失败：B2d-合同漏了esbuild两个精确shared子路径alias，通用alias误拼index.ts/model-config。补测试先红再修当前build入口，10条Node构建测试通过。旧bundle内容测试只证明本地现有包，其新代码实构建证据取后面的Pro运行；没有以本地旧bundle通过掩盖新Agent打包失败。
- 同时审查裁剪构建：v4已携带纯表达式库，Share及三个旧remote模板缺新增shared依赖的manifest/源码；仅补这两条COPY，不修旧模板其他既有缺项。新增5项闭包检查4红/1绿，修复后和Share边界共7测试通过，实际Share静态构建成功。不声称Docker镜像已实构建，也不部署Web。Share没有消费新的@shared子路径，未擅改其alias。
- Pro以冻结锁文件离线安装配套依赖，重新构建Desktop和Agent；隔离运行 `desktop-e2e-20260910-030213-463` 的SC90-01/F98-03两条通过（14.7s）。SC90新增真实图片/视频/PDF切换，确认最终字段落盘及重开状态，原取消、失败草稿、固定转智能、禁用保持断言不减。Map和1200/390布局用例继续通过。既有WebDriver Browser.getWindowForTarget滚动降级仍有日志，行为断言实际通过。
- Pro只同步隔离工作目录；两份已被共享合同替代的旧schema副本加.todo104-retired后缀，避免被tsc收集，可恢复，不涉及用户.zcode。新增shared依赖给Docker/Agent带来的漏接在本批修掉，不转交102绕过。
- 日志：`/tmp/todo104-b2d-format-{red,builtin-equivalence,tests,changed-tests,cli-tests,typecheck-final,cli-typecheck,lint-final,cli-lint,build-alias-red,build-alias-tests,docker-red,docker-tests,share-build,pro-e2e,pro-e2e-final}.log`。
- 复审：七项改名的所有生产代码引用已收口，旧拼写只剩明确负例/历史说明；UI字段来源与高亮keys同步；工具媒体过滤仍读取同一执行Model，不重新选择Provider或改写历史。Prompt trajectory现有fixture工厂另有models/enabled/不完整OptionSpec等旧接口问题，未借改名扩修，不作为本批通过证据。B2剩余、B3/B4/B5继续推进，不合回recovery，不推送。

### B2d-MFJS 实施与复审（2026-09-10）

- `requiresMfjsToolSchema` 唯一归属为 `ModelConfig.properties`。共享完整schema要求boolean，稀疏schema保留缺省/null；ModelPropertiesConfig承担overlay和序列化，ModelConfig不再重复保存。CLI的ResolvedAiSdkModel删除重复成员，generate/stream工具投影从固定执行Model.properties读取；不改变工具transform私有参数、MFJS实际转换算法、请求Map或Selection。
- Builtin15→16只移动原两处false/true；对HEAD JSON做同样结构变换后deepEqual通过，其他能力/Map/预算逐值不变。旧顶层字段严格拒绝，不新增未上线配置兼容。
- UI的草稿、个人覆盖标记、智能/手动物化均使用嵌套属性，删除原MFJS专门写入分支。未触碰且effective缺省/null/false时，不凭空保存false；原Personal null仍保留，enabled不受影响。明确设置true/false即使与推荐相同仍保留来源；单测覆盖重开和未触碰组合。
- 红测先有27失败/7通过。移植fixture后31文件486通过/3失败，两处仍用普通Object替代ModelPropertiesConfig、一处revision旧断言；更新后Provider/ProviderNode+SmartDraft27文件390通过。全部本批非CLI变更测试25文件552通过，最终增强UI57通过。新工具载荷测试开/关×generate/stream四条通过，实际拦截Anthropic HTTP请求，检查本地ref→defs转换、false不转换及输入合同不被改写。
- 第一次wire测试把transport注入了仅供resolve的fixture，却通过另一Adapter发请求，遇到.invalid DNS失败；已改为测试全局fetch拦截并在afterEach恢复，不改产品网络层、不增加重试。最终四项36ms通过，没有将超时当作产品错误。
- CLI扩大回归13文件278通过/4失败。重建adapters/core/bootstrap后，Script Workflow两个子进程旧产物错误消失；三文件复跑122通过/2失败。剩余：①无configured default的新建Runtime得到Registry首项（runtime-config源在本批未改，现有resolveInitialModelSelection默认推荐被该入口使用，与未绑定用例不符，留待B5核对，不能以本批绿色宣称全链路通过）；②remote Cron denylist，已有Todo102 V102-06。未删除/跳过断言，也不在MFJS归位中改这些语义。最终定向Provider runtime/selection/wire共13通过。
- Pro完整重建Desktop与Agent，隔离运行 `desktop-e2e-20260910-031927-186`：SC90-01/F98-03两条通过（15.6s）。SC90加入MFJS实际点击、嵌套字段落盘、重开值，以及顶层字段不存在断言；原媒体、固定/智能、失败/取消、enabled和窄屏排版断言均保留。未操作真实账号数据、不自动晋级用例。
- 根typecheck通过；CLI contracts/adapters/core/bootstrap typecheck及build通过；root lint43既有warning/0error，CLI受影响文件仅4个既有unused warning；机械改fixture产生的一处重复properties已在提交前消除并复测。architecture0违规。测试辅助类型和所有生产引用做反向检索，无遗漏顶层消费者。
- 日志前缀 `/tmp/todo104-b2d-mfjs-`：red、tests、tests-final、changed-tests、ui-final、wire、wire-final、cli-tests、cli-rebuilt、cli-focused-final、typecheck、types-final、cli-types、cli-build、lint、cli-lint-final、architecture、pro。本批收口不等于Todo104完成；Provider/规则最终结构、B3/B4/B5仍未完成，Goal保持完整范围。

### B2e Provider 字段命名与复审（2026-09-10）

- B2d-MFJS已提交 `351ec06cfb`。本批将新Provider配置里的modelIds→personalModelIds，api.baseURL→api.baseUrl，同时更新schema/类型/overlay/序列化、成员增删改排序、设置稀疏保存与读取、Host元数据、Wiki和Adapter。
- 成员owner未变：builtinModelIds/Account成员仍不可冒充Personal删除或改ID，ModelOrder仍覆盖最终成员；修改普通Provider字段继续剥离成员字段。不改变页面布局、语言、连接语义、请求选项、Selection重解析/提交时机。
- 旧staging导入仍读endpoints.baseURL/options.baseURL/models，转换后的ProviderConfig才写新名；SDK边界继续构造baseURL，运行网络与账号描述DTO不随配置盲目改名。ModelRule查询baseURL和Match整体留给下一组，不双读新旧配置字段。
- 新字段/null/旧拼写拒绝红测先失败，再更新实现；第一轮437条431通过/6失败均为旧错误路径/局部API对象期望/revision。扩大到59文件后931通过/4失败（其中3项为同轮运行时尚未更新的路径期望，另一项抓到E2E seed的baseURL简写漏接），逐项修改后最终59文件935通过。Provider/ProviderNode另27文件386通过；包含动态成员、个人排序、表单API headers和已发布配置导入。
- 类型检查抓到跨行api.baseURL、排序局部变量被机械改名和WDIO测试shape三处；均已修复。最终生产diff确认排序仍用modelIds局部参数、不改其语义；撤回formatter对services/node.ts的无关旧格式变动。新配置精确检索和AST核对不再残留旧key，仅保留显式拒绝负例和既有SDK/旧数据/规则接口。
- CLI五文件36测试通过；请求wire两文件10测试通过。为六种API/账号配置新增真实出站URL断言，确认新api.baseUrl没有丢失导致回落SDK默认域名；原roles/prompt、headers、MFJS开关断言保留。
- Builtin16→17：对HEAD JSON做同样改名后deepEqual通过，共23处endpoint字段，所有endpoint值/模型名单/规则Map/预算不变。规则数组/label/template归属尚未改变，不能宣称Provider最终结构已完成。
- Pro共享重建Desktop+Agent，最终隔离运行 `desktop-e2e-20260910-033329-491`：SC90-01、F98-03、W89-05/W89-08三条通过（13.8s+5.5s）；验证个人成员新字段落盘、重开、重复添加失败草稿、删除/启停，媒体/MFJS/Map原断言保留。第一次三条也通过，但当时类型检查另抓排序变量问题，修复后重建复跑最终候选，没有使用第一次结果覆盖未修代码风险。后续应先收类型检查再启动共享E2E，避免这次的重复构建。
- 根typecheck、CLI四包typecheck通过；root lint43既有warning/0error，CLI两项既有unused warning；architecture0违规。JSDOM已有canvas未实现提示未影响行为断言。日志 `/tmp/todo104-b2e-{red,tests,changed-tests,changed-tests-final,provider-final,types,types-final,types-final2,cli-types,cli-tests,wire,lint,cli-lint,architecture,pro,pro-final}.log`。
- 本批完成的是两个已裁决字段，不新增兼容、不推送、不合回recovery。剩余B2外层Provider/Model规则、B3同文件默认选择/分发、B4路径/revision和B5整体复审仍为Goal完整范围。上批保留的Runtime新建默认选择/Cron问题未擅自改动。
