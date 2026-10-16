# 闲时任务（Off-Peak Task）v1 实现 Spec

> **状态：已实现，持续按 Figma 收口。** 当前仓库已包含 `offPeak` 领域类型、repo、service、
> scheduler、UI 与进程内 mock；本文记录当前产品语义与实现约束。
>
> **2026-08-22 Provider Config 收口：** `client/configs.offPeak` 只保留
> `enable_offpeak_task` 曝光开关；模型成员来自 Built-in `builtin:offpeak-idle-plan`，模型能力来自
> Effective Model Config。下文历史 `allowed_models` 描述均由此条覆盖。

> 来源：PRD《z.ai-z.code-闲时任务 PRD v0.2》经 grilling 会话收敛后的实现口径。
> 配套：`glossary.md`（术语/领域模型）、`decisions.md`（D1–D40 历史决策记录）。
> 与 PRD 的差异见文末「明确不做」——**该清单需拿去与产品对齐确认**。
>
> **服务端契约真源**：内部仓库 `zcode/zcode-server` 的 `docs/off_peak_design.md`
> （`glab api "projects/zcode%2Fzcode-server/repository/files/docs%2Foff_peak_design.md/raw?ref=main"` 拉取）。
> 契约冲突时以该文档为准。关键约束摘录见 §4.1。

## 1. 一句话定义

闲时任务 = **Automations 体系下的一次性后台任务**（D28，Figma 定稿范式）：用户在 Automations 主视图/模板卡创建（title + instructions + 项目 + 权限 + 模型），提交即 `POST /ticket` 取号排队。**排队由服务端承载**（全局 ticket FIFO、按资源空余控并发准入）；客户端用批量 `POST /ticket/status` 观察 ticket，`ready` 时写 `schedulable=true` 并派发。无人值守执行按 3h active ticket 分段，收到 `400/3102` 后用同 task_id 重取号并 resume 同一 session，直到自然完成；每个自动派发 turn 使用用户不可见的 idle plan provider。

命名按层级固定：英文 UI 的单项概念使用 `Idle-time task`，侧栏系统分组使用复数
`Idle-time tasks`；中文 UI 统一使用「闲时任务」。TypeScript 类型/变量/常量分别使用
`OffPeak*` / `offPeak*` / `OFF_PEAK_*`；文件与 URL 使用 `off-peak`，SQLite 使用
`off_peak_*`。用户概念不改叫 Off-peak task，避免与服务端低峰准入协议混淆。

闲时任务设置 UI 的字号遵循 `DESIGN.md` 专用 token：既有 `text-ui-xs` 提升为
`text-ui-sm`；历史 `text-base` / `text-sm` / `text-xs` 分别迁移为 `text-ui-lg` /
`text-ui-base` / `text-ui-sm`；`16px` / `14px` / `13px` / `12px` 分别迁移为
`text-ui-lg` / `text-ui-base` / `text-ui-base` / `text-ui-sm`，只有小于 `10px` 的弱元信息使用
`text-ui-xs`。设置页不得继续使用 arbitrary UI font size。

闲时任务与定时任务设置页的表单输入内容统一使用 `text-ui-base` + `leading-5`（默认
`14px / 20px`）：包括任务标题、调度摘要或调度选择值、Instructions 正文及 placeholder。
两页必须复用同一个输入字号契约，不得在特定频率、创建态或编辑态回退到 `text-ui-sm`。

闲时任务指令工具条与定时任务共用同一套控件视觉和触发交互：项目、权限、模型与推理控件
统一使用 `h-7`、`rounded-lg`、`text-ui-base font-normal`，默认无背景，hover 与菜单展开期间
统一使用 `bg-surface-hover` 并提升为主文字色；菜单统一向工具条上方展开并与 trigger 保持
`4px` 间距。不得在闲时页面用 `focus-within`、`rounded-full` 或局部背景覆盖制造另一套交互。
项目菜单仅在 Automations 调用处收敛到该契约，普通会话项目 chip 不受影响。

工具条的展示组件以 New Task composer 为唯一实现来源：项目继续复用
`ChatEmptyWorkspacePreviewMenu`，定时与闲时只统一 Automations 包装参数、锁定态和无项目占位；
闲时模型直接复用 `ModelConfigSelect` 的扁平列表模式，推理强度直接复用
`ThoughtLevelCycleControl` 的 select 模式；权限直接复用会话 composer 的 `ConfigSelect`
（mode 类目），定时与闲时都不得再各自维护 DropdownMenu 复刻。复用只覆盖展示、键盘交互、
弹层和焦点恢复，不得把定时任务的 `inherit`、模型预览、管理模型入口或 session 状态带入
闲时任务；闲时任务由 Built-in `builtin:offpeak-idle-plan.models` 提供扁平模型列表，始终提交具体模型，
并保留 D34 的默认推理档位。

权限选择器遵循会话输入框的高权限语义：仅当 `permissionMode=yolo`（完全访问）被选中时，
trigger 的权限图标与文本持续使用 `text-warning` 橙色，并在 hover / 菜单展开态保持橙色；
其他权限模式继续使用默认前景色，尾部 chevron 保持弱化色。复用 `ConfigSelect` 后，权限
trigger 图标随当前值切换（与会话 composer 一致），菜单固定 `w-64` 并展示图标 + 标题 +
描述的双行选项，选中项由菜单打开时的初始高亮承接；Automations 页面没有聊天输入框，
关闭菜单后焦点必须回到 trigger 本身（`restoreFocusSelector=null` 保留 Radix 默认回焦），
不得落到 body。闲时权限必须与会话输入框及定时任务复用同一套 GLM 展示词表和 Tooltip：
标题走 `mode.label.glm.*`，描述走 `mode.description.glm.*`，Tooltip 走
`chat.toolbar.mode.label`；通过共享的 mode option builder 并传入 `glm` provider 实现，
不得再维护 `offPeak.mode.*` 专属文案，避免三处权限名称漂移。

闲时任务与定时任务的 Instructions 复合输入必须复用同一个结构组件，避免两套页面分别维护
高度和表面层级。Figma `4827:1399` 的桌面契约为：外框 `168px` 高、`12px` 圆角，正文
`116px` 高且使用 `8px` 内边距，底部工具条 `52px` 高且使用 `12px` 内边距；窄屏只允许
工具条因换行增高，不得改变正文高度。

## 2. 领域模型

领域类型位于 `packages/shared/src/off-peak-types.ts`（勿混入 automation-types）：

```ts
type ZCodeOffPeakTaskStatus =
  | "queued" // 排队等服务端授权
  | "paused" // 用户 Pause，停止派发（D30-10）
  | "running" // 执行中
  | "completed"
  | "failed"
  | "cancelled"; // 终态

interface ZCodeOffPeakTask {
  offPeakTaskId: string; // 本地主键，同时用作服务端 task_id（D26）
  serverTicketId?: string; // 服务端 Snowflake ticket_id；重新取号时更新（D26）
  title: string; // 表单 Task title（D28）
  conversationId?: string; // 宿主对话 taskId；D30-8 创建不预建对话，首次派发后回填（兼作"已派发过"信号）
  sessionId?: string; // 首跑后回填；续跑/中断恢复 resume 用（"存在 = 已有真实会话"的语义各处依赖，禁止预填）
  prompt: string; // 表单 Instructions
  permissionMode: ZCodeTaskMode; // 权限四档全开放（D29-4）；现产品词表 build/edit/plan/yolo，默认 "build"（Ask before changes）
  model?: string;
  thoughtLevel?: string; // 推理强度（D34，与 automation 对齐）；缺省走 workspace 默认
  workspaceKey: string; // workspaceIdentity?.trim() || workspacePath
  workspacePath: string;
  workspaceIdentity?: string;
  status: ZCodeOffPeakTaskStatus;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  failureReason?: string; // 磁盘不足 / 目录丢失 / API 连续失败…
  filesChanged?: number; // 完成通知与状态条展示
  settledAt?: number; // 终态核销 ack（D22）
  historyDeletedAt?: number; // 仅隐藏本地 History 行；不删除 task/session/执行字段（D37）
  createdAt: number;
  updatedAt: number;
}
```

存储：tasks-index.sqlite 表 `off_peak_tasks`（复用 AutomationRepo 的库与 Repo 模式）。
新增列使用 `ensureColumn` 兼容迁移，禁止重建或清空用户现有表。

2026-09-10 存储裁决（[Todo104 §6.18.1](../working-memory/provider-refactor/steps/todo-104-pre-release-schema-review.md)）：
新版 `model_selection` 是迁移后的选择权威。编辑标题、指令、权限或新版选择时，不清空或反向更新
旧 `model` / `thought_level` 列；原值只供旧版回滚读取。新记录不伪造旧值。
本项不改变 queued/paused 编辑门禁、Ticket 绑定及执行前校验，也不让新版从保留列重新选模。

D48 起，闲时任务的**已派发会话**在 tasks-index 拥有一等 task 行：`tasks.off_peak_task_id`
列持久标记归属（对齐 cron 的 `cron_automation_id` 机制；不复用 cron 标记，见 D45），
行 id = 首跑创建的 sessionId。`off_peak_tasks` 仍是排队/调度状态机的唯一真相源；
排队/暂停（未派发）任务不产生 task 行（D48-A：无幻影行），只在 Automations 主视图管理。
侧栏契约见 §5.1。

### 状态机

```
queued ⇄ paused（用户 Pause/Continue；票过期停在 paused 等手动继续）
queued ──服务端 ready 且被派发──▶ running ─────────▶ completed
  │                             │ ├─ 不可恢复错误 ─▶ failed
  │                             │ └─ 400/3102 ─────▶ queued（换票，复用 session）
  └── 用户取消（任何非终态） ──────────────────────▶ cancelled
```

不变量：

- 终态不可逆出；文件修改任何情况不回滚。
- 任务可多个并发执行，并发额度由服务端调度决定（D20）；单任务派发 single-flight 防重复。同 workspace 并发的文件冲突风险与手动并发对话一致，不新增隔离。
- ~~composer 锁定~~（D28/D30 作废）：run session 是普通对话，running 中补发 prompt 走现有 busy queue；自动 turn terminal 后再 drain，排队消息按 Session Selection 创建用户模型。任务操作收敛在卡片菜单：queued「Pause / Delete」、paused「Continue / Delete」、running「取消」。
- `build` 权限模式 / elicitation 复用普通 session 的交互链路：Agent 在会话内等待用户响应，但 Off-Peak 聚合状态保持 `running`，卡片不提供独立 Review 状态或专用通知。批准/拒绝都在同一个自动 turn 内继续，仍使用该 turn 的 idle Active Model；不承诺 D11/D27 历史方案中的批准后切用户 provider。
- failed 不自动重试；用户可手动重新入队 = 重新提交尝试。

## 3. 调度规则（D18/D26/D39：客户端不承载排队核心）

- **排队在服务端**：全局闲时任务池，FIFO（按任务创建时间，先创建先排），服务端按资源空余安排一定并发的准入。
- 客户端三职责：
  1. **取号**：创建任务时 `POST /ticket {task_id}`；服务端返回 ticket/state/position，成功才落本地 task。`429/3103 + next_take_at` 表示当前无法取号。
  2. **批量同步 + 派发**：有非终态 ticket 时用一个共享 timer 调 `POST /ticket/status`；服务端 `ready` 写成 `schedulable=true`，scheduler 再按本地 FIFO 事务认领。
  3. **处理 messages 容量等待**：idle provider 收到 HTTP `429/3105 + Retry-After` 时在 adapter 内等待重试；普通 provider 不走该特判。
- **无窗口可错过（D21/D9）**：机器睡眠 / app 未开期间什么都不发生，恢复后继续轮询与派发。⚠ automation 的 `MISFIRE_GRACE_MS` skip 策略与此无关，不得复用。
- `POST /ticket` 若直接返回 ready，service 立即写 `schedulable=true` 并唤醒 scheduler；否则由后续 batch status 观察 ready。
- running 中途每次模型请求**皆可能被重新排队**（D19）：仅 idle plan provider 把 HTTP 429/3105 分类为 `OffpeakQueued`，单次等待 `min(Retry-After 或 60s, 5min)`，abort-aware、无限幂等探测且不消耗普通 retry budget。stream 仅在可见输出边界前重试。客户端不新增持久态；由于 running 在 `sendPrompt` ACK 后写入，首个 messages 请求等待 429 时 UI 也保持 running。ready 票等待到 TTL 过期后由 3102 统一换票，不另设“首派超阈值弃派”状态机。
- 派发执行：新对话 = createTask + sendPrompt；续已有对话 = resume sessionId + sendPrompt。permissionMode 随派发下发。
- 中断恢复：app 重启发现 running 残留（进程已死）→ 置回 queued 队首，授权后重新发起尝试并 resume 同一 session 续跑（"重启后自动续跑"文案的实现口径）。
- provider：闲时执行 → idle plan（3h ticket 分段 + 自动续跑，D26）。隐藏的 Built-in `builtin:offpeak-idle-plan` 提供静态 Provider/Model 事实；每次派发提交标准 Model Selection，并在 `modelExecution` 中只携带本次 Request Auth、前台 Child override 与后台拒绝策略。它通过同一 Registry/ModelFactory 创建 idle Active Model，不修改 Session Selection，也不构造完整 Runtime Model 快照。首次派发创建 session 时，通过 `workspace/readState(preferWorkspaceDefaults=true)` 按完整 `providerId/modelId` 选择 `defaultModel → lastUsed → settings.model.current`，不得按 `available[0]` 或 provider registry 顺序猜测；多 provider 时模型栏因此稳定显示 workspace 用户模型。OffPeak 表单模型只决定 idle 自动 turn，不覆盖 Session Selection。permission approval 发生在同一自动 turn 时继续使用 idle Active Model，不切用户 provider，也没有套餐配额提示；用户补发 prompt 在当前 turn terminal 后 drain，并按自己的普通 Submission 与 Session Selection 创建用户模型。D11/D27 的批准切换属于未采纳的历史意图；~~立即执行~~ v1 已砍掉（D32）。
- 派发失败分类：网络、Agent 启动等未知或可自愈错误为 `transient`，保持 queued 并按 30s 起、15min 封顶退避；用户 workspace 无可用模型、idle plan 无可用模型或双凭证缺失属于确定性 `permanent`，必须直接转 `failed`、记录原因并停止重试/重取号，由用户修复配置后重新提交。禁止把确定性配置错误伪装成长期“等待闲时算力”。

## 4. 当前服务端契约（D26/D39；客户端同时提供进程内 mock）

### 4.1 Coding Plan 支持矩阵与凭证真源（D40）

服务端静态契约已按 `zcode-server/main@ec2b18daa01b8e1b801f0691ac22153c2e56c6db` 复核
（2026-07-22）。`X-Coding-Plan-Api-Key` 在服务端是 opaque key：Coding Plan verifier 会按
JWT 登录 provider 分别走 ZAI / BigModel 校验，并校验套餐有效期及 key 所属用户；不会按客户端
provider id 分流，也不会把该 key 透传给闲时模型上游。

但 2026-07-22 test 环境 Team Plan 联调证明，静态 header 形状成立不等于依赖链已兼容：客户端已
正确解析并发送 Team 项目 runtime key，服务端 Coding Plan verifier 的 subscription 依赖仍以
`3101 coding plan is required` 拒绝该 key，随后被服务端包装成 `500/2007`。因此当前支持矩阵必须
区分“客户端凭证/传输已支持”和“测试后端端到端可用”：

| 当前 provider family / 选中连接                                                                             | Off-Peak 使用的 Coding Plan 凭证                                                  | 资格                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------- |
| ZAI + `coding-plan:builtin:zai-coding-plan`                                                                 | 选中 ZAI Coding Plan provider 的原始业务 API Key                                  | 支持                                      |
| BigModel + `coding-plan:builtin:bigmodel-coding-plan`                                                       | 选中 BigModel 个人 Coding Plan provider 的原始 API Key                            | 支持                                      |
| BigModel + 完整 `team-plan:builtin:bigmodel-coding-plan:<product>:<organization>:<project>`                 | 复用 Team Plan runtime-key resolver，按选中组织/项目取得 `${apiKey}.${secretKey}` | **客户端已支持；test 后端 verifier 阻塞** |
| ZAI / BigModel Start Plan                                                                                   | Start Plan 只有 zcode JWT，不是 Coding Plan API Key                               | **拒绝**                                  |
| API Key 模式、family/连接未选中、登录 provider 与所选 family 不一致、连接缺失/disabled/stale、畸形 Team key | 无与当前选择一致的 Coding Plan runtime credential                                 | **拒绝**                                  |

`providerFamilyDomain`、family mode 与 `modelProviderFamilySelectedKeys` 是执行选择真源。禁止扫描所有
缓存 provider 后任选一把 key，也禁止在 Team Plan runtime key 失败时回退个人 BigModel key。
灰度配置只负责曝光；模型成员来自 Built-in `builtin:offpeak-idle-plan`。主页模板点击只回答“是否持有任一 Coding Plan”：此处按
provider 快照中的套餐种类与系统禁用状态判断，不要求先选 provider；进入创建表单后，提交资格仍由
同一 resolver 的脱敏 selected-connection support snapshot 决定，未选 family/connection 时禁止提交。

跨进程凭证/状态流如下（凭证只在 host/service 内存中，脱敏 support 才能过 RPC）：

```text
settingService
  providerFamilyDomain + family mode + selected connection key
                    |
                    v
        exact connection classifier
          | ZAI personal -> selected ZAI provider apiKey
          | Big personal -> selected BigModel provider apiKey
          ` Team        -> selected org/project + existing runtime-key resolver
                    |
credentialService --+--> OffPeakCredentialSnapshot
  active OAuth provider    { family, connection key/kind, jwt, codingPlanApiKey,
  zcode JWT                  organizationId?, projectId? }
                              |                 |                    |
                              |                 |                    `-> host dispatch
                              |                 |                        modelExecution.requestAuth
                              |                 |                        (auth + ticket + Team identity)
                              |                 `-> server client request snapshot
                              |                     availability/take/status/settle
                              |                     (auth + Team identity)
                              `-> sanitize -> IOffPeakTaskService RPC -> UI eligibility

client/configs gray enabled + support.supported + availability.canTakeNumber
                              |
                              `-> create entry enabled/locked
```

同一次 HTTP 请求或自动派发 turn 只解析一次 snapshot，再同时填充 JWT 与 Coding Plan key，避免
选中连接在两次独立读取之间切换而混用凭证。选择变化后下一次操作重新解析；秘密不写入 task、
SQLite、workspace catalog 或 renderer state。

BigModel Team 连接的新版 selected connection key 已同时包含 organizationId/projectId。五个
Off-Peak 端点必须从同一次 credential snapshot 注入
`bigmodel-organization` / `bigmodel-project`；两者均 trim 后非空才成对发送，禁止从 API Key
反查或只发送其中一项。ZAI、BigModel 个人套餐以及仅含 projectId 的旧版 Team key 不发送这两个
header，保持原有鉴权行为。

2026-07-22 test 运行时证据边界（凭证原文与指纹均不得写入客户端日志）：

```text
selected BigModel Team org/project
  -> Team project key prewarm status=existing
  -> selected credential snapshot kind=bigmodel-team
  -> GET /ticket/availability（JWT + 非空 Team key）
  -> server Coding Plan subscription verifier: 3101 coding plan is required
  -> server contract wrapper: HTTP 500 / code 2007

另一次 POST /ticket -> HTTP 429 + 空 body
                     -> 全局 HTTP 限流；不是 3103 取号额度
```

客户端不得为绕过该阻塞回退个人 BigModel key，否则会违背 selected connection 与套餐归属；后端需
让 verifier 接受 Team 项目 credential，或提供明确的 Team 资格校验分支。客户端只有看到明确
`429/3103 + next_take_at` 才展示额度耗尽；`500/2007` 与无业务码的裸 `429` 统一按暂时不可用展示，
同时在 service 日志保留不含秘密的 credential kind、HTTP/code 与 request id，供后端关联。

```http
# 0. 鉴权：Bearer JWT + 原始 Coding Plan API Key（服务端两级校验：登录 + coding plan 资格）
Authorization: Bearer <zcode-jwt>
X-Coding-Plan-Api-Key: <coding-plan-api-key>
# BigModel Team 额外携带当前选中连接的身份（五个端点一致；必须成对）
bigmodel-organization: <organizationId>
bigmodel-project: <projectId>

# 任务生命周期五接口（D39，前缀 /api/v1/off-peak）：额度快照 → 取号 → 批量查状态 → 调模型 → 结算
# 0. 查询新 ticket 可用性（只读快照；真实取号仍是最终权威）
GET /ticket/availability       → { can_take_number:true } | { can_take_number:false, next_take_at:<unix-ms> }
# 1. 取号（客户端提交 task_id，服务端返回 Snowflake ticket_id；同 task_id 过期后可重新取号）
POST /ticket                 { task_id } → { ticket_id, state, position, next_poll_after, ... } | 429/3103
# 2. 批量查状态（用 ticket_id；有非终态任务才轮，间隔按 next_poll_after；客户端只观察服务端已推进状态）
POST /ticket/status          { ticket_ids:[…≤100] } → { next_poll_after, tickets:[{ticket_id,state,position,active_deadline}] }
#    state: queued|ready|active|expired|settled|not_found；ready 写成本地 schedulable
#    本地 running 在 sendPrompt ACK 后写入，可能早于服务端 active
# 3. 调模型（= Anthropic /messages；ready 后 5min 内发首个即准入 active）
POST /anthropic/v1/messages  # 头 +X-Off-Peak-Ticket-ID: <ticket_id>，body 原生 Anthropic
#    429/3105 模型并发满→带 Retry-After，按 D24 min(Retry-After,5min) 退避；400/3102 ticket 不可用→触发续跑；400/3006 模型不在白名单；429/3103 取号超限→data.next_take_at + 刷新额度快照
# 4. 结算（客户端统一带双凭证；服务端当前只校验 JWT；无 body）
POST /ticket/:ticket_id/settle → { ticket_id, state:settled, settled_at }

# 5. 灰度配置（共用 client 配置接口，非本特性新开，零新增请求，Authorization 可选）
GET /api/v1/client/configs   → data.configs.offPeak: { enable_offpeak_task }
#    enable===true 时开放入口；模型列表来自 Built-in builtin:offpeak-idle-plan，准入以服务端校验为最终依据（3006 兜底）
#    额度（D39）：不再经 client/configs 下发；客户端通过 /ticket/availability 控制前置置灰。
```

### 取号额度口径（服务端 off_peak_design.md，权威）

- 服务端内部配置 `take_number.{window, limit}` 不再下发客户端；客户端只消费 availability 的 `can_take_number` 与 `next_take_at`，**实际取号仍是最终准入依据**（超限 429/3103）。
- 计数依据 = 该用户 `off_peak_tickets.created_at`；**每次成功创建 ticket 计一次**；同用户同 `task_id` 幂等提交不重复计数。
- 幂等免计**只在最新 ticket 未过期时成立**：最新 ticket 已 expired → 重新取号新建 ticket，**计入额度**。settle / ready 过期 / active 到期**均不返还**已占用名额；ticket 创建时间移出滚动窗口后名额自动恢复。
- availability 额度已满 → HTTP 200，`can_take_number=false` + `next_take_at`（Unix 毫秒）；到点重新查询。
- 实际取号超限 → `HTTP 429 + code 3103 + data.next_take_at`；查询与取号之间的并发竞态由该响应兜底。
- availability 查询失败、加载中或结果未知时均禁入；下一次成功刷新返回 `can_take_number=true`
  后恢复。灰度曝光只读取 `enable_offpeak_task === true`；Built-in 模型列表为空时表单不可提交。

## 5. UI 清单（Figma「自动化 & 闲时任务」页为唯一真源；改 packages/ui 前先读 DESIGN.md）

> **New task 首页临时覆盖口径（2026-08-20）**：当前不挂载 `OffPeakNewTaskEntry`，首页不展示
> 闲时任务横幅和模板按钮。组件实现、单元测试及下表中的首页布局/预填契约保留备用；下表所有
> “New task 首页入口当前可见”的旧描述均由本条覆盖，恢复挂载前必须重新确认产品边界。

| 模块               | 口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 灰度门控（D31）    | 有效开启 = `configs.offPeak.enable_offpeak_task===true`；模型成员来自 Built-in `builtin:offpeak-idle-plan`，为空时表单不可提交。未命中 → 仅 Idle-time tab、闲时创建按钮、闲时模板卡与闲时侧栏分组不渲染，Scheduled tasks 及已有定时任务不受影响；「非 coding plan 置灰锁」只在灰度命中后生效；中途关闭 → 只藏闲时创建入口，非终态闲时存量仍展示并跑到终态，无闲时存量则隐藏闲时入口                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Automations 主视图 | scheduled 与 idle 均为空时隐藏无筛选价值的 Tabs，使用 Figma 大空卡；有任务后展示 Scheduled tasks / Idle-time task 两个 tab（D47 移除 All 混排总览；灰度未命中且无闲时存量时只剩 Scheduled 单 tab，action row 仍承载刷新与创建入口）。页头使用 `text-ui-lg` 主标题与 `text-ui-base` 辅助说明建立层级，禁止用任意字号绕过 DESIGN.md。列表态 action row 同时承载 Scheduled 与 Idle 创建入口：未选中的 tab 默认透明，仅在 hover 或选中时显示背景；`Create via chat` 使用描边次按钮，`Idle-time task` 使用主按钮。keep-awake 横幅是全局开关（镜像设置页「常规」），Scheduled / Idle 两个 tab 都展示：列表态位于任务卡之前，空态保持大空卡在前、横幅在后。不设跨类型混排栅格，两类卡片只在各自 tab 内保持独立列表语义。 顶栏 tab 下方（当前 tab 有任务时）展示一行状态筛选胶囊「全部 / 进行中 / 已完成 / 失败」，Scheduled 与 Idle 共用同一组：闲时 queued/paused/running 归进行中、failed/cancelled 归失败；定时以卡片是否展示失败徽章（`hasAutomationFailureState`）判失败，其余按 lifecycle 归组。筛选默认全部、不持久化、切换顶栏 tab 即回到全部、不显示计数；筛选命中 0 条时展示「没有符合条件的任务」，不复用「还没有任务」空态。两类列表都在筛选后超过 8 张卡片时由 grid 自身滚动（`max-h-[1198px] lg:max-h-[606px]`），阈值按筛选后的数量计算。Idle 模板与 Scheduled 模板使用 Client Scenes 当前目录和两列栅格。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 创建资格           | 主页模板导航门与真正创建门分离：主页只要 provider 快照中存在任一未被系统判定失效的 ZAI 个人 Coding Plan、BigModel 个人 Coding Plan 或 BigModel Team Plan 即可进入表单，不要求预先选择 provider；确实不存在任何 Coding Plan 时模板保持正常视觉，点击弹可关闭的订阅 Toast，Upgrade 打开现有升级弹窗。两个闲时 Upgrade 入口都归并到 `coding_plan_upgrade_ck`，固定使用 `eventRegion=app.session`、`upgrade_source=session_idle_time`，并创建贯穿 product/cycle/pay/result 的 `purchase_funnel_id`；购买面板内触发 OAuth 时不得丢失 funnel ID 或来源。表单提交、Automations 创建入口、票据请求和 runtime 仍共用 selected-connection support snapshot；Start Plan/API Key 模式/family 或连接未选中/登录 provider 身份不一致/disabled/stale 连接均禁止提交并显示 Tooltip。创建准入 fail-closed：只有 availability 成功返回 `can_take_number=true` 才放行；返回 false、加载中、未知、网络错误或临时依赖异常均置灰禁入。false 的 Tooltip 将 `next_take_at - 当前时刻` 向上取整到分钟，以本地化的小时/分钟剩余时长展示，不展示年月日或绝对时刻；等待期间按分钟更新，到点重查，异常可手动刷新；实际取号仍兜住查询后的并发竞态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 创建表单（整页）   | 创建态页头为 New Idle-time task，默认 title=Untitled；该默认值在用户尚未编辑且不是模板预填时跟随 locale 更新，用户输入、模板草稿和已保存标题不自动翻译。Instructions 示例按 locale 提供。Project 只列当前窗口已打开且可用的本地项目，不列 recent/remote；创建后项目不可修改。权限四档默认 Ask before changes，第一次以非 Full access 提交时显示一次警告但同一次点击继续创建，不做二次确认；Instructions 下方的无人值守提示使用 `text-ui-sm`（默认 `12px`）。创建表单不展示闲时排队说明、免费频次或“最早可用时段”只读卡，表单内容直接从任务标题开始。模型走 Built-in `builtin:offpeak-idle-plan.models`，能力与推理档位走 Effective Model Config，keep-awake 仅镜像全局设置且创建不修改它。长标题在页头单行截断，不得挤压返回按钮与 keep-awake 控件；桌面页头按“返回/标题 → 16px 间距 → 12px 竖分隔线 → 16px 间距 → keep-awake”内联排列，禁止把 keep-awake 推到容器最右侧；窄屏允许整个控件组安全换行。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 列表卡片           | 位次徽章 `#N in queue` / `#N Paused`（**无 Est.**）；queued 与 paused 均使用闲时任务专用紫色弱强调胶囊，禁止复用会在 Zai Dark 变成白色的 `brand`；Zai Light 前景/背景为 `#9E77ED / #F5F3FF`，Zai Dark 为 `#7B5CE5 / #160D38`。定时任务调度 Tag 继续使用绿色 `success` 语义，以建立闲时紫色、定时绿色的类型区分。queued 使用月亮图标，paused 无论是否保留位次都使用圆形停止图标，running/completed/failed 分别使用 spinner/完成/警告语义图标。终态卡片底部只展示状态，不追加 `filesChanged` 数量；该字段继续保留用于持久化、通知等非卡片场景。菜单 queued=Pause/Delete、paused=Continue/Delete、running=Cancel；Pause 行尾保留信息图标与悬浮 Tooltip，英文文案为 `Tasks paused beyond the queue wait time will be placed back in the queue`，中文文案为`暂停时长超过队列等待时限的任务，将会被重新放回队列。`；选择 Pause 后直接执行，不再弹二次确认。Delete 确认的中文固定为标题「删除此闲时任务？」、正文「此操作无法撤销。如果任务当前正在排队或运行中，将立即停止。」、操作「取消 / 删除闲时任务」；英文对应为标题 `Delete this idle-time task?`、正文 `This action can't be undone. If the task is currently queued or running, it will stop immediately.`、操作 `Cancel / Delete idle-time task`。该确认文案不插入用户任务标题，避免长标题挤占风险说明。列表只按 `createdAt` 倒序排列，不按状态分组，任务状态变化不得改变卡片位置；终态卡保留可 Delete 不自动清理。 脚注一行内状态徽章（含失败态旁的位次徽章）不可收缩（`shrink-0`），只有右侧「运行会话：{title}」允许 truncate，长会话标题不得把状态文字裁成单字。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| History tab        | 一次性 task 只有 0/1 行：无 `startedAt` 或已有 `historyDeletedAt` 时为空；running=`In progress`，completed=`Succeeded`，failed=`Failure`，启动后的 cancelled=`Skipped`。首列显示截断 prompt；行菜单为 Go to session（有 session 时）/ Delete history。桌面行菜单宽 160px、圆角 10px、上下内边距 6px，两项之间保留 1px 分隔线；菜单以触发按钮左边缘向左偏移 10px 展开，而非右边缘对齐，窄屏仍由浮层碰撞检测约束在视口内。Delete history 立即写 `historyDeletedAt`，无确认/Undo，不删除 task、session 或执行字段。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 模板               | New task 页与 Automations 共用 `clientScenesService.list()` 响应中 `off-peak-task.options.prompts.items` 的远程目录；标题取当前语言 `labels`，仅 New task 首页卡片描述按当前语言优先取 `descs`、缺失或空白时回退 `contents`，Automations 卡片描述与预填 instructions 继续取当前语言 `contents`，两种语言标题均为空的模板直接拒绝。点击时把配置值复制成普通用户草稿，只打开表单，不创建、不取号、不发送；进入表单后 locale 切换、Client Scenes 重取或后台刷新均不得覆盖用户编辑。Client Scenes 失败不得阻断 Automations 的手动创建；Automations 当前可见的闲时 / 定时模板区在目录加载期间分别显示默认 4 张骨架卡（桌面双列两行，手机单列自然排列），请求成功、业务失败或网络失败后结束骨架态；对应远程目录为空时展示本地化的「无可用模板」。Automations 的闲时模板区只展示远程目录，不注入本地 Customize。New task 首页模板区独立使用固定选择规则：过滤远程 Customize，按远程原始顺序最多取前两条可用普通模板，再把唯一的本地 Customize 空白入口固定追加为最后一项；无可用远程普通模板时只展示本地 Customize。服务端 scene/item/default 元数据不进入 off-peak 持久化，任务只保存用户确认后的最终表单字段。New task 首页闲时入口不再挂在 Chat composer 正下方，而是常驻草稿页**底部固定区域**，与页面底部保持 `38px` 间距，并且不随会话内容滚动；闲时入口的横幅行与模板按钮之间固定保留 `12px` 垂直间距。横幅的喇叭图标与主文案作为一个整体**水平居中**，主文案必须完整展示，禁止省略号截断；括号内的两项资格说明移到 Tooltip，完整主文案区域作为 hover 与 keyboard focus 触发区，不额外展示提示图标，也不使用带问号的 `cursor-help`，保持普通箭头光标。窄宽度下主文案允许自然换行。模板按钮使用**单行多列横向排列**：桌面为等宽三列，按钮容器使用 `780px` 上限并配合 `w-full` 收缩，列间保留 `16px` 间距；窄屏无法安全容纳三列时切换为单列，避免中英文文案和点击区域被压缩。模板描述最多展示 2 行且禁止固定行高，由同一栅格行内最高内容统一拉伸卡片高度。不得保留自动切换、拖拽、圆点指示器或其他轮播交互。横幅右侧的关闭按钮本轮设计暂不提供，实现与 i18n 保留但不可见，`newTaskBannerDismissed` 语义不变。New task 首页按“任一 Coding Plan”判断导航，无套餐时点击走 Upgrade Toast；有套餐但尚未选 provider 时允许进入表单，由表单 selected-connection 门禁继续禁止提交；灰度门控、Coding Plan 判定、Upgrade Toast、草稿预填与 `session_idle_time` 埋点在布局合并后完全不变。 |
| 侧栏               | Group 视图系统分组「Idle-time tasks」= tasks-index 真实系统分组（D48-A：`OFF_PEAK_DEFAULT_GROUP_ID`，与 cron 分组同构；Project 视图不出现独立系统分组；完整契约见 §5.1）。组内成员 = **已派发过的闲时会话**（与 cron 组只装运行产物同构）；排队/暂停任务派发前不上侧栏，只在 Automations 主视图管理（作用域同 grouped 视图：只显示已打开项目）。行尾按 task meta `offPeakTaskId` 展示月亮标识与 `updatedAt` 相对时间，不展示位次徽章；行点击进 session 对话。折叠、收起全部、组内拖拽、整组拖动、置顶全部走 grouped 原生管线并随其持久化。行关闭 = 归档（无确认弹窗）；删除/取消入口在 Automations 卡片菜单。组头「+」打开 Automations。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 编辑               | queued/paused 全字段可编辑；running 起锁定（仅取消）；终态只读；丢弃草稿弹窗与 scheduled 共用 Automation confirmation presentation：桌面宽 448px、最小高 180px。中文固定为标题「丢弃闲时任务的草稿？」、正文「你对当前闲时任务的更改将会丢失。」、操作「取消 / 丢弃」；英文对应为标题 `Discard Idle-time task draft?`、正文 `Your changes to the current idle-time task will be lost.`、操作 `Cancel / Discard`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 通知               | Off-Peak 聚合只发完成/失败通知；permission/elicitation 等确认通知由普通 session 通知链路负责，避免同一请求重复通知。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 多端               | 手机 `/remote` 完全隐藏 Automations 导航与路由，陈旧路由回退聊天；桌面远程 workspace 隐藏 Idle-time。Scheduled 与 Idle-time 新建均只允许本地项目；既有远程任务继续可见和管理。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

`OffPeakNewTaskEntry` 保留底部固定区的独立宽度约束，但当前不挂载到 New task 首页：横幅使用 `580px` 上限，三列模板按钮
使用原布局的 `780px` 上限；两者都配合 `w-full` 向窄屏收缩，不依赖
`@container/conversation` 断点做左右外扩。该宽度规则只作用于闲时入口自身，不得同步改变
composer、标题、Z 图标或全局组件。

Automations 主视图与备用的 New task 首页模板组件共享远程映射语义，但各自维护展示与 fallback 状态：
Automations 只展示完整远程目录；首页模板区过滤远程 Customize，按目录顺序最多取前两条普通远程模板，
再把本地 Customize 固定追加为最后一项。远程普通模板为空时，首页只展示本地 Customize。远程目录刷新只影响
尚未点击的模板卡。首页卡片描述按当前 locale 优先取 `descs`，缺失或空白时回退 `contents`；用户点击时
仍只把 `labels` / `contents` 物化到跨页草稿，之后由
`OffPeakEditView` 本地 state 接管。Custom 模板的空 `contents` 表示空白 instructions，不得回退成
其它模板 prompt。

Automations 主视图与 New task 首页中的闲时模板图标都把远程 prompt item 的 `img` 解释为
Lucide canonical 名称并按名动态加载，以 `16px` 展示；SVG 使用 `currentColor` 继承图标槽字色。
`img` 缺失、空白、名称不属于当前 Lucide 版本或模块加载失败时，Automations 继续按 item id 走
现有 Lucide 语义映射，首页继续回退既有 `Moon`。`imgs` 不参与闲时模板图标选择。本地 Customize
没有远程 `img`：Automations 保持 `SlidersHorizontal`，首页保持 `Moon` 回退。

备用 New task 首页组件恢复挂载时，与 Automations 的闲时模板和定时模板共用 renderer 内的 Client Scenes SWR 原始数据缓存。
同一 Service authority 并发挂载只请求一次，成功结果在 10 分钟 dedupe 窗口内复用且不轮询。冷缓存显示
Automations 骨架；热缓存立即展示 last-known-good 模板并后台重验，重验失败不得清空卡片或覆盖已物化的
表单草稿。Service/Host attachment 切换使用隔离 cache key；该内存缓存不进入 off-peak、automation、
session 或 localStorage 持久化。页面实际经历 `hidden -> visible` 时，当前 Service/cache authority 必须绕过
去重窗口强制重验一次；多个模板消费方合并请求，普通 focus、重复 visible 或首次 visible 不触发强制失效。

```text
useClientScenesResource(service authority)
        |
        +--> cold pending: Automations 当前可见模板区显示两行骨架
        +--> cache hit: 立即展示旧目录，必要时后台重验
        |
        v settled
off-peak-task 远程候选目录 ----+----> Automations 完整模板区 / 失败降级
                               `----> New task 前两条普通远程模板 + 本地 Customize
                                                   |
                                                   | 点击时复制当前语言值
                                                   v
                                           OffPeakEditView 本地草稿
                                                   |
                                                   `-- 用户确认/取号 --> OffPeakTaskService --> off-peak record
```

New task 首页横幅文案属于稳定产品口径，说明移入 Tooltip 后不保留中英文括号，并在 Tooltip 内单行完整展示：

- `zh-CN` 完整文案：订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放
  - 主文案：订阅用户新功能体验：创建“闲时任务”，我们将免费在算力富余时段为你完成指派任务。
  - Tooltip：`本功能不消耗订阅用户套餐额度、本功能仅面向订阅用户开放`
- `en-US` 完整文案：New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power. This feature does not consume your subscription plan quota and is available exclusively to subscribers.
  - 主文案：New feature for subscribers: Create "Idle-time task" , We will complete your assigned task for free during periods of surplus computing power.
  - Tooltip：`This feature does not consume your subscription plan quota and is available exclusively to subscribers.`

首页远程模板标题从当前 locale 的 Client Scenes `labels` 解析；描述按同语言 `descs` 优先、
`contents` 兜底，且最多展示 2 行；草稿指令始终从 `contents` 物化。禁止首页展示与跨页草稿使用
两套静态文案。仅保留本地 Customize
保底的 `offPeak.newTask.template.customize.title` / `.description` i18n key，并在渲染时通过
intl 解析；catalog 不得再保存一份 cn/en 文案。中文界面应同时展示并填入中文，英文界面应同时展示并填入英文；
进入创建页后草稿按普通用户输入处理，不因后续语言切换覆盖用户编辑。已删除的静态模板 locale key
不得继续保留，避免与 Client Scenes 远程目录形成第二事实源。

首页与 Automations 中的闲时模板描述共用中文短语换行规则：支持时使用
`word-break: auto-phrase`，并配合 `line-break: strict` 与 `text-wrap: pretty`，避免“简报”
等双字词被拆成孤立单字或标点落到行首；不支持短语换行的浏览器回退到正常断行，且不得使用
`keep-all` 导致窄屏溢出。

完成态卡片必须与定时任务保持一致的静态弱化层级：整张卡片使用 `opacity-60`，标题、描述、状态
和图标全部降级，完成状态使用 `text-foreground-subtle`，不得继续使用 success 高亮；hover 时保持
弱化透明度，但必须显示 `bg-hover` 背景反馈并露出可用操作。完成图标使用 Figma `4768:1998`
导出的本地 `square-check` SVG，保留 `16px` 尺寸和 `1.333px` 圆角描边，不得使用 Lucide
近似图标。该弱化只表达终态，不得给卡片或操作区增加禁用、`pointer-events-none` 等行为；
右上角「更多」仍可通过鼠标、键盘唤起，并保留终态任务的删除等可用操作。

创建/编辑页的返回操作与创建态提交按钮遵循 Figma `4970:2056`：分别使用设计稿中的
`arrow-left-sm` 与 `Full Stack-play` 原始矢量，保存为仓库内本地 SVG，不得继续使用 Lucide
近似图标。两者统一保留 `16px` 外层占位，glyph 几何和 `1.33px` 圆角描边按 Figma 原稿渲染；
图标颜色跟随所在控件的语义文本色，以兼容明暗主题和 hover / disabled 状态。Scheduled 与
Idle-time 创建/编辑页的返回文案统一使用 `text-ui-base`（默认 `14px`）与 `20px` 行高。
返回控件默认不显示背景，hover / keyboard focus 时使用 `bg-hover` 与主文字色，并保持
`rounded-lg` 点击区域；从首页模板 case 进入创建页时不得丢失该交互态。自动化页面共用的
switch 在 hover 时必须显示 `border-hover` 语义描边反馈，不能只有点击和 focus 状态。

任务卡操作菜单遵循 Figma `4579:913`：暂停动作使用 `stop-circle`，不得使用双竖线
`pause-circle`；编辑动作使用 `Full-stack-edit`，不得使用 Lucide `Pencil` 近似图标。两枚图标
均保存为仓库内本地 SVG，在 `16px` 图标占位内保持设计稿原始 glyph 尺寸，并通过 mask 继承
当前菜单文本色，以兼容 Zai Light、Zai Dark、hover 与 disabled 状态。

定时任务卡的「已暂停」状态遵循 Figma `4622:5289`：使用同源 `stop-circle` 描边矢量，
禁止回退为圆圈内实心方块；状态行保留 `20px` 图标占位，内部 glyph 为 `14.6667px`，
描边宽度为 `1.33333px`。图标继续通过 mask 继承状态语义色，保证明暗主题一致。

Automations 主视图的 Keep-awake 提示栏固定使用 `10px` 圆角，上、下、左内边距均为
`12px`；桌面断点不得把垂直内边距覆盖为 `0`。右侧开关继续保留 `12px` 安全间距。列表态
action row 与紧随其后的 Keep-awake 提示栏之间固定保留 `20px` 垂直间距。

当前 tab 同时展示至少一张真实任务卡与至少一个模板区时，两区之间遵循 Figma `4835:5515`：
插入全宽 `1px`、`bg-surface` 的分割线；分割线容器上下各保留 `8px`，并继续参与外层 `32px`
区块间距，使任务卡到线、线到模板标题的视觉间距均为 `40px`。任务卡或模板任一侧为空时不显示。

Automations 主视图有任务时，Scheduled tasks / Idle-time task 两个 tab 之间固定使用
`8px` 间距，复用设计系统 `gap-2`；右侧刷新与创建操作组中的相邻控件保持 `12px` 间距，
复用 `gap-3`。控件按 tab 条件隐藏时不额外占位。

该 action row 内的 tab 与创建按钮统一使用 `text-ui-base font-normal`（默认 `14px / 400`），
禁止按钮单独使用 `font-medium` 形成不一致的字重。Idle-time task 创建按钮为纯文本按钮，
不展示月亮或锁图标；禁用态使用 `bg-surface` +
`text-foreground-subtlest` 的实体灰色层级并保持 `opacity: 1`，禁止通过白色主按钮整体降透明度
模拟禁用。

History 无记录空态遵循 Figma `4866:3110`：保留 `226px` 最小高度、圆角边框和居中文案，
容器使用 `bg-background` 实体背景（Zai Dark 下解析为 `#161616`），避免 Electron 透明窗口的
原生材质透出；该背景规则只作用于无记录空态，不改变有记录表格的表头和行悬浮样式。

New task 页闲时模板横幅的图标遵循 Figma `4810:1407`：喇叭与关闭操作都使用
`32px` 外层占位，内部 glyph 固定为 `16px`，统一采用 `1.33333px` 圆角描边以及相同的颜色和
透明度。喇叭必须使用设计稿的 `announcement-03` 字形，关闭图标使用同一套 `x-close`
字形；禁止混用视觉重量不同的通用图标替代。提示文案作为一个连续的国际化文本节点渲染，
不得在标题与说明之间插入 flex `gap`；中文不增加空格，英文只保留语法所需的单个普通空格。
文案与两枚图标统一继承 `text-foreground-subtle` 和 `80%` 透明度，不允许 SVG 自带颜色与
文本透明度分别计算后产生色差。入口移至底部固定区后关闭操作暂不对用户可见，但上述关闭图标规格
与实现必须原样保留，方便产品重新放开时直接恢复展示。

侧栏视觉契约：Idle-time 系统分组复用 grouped task 中 Scheduled tasks 的共享展示样式，不得单独维护 header、计数徽章、纵向导线或任务行的 class。两者使用相同的标题行尺寸、紧跟标题的折叠箭头和 hover/focus 状态，并进入同一个系统分组纵向流；父级任务区的 section gap 不得插入两者之间，组间距只由共享 group container 控制。两者保留各自的语义颜色：Scheduled tasks 使用蓝色 Hash 标记与导线，Idle-time 使用紫色 Hash 标记与导线；D48 收敛后两者共用 grouped 视图同一数据源与折叠/排序管线（见 §5.1）。Idle-time 任务行沿用 Scheduled 的“标题在左、图标与相对时间在右”结构，行尾使用月亮图标标识闲时任务来源（按 task meta `offPeakTaskId` 判断），并复用 `formatTaskRelativeTime(updatedAt)` 展示时间；hover 时与 Scheduled 一样隐藏月亮/时间并展示 grouped 行原生 action。显示文件树打开该闲时任务所属 workspace；移动到顶部/组内拖拽经 grouped 原生排序管线持久化到 `task_group_members.sort_order`，不改 `queuedAt`、服务端 FIFO 或调度顺序；关闭即归档（D48 统一语义，见 §5.1），删除/取消入口在 Automations 卡片菜单。折叠仍由标题区域触发，新增入口及任务行 action 不得误触折叠或任务跳转。

**已砍入口**：composer 月亮开关（PRD 原案，范式作废）、对话中 429/额度耗尽 toast 引导。~~Create via chat 接入闲时~~ 已由 D49 恢复为会话内创建工具，契约见 §5.2。

### 5.1 侧栏一等行收敛契约（D48-A，取代虚拟 id 折叠与 renderer 排序机制）

闲时侧栏分组自 D48 起收敛为 tasks-index 真实系统分组，完全复用 grouped 视图管线。
2026-07-28 早间落地的虚拟分组 id（`zcode-off-peak-sidebar-group`）、
`zcode-off-peak-sidebar-order` localStorage 排序、组内独立 DndContext 与
off-peak session 投影去重（`off-peak-session-projection`）随之整体退役；本地折叠/
排序偏好接受重置、不做迁移（该机制未随正式版发布）。

一等行（照抄 cron 四件套）：

- task meta 持久字段 `offPeakTaskId`：类型 + 运行时 schema、`createTask`/`resumeTask`
  入参、`syncTaskMeta` 标记保全（运行态 snapshot 不带标记，必须用已存值兜底）、首次获得
  标记时 `ensureOffPeakGroupMembership`（分组行 / 顶层排序 / 成员关系全部 INSERT OR
  IGNORE 幂等写入，绝不覆盖用户手动整理）。不复用 cron 的 `cronAutomationId`（D45：
  兄弟实体各用各的标记）。
- 系统分组 id `OFF_PEAK_DEFAULT_GROUP_ID` 定义在 shared，与 `CRON_DEFAULT_GROUP_ID`
  并列（此前"不进 shared"的边界前提是无真实 membership，D48 后前提消失）。
- 月亮标识为纯 meta 判断（`isOffPeakTask`），task row 不反查 off-peak store。
- 存量迁移：有 `sessionId` 的任务按 `off_peak_tasks.session_id` join 回填标记（MR1
  bootstrap 已做）+ 成员关系（本节新增，逐行 ensureOffPeakGroupMembership，幂等）。

远程 workspace 明确不在支持范围（闲时任务 v1 为桌面本地专属）：

- 派发路径只面向本地 workspace，远程会话不会获得 `offPeakTaskId`；远程 grouped 视图
  不出现 Idle-time 系统分组。
- 归组写入对远程 identity 直接跳过（`ensureOffPeakGroupMembership` 守卫）；bootstrap
  成员关系回填同样跳过 `workspace_key` 为远端 identity 的存量行——历史行的
  `workspace_identity` 列可能缺失，若用 `workspacePath` 重算 key 会把成员关系串写到
  同路径本地 workspace（review CR-01）。

排队/暂停可见性（D48-A，取代 grill 初版的幻影行选型）：

- **组内成员 = 已派发过的会话**，与 cron 组只装运行产物完全同构；排队/暂停任务派发前
  不产生 tasks-index 行、不上侧栏，Automations 主视图是唯一队列管理面。
- `sessionId` / `conversationId` 保持首跑回填语义（"存在 = 已跑过"被 History
  Go-to-session 门控、卡片入口等多处依赖，禁止预填）。

照抄 cron 的行为（明确接受，不做特判）：

- 作用域 = grouped 视图的已打开 workspace scope（Automations 主视图仍是全局队列面）。
- 成员关系松散：闲时行可被拖出组、普通 session 可被拖入组；标记跟行不跟组，拖出不丢
  月亮身份，ensureMembership 的 OR IGNORE 不会把它拖回。
- 组内排序：默认最新在前；手动排序后新条目按缺序补尾落组底。
- 空组常驻：会话全部删光/归档后空组保留，组头「+」作为闲时入口（组在首次产生闲时会话
  前不存在，从未用过闲时的用户不会看到空组）。
- 组头禁改名、禁解散；颜色可改（`isOffPeakGroup`，机制同 `isCronGroup`）。

唯一不照抄：组头「+」打开 Automations 主视图（cron 的「+」创建组内普通草稿，对闲时是
语义错误——草稿不是闲时任务）。

明确不做：成员关系封闭守卫、行尾位次徽章、收敛加临时功能开关、本地折叠/排序偏好迁移。

**暂缓（deferred）：幻影行方案。** 若未来有真实用户信号要求排队/暂停任务侧栏可见，再启用
"创建时预分配 sessionId 写行 + 全面抑制"的增量扩展（协议已支持带 id 建会话）。当时评审
记录的代价：抑制无单点 chokepoint（taskIndexItems 同时喂 grouped 与平铺列表）、
`sessionId` 预填破坏"存在=已跑过"的隐含契约（History/卡片等多处依赖）、"有行无会话"
成为全系统三态不变量。A→幻影行是纯增量升级，不返工。

### 5.2 会话内创建（D49，v2 新增）

用户在任意会话里用自然语言创建闲时任务，与定时任务 `CronCreate` 范式对齐；底层与表单创建
走同一 `OffPeakTaskService.createTask`（创建即取号、fail-closed，服务端 3103 为最终权威）。

**工具面**（agent tools，经 zcode-protocol `offPeak/create` / `offPeak/list` 桥到 host）：

| 工具            | 参数                                                                | 说明                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OffPeakCreate` | `title`/`prompt` 必填；`permissionMode`/`model`/`thoughtLevel` 可选 | 缺省 = **yolo（全自动）/ `allowed_models` 最后一个 / 推理最高档**（与表单缺省有意分叉，理由见 D49-4）；缺省解析在 host 端；model 入参时预校 allowed_models。`needsApproval: true`。**D50：始终绑定当前会话**（端口填 `boundSessionId`），派发时 resume 本会话执行任务原 prompt；本会话已有未终态闲时任务时拒绝再建。 |
| `OffPeakList`   | 无参数                                                              | 只读，返回当前 workspace 闲时任务最小字段（id/title/status/位次/时间/sessionId?），供 agent 回答任务状态。                                                                                                                                                                                                           |

**turn 边界**：

```text
普通用户 turn ──────────── OffPeakCreate ✅  OffPeakList ✅
cron automation 自动 turn ─ OffPeakCreate ✅（D49-3 组合玩法） OffPeakList ✅
闲时自动派发 turn ───────── OffPeakCreate ❌ SendMessage ❌ Workflow ❌（D52，denylist ["CronCreate","OffPeakCreate","SendMessage","Workflow"]） OffPeakList ✅
subagent_child ──────────── 均不注册
```

**工具注册与调用准入（3.12.2）**：本地 Host 依据服务装配与工作区支持条件同步
`workspace/updateOffPeakToolPolicy`，并保留 legacy/V4 create/resume 的同源 flag。该判断不读取
灰度、套餐或模型目录；灰度未知/关闭时本地会话仍注册工具。纯 CLI、远程 workspace、
子 Agent 维持现有不注册边界。OffPeakCreate 实际调用进入 Host handler 后，才读取当前灰度与
套餐、模型信息，通过后创建与取号；失败无创建副作用。OffPeakList 保持 workspace 隔离的本地查询。
页面入口仍遵循 D31；idle turn denylist、审批、绑定守卫和服务端最终准入不变。

**轮尾卡片**：回复完成后在助手正文之后渲染静态卡（cron `CronCreateAutomationCard` 同款
管线）：月亮图标 + 任务标题 + 创建时位次快照（`#N in queue`）+「去到闲时任务」按钮。
不订阅后续状态。按钮与卡片主点击 → `onOpenAutomationsMain(offPeakTaskId, "idle")` →
Automations idle tab 按 `offpeak-` 前缀分流解析 → `offpeak-edit` 视图（queued/paused 可编辑，
running/终态沿用 readOnly 只读，D30-7）；任务已删除时 toast targetNotFound。

**绑定会话运行（D50）**：任务在创建它的会话里执行。派发前先探测会话是否正在跑用户 turn，忙则
transient 退避重试且不改任何会话配置；派发写入的权限模式（缺省 yolo）任务结束后不回滚；用户在任务轮
点 Stop = 取消任务（票作废）；绑定会话被删除 = permanent 失败。Automations 卡片脚注与编辑页展示绑定
会话标题（`sessionTitle`，list 时联查 tasks-index），编辑页附 Stop 即取消提示。表单创建仍新建独立 session。

**不做**：会话内 update/cancel 工具；会话标题冻结（不照抄 CronCreate 的
setCustomSessionTitle）；卡片活状态订阅；本地额度计数；绑定/独立会话开关；任务结束后权限模式回滚。

## 6. 复用点速查（feat/cron 基建）

| 复用                                          | 位置                                                           |
| --------------------------------------------- | -------------------------------------------------------------- |
| scheduler utility process + 事务认领模式      | `packages/desktop/src/scheduler/`                              |
| tasks-index.sqlite + Repo 模式                | `packages/services/src/session/automationRepo.ts` 仿写         |
| dispatch→main→host→createTask/sendPrompt 管道 | `desktopCronScheduler.ts` / host 域                            |
| 权限模式                                      | `ZCodeTaskMode` 现有 `bypassPermissions` / `default`，无新模式 |
| 敏感操作确认                                  | 现有 permission_request / elicitation 链路                     |
| 通知                                          | `desktopNotifications.ts`                                      |
| 内置不可见 provider                           | Start plan 机制（provider 注入路径核对后复用）                 |

## 7. 明确不做（v1 砍掉清单——需与产品对齐）

- 余额守护整章：余额校验/实时查扣/¥0.50 停止/充值引导（无"余额"概念，D1）
- window_paused 状态、窗口结束快照续跑、"已消耗 N 次窗口"、窗口结束三选一通知（D3）
- "期望完成时间"三档选择 + 到期"切即时"提醒（D14，只剩只读预计开始时间）
- tier 配额 lite:1/pro:2/Max:3（D6，服务端统一个数上限）
- 文件系统沙盒（D8，文案改"自动批准所有操作"）
- 自动 git 基线（D8，保留"建议先 commit"警示）
- 精确 ETA（"22:07"式）与排队时长测算
- 手机端展示、发起或远程批准（D37：`/remote` 完全隐藏 Automations）
- 自动 powerSaveBlocker 联动（D4，手动开关）
- 排队超时/任务过期机制（持续满载时无限等待，出口 = 取消 / Pause）
- Est. 预计等待展示、任务自动清理、Run again 重跑、对话内引导入口（429/额度 toast，D29/D30 砍）；原一并砍掉的 Create via chat 已由 D49 恢复为会话内创建工具（§5.2）
- 「立即执行」出队入口（D32，以 Figma/D30 卡片菜单为准；想马上跑 = 取消后自己开对话）
- Off-Peak 专用 `awaiting_approval` 状态、Review 卡片动作和等确认通知；确认交互只走普通 session，聚合状态保持 running
- 批准后在当前 turn 中切用户 provider / “将使用套餐配额”提示（D11/D27 历史意图未采纳）
- 详情页"消耗算力/剩余算力"字段

## 8. 待验证项（实现前）

> 2026-07-15 spike 已全部完成，结论详见 `tech-design.md` §11；本清单只留判定。

1. ~~session 中途切换 provider~~ ✅ 成立：`session/updateRuntimeModelConfig` 对 live session 下一次模型请求生效（须 `applyModelSelection: true`）。
2. ~~session resume + 续跑的 agent runtime 能力~~ ✅ 成立：冷恢复从会话库水合历史，新进程内先 resume 再 sendPrompt（中断恢复的 resume 提示词策略仍实现时定）。
3. ~~Start plan provider 注入路径核对~~ ✅ 成立：`applyStartPlanCredentialApiKey` 即形态模板（JWT 当 provider apiKey）；原始 Coding Plan Key host 域可读。开工时据此形成 D33 的 per-turn Runtime Model 方案；Provider Refactor M4 已保留其“单次执行、零持久化”产品不变量，并把实现替换为隐藏 Built-in Provider + 标准 Model Selection + `modelExecution.requestAuth`。
4. ~~重试/退避基建核对~~ ⚠ 可承载但非纯复用：需新增 retry reason `offpeak_queued`、429+3105 映射、三处 retry loop 绕过预算 + 新写 min(Retry-After, 5min) 钳制（现有 5min 是拒绝阈值非钳制）。
5. ~~client/configs 拉取时机核对~~ ⚠ 通道成立：走 coding plan subscription provider 的 getClientConfigs（1h 缓存），"零新增请求"网络侧准确；入口打开强刷需加 force 参数，灰度翻转最长 1h 不可见；端点现不带 Authorization（tech-design §7.8-⑤）。
6. 服务端排期——客户端按 §4 契约 mock 开工。

## Todo128 更新：资格刷新一致性（2026-09-11）

创建资格继续遵守既有灰度、当前连接、权益、凭据与取号额度规则。启动只等待就绪，Host
闲时凭据解析每次显式读当前 Registry，不使用首次启动返回值。初始化、连接变化、Registry
已完成通知、手动刷新和额度恢复重查统一通过 Store 的串行检查；两入口相同通知去重。

```text
初始化/连接变化/Registry 完成通知/手动刷新
  → 旧资格失效 → 串行检查当前资格 → 必要时查额度 → 同代原子发布
               在途收到变化 → 丢弃旧成功/错误，合并检查最新代
```

查询失败或未知继续禁入；不把旧资格与新额度拼接。Provider 更新不修改表单草稿、已绑定
Ticket 或执行中的模型。不新增轮询、不扩大手机/远程闲时支持，也不恢复当前未挂载的首页
入口。具体影响面与 S1–Q5 验收见 [Todo128 影响面](../working-memory/provider-refactor/steps/todo-128-impact-and-cases.md)。
