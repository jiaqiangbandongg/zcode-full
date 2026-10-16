# Todo109 数据库实施账本

> 实施基线：`dfce309227`；旧格式基线 `staging_backup@790884b1ce`。2026-09-10：实现、存储回归及 Pro 桌面关键验收完成；远程/手机联合实机限制见 D 节，不宣称全平台验收通过。

## A. Agent 存储契约和逐表结论

现有 0001–0019 SQL 原样保留；新增 `0020_provider_model_selection`，采用固定 SQL 数据转换（不扩展运行时账号依赖或修改历史 checksum）。迁移先固定旧会话当前选择，再补历史消息/Part 新成员，防止消息转换改变当前选择来源判断。

| 表                                                        | 对照结论/本轮操作                                                                                                                   | 验证状态                                   |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| session_entry                                             | runtime/model_selection 新增 modelSelection；保留全部旧 data 成员和元数据。其他 entry type 保持                                     | 原始库断言、恢复、Pro 通过                 |
| message                                                   | user.model → modelSelection；assistant providerID/modelID/variant → providerId/modelId/reasoningLevel；历史来源不改身份；旧成员保留 | 原始库、冻结旧 Reader、更新/fork 通过      |
| part                                                      | timeline 另存 fromModelSelection/toModelSelection；subtask 另存 modelSelection；旧对象不覆盖                                        | 原始库、冻结旧 Reader、更新/fork 通过      |
| session_input                                             | 旧 payload 未记录的 modelSelection/mode 保持缺失；无旧字段可转换                                                                    | 全表保护、协议恢复通过                     |
| model_usage                                               | TS 名称调整，SQL provider_id/model_id/variant 不变；历史来源及统计不改                                                              | 原始整行保护通过                           |
| turn_usage、tool_usage                                    | Turn/工具用量及关联不因 Provider 重构改变                                                                                           | 原始整行及外键保护通过                     |
| local_setting                                             | 废弃全局 reasoningLevel 旧行保留，不迁成显式 Session 选择                                                                           | 原始整行保护通过                           |
| session、todo、permission、input_history                  | 持久化契约不变；不改内容、ID、关系、时间或顺序                                                                                      | 原始整行及外键保护通过                     |
| session_target                                            | 目标存储格式不因 Provider 重构变化，不改运行状态                                                                                    | 原始整行保护通过                           |
| workflow_definition/run/activity/event、session_task_link | opts/result 等 JSON 原样保存；link.model 是现有执行记录，不批量改名                                                                 | 原始整行/外键保护通过；生产/消费方复核完成 |
| dwf_run/actor/node/event                                  | 保留 0019 独立 journal、resolved_model 及绑定，不提前实现引擎                                                                       | 原始整行及外键保护通过                     |
| schema_migration                                          | 追加 0020；0019 及更早 SQL/账本/checksum 不变                                                                                       | 全表、重复打开及故障测试通过               |

### 新 Reader / Writer 契约

```text
数据库打开 -> migration 0020 -> 当前 Reader -> 正常历史/运行接口
旧字段     -> 仅 migration 和回滚 Reader
新配置缺失 -> 正常内容可读，执行所需配置由既有入口检查
```

- SQLite adapter 解包新 Part 成员为现有逻辑 Port 的 fromModel/toModel/model；运行层不接触旧字段。可读性需要容忍缺少 toModel，不伪造空字符串 Provider。
- 新 User/Assistant 仅消费新成员；旧配置字段不作为读取 fallback。保存旧行时保留原旧成员，不持续更新旧快照；新增记录是否需要最小旧字段由冻结 Reader 测试决定。
- 删除 SessionStorePort 上逐会话 migrateLegacyModelSelection 和 bootstrap 恢复时调用。迁移以库版本为门禁，不以每次恢复为门禁。
- 迁移 SQL 以有明确旧来源的记录为对象；未知 builtin 身份不绑定，保留原来源。普通历史模型来源无需查询 Registry/Account。
- 更新数据库不触碰任务活动时间，不改变已接受输入的模式/顺序/执行绑定。旧消息既有 modelSelection 的历史合法表示需在实现中先辨别来源，不能把已经发布的字段误当未上线中间态。

## B. App 库

TaskIndexRepo/AutomationRepo/OffPeakTaskRepo 共用 tasks-index.sqlite。建表/补列已归一至库级 versioned migration，保持已有必要初始化行为。

实施边界：统一入口由 services/session 的任务库模块拥有，三个 Repo 都在开放读写前调用；不跨域复用 Agent 的具体 adapter。建表、补列、索引归入 0001（接管已有/部分表），Provider 数据转换归入 0002。IMMEDIATE 事务内核查库级账本，失败回滚。声明式 SQL/列清单参与 checksum；TS 数据转换采用冻结语义版本标识，不能用 function.toString() 作 checksum（打包会改写函数文本），已发布转换实现不得原位编辑。

Automation 旧默认选择在迁移时明确写 JSON null；存在但不可确定的旧选择保持 SQL NULL，执行要求重选。正常派发不再检查旧 model 列。Off-Peak 旧数据没有 Provider 身份，不能在库事务或 list/get 用当前账号补出；保留 Ticket/旧列，展示配置待修复，当前有效新选择仅派生可用性。

旧 ACP ID 整理属于本轮之前已有的迁移，不借机改变其历史产品裁决；闲时标记/归组和已删除引用清理由索引 Repo 维护，属于可重复的关联投影维护，不作为 Provider 数据转换。实施时记录保留理由。

最小兼容写入已定位：旧版模型切换 Reader 无条件访问 toModel.providerID，因此新增 timeline 保留一个旧 toModel 对象；更新时不覆盖旧快照。User 的旧 hydration 虽有空值保护，但协议 mapper 的 modelRefFromInternal 无条件读取 user.model，所以新增 User 也保留最小旧 model 对象。Assistant 旧协议 mapper 构造来源对象，即使字段缺失仍可读，不普遍双写。

复制边界：逻辑 Reader 不携带旧模型字段，fork 不能靠它重新生成旧快照。存储写入接受可选的原记录坐标（sessionID/id），adapter 在复制时保留原记录的旧字段；Core 只传原/目标 ID，不解析旧配置。原子 fork bundle 一并携带消息/Part 的坐标映射，在既有事务内执行；不另建迁移服务或读取 fallback。

App 八张表的结论：`automations` 的旧 model/provider/thought_level 生成 model_selection；`automation_runs` 旧版没有可靠完整身份，不猜历史执行选择；`off_peak_tasks` 保留全部旧模型字段和 Ticket，缺身份不绑定；`tasks` 及四张分组/顺序/工作区关联表保持原记录。八表完整 fixture 与旧 Reader 均验证，新增的唯一账本为 `tasks_schema_migration`。

保留的非本轮旧逻辑：TaskIndex 的 ACP task ID 整理早于 Provider 重构；闲时标记/分组是关联投影维护；OffPeak 的 awaiting_approval → running 是旧生命周期修复，不是模型选择转换。TaskIndex 的 `model` 是列表展示事实，不能误当旧 Selection 读取旁路删除。本轮不重新裁决这些既有语义。

## C. 调用链、完整性复审与范围

- Agent owner：`sqlite-session-store.ts` 打开后经既有 `migration-runner.ts` 应用 0020，再允许 Repo 读写；App owner：三个 Repo 的初始化统一调用 `tasksDatabase/migrations.ts`。两个物理库独立记账、独立事务，不互相导入具体 adapter。
- 转换来源：以旧基线仓库格式及实施基线的 `model-selection-migration.ts`、`automationSelectionMigration.ts`、共享旧身份解析规则逐项对照；上述两个被替代的文件及 SessionStorePort 逐会话迁移 API 已删除。冻结 SQL/TS 转换不运行时引用可变 Provider/Account 规则。
- 正常入口：Agent codecs 只消费新成员；bootstrap 的 create-app、message-mapper、transcript-hydration 不再恢复旧选择。App Automation 默认用 JSON null 与 SQL NULL 区分，无旧列 fallback；OffPeak `projectModelSelectionIssues` 只投影错误，不在 list/get 写库补迁。
- Producer：Core 的消息持久化仍经过 Port；SQLite adapter 定义物理兼容字段。`session-fork.ts` 原子 bundle 及 `workspace-checkpoints.ts` 复制均传原记录坐标，adapter 在既有事务内搬运旧快照。子 Session 当前选择是 fork 边界的新选择，不复制父 Session 当前配置；原父 entry 不变。共享会话显式导入保留独立导入边界，未恢复普通读取兜底。
- Workflow：`repositories/script-workflow-runs.ts`、`script-workflow-activities.ts` 和 `session-inputs.ts` 对旧基线无修改；Core workflow scheduler/expert 的 model 是事件/执行结果事实，不是待按当前账号重解释的持久化 Selection。原始 JSON、统计、顺序及子会话关联保留。
- 全仓搜索数据库驱动、建表和路径入口，Provider 重构涉及的自有 SQLite owner 为上述两库。desktop Chrome Cookie 读取的是浏览器库，stability telemetry / remote connect 仅诊断 SQLite 错误，不是第三个 owner。JSON/Markdown 配置、外部缓存与第三方库不纳入本轮 DB migration。
- 双向审查：旧字段及值由原始 SQL 断言保护；当前协议/执行不再从旧字段恢复；缺配置只阻止需要模型的执行，不隐藏内容；Provider 映射无账号查询、无权益判断；历史 provenance 不映射；没有改 owner/workspace identity、continuous/replayable 或 Ticket 策略。

## D. 验证证据与限制（2026-09-10）

### 自动化与静态检查

- Agent 整批 10 文件 **195/195 通过**，覆盖 provider-database-migration（9）、session-model-selection-migration（16）、session-store（44）、新物理 codec、App/Protocol unbound resume、共享上下文导入及 fork 等相关链路。`provider-migration-unrelated-tables.ts` 为 22 张业务表提供合法关联 fixture；校验整行、外键、旧账本、时间与内容，不仅检查表存在。
- App 最终合批 **9 文件 137/137 通过**（前一轮 123+14 的相同覆盖，不重复累计），包含 workspace identity、闲时标记和 Selection View。核心新增 `tasksDatabaseMigration.test.ts` 9 条、`tasksDatabaseRollback.test.ts` 1 条，包含八表保护、三 Repo 初始化、故障回滚、部分列接管、checksum、两线程同时打开只转换一次、离线、Ticket 保留及降级再升级。
- 冻结 Reader 位于两侧 `tests/fixtures/staging-backup-*-readers.mjs`，源自固定 `790884b1ce` 的真实函数，不引用当前 Reader。证明新版新增/修改数据可由旧内容读取链处理；不是启动了完整旧版 Electron 的声明。
- 根 `pnpm typecheck`、`pnpm lint`（既有 42 warnings / 0 errors）、`pnpm architecture:check --changed`（0 violations）、Agent contracts/adapters/core/bootstrap 类型检查及相关构建通过。新测试直接使用 esbuild，已补 services 开发依赖及锁文件；frozen/offline 锁文件检查通过。
- Agent 自身更严格 lint 仍报告 8 个既有超长文件和 3 个既有 warning；不通过删除历史 migration 或拆分无关大文件消除。根 lint 不覆盖 Agent，不能将根通过写成 Agent 全绿。
- 全仓 `pnpm knip` 仍有大量既有 unused/unlisted 提示，未宣称通过。发现的本轮 esbuild 未声明依赖已修；被删除 API/文件的源码调用搜索无残留。dep:refs 对 Agent 路径解析不可用，使用定向源码引用核对，不声称图工具通过。
- 扩大回归中的 `runtime-unbound-resume.test.ts` 有一条既有错误文案断言失败：期待 `Select a model before continuing`，实际被包装为 `Model creation failed`。用固定 `dfce309227` Core 源码复跑同样失败；执行仍在模型创建前拒绝缺配置，不是偷偷选择模型。本轮不扩修此旧问题。

### Pro 集中桌面验证

- Pro 隔离目录 `/Users/dev/Desktop/projects/Z.AI/zcode-db109-e2e.L1ztpm`；没有覆盖其原工作区或真实用户库。一次整批构建，复用 pending `conversation-session-unbound-resume.test.ts`。
- Run ID：`desktop-e2e-20260910130906791-p75075-7e14793053e6f24c`。报告位于上述目录 `packages/desktop/.e2e-artifacts/<Run ID>/summary.md`。**1 spec / 1 test PASS，零 flaky，零基础设施失败**；一条用例串联四个冷启动场景。
- 验证：首次真实启动先迁移旧选择且原字段保留；缺档位/非法 Provider 不妨碍显示历史；回滚写入导致缺新字段时不重跑 0020、模型选择保持空；用户重选后同一 Session 成功提交并得到 replay 回复。没有调用真实模型服务，也不自动晋级 pending。
- DB109-01～13 的数据库/Reader/协议关键断言已覆盖；DB109-14 **部分验证**：桌面本地实机、两种协议 clientMode、workspace identity 单测通过，但未运行手机 shared-host + 真实 SSH/WSL 联合 E2E，不把协议单测等同联合实机。Windows/完整旧版桌面二进制同样未实跑。
- Agent 0020 仅转换 JSON，不新增业务表/列；App 新增库级 ledger。已向用户询问 CLI 负责人协调，尚无确认；未擅自发送外部消息，不能宣称已同步。发布前仍需团队确认。

## E. 复审缺口补修（2026-09-10）

最高原则再次确认：**回滚，或回滚后再升级，允许模型选择失效、由用户重选；但不能因为本轮选择格式变化导致会话/任务打不开、正文丢失，或在读取展示时报告异常。** 执行前必要配置校验仍保留，不偷偷代选；这不是吞掉数据库损坏、IO 失败等真正异常。

### 两项修复与边界

1. `0020` 对无法确定身份的旧 User `model` 会产生 `modelSelection: null`；原 Reader 直接透传，导致协议 `info.model` 校验失败。新增回归先复现 ZodError，再在 SQLite Reader 用公共 Selection 结构解析将非法新配置投影为缺失。Timeline/Subtask 原先仅检查 object，同类残缺身份也会穿透协议，现一并校验；合法的历史身份、档位与 Timeline label 保留，不查 Registry/账号。**不修改已提交 migration 的 SQL/checksum、不重跑、不删除或修补磁盘旧值、不恢复旧字段 fallback。**
2. restore 插件直接写 SQL，绕过普通 Writer 的旧 User 最小对象；冻结旧 Reader 因 `model` 整体缺失而抛错。导入脚本仅增加 `model: {}`，旧版模型可失效但内容可读；当前仍只使用 `modelSelection`，不扩大 Assistant 双写，不重新裁决 ACP 来源身份。

```text
旧库首次升级 -> 既有 0020 -> SQLite Reader 结构校验 -> 内容/协议正常读取
回滚期间写旧格式 -> 再升级（账本不重跑） -> 缺失/非法新选择不阻断内容
显式 restore 导入 -> 新选择 + 最小旧对象 -> 新/旧 Reader 均可读取正文
```

### 新增证明与复验

- `database-rollback-readability.test.ts` 直接执行真实 migrations、SessionStore、协议 mapper/schema，并调用冻结 `790884b1ce` Reader；覆盖空旧对象、半残身份、null、新字段缺失、错误类型档位、原字段/正文/账本保持。真实 restore CLI 子进程使用两个临时 SQLite 与 snapshot 文件，导入 User/Assistant 后在旧 Reader 和再升级后的当前协议读取正文，stderr 为空。没有访问用户数据库。
- Agent 合批 **6 文件 96/96 通过**，App 两库迁移/回滚相关 **2 文件 10/10 通过**。测试先红后绿；缺字段对照可读，合法但未知 Provider 的选择仍保留，不因不可执行而抹掉历史。
- 根 `pnpm typecheck`、`pnpm lint`（42 既有 warnings / 0 errors）、adapters 构建、bootstrap 类型检查、desktop `typecheck:e2e`、fixture check、architecture check 通过。修改的 codec 单文件 lint 1 file / 96 rules / 0 diagnostics。Agent 全仓 lint 经补齐调用 PATH 后运行，仍因未修改的 CLI/contracts 等超长文件失败，不宣称 Agent 全仓 lint 全绿。
- Pro 复验 run：`desktop-e2e-20260910150113615-p79512-7b913cccfacc70a8`，同一隔离目录，**1 spec / 1 test PASS**，四个冷启动场景。新增旧 User `model: {}` 经 migration 后仍显示提问和回复、读取无配置格式异常；回滚移除新 User 字段后再次启动，旧账本不变，正文可见，重选后继续同一 Session 成功。
- 前一尝试 `desktop-e2e-20260910145741668-p78675-f3dd3d3bd47d9881` 在首条准备消息发送失败，尚未进入迁移 fixture；保留失败记录，不算通过，也不直接断言其根因。补充“展开详情”诊断后，**未再修改产品代码**的上述复跑通过。此处不宣称首跑稳定性已证明，不扩修独立发送问题。
- 仍未运行完整旧版 Electron 二进制、手机 shared-host/真实 SSH 联合及 Windows GUI；旧版证据来自冻结实际 Reader，Pro 证据是当前版本冷启动桌面。既有外部协调限制不变。本补修不改表结构/迁移账本，不新增协调事项，不自动推送。
