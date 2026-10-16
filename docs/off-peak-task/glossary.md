# 闲时任务 · 术语表与领域模型

> **状态：已实现；本文是 2026-07-22 的代码事实快照。** 当前实现包含 `offPeak` 领域、
> `off_peak_tasks`、ticket 同步、scheduler/host 派发、per-turn idle provider、UI 和 mock。
> `decisions.md` 是历史 ADR；早期 D11/D25/D36 等条目须按后续 superseded 标记阅读。
>
> 2026-08-22 起，`client/configs.offPeak` 只提供曝光开关；模型成员和静态能力统一来自
> Built-in `builtin:offpeak-idle-plan` 与 Effective Model Config。

> 当前口径来源：`spec.md`、`tech-design.md`、`implementation-notes.md` 与实际代码。

## 术语表

| 术语                    | 英文/代码名                        | 当前定义                                                                                                                                                           |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 闲时任务                | Off-Peak Task / Idle-time task     | Automations 体系下的一次性后台任务。创建即取号；首次派发才创建 session；完成后进入不可逆终态，再跑需新建任务                                                       |
| 本地任务 ID             | `offPeakTaskId` / server `task_id` | 一条逻辑任务的稳定 ID。跨多张 ticket、多个 3h 自动续跑分段保持不变                                                                                                 |
| 服务端票据 ID           | `serverTicketId` / `ticket_id`     | 服务端每次取号生成的票据 ID。过期重取时覆盖 task row 的当前值；本地不保存 ticket 历史                                                                              |
| 取号可用性              | Take-number availability           | `GET /ticket/availability` 返回的即时快照；只有成功返回 true 才允许创建，false/加载中/未知/查询失败均禁入，`POST /ticket` 兜住查询后的并发竞态                     |
| 取号                    | Take Number                        | `POST /api/v1/off-peak/ticket {task_id}`。成功才创建本地 task；返回 ticket state、position 和 next poll 建议                                                       |
| 服务端准入态            | Ticket state                       | `queued / ready / active / expired / settled / not_found`。ready 会写成本地 `schedulable=true`；active 与本地 running 不是严格同时写入                             |
| 客户端执行态            | Task status                        | `queued / paused / running / completed / failed / cancelled`。permission/elicitation 在普通 session 内等待时聚合态保持 `running`；三个终态不可逆                   |
| 闲时队列                | Off-Peak Queue                     | 权威排位在服务端 ticket FIFO；本地 scheduler 另有 `queued+schedulable` claim 队列；busy session 的用户 prompt 又是第三层消息队列，三者不是一个全局 FIFO            |
| Pause / Continue        | —                                  | Pause 只停止本地派发，服务端票继续老化；Continue 时票仍有效则复用，expired/not_found/缺票则重新取号                                                                |
| 自动续跑                | Continuation                       | messages 返回 `400/3102` 后，同 `task_id` 重取新 ticket，保留 conversation/session，并以固定 continuation prompt resume                                            |
| 闲时专属 Provider       | `account:{zai|bigmodel}-offpeak-idle-plan`                | Built-in Config 中的执行期隐藏模型源，不进入普通模型选择；每个自动 turn 固定精确模型并注入请求访问材料，不改写 session 常驻模型                                        |
| Session 常驻模型        | User workspace model               | 首次派发按 workspace `defaultModel → lastUsed → current` 选择完整 `providerId/modelId`。模型栏显示它，而不是 idle provider；多 provider 时不按 provider 字典序猜选 |
| 用户排队消息            | Busy queued prompt                 | 自动 turn 忙碌时用户补发的 prompt。turn terminal 先恢复用户常驻模型再 drain，因此使用用户 provider                                                                 |
| Permission approval     | —                                  | 只走既有 session permission/elicitation 链路；Off-Peak 聚合保持 running。批准或拒绝发生在同一自动 turn 时仍使用 idle provider，不提供专用 Review 卡片或重复通知    |
| 容量等待                | `429/3105 + Retry-After`           | 只对 idle provider 特判：单次等待 `min(Retry-After 或 60s, 5min)`，abort-aware、无限探测且不消耗普通 retry budget；本地 task 仍显示 running                        |
| 灰度开关                | `configs.offPeak`                  | `enable_offpeak_task=true` 且 Built-in offpeak Provider 模型非空才开放创建；远端只控制曝光，不承载模型事实或额度                                                   |
| 创建额度                | Server take-number quota           | 服务端内部 `take_number.limit/window` 不下发客户端。客户端不再使用 D36 的 `limit.max_tasks/sliding_window` 或本地 createdAt 计数                                   |
| 终态核销                | Settle                             | 终态后按当前 ticket 调 `POST /ticket/:ticket_id/settle`。网络/5xx 由本地 outbox 补报，4xx 视为已无票可释放                                                         |
| History                 | Execution summary                  | 一条 task 只有 0/1 行聚合历史，不按 ticket/3h 分段展开；Delete history 只写 `historyDeletedAt` tombstone                                                           |
| Keep Awake              | `keepAwakeWhileRunning`            | 名称沿用，但最终行为是全局设置：开启即启动 `prevent-app-suspension`，与当前 active task 数无关；不能阻止合盖或用户主动睡眠                                         |
| ~~余额守护 / 算力余额~~ | —                                  | 已砍：客户端无金额余额逻辑，不展示消耗/剩余算力                                                                                                                    |
| ~~预计等待 / Est.~~     | —                                  | 已砍：卡片只展示服务端 position，不计算 ETA                                                                                                                        |
| ~~立即执行 / Run now~~  | —                                  | v1 已砍；想手动接管需取消自动任务后在普通对话继续                                                                                                                  |
| 会话内创建 | `OffPeakCreate` / `OffPeakList` | D49 恢复的会话入口：agent 工具族与 Cron* 兄弟并列，按语义分流。Create 缺省 yolo/白名单末位模型/最高推理档（与表单缺省有意分叉）；闲时自动 turn deny Create、cron 自动 turn 放行（组合玩法）；List 只读全场景可用 |
| 绑定会话 | Bound session / `boundSessionId` | D50：会话内创建的闲时任务绑定并运行在创建它的会话里（对齐 CronCreate targetTaskId）。创建即写 `session_id`，`conversation_id` 首跑回填；派发前探测会话忙碌则 transient 退避、不改配置；Stop 即取消。表单创建仍新建独立 session |
| 轮尾卡 | Turn-tail card | 回复完成后渲染在助手正文之后的静态结果卡（cron CronCreateAutomationCard 同款管线）。闲时卡 = 月亮图标 + 标题 + 创建时位次快照 + 「去到闲时任务」按钮，不订阅后续状态 |

## 与现有定时任务（Automation）的关系

| 维度     | 定时任务 Automation    | 闲时任务                                                    |
| -------- | ---------------------- | ----------------------------------------------------------- |
| 触发     | cron 表达式，周期性    | 一次性；服务端 ticket ready 后派发                          |
| 错过时机 | cron misfire 可 skip   | queued 保留并继续等待；不复用 cron misfire skip             |
| Session  | 每次运行创建 session   | 首段创建一个 session，后续 ticket 分段 resume 同一 session  |
| 排队权威 | 本地 cron due time     | 服务端 ticket FIFO；本地只认领 ready 快照                   |
| Provider | 用户常驻 provider      | session 常驻用户 provider；自动 turn 临时使用 idle provider |
| 数据     | automation 表/状态机   | 独立 `off_peak_tasks` 表、消息类型和状态机                  |
| 多端     | 按既有 Automation 边界 | 手机 `/remote` 和桌面 remote workspace 隐藏闲时产品入口     |

## 两轴状态与时序

```text
服务端 ticket：queued ──► ready ──首个 messages──► active ──► expired/settled
                       │                                   │
                       └─ batch status 写 schedulable      └─ 3102 触发换票

客户端 task：  queued ⇄ paused
                  │
                  └─ scheduler claim → sendPrompt ACK → running → completed/failed/cancelled
                                                      │
                                                      └─ 3102 → queued（同 session）

permission / elicitation：普通 session 等待用户响应；客户端 task 仍为 running。
```

## 不变量与当前限制

- `workspaceKey = workspaceIdentity?.trim() || workspacePath` 用于身份隔离；文件/cwd 继续使用 `workspacePath`。
- task、ticket、session 是三个不同生命周期：一 task 可换多 ticket，但只复用一个 session。
- 终态不可逆；取消/失败不回滚已写文件。
- 本地 running 在 `sendPrompt` ACK 后写入，可能早于服务端 active；429/3105 等待没有独立持久态。
- `next_poll_at` 是服务端建议时间快照；当前 `OffPeakTaskService` 用一个共享 timer 批量同步，不是 per-task timer。
- `not_found` 在 background sync 中不自动 retake；用户 Continue 会检查并按需重取。
- permission approval 不切换当前 turn 的 provider；D11/D27 的历史意图已由 D44 明确砍掉。
