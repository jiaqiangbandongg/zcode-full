# Todo87 实施影响记录

## Feature Summary

意图：恢复 D02 账号切换后的同模型体验，保留重构后的原选择/执行选择边界。能力、裁决与剪枝见 Todo87；当前为 implementation-handoff。改动层为 option-source、validation、recovery、commit-effect；不改 schema。种子：ModelSelectionFacade、useDraftConfigControl、dispatchCronRun。排除：发送前同步、闲时跨账号换票、历史/已固定请求重解释。

## UI Surface Matrix

| 场景/入口 | 共享实现 | 原意图 owner / 初始化 | 门禁、提交和持久边界 | 隔离 |
| --- | --- | --- | --- | --- |
| Composer / SessionPane | 带输入的 Selection Service + 公共 hook | scope draft；Session 仅首次 seed，新草稿沿用 Recent/Configured Default | View 派生；accepted 才采用有效值，ACK 期间编辑则不覆盖 | workspaceIdentity、Session；continuous/replayable 不改 |
| 定时任务编辑 / AutomationEditView | 同一 Service/hook | 表单原选择；已有跟随 Workspace 模式保留 | 主动保存才改长期配置；后台首次派发前解析并固定 run | 表单与 run 不互写 |
| Bot / Wiki | 同一 Service | 各域自己的选择 | 准备新执行时解析；已固定执行除外 | 不改普通聊天意图 |
| 显式 Subagent | 保留现有 Agent 校验 | Profile 显式选择 | 本轮不接账号对应；用户已裁决后续单独设计协议接入 | 未指定模型继续继承 Parent |
| 闲时列表/执行 | 原身份只读校验 | 任务原选择 + 已领取 Ticket | 非终态执行检查保留；读取不清库 | 不跨 Z.AI/BigModel 换 Provider/Ticket |

## Shared And Divergent Behavior

公共的是候选来源、同 ID 匹配、失效档位置空以及输入/Host 代次隔离；不同的是各域提交与保存边界。UI 不共享某个消费者的 effectiveSelection；普通菜单继续过滤 hidden，闲时只在受限路径使用原 hidden Provider。既有全新选择初始化不等于已有意图修复。

## Feature Relationships

| 级别 | 关系 | 条件与证据 |
| --- | --- | --- |
| must-inspect | Account/Config → Registry Snapshot → Facade → Service/hook → Composer | 同快照账号状态；`providerRuntime.ts`、`facades.ts` |
| must-inspect | scheduler → Host → run 固定 → dispatch | 已改为 Host 首次派发解析后固定；scheduler/manual claim 不提前冻结，既有 run 不重新对应 |
| must-inspect | OffPeak list/get/sync → repairLegacyModelSelections | 已有新选择仅派生诊断，不再由读取触发 invalidate；真正旧结构迁移保留 |
| should-inspect | Bot/Wiki 准备 → Service | 不仅修改设置控件 |
| conditional | 显式 Subagent override | 无 override 继承 Parent，不受当前账号重算影响 |

## State Owners And Commit Sinks

| 状态 | 权威 owner | 写入边界 |
| --- | --- | --- |
| Account/Registry | 目标 Host applied snapshot | 源刷新，非调用者持久化 |
| Composer 原意图 | Renderer scope draft | 用户编辑；匹配原意图的 accepted 回调；Root promotion |
| 有效选择 | 单次读取/消费者 | 不直接持久化，不广播成全局选择 |
| 定时 run | AutomationRepo | 首次固定；已有 run 重试不重新对应 |
| Active Model/Submission | CLI / 本次提交 | 固定后只由 Registry 校验，不静默换模型 |

## Must-Preserve Invariants

不增加持久化迁移；原意图为空不补默认；临时失败不伪装为空；无 Provider 同名猜测；不引入发送前同步；各端仍共用 Host，delivery profile 不改。验证对应 SR87-01～14；实际结果记录于 Todo85 审计表，未执行的 E2E 不计通过。

## Codegraph Evidence

codegraph 工具本次不可用，已用 rg/read 沿上述种子追踪 1～2 跳。Service 的直接调用者为 UI hook、Bot、Host automation；Composer 所有原选择写入由 useDraftConfigControl 收口。此表不冒充图查询结果。

## Graph Drift Candidates / Graph Delta

统一有效选择已在 Feature Graph 标明实现与精确代码种子；Composer、Automation、Bot、Wiki 接入，Off-Peak 只读保护；显式 Subagent 按用户裁决排除。codegraph 不可用，验证 YAML、文件/符号种子，不伪称完成索引查询。

## Unresolved Questions

显式 Subagent 已确认缺少 Host 账号事实；用户裁决本轮保留原校验，后续单独接入。不扩展协议，也不做仅设置页自动对应的半套行为。

## Planning Handoff

Spec：selection-state.md 已追加实施契约；catalog/coverage：SR87 已按真实证据更新；E2E 已跑 Air，新候选保留 pending 待人工转正；决策、提交和报告见 Todo85 审计表。不是所有边界都需要 Electron 全排列。
## Wiki 的新生成与补齐边界（2026-09-07）

新生成（含 task_complete 触发的新一轮）在开始时解析生成设置的原选择，固定本轮配置；后续页面请求复用该配置。补齐同一 Wiki 的失败页继续使用历史生成选择，不随当前账号重新对应。读取/展示不修改 Wiki、聊天或 Recent。ModelClient 分开提供新生成配置解析与既有固定配置读取，二者共用目标 Host 读取与配置投影，不另建账号匹配规则。
