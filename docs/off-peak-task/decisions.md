# 闲时任务 · 决策记录（ADR 滚动式）

> **状态：历史 ADR，功能已实现。** 本文按时间保留 D1–D44 的方案演进，早期条目不会回写成
> 最终方案；“已定”只表示当时结论。当前行为以 `spec.md`、`tech-design.md`、
> `implementation-notes.md` 和代码为准，Scheduled Automation 仍是独立领域。

> grilling 会话产出。每条决策：背景 → 选项 → 结论。OPEN = 未定案。

### 当前代码阅读索引（2026-07-23）

- 服务端接口以 D26/D39 为准：`availability → POST /ticket → POST /ticket/status → messages → settle`；D25 的 register/per-task GET 是历史形状。
- 票据失效正式码是 `400/3102`；`3001` 只保留在 adapter 的滚动发布兼容与历史说明中。
- 创建额度以 D39 availability 快照 + `POST /ticket` 的 3103 为准；D36 的
  `limit.max_tasks/sliding_window` 和本地 createdAt 计数已从最终客户端删除。
- D44 已明确不采纳 D11/D27 的 Off-Peak 专用批准状态机：permission/elicitation 只走普通
  session，聚合状态保持 `running`，同一自动 turn 继续使用 idle-plan overlay。
- D33 per-turn overlay 已实现；自动 turn 忙碌时补发的用户 prompt 会在恢复用户常驻模型后 drain。

## D1 计费模型（已定 2026-07-09）

**结论：免费池。产品语境下不存在"余额"这个概念，余额守护整章作废，客户端零余额逻辑。** 创建时按等级配额鉴权（lite:1 / pro:2 / Max:3，具体语义见 D5）。

原始分析：

PRD 自相矛盾：前置定义说 v1 走免费池（codingplan+lite:1/pro:2/Max:3），v0.2 又新增整章 ¥0.50 余额守护，随后整章被划掉。现有 coding plan 是配额制（`GET /api/monitor/usage/quota/limit`，百分比），客户端没有任何 ¥ 余额 API。

- A（推荐）：v1 免费池 + 等级配额，余额守护整章不做，客户端零余额逻辑。
- B：免费池 + 只读展示余额。
- C：完整余额守护（需服务端新增余额 API + 每次调用后查扣）。

## D2 闲时窗口真源（已定 2026-07-09）

**结论：服务端下发窗口表，客户端只读缓存。窗口 API 就绪前不做精确 ETA，只显示"下个闲时窗口"级别的文案。**

> 已被 D21 取代（2026-07-10 文档评论共识）：不下发窗口表，客户端无窗口概念，改为轮询调度授权接口。

原始分析：

PRD 三种口径打架：maas 波峰 14-18 反推（→ 其余 20h 全是闲时，"今晚 22:07"叙事崩）/ 设置页 preset 22:00-06:00 / "跟 maas 保持一致，需验证"。

- A（推荐）：服务端下发窗口表（v1 可以是服务端配置硬编码），客户端只读缓存；无 API 前不做"预计开始时间"精确 ETA。
- B：客户端硬编码 preset。
- C：按 maas 波峰反推。

## D3 窗口边界语义（已定 2026-07-09）

**结论：准入门槛制。窗口只控制"何时允许启动"，开跑后跑到终态不打断。砍掉：window_paused 状态、"已消耗 N 次窗口"、窗口结束快照续跑、"窗口暂停"通知。**

原始分析：

"窗口结束未完成 → 暂停快照 → 下窗口续跑"章节已划掉，但 window_paused 状态、"已消耗 N 次窗口"、"不会因中断丢失进度"仍散落全文。硬边界 = 要解决 mid-run kill（正在跑的 bash 怎么办）+ session 快照续跑，是全 PRD 实现成本最高的一块。

- A（推荐）：准入门槛制——窗口只控制"何时允许启动"，开跑后跑到终态；砍 window_paused。
- B：硬边界制——窗口结束强制暂停 + 续跑（PRD 原文）。
- C：软边界——窗口结束后不再发起新 LLM 调用，收尾后暂停，下窗口续跑。

## D4 防休眠（已定 2026-07-09，低优先）

**结论：设置里提供一个手动"保持唤醒"开关，本期不做自动 powerSaveBlocker 联动，不深究。保留"保持插电"教育卡片。**

原始分析：

PRD 明确"不会阻止系统休眠"，只给设置卡片让用户自己关休眠。macOS 默认闲置即睡 → 22:00 窗口到点机器在睡，任务永远不跑，核心承诺不成立。Electron `powerSaveBlocker.start("prevent-app-suspension")` 一行可防闲置休眠（防不了合盖，插电+合盖建议仍保留）。现有 cron scheduler 对睡过的窗口是 skip 策略，闲时任务语义相反。

- A（推荐）：存在 queued/running 闲时任务期间开 powerSaveBlocker，设置可关。
- B：遵循 PRD 不阻止休眠（接受大概率首晚跑不成）。
- C：仅 running 期间防休眠（排队等待期睡了照样错过窗口）。

## D5 任务身份 = 对话上的延迟发送 + 排队锁定（已定 2026-07-09）

闲时任务不是独立实体，是"某个对话上的一次延迟发送"（可新对话、可续已有对话）。排队期间该对话 composer 锁定，只允许"取消 / 立即执行"，上下文不漂移。窗口到点在提交时的对话状态上执行（续已有对话 = resume 该 session 发送排队 prompt）。

## D6 配额：tier 作废，服务端限调度任务个数（已定 2026-07-09）

PRD 的 lite:1/pro:2/Max:3 和"每人最多 1 个/24h"全部作废。**服务端统一限制每用户已调度（非终态）任务个数**，具体数值是服务端策略，客户端只处理"创建被拒（已达上限）"。

> 修正见 D18：上限数值由服务端**下发**，客户端本地强制，不走 per-create 鉴权接口。

## D7 本地调度：严格串行（已定 2026-07-09）

窗口内本机按入队顺序一次只跑 1 个任务，跑完再下一个。不做 worktree 隔离（串行天然避免同 workspace 并发写）。跨 workspace 也串行（app 级单执行位）。

> 修正见 D18：排队逻辑归服务端；本机串行降级为「执行策略」——同一时刻仅尝试/执行 1 个，保留防同 workspace 并发写的效果，但它不是队列。
>
> 已被 D20 推翻：客户端不做任何并发限制，并发额度由服务端调度决定。

## D8 全自动 = bypassPermissions，不碰 git（已定 2026-07-09）

全自动映射现有 `bypassPermissions`，敏感暂停映射 default + 现有 permission_request 通知链路。不做文件系统沙盒，文案删"强制沙盒"改"自动批准所有操作"。不做自动 git 基线，保留 PRD"建议先 commit 干净版本"的警示文案，责任留给用户。

## D9 错过窗口 = 顺延不丢弃（已定，语义推论）

queued 任务在窗口内因 app 未开 / 机器休眠未被调度 → 保持 queued，自动等下个窗口，无需用户操作。注意：与现有 automation scheduler 的 misfire-skip（`MISFIRE_GRACE_MS` 记 skipped 不补跑）语义相反，闲时任务调度路径不能复用该策略。

> D21 后自然成立：无窗口可错过，恢复后只要还有 queued 任务就继续轮询与派发。

## D10 通知动作按钮 = macOS best-effort，主路径应用内（已定，工程事实）

Electron Notification 的 actions 仅 macOS 且需签名 + 用户通知样式为"提醒"才显示；banner 一闪而过。三按钮（批准/拒绝/取消）只作为 macOS 增强，**权威交互路径是应用内**（对话详情页顶部状态条 + 操作按钮），通知点击一律跳转对话。复用现有 `desktopNotifications.ts` 链路。

## D11 计费执行形态 = 闲时专属 Provider（idle plan）（2026-07-09 引入）

> **实现状态修正（2026-07-23）**：idle plan per-turn 注入已实现；本节关于 permission
> approval 后切用户 provider/套餐配额提示的派生规则未被最终代码采纳，已由 D44 明确砍掉。

"免费池"的落地形态：**闲时任务在窗口内执行时使用一个用户不可见的专属 provider（idle plan，类似 Start plan 机制）**。派生规则：

- 敏感暂停的任务被批准后**立即续跑**，但续跑**不允许使用 idle plan**，切换到用户自己的付费 provider。批准交互必须明示"继续将使用你自己的套餐配额"。
- queued 态"立即执行"同理：出队即用用户自己的 provider。
- 评论确认（2026-07-10）+ D27 精化：切用户 provider 的触发是「用户主动让它继续做事/接管」——批准执行敏感操作、立即执行、主动补 prompt；**拒绝并跳过 = 否决 + 继续无人值守 → 保持 idle plan**（D27）。切换均为纯客户端逻辑，服务端不感知。
- ⚠ 待验证：session 中途切换 provider 的现有机制（参考 chat-model-change-notice）能否覆盖续跑场景。
- （原 OPEN 已由 D15/D26 定案：active 3h 时间盒 + 自动续跑。）

## D12 侧栏"进行中"分组 = per-workspace 展示（已定 2026-07-09）

只聚合当前 workspace 的闲时任务，与 automation 主视图同栖。调度仍是 app 级全局串行（D7），展示与调度解耦。

## D13 多端边界 = 桌面发起，手机只读（已定 2026-07-09）

发起入口（月亮开关）与敏感批准仅桌面端；手机远控经现有 replayable 链路自然只读可见状态图标/分组，不做专门功能，不屏蔽。

## D14 "期望完成时间"字段重定义（已定 2026-07-09）

砍掉用户三档选择（下次窗口/24h/48h）及到期提醒。提交弹窗只展示**只读的"预计开始时间"= 服务端窗口表返回的下一个窗口；若提交时已处于窗口内，即为当前窗口 → 任务立即（轮到执行位时）开跑**。文案随之调整：月亮开关的价值主张是"闲时窗口执行"，不绑死"夜间"。

> D21 后进一步弱化：无窗口表可推算，提交弹窗与状态条改为"等待闲时算力执行"，不做任何开始时间承诺。

## D15 running 跨窗口结束 = 锁定 idle plan 到终态（已定 2026-07-09）

**结论：任务开跑即锁定 idle plan 直到终态，服务端按"窗口内启动的任务"整任务核销。** 对服务端的硬要求：idle plan 放行不能是"窗口外一刀切拒绝"，必须支持"窗口内启动的任务跑到终态"（宽限期或任务级标识），写入 API 契约。

> D19 补充：锁定到终态是 **provider 归属与放行保证**（不拒绝、不切换），不是免排队保证——任务内每次请求仍可能排队等待。
>
> **D26 修正（2026-07-14）**：服务端 active 硬顶 3h，并非「锁定到终态」。跨 3h = 同 task_id 重新取号 + resume 续跑（见 D26）。

原始分析：

D3 准入门槛制允许任务跑过窗口结束，D11 又规定 idle plan 仅窗口内可用，两者相撞：

- A（推荐）：开跑即锁定 idle plan 直到终态，服务端按"窗口内启动的任务"整任务核销，超窗溢出可控。
- B：窗口结束瞬间切到用户付费 provider 继续——用户睡着时开始烧自己的钱，不可接受，除非明示同意。
- C：窗口结束即停（回到硬边界，推翻 D3）。
  取决于服务端 idle plan 是否在窗口外直接拒绝请求。

## D16 idle plan 接入形态 = 复用 Start plan 机制（已定 2026-07-09）

内置不可见 provider，服务端窗口期放行（含 D15 的到终态宽限）。客户端复用 Start plan 式基建，不新增任务级临时凭证下发链路。

## D17 服务端现状 = 三件套全部新开（已确认 2026-07-09）

窗口表 / 创建鉴权+核销 / idle plan 放行，当前都不存在。客户端按 spec 中的 API 契约草案 mock 先行开工，契约拿去和服务端/产品对齐。

> 修正见 D18：三件套重构为「配置下发（窗口表+创建上限）/ 网关排队准入（response header 协议）/ idle plan 放行」；显式登记与终态核销是否需要，待服务端定。

## D18 排队归服务端，客户端只做尝试与应答处理（已定 2026-07-09，修正 D6/D7/D17）

用户澄清的真实架构：

- **服务端承载排队核心**：全局闲时任务池，跨用户 FIFO（先创建先排），服务端按资源空余安排一定并发的准入。
- **客户端不承载排队逻辑**，只做三件事：
  1. 创建：按服务端下发的任务数量上限本地限制提交（无 per-create 鉴权接口；多设备同账号超创建的兜底由服务端队列天然承担）。
  2. 窗口内：对本机最早的 queued 任务发起执行尝试，请求打向服务端。
  3. 处理排队 response header（排队中/放行/位置/重试间隔）：被告知排队 → 保持 queued（可展示队列位置）按 Retry-After/退避重试；放行 → running。
- ~~本机「严格串行」保留但降级为执行策略~~（已被 D20 推翻：客户端不限并发）。
- 副产品：PRD 里"前面还有 N 个任务"的排队位置展示，靠 header 位置字段变得真实可做（可选）。
- （原"待服务端定"均已定案：FIFO=前置登记 D25；终态核销=settle D22；running 中途排队 D19。）

## D19 任务内每请求皆可重排队，服务端尽力优先在跑任务（已定 2026-07-09）

任务准入后，**每一次模型请求都可能被服务端重新排队**；服务端尽最大努力做优先级排队，保证同一任务的 Agent loop 优先调度（新任务准入让位于在跑任务的续请求）。客户端实现口径：

- 排队 header 处理收敛到 **idle plan provider 适配层**（Retry-After + 退避重试），对 agent runtime 透明——loop 只感知"这次响应慢"。核对复用现有 `bigmodel-business-error-retry` 机制。
- 不新增状态机状态：任务保持 running；详情页状态条可临时展示"排队等待闲时资源（第 N 位）"。
- 排队等待**不计入**"API 连续失败"的 failed 判定，等待不设上限（无人值守场景等待免费）；仅真实错误才终态。
- 用户取消任务时中止等待中的重试循环。
- 评论补充（2026-07-10）：服务端优先队列的设计目标之一——**保证同一 session 的请求尽量连续跑完**，避免 loop 中途长时间饥饿。

## D20 并发由服务端控制，客户端不做本机串行（已定 2026-07-09，推翻 D7）

用户可以同时有多个闲时任务、多个并发运行；**给每个用户实际调度多少并发，由服务端决定**。客户端窗口内把所有 queued 任务按入队顺序全部发起，准入与并发额度全在网关（结合 D18/D19 的 header 协议）。

- 单任务派发仍是 single-flight（认领事务防同一任务重复派发），任务之间不设本地并发上限。
- 同 workspace 多任务并发写文件的风险，与用户手动同时跑多个对话完全一致（现状已允许），不新增 worktree 隔离。
- 评论确认（2026-07-10）：未来按套餐分层并发（如 Max Plan 3+ 并发）——服务端策略，客户端无感。

## D21 客户端无窗口概念：轮询调度授权取代窗口表（已定 2026-07-10，取代 D2 的窗口表形态）

来源：飞书文档评论区共识。客户端**不判断高峰/低峰、不存窗口表**：

- 仅当本机存在非终态闲时任务时，轮询服务端调度授权接口；**轮询间隔由接口下发，不写死**。
- 响应含 `canDispatch`（当前是否可派发）+ 间隔 + maxTasksPerUser；canDispatch=true 即发起派发（"提交"= 这一轮模型请求可以放行）。
- 弹性全在服务端：算力宽裕时可 24h 放行、新增算力充沛的小模型时可放宽策略——客户端无需发版。
- D3 准入门槛制精神保留：门槛从"时间窗口"变成"服务端授权"；running 之后依旧与授权无关（D15 锁定到终态）。
- UI 不再做任何开始时间承诺，文案统一"等待闲时算力执行"。

## D22 终态核销 = 显式 settle 上报 + 静默超时兜底（已定 2026-07-13）

原 7.6 待定项 2 定案。新增幂等接口 `POST /api/off-peak/tasks/{id}/settle`（status + endedAt），客户端 outbox 模式：终态即上报、`settled_at` 列记 ack、poll 周期捎带补报、host 启动扫描。服务端收到即移出等待队列/活跃集合、释放额度；静默超时回收保留作兜底。核销非计费动作，纯资源记账。设计细节见 tech-design §7.7。

## D23 宿主对话非终态全程锁定 + provider 绑定 run 作用域（已定 2026-07-13）

D5 只锁了 queued，本条补齐 running / awaiting_approval 的空档（"用户直接 prompt 这个 session 怎么办"）：

- **非终态全程锁定** composer，人工介入面收敛为状态对应按钮：queued「取消 / 立即执行」、running「取消任务」、awaiting_approval「批准 / 拒绝跳过 / 取消」。想直接对话的唯一路径 = 先取消（自动化终止、文件保留、解锁）——"接管 = 终止自动化"。
- 否决的备选：running 期间放开打字（人工消息排到任务后、切用户 provider）。同 session 免费/付费轮次交错对用户不可解释，且踩 desktop queued prompt 的语义边界，灵活性收益撑不起复杂度。
- **provider 绑定为 run 作用域**：idle plan 选择键仅随本次派发注入，不持久化到 session 配置；终态后对话自动回落用户自己的 provider——否则解锁后的第一句人工消息继续烧免费池，反向违反 D11。列入 MR3 验收标准。

## D24 长等待策略：短钳制 × 无限探测，核心靠 Retry-After（已定 2026-07-13）

服务端可能下发小时级 Retry-After，客户端从不长睡（2026-07-14 服务端确认 429 会返回 `Retry-After`；载体是 HTTP 429/3105，非自定义应答头）：

- **规则 1（首派弃派）**：queued 态首个请求 Retry-After > `max(10 分钟, 当前 pollInterval)` → 放弃本次派发，任务留在 queued 等下轮授权，不空挂 agent loop；重派发复用中断恢复的 resume 语义。
- **规则 2（单次钳制 × 无限探测）**：running 态单次等待 = `min(Retry-After, 5 分钟)`，无限次幂等探测（3h ≈ 36 次），资源提前空出即被下次探测捕获。钳制与 retry-after 解析复用 `bigmodel-business-error-retry` 既有逻辑；**预算豁免是新增开关**——新 retry reason `offpeak_queued` 绕开统一 retry budget（否则现状探四五次就 fail）。
- **规则 3**：UI 如实展示重试提示，取消/立即执行随时可用；取消 abort 等待定时器。
- **服务端两条义务**：小时级缺口用粗阀表达（schedulable=false + 长轮询间隔），勿 admit 后给小时级 Retry-After；排队应答必须在请求受理前返回（零模型副作用），SSE 流中途不得转排队。
- 实现落点：`apps/zcode-cli/packages/adapters/src/model/{failure-inspection,failure-classifier,runner-retry}.ts`，详见 tech-design §4.3。

## D25 服务端契约收敛为任务生命周期四接口（已定 2026-07-13，取代 D21 的全局 poll，定案 7.8-1）

> **历史接口形状，已被 D26 取代。** 下文的 `POST /register`、`GET /:taskId`、409 和
> `maxTasksPerUser` 只用于保留演进过程，不是当前客户端契约。

**取号 → 轮询 → 模型请求 → 结算**：

1. `POST /register`——创建任务时取号，服务端按注册顺序登记进全局 FIFO（**这就是前置登记，7.8 待定项 1 定案**：FIFO 序服务端记，queuedAt 伪造/多设备绕过均消除），并在此校验 maxTasksPerUser（超限 409）。
2. `GET /:taskId`——**替换 D21 全局 poll**：回 `status + schedulable + queuePosition + nextPollAfter`。schedulable=true ≡ 窗口开 + 排到了（粗阀，per-task）。
3. `POST /messages`——= /chat 调模型，schedulable 后发起。D19 细阀在此：running 保号、单次请求可限流退避（D24 短钳制×无限探测）。
4. `POST /:taskId/settle`——终态释放号/并发槽（D22 归入生命周期）。

连带：① 全局 `GET /poll` / `off_peak_poll_state` 单行表废弃，schedulable/queue_position/next_poll_at 落在 `off_peak_tasks` 行上（scheduler 跨进程读）；② 提交从"本地必成功"变为"register 往返可失败"（409/网络），UI 需失败态——D18"无 per-create 接口"随之作废；③ maxTasksPerUser 权威在 register 409，客户端本地计数仅用于按钮预判，多设备超限被服务端挡住；④ 并发控制 = 服务端决定同时翻多少任务 schedulable。

- 保留待议：register 与首个 messages 是否合并（当前取"轮询到 schedulable 再发 messages"，职责更清晰）。

> **D26 取代（2026-07-14）**：对齐服务端 v2 实际契约——register→`POST /ticket`（返回服务端 Snowflake ticket_id）、per-task GET→批量 `POST /ticket/status`、schedulable→服务端 ready 态。详见 D26。

## D26 服务端 v2 契约对齐（已定 2026-07-14，修正 D3/D9/D15/D24/D25）

对照 `zcode-server` feat/off-peak 的 `off_peak_design.md`(v2)。服务端是一个**有严格时间盒的准入系统**，与我们「开跑跑到终态」的假设不同。

**1. 双 ID（task_id / ticket_id）。** 客户端提交自己的 `task_id`（每个闲时任务一个稳定 id，用户内有意义、不要求全局唯一）；服务端取号生成 Snowflake `ticket_id`，此后 status/settle/messages **一律用 ticket_id**。本地表加 `server_ticket_id` 列，取号成功回填、重新取号更新。

**2. 两轴状态机。** 服务端准入态 `queued→ready→active→expired/settled`；客户端执行态 `queued/running/awaiting_approval/终态`。映射：**schedulable ≡ 服务端 ready**、**running ≡ 服务端 active**、客户端终态→settle→服务端 settled、服务端 expired→触发续跑或失败。

**3. 低峰窗口在服务端，客户端仍无窗口概念（D21 成立）。** `queued→ready` 只在服务端低峰窗口内晋级（默认 00:00-08:00 + 12:00-14:00，Asia/Shanghai，支持跨午夜）；非低峰可取号/查排位但不晋级。客户端不存/不判窗口，只轮询看 state；「等待闲时窗口」文案现字面属实。已 ready/active 的票不受窗口结束影响。**修正 D9**：queued→ready 错过窗口=等下一个低峰窗口（不丢弃）成立；但 ready 5min、active 3h 是硬计时器。

**4. 3h 上限 + 自动重新取号续跑（问题①②定案）。** 服务端 active 硬顶 3h、不滑动续期，到期后 message 收 `400/3102`——**修正 D15/D3**：idle plan 是 3h 时间盒不是「锁定到终态」。取号额度实际放宽：**同一 task_id 允许多次取号**（过期后同 task_id 重新取号→新 ticket_id）。客户端做**自动续跑**：active 到期/收 400/3102 → 同 task_id 重新取号 → 回 queued 等下一个 ready → resume 同一 session 续发 → agent loop 自然完成 → settle。用户视角是一个 running/等待交替、慢慢跑完的任务；每段 3h 是一个 ticket，task 横跨多个 ticket。

**5. 接口/头对齐（取代 D25 形状）。**

- `POST /api/v1/off-peak/ticket {task_id}` → `{ticket_id, state, position, next_poll_after, …}`（取号，可能直接 ready）。
- `POST /api/v1/off-peak/ticket/status {ticket_ids:[…≤100]}` → 批量状态（position / active_deadline）。
- `POST /api/v1/off-peak/ticket/:ticket_id/settle`（仅 JWT，无 body）。
- `POST /api/v1/off-peak/anthropic/v1/messages`，头 `Authorization: Bearer <jwt>` + `X-Coding-Plan-Api-Key: <原始 key>` + `X-Off-Peak-Ticket-ID: <ticket_id>`，body 原生 Anthropic。
- idle plan provider = baseURL 指向该 messages 端点、auth = JWT + coding-plan-key 的 provider；服务端持上游 key（免费池落地）。模型受 `allowed_models` 白名单、body ≤10MB。

**6. 错误码映射 v3（服务端 2026-07-16 文档，修正 v2 的 3001）。** `3101/403` 无有效 coding plan→拦提交；`3103/429` 取号额度（+next_take_at，已放宽）；`3105/429` 模型并发满→**带 `Retry-After`**，客户端按 D24 `min(Retry-After,5min)` 退避、吃 3h 预算；`3103/429` 取号额度→带 `next_take_at`（绝对时间，非 Retry-After）；`3102/400` ticket 不可用（过期/settled/不存在/非本人）→**触发续跑重新取号，非普通报错**；`3006/400` 模型不在白名单→提交前用 allowed_models 校验；`3011/499` 客户端取消→预期结果；`2001/2002/2007/2010`(500) 依赖异常→瞬时退避。 **重排队/限流的真实信号是 HTTP 429/3105 + Retry-After，非早期设想的 `X-OffPeak-Queue` 应答头**——D24 退避据此，§4.3/§7.6 的 header 表述按此理解。

**7. 客户端要接的活。** 供给 `X-Coding-Plan-Api-Key`（用户 coding plan provider 原始 key）；持续批量轮询驱动晋级（服务端无常驻调度器，查状态即触发 Promote）；维护 task_id↔ticket_id、存 server_ticket_id。

（问题③ ready 5min 抢首发的 next_poll_after 调短：本期不管。）

## D27 收尾确认（已定 2026-07-14）

> **实现状态修正**：模型白名单、提交取号和过期重取已落地；下文 permission approval 后
> 切用户 provider/拒绝跳过的 Off-Peak 专用状态机未被最终代码采纳，见 D44。

一次性确认所有剩余口子：

- **拒绝跳过保持 idle plan**：切用户 provider 只在「用户主动让它继续做事/接管」时发生（批准执行敏感操作 / 立即执行 / 主动补 prompt）；拒绝并跳过是否决+继续无人值守，留 idle plan（精化 D11）。
- **模型：用户可选 + 提交前 allowed_models 预校**。→ 需服务端把 `allowed_models` 暴露给客户端（新增接口或 config 下发）——**给服务端的新增对齐项**。撞 3006 作兜底。
- **提交即取号**：确认加入队列即 `POST /ticket`，非低峰也取号进 FIFO、显示 position，只是不晋升 ready。
- **ready 5min 废票 = 同 task_id 自动重取**：与 active 3h 到期一视同仁（统一"任何 expired → 同 task_id 重新取号续跑"，问题③本期不调轮询间隔）。
- **files_changed**：复用现有 task diff，MR4 核对，不单独定。
- **settle 只结算当前 ticket**：过期旧 ticket 服务端已自然终态，无需 settle。

### 给服务端/产品的对齐清单（拿去敲）

1. 429/3105 补文档写明返回 `Retry-After`（口头已确认，v2 文档待补）。
2. ~~暴露 `allowed_models` 给客户端~~ ✅ 已解决（2026-07-15）：服务端 §11.1 经共用 `GET /api/v1/client/configs` 灰度下发 `data.configs.offPeak.allowed_models`，见 D31。
3. `take_number.limit` 放宽的实际值（同 task_id 多次取号已确认允许）。

### 开工前代码 spike（事实验证，非决策）

- `session/resume` 跨 ticket 续跑 + `updateRuntimeModelConfig` 中途切 provider。
- 客户端能否读到原始 Coding Plan API Key（`X-Coding-Plan-Api-Key` 前置）。
- `bigmodel-business-error-retry` 承载 429+Retry-After。

## D28 UI 范式 = Automation 兄弟实体，一切以设计稿为准（已定 2026-07-14，推翻 D5/D23 的对话式范式）

> **口径修正（2026-07-28）**：本条的「Automations Tab（All / Scheduled tasks / Idle-time task）」
> 已由 D47 收窄为 Scheduled / Idle 两个 tab，All 混排总览删除；其余定案继续成立。

Figma（⚫️ Z.ai - Zcode / 自动化 & 闲时任务页）定稿范式：闲时任务是 **Automations 体系下的实体**，不是"对话上的延迟发送"。

- **创建**：Automations 主视图整页表单（Task title + Instructions + 项目 + Ask for approval 下拉 + 模型 + Idle-time 时段选择），Settings/History 双 tab——完全复用 feat/cron 定时任务的创建范式。
- **列表**：Automations Tab（All / Scheduled tasks / Idle-time task），卡片带排队位次徽章与操作菜单。
- **入口**（≥4 个）：Automations 主视图按钮、New task 页引导条+模板卡、对话中 429/Coding plan 额度耗尽 toast 引导、Create via chat。**PRD 的 composer 月亮开关不存在了。**
- **连带作废/重写**：D5（延迟发送+排队锁定）、D23（非终态锁定 composer、接管语义）整体作废——run→新 session，无锁对话问题；侧栏月亮状态图标、per-conversation 提交确认弹窗、"记住偏好 30 天"均随范式消失。D26 的 3h 续跑、四接口契约、D24 等待策略、D27 计费边界**继续成立**（作用于 run 执行层）。
- 后续 UI 细节以该 Figma 页为唯一真源，spec §5 UI 清单按设计稿重写（本次 grilling 收敛后统一落）。

## D29 设计稿交互定案·第一批（grilling 2026-07-14）

> **实现状态修正**：权限下拉保留；“批准 = 接管 = 切用户 key”和专用等待态未被最终代码采纳，
> 见 D44。下文保留的是当时设计反馈，不是当前 UI 契约。

以 Figma「自动化 & 闲时任务」页为真源，逐题拍板：

1. **一次性实体**：创建即取号排队 → 跑完进终态；不做 Run again（服务端 settled 票不可同 task_id 重取，再跑=新建新 task_id，从模板/复制入口走）。
2. **History = 一行汇总整个执行**：3h 续跑分段对用户透明，不逐段成行；Go to session 跳唯一 session。
3. **Pause/Continue（方案 A + 手动 Continue）**：Pause = 客户端停止派发，票留服务端队列继续排；暂停中排到 ready 未接 → 票 5min 自然过期 → **停在 Paused 态，不自动重取**；Continue：票活着=恢复派发（零成本），票已废=此刻手动重取号回队尾。额度消耗永远由用户显式动作触发。→ 给设计的文案微调：tooltip「会被重新放回队列」应改为「需手动继续以重新排队」。
4. **权限默认 = Ask for approval**（安全优先），表单就地警示：「闲时执行时无人值守，需要确认的操作会暂停任务直到你响应」。四档全开放（Ask/Edit automatically/Plan/Full access，映射现有 ZCodeTaskMode）。派生：批准 = 接管 = 切用户 key 跑到完（D27，票此后不再需要）；拒绝跳过留 idle plan，票已过期时重取号搭在"拒绝"显式动作上。
5. 照设计直接采纳（无争议）：达上限创建按钮置灰 + tooltip "Free tier limit reached"；非 coding plan 用户按钮带锁 + "仅限 coding plan 用户使用"；多任务同时排队（多卡同屏各带位次）；模型下拉=allowed_models 白名单形态。

## D30 设计稿交互定案·第二批 + 范式连带修订（grilling 2026-07-14 收官）

1. **Est. 预计等待砍掉**：卡片只显示位次（#N in queue），客户端不做任何时间预估（D14 口径贯彻）；服务端不必加预估字段。→ 设计改稿项。
2. **额度口径定稿**：滚动 24h 内 distinct task_id ≤ 服务端配置数（**含 Paused**，不返还）；同一 task_id 多次取号不重复计数（续跑/Continue/拒绝后重取全部免计）。文案跟配置走（"X free runs every 24 hours"）。→ 服务端对齐项定案。
3. **保持唤醒 = 单一全局开关**，列表横幅/创建页/设置 General 三处入口镜像，文案统一；实现 = `keepAwakeWhileRunning` 配置 + powerSaveBlocker 在存在执行中任务期间生效（D4 落地形态）。
4. **入口收敛为两个**：Automations 主视图按钮 + New task 页引导条&模板卡（模板 = 预填创建表单）。**砍掉**：对话中 429/Coding plan 额度耗尽 toast 引导（该设计帧 v1 作废）、Create via chat 接入闲时。
5. **侧栏**：Group 视图系统分组「Idle-time task」（跨项目聚合，计数徽章）；Project 视图不出现；**D12 per-workspace 作废**。条目点击：无 session（排队/暂停）→ 任务详情页；有 session → 直接跳 session 对话（顶部留"查看任务"回详情）。
6. **终态卡片**：保留展示（Succeeded/Failed 徽章+时间），可 Delete，不自动清理。排序口径已修订为只按 `createdAt` 倒序，不再按活跃/终态分组。
7. **编辑窗口期**：queued/paused 全字段可编辑（票只锁队列身份，prompt 派发时才读）；running 起锁定编辑（仅可取消）；终态只读。丢弃草稿弹窗沿用 scheduled 范式。
8. **D25 取舍修订（范式连带）**：不再"提交时预建宿主对话"——创建只落表单数据+取号；**派发时 createTask 新建 session**（automation 同款），sessionId 首跑回填，中断恢复仍 resume 同一 session。
9. **D23 修订（范式连带）**：composer 锁定作废——run session 是普通对话，running 中用户插话走 z.code 现状（busy 排队消息）；但**排队消息必须走用户自己的 provider**——D23 的「provider 绑定 run 作用域」比以前更关键（防中途插话和终态后聊天烧免费池），列 MR3 验收 + spike 覆盖。
10. **状态机新增 paused 态**（用户主动）：queued ⇄ paused（Pause/Continue）；paused 中票过期仍停在 paused（D29-3）；paused 可取消、可编辑。

### 给设计的反馈清单（拿去和 Mico 对）

1. 卡片去掉 Est.，只留位次。
2. Pause tooltip 文案改：「排到号未开始的暂停任务票会失效，需手动"继续"重新排队」（现文案暗示自动放回，与手动 Continue 语义冲突）。
3. 权限默认保持 Ask for approval，但表单需加警示行：「闲时执行时无人值守，需要确认的操作会暂停任务直到你响应」。
4. 缺失状态补设计：running 态卡片徽章、终态卡片样式（Succeeded/Failed）、awaiting_approval 卡片态、Paused-票已失效（需手动继续）的提示态。
5. 系统通知样式未画（完成/失败/等确认三种，交互按 D10：macOS best-effort 按钮、点击跳 session）。
6. "One free run every 24 hours" 文案改为跟服务端配置数。
7. 对话中轻流量入口帧（429/额度耗尽 toast 引导）v1 作废。

## D31 客户端灰度开关接入（已定 2026-07-15，对齐服务端 §11.1）

服务端设计新增 §11.1：Off Peak 客户端入口经**现有共用配置接口**灰度下发——`GET /api/v1/client/configs`（Authorization 可选、Common Params 走现有统一 Header），客户端从 `data.configs.offPeak` 读取，**零新增请求**。z.code 已有该接口消费者（`forceUpdateGuard.ts` 启动强更检查、`bigmodelCodingPlanSubscriptionProvider.ts`），直接复用拉取链路。

字段：`enable_offpeak_task`（功能总开关，false/缺失/未命中灰度不下发 key 均按关闭）+ `allowed_models`（灰度用户可选模型列表）。服务端明确：该配置**只控曝光与模型展示**，不替代服务端鉴权/低峰判断/ticket 准入/白名单校验（3006 兜底不变，D27 成立）。

客户端三决策：

1. **灰度未命中 = 完全隐藏，锁在灰度之内**：Idle-time tab / 创建按钮 / 模板卡 / 侧栏分组全部不渲染；「非 coding plan 置灰锁」（D29-5）只在灰度命中后才生效。曝光判断两层：灰度开 → 再看 coding plan。
2. **有效开启判据 = `enable_offpeak_task === true` 且 `allowed_models` 非空**：模型列表空/缺失视为配置不完整，按关闭处理（隐藏），不展示一个无法提交的表单。
3. **灰度中途翻转：存量继续跑，只藏创建入口**：配置刷新后 enable 变 false——创建入口（按钮/模板卡）隐藏；若存在非终态存量任务，Idle-time tab/侧栏分组仍展示存量并跑到终态（服务端 ticket 准入是真权威）；无存量则整体隐藏。模型被移出白名单的存量任务不预判，派发时撞 `400/3006` 走现有失败处理。

派生：D27 对齐清单第 2 项（暴露 allowed_models）关闭；spike 增补一项——确认现有 client/configs 拉取时机（forceUpdateGuard 为启动一次性），灰度刷新节奏可能需要入口打开时补拉。

## D32 「立即执行」砍掉 v1（已定 2026-07-15）

> “立即执行”删除已落地；本节末尾的批准切 provider 只是当时收敛的剩余意图，当前没有运行时接线。

D30 定案的卡片菜单（queued=Pause/Delete/编辑）与 Figma 均无「立即执行」入口，但 §0 计费边界表、D18 遗留小项、RPC 清单仍残留该入口，文档自相矛盾。与用户确认：**以 Figma/D30 卡片菜单为准，v1 不做立即执行**。想马上跑 = 取消任务后自己开对话。连带清理：计费边界表该行、RPC `offPeakRunNow`、迁移表「queued→出队」行、spec §3 主动接管触发列表中的「立即执行」。切用户 provider 的触发收敛为两个：批准执行敏感操作、run session 内主动补 prompt。

## D33 run 作用域落地 = per-turn runtimeModel 注入（已定 2026-07-15，落地 D23/D30-9）

spike ②（tech-design §11）证实：往 session 上设置模型会三层持久化（app 缓存 `runtimeModelConfigBySessionKey` / CLI `record.modelRuntime` / workspace catalog），用户 busy 插话与终态后聊天都会 drain 到 idle plan，违反 D23/D30-9。两个方案对比后与用户确认定案 **(a) per-turn 注入**：

- 派发的每次 sendPrompt 单独携带 idle plan runtimeModel，仅对该轮生效；不写 session 常驻模型、不落三层缓存、不碰 workspace catalog（`applyWorkspace:false` 语义）。
- session 常驻模型始终是用户自己的 → 插话与终态后聊天**天然**走用户 provider，无回切时序问题。
- CLI 运行态必须把「session 常驻模型」与「active turn 临时模型」作为两层状态处理：`ensureModelReady` 可以校验 active turn 临时目标，但不得因为它不在 workspace catalog 就自动回退到用户模型；该例外只由内存中的 active turn 标记授权，不能放宽普通隐藏模型的 catalog 边界。
- provider registry 在 turn 运行期间可能热更新。每次 overlay/registry 重建必须使用「最新 workspace catalog + 当前 active turn runtimeModel」，禁止把临时 provider 从在途 turn 的后续重试中删掉；turn 结束后才恢复用户模型并按最新 workspace catalog 清除临时 provider。
- 应用、热更新、恢复和清理必须进入同一 session 模型配置串行化边界；恢复与清理先于 ready/queue drain。恢复原模型失败时仍要清除临时凭据，并走 workspace catalog 的可用模型兜底，不能留下“runtime 指向已删除临时 provider”的半状态。

```text
workspace catalog ───────────────┐
                                 ├─ latest catalog + active turn override ── model registry
sendText(turnRuntimeModel) ──────┘                              │
                                                               ├─ provider registry refresh: 保留 override
turn finally: restore user model ── clear active override ─────┴─ rebuild latest workspace-only registry
                                                               └─ release ready / drain queue
```

- 否决的备选 (b)：createSession 设 idle plan + 终态事件显式回切 + drain 前拦截——改动面小但存在回切与队列 drain 的竞态。
- 代价（工程接受）：agent 服务/CLI 侧需要一条不落缓存的 per-turn runtimeModel 通道（现有 `ZCodeAgentSendPromptParams.runtimeModel` 未接 V4 sendText 主路径、且 send 后会写缓存，需扩展）。
- 配套工程决定（同日）：服务端 mock 交付为**进程内 mock + 环境开关**（真实 HTTP client 按契约实现，开关切 mock 可真机点通全流程，联调仅删开关）；E2E 本轮一并做（catalog/matrix 剪枝先与用户确认）。

## D34 补齐思考深度字段（已定 2026-07-16）

领域模型起草时遗漏：automation 的配置面是 model + provider + mode + thoughtLevel，off-peak 起草时只搬了 model + permissionMode(=mode)，`thoughtLevel` 未搬——D1–D33 从未讨论过要不要给闲时任务思考深度，既没决定要也没决定砍。Figma 创建表单 composer 画了 `Max ▾` 思考深度选择器（与 automation 一致），证明本该有。

**结论：补齐 `thoughtLevel`，与 automation 对齐。** provider 仍不搬（闲时固定 idle plan，D26/D33）。贯穿：shared 类型/创建入参 + `off_peak_tasks.thought_level` 列 + OffPeakRun 协议 + host 派发 `setConfigOption("thought_level")`（与 automation 同路径，per-turn provider 注入不变）+ UI composer 工具条思考深度下拉。缺省走 workspace 默认（不填即不下发）。

## 遗留小项（已随批次顺带定案）

- ~~queued 态操作 = 取消 / 立即执行~~（已被 D30 卡片菜单 + D32 取代：queued=Pause/Delete/编辑，无立即执行）；failed 不自动重试，可手动重新入队（重新鉴权）。
- 详情页"消耗算力/剩余算力"字段随无余额/不可见 provider 自然砍掉。
- "记住偏好 30 天"只记权限模式一个字段。
- 代码域命名统一 `offPeak`（表 `off_peak_tasks`），分支名不改。
- "前往充值"跳转等余额相关文案全部作废。

## D35 边缘态 Figma 逐帧核对结论（已定 2026-07-16）

用 agent-browser 隔离实例对 Figma「自动化 & 闲时任务」页全部 idle 相关帧逐一实测后收敛：

1. **已补实现（Figma 有、spec 已列或不冲突）**：丢弃草稿弹窗（4889-1942，spec §5 本就要求"沿用 scheduled"——但 scheduled 自身未实现，闲时先行）；History tab 表格化（Instructions/Triggered/Status/Duration + 行菜单，4866-2819）+ 创建态空态「No history yet.」（4866-3106）；权限下拉两行样式 + 选中 ✓（4835-4974，复用主 composer `mode.description.glm.*` 文案）；未开启完全访问右上提示（4970-2055）。
2. **达上限置灰 = 反应式（过渡态，已被 D38 取代）**：当前客户端无配额查询 API（四接口契约无此端点），"Free tier limit reached" 置灰只能在创建收到 3103 后置位、下次创建成功清除。mock 网关补 `ZCODE_OFFPEAK_MOCK_QUOTA_COUNT` 注入以便验收。**后续计划**：新增配额查询接口后，改为在入口打开/创建按钮渲染前主动查配额，不再依赖 3103 失败事件做反应式置灰。当前实现仅作为无配额接口前的兜底方案。
3. **非 coding plan 锁定态 = 客户端按当前时刻注册表判定（2026-07-16 用户拍板，推翻本条初版"暂缓"；资格真源已被 D40 取代）**：当时约定不等服务端 entitlement 字段——无有效订阅时 `codingPlanProviderAvailability` 已把 coding plan provider 置 `systemDisabledReason` 并实时同步 renderer 注册表，UI 判 `hasActiveCodingPlanProvider`（zai/bigmodel coding plan + bigmodel 团队套餐连接；Start plan 不算）即可，零新增请求。锁优先于达上限置灰；注册表加载中不闪锁。mock 演示走 `codingPlanActive` 强制通道（`ZCODE_OFFPEAK_MOCK_NO_PLAN=1` 演示锁态），真实路径不下发该字段。D40 进一步证明广泛扫描注册表会与 runtime credential 分叉，现状改为 host 解析当前 selected connection 后向 UI 返回脱敏 support。
4. **维持作废**：「超出排队时间」自动分组 + 自动放回队列 toast（4866-2175 局部，被 D 决策 §266 推翻）；对话中轻流量入口帧（4828-1642，D30-4 v1 作废）；All tab idle 卡 Est.（D30-1）。

## D36 达上限置灰 = 配置额度 + 本地记录预判（2026-07-16 用户拍板，已被 D39 取代）

服务端契约真源：内部仓库 `zcode/zcode-server` 的 `docs/off_peak_design.md`（§11.1）。

**目标形态**：不靠撞墙——按「服务端下发的取号额度上限 + 本地滚动窗口取号记录」提前置灰创建按钮。

**字段名确认（2026-07-17 D36 收口）**：服务端 `data.configs.offPeak` 现下发三层结构 `enable_offpeak_task` / `allowed_models` / `limit: { max_tasks, sliding_window }`（示例 `{"max_tasks": 5, "sliding_window": 86400}`）。`sliding_window` 单位是**秒**（非自然日）；`max_tasks` 是滚动窗口内最多成功提交的 task 数。客户端读取与服务端 `off_peak.take_number.{limit,window}` 保持一致——字段缺失/非法/未命中灰度 → 视为不可提交新 task（按 D36 阻塞前同样走 3103 兜底）。

**计数口径（权威修正 D30-2）**：滚动窗口内按用户 `off_peak_tickets.created_at` 计数，每次成功创建 ticket 计一次；幂等免计**仅当最新 ticket 未过期**——同 task_id 票还活着的续跑/Continue 免计，**票过期后的 Continue/重取会新建 ticket 并计入额度**（D30-2「续跑/Continue/拒绝后重取全部免计」表述过宽，据服务端文档收紧）。settle / ready 过期 / active 到期**均不返还**已占用名额；ticket 创建时间移出滚动窗口后名额自动恢复。

**本地计数的先天不准**：续跑/过期重取在服务端消费额度但客户端不一定新增 `off_peak_tasks` 行；多设备更不可见。→ 本地计数只作**预判**（提前置灰减少无效点击），服务端 3103 始终是权威兜底。实现路径：`resolveOffPeakClientConfig` 解析 `limit` → repo 加滚动窗口 ticket-take 计数 → `count >= max_tasks` 前置置灰创建按钮，3103 兜底保留。

## D37 Automations Figma 差异收口（已定 2026-07-20）

以 12 张 Figma 画板和 49 条左右图 diff 为 UI 真源，同时保留已经成立的调度与会话语义：

1. **命名分层**：英文 UI=`Idle-time task`，中文 UI=闲时任务；技术域分别使用
   `OffPeak*` / `offPeak*` / `OFF_PEAK_*` / `off-peak` / `off_peak_*`。
2. **本地项目边界**：整个 Automations 的新建只列当前窗口已打开且可用的本地项目，
   不列 recent/remote；创建后项目不可修改。存量远程任务继续可见和管理。
3. **端侧边界**：手机 `/remote` 完全隐藏 Automations；桌面远程 workspace 隐藏 Idle-time。
4. **卡片导航**：卡片主点击固定进入 Settings/History；Go to session 是显式次操作。
5. **History 仍是一体一次执行**：每个 task 只有 0/1 行，不新增 runs 表。`startedAt` 后显示，
   进行中统一 `In progress`，终态映射 Succeeded/Failure/Skipped。Delete history 只写
   `historyDeletedAt` 隐藏该行，不删除任务、会话或执行字段，无确认与 Undo。
6. **提示边界**：非 Full access 第一次提交显示警告但立即创建；无订阅模板点击显示带
   Upgrade 与关闭 X 的 8 秒 Toast；锁定按钮继续显示 Tooltip。
7. **keep-awake 与配额（配额部分已被 D39 取代）**：keep-awake 仍是全局持久设置，创建不修改；
   当时约定本地配置计数只作 UI 预判，服务端 3103 保持最终权威。
8. **验收**：1440×960、dark、en-US、固定侧栏与确定性 fixture 为主基线；
   light/zh-CN 做语义验收。Figma 的多 Popover 组合稿拆成独立可达状态；不引入截图 matcher，
   用左右图 HTML 逐条标记已解决或有 ADR 依据的预期差异。

## D38 取消额度前置置灰，3103 只作单次创建错误（2026-07-21，已被 D39 取代）

服务端当前没有只读额度探测接口，`client/configs.limit` 只下发静态上限与滚动窗口，无法覆盖
多设备取号、过期重取等服务端真实用量；现行 `429/3103` 也不返回可依赖的 `next_take_at`。
因此 D35 的反应式 `quotaExhausted` 与 D36 的本地滚动计数均无法给出可靠的恢复时刻。

**最终交互：不提前置灰。** Coding Plan 资格锁仍保留；额度不再参与创建按钮、空态入口或模板卡
的 disabled 判定。用户每次点击创建都真实请求 `POST /ticket`：成功则创建任务，收到 3103
则展示现有“Free tier limit reached / 闲时任务额度已用完”错误，本次请求结束后入口立即恢复可点。
客户端不持久化或在内存中保留额度耗尽 boolean，不因本地 `limit` 计数阻止请求；服务端 3103
始终是额度准入的唯一权威。

```text
创建入口（仅 Coding Plan 资格门控）
  -> POST /ticket
     -> success：创建 task
     -> 429/3103：展示错误；不落 task；请求结束后允许再次点击
```

## D39 服务端额度可用性快照 + 精确恢复时间（已定 2026-07-21）

服务端 `main` 在 `7d90055719ee6e6be3424a90441967e359618d4a` 更新并实现了额度查询契约：

```http
GET /api/v1/off-peak/ticket/availability
Authorization: Bearer <zcode-jwt>
X-Coding-Plan-Api-Key: <coding-plan-api-key>

→ { code: 0, data: { can_take_number: true } }
→ { code: 0, data: { can_take_number: false, next_take_at: 1783908000000 } }
```

`next_take_at` 是 Unix 毫秒时间戳，只在当前不能创建新 ticket 时返回。它按滚动窗口内
当前 `limit` 阈值对应 ticket 的 `created_at + window` 计算，因此动态降低服务端 limit 后
仍能给出正确恢复时间。该结果只是调用时快照；查询成功后可能有并发请求消耗额度，最终仍以
`POST /ticket` 为准。

**客户端职责重新分层：**

1. `GET /api/v1/client/configs` 的 `offPeak` 只保留 `enable_offpeak_task` 与
   `allowed_models`，删除不再使用的 `limit` 字段、解析和本地 `createdAt` 计数。
2. 进入 Automations 时主动查询 availability。`can_take_number=false` 时创建按钮提前置灰，
   Tooltip 显示服务端 `next_take_at`；到点后重新查询，不持久化 `quotaExhausted` boolean。
3. availability 查询失败时按 D43 fail-closed；真实创建仍由 `POST /ticket` 处理查询成功后的
   并发竞态。
4. availability 为 true 后到实际取号之间存在并发窗口。若 `POST /ticket` 仍返回 3103，
   UI 展示本次错误并立即刷新 availability；服务端 3103 是最终准入权威。
5. 3103 的新响应从 `data.next_take_at` 携带恢复时间；客户端兼容旧 mock 的顶层
   `next_take_at`，但不把任何一次错误转换为无期限 boolean。

```text
client/configs ──> 功能曝光 + allowed models
                         │
                         v
ticket/availability ──> 创建按钮额度快照 + next_take_at 定时刷新
                         │ can_take_number=true
                         v
POST /ticket ─────────> 最终准入（并发竞态仍可能 429/3103）
```

## D40 Coding Plan 资格与凭据统一为 selected connection 快照（已定 2026-07-22）

D35 的 broad provider-registry 扫描只回答“缓存里是否存在某个可用套餐”，不能回答“当前 provider
family 实际选中了哪个 connection”。旧 runtime resolver 又固定读取个人 BigModel key，导致 UI 可放行
ZAI/Team，而取号或自动 turn 仍报 `codingPlanApiKey` 缺失；切换 connection 时还可能把 JWT、ticket key
和 turn key 拼成不同时间点的混合凭据。

**结论：资格、票据 API 与 per-turn runtime 共用一次 host 侧 selected credential snapshot。**

```text
provider family + family mode + selected connection key
                         |
                         v
       exact connection classifier (Start/API Key rejected)
                         |
                         v
 selected provider registry entry / existing Team runtime-key projection
                         |
                         v
 OffPeakCredentialSnapshot { support metadata, JWT, codingPlanApiKey }
           |                         |                         |
           v                         v                         v
 sanitized UI support      availability/take/status/settle   per-turn model
```

支持矩阵固定为：ZAI 个人 Coding Plan 原始 key、BigModel 个人 Coding Plan 原始 key、BigModel Team
项目 runtime key（复用既有 `${apiKey}.${secretKey}` helper）。Start Plan、API Key mode、未选择、
active OAuth provider 与所选 family 不一致、disabled、stale 或解析期间 selection/登录身份改变均拒绝；
禁止扫描任意缓存 provider 或在 Team 解析失败后回退个人 key。UI 只接收 provider
family/id/selected key 等脱敏 metadata，不接触秘密。

服务端 `main@ec2b18daa01b8e1b801f0691ac22153c2e56c6db` 的 verifier 按 JWT 登录 provider 支持
ZAI/BigModel，并把 `X-Coding-Plan-Api-Key` 当 opaque credential 校验套餐归属，因此三种 key 形态
可共用当前五端点契约；Start Plan JWT 不是 Coding Plan API key，不纳入支持矩阵。

## D41 主页模板导航按任一 Coding Plan 放行（已定 2026-07-22）

主页模板点击只是携带草稿进入创建表单，不会取号或启动 runtime。若把 D40 的 selected-connection
门禁提前到这里，尚未选择 provider、但账号已有 Coding Plan 的用户会被误判成“未订阅”并收到 Upgrade
Toast。产品口径调整为：主页导航门只判断 provider 快照中是否存在任一未被系统禁用的 ZAI 个人、
BigModel 个人或 BigModel Team Coding Plan；Start Plan 不计入。用户手动关闭 provider 不等于取消订阅，
仍算“已有套餐”。

```text
New task 模板点击
        |
        +-- 无任一 Coding Plan --> Upgrade Toast + 不写草稿/不导航
        |
        `-- 有任一 Coding Plan --> 写草稿 + 进入创建表单
                                      |
                                      `-- 提交仍走 D40 selected connection 门禁
```

D41 只放宽导航，不选择或切换 provider，也不允许 runtime 扫描缓存后任选凭证。Automations 创建按钮、
创建表单提交、ticket API 与 per-turn runtime 继续使用 D40；未选择 family/connection 时表单提交保持禁用。

## D42 Team Plan 客户端传输成立，test 后端 verifier 仍阻塞（已确认 2026-07-22）

tester 的 Windows test 包 `3.5.3-alpha.0@fc76b00d` 在切换到完整 BigModel Team org/project 后，
Team 项目 API Key 预热返回 `status=existing`，entitlement 解析为同一 org/project 的 `scope=team`，
且 Off-Peak availability 已进入服务端 Coding Plan middleware。测试后端日志进一步确认 verifier
调用 subscription 依赖时得到 `3101 coding plan is required`，随后按当前基础设施契约包装为
`HTTP 500/code 2007`。这排除了“客户端没带 key”——缺 key 应在 middleware 直接返回 `403/3101`。

同一轮中的 `POST /ticket HTTP 429` 在服务端 access log 中 body_size=0，属于独立全局 HTTP 限流，
不是带 `next_take_at` 的 `3103` 取号额度。决策：

- 不回退个人 BigModel key，也不把 Team 套餐伪装成客户端修复成功；后端必须补 Team credential
  verifier 分支或让现有 subscription 依赖接受 Team 项目 runtime key。
- 客户端只有明确 `code=3103` 才展示额度错误；`2007` 与裸 `429` 展示暂时不可用。
- ticket client 给请求补标准来源/request-id header，并用 service `warn` 记录 path、HTTP/code、
  credential kind 与 request id；禁止记录 JWT、API Key、secret 或 fingerprint。

## D43 创建准入改为 fail-closed（已定 2026-07-23，取代 D39 的 fail-open）

用户明确要求“无资格和临时依赖异常都要禁入”。创建入口不再把 availability 当作可丢失的额度
优化，而是把它作为服务端准入确认：只有 selected-connection support 成功，且最新一次
`GET /ticket/availability` 成功返回 `can_take_number=true` 时才允许创建。

```text
selected connection support
        |
        +-- unsupported / unresolved ----------------------> 禁入
        |
        `-- supported --> GET /ticket/availability
                              |
                              +-- true --------------------> 允许创建
                              +-- false + next_take_at ----> 禁入，到点重查
                              `-- loading / network / 5xx -> 禁入，刷新后重试
```

临时依赖异常不写成永久资格结论，但在下一次成功刷新前保持禁入。手动刷新、重新进入页面或
`next_take_at` 到点重查均可解除该临时门禁。`POST /ticket` 仍是 availability 成功后的最终权威，
用于兜住查询与提交之间的额度竞态；创建请求自身失败后也恢复为禁入，直到 availability 再次成功。
New Task 与 Automations 可能在导航时短暂重叠挂载，二者的初始化必须在共享 store 中 single-flight，
禁止并发 availability 请求用后到的限流/成功结果互相覆盖。

## D44 Permission 只走普通 session，砍掉 Off-Peak 专用等待态（已定 2026-07-23）

代码事实是 per-turn `runtimeModel` 覆盖整个自动 turn。permission/elicitation 会在普通 session
内阻塞工具执行并等待用户响应，但不会结束当前 turn；因此只订阅事件并写
`awaiting_approval` 无法实现 D11 的计费切换，反而会让 Review 卡片和专用通知承诺一条不存在的
provider handoff。

**结论：以当前运行时边界为产品口径，不新增中途 provider handoff。**

```text
off-peak sendPrompt(turnRuntimeModel=idle plan)
        |
        +-- permission / elicitation requested
        |       |
        |       +-- 普通 session 展示并收集响应
        |       `-- off_peak_tasks.status 保持 running
        |
        +-- approve / deny --> 同一自动 turn 继续，仍用 idle plan
        |
        `-- turn terminal --> 恢复用户常驻模型 --> drain 用户排队消息
```

- 删除 `awaiting_approval` 领域态、Repo 写入口、卡片 Review 展示和 Off-Peak 专用等确认通知。
- 历史数据库若存在该预留值，初始化时迁移为 `running`；启动恢复仍按 running→queued 处理。
- Ask for approval 权限选项保留，安全确认仍由普通 session 完成。
- completed/failed 仍由 Off-Peak 聚合通知；permission/elicitation 通知只由 session 通用链路负责。
- 若未来产品重新要求“批准后切用户 provider”，必须先设计可验证的 mid-turn runtime-model
  handoff，再重新引入聚合状态，不能仅恢复 UI/Repo 壳。

## D45 闲时自动 turn 禁止创建定时任务（已定 2026-07-23）

闲时任务的首跑与续跑都会进入普通 session，但执行主体是后台自动 turn。若沿用普通用户 turn
的完整工具面，模型可以调用 `CronCreate` 创建新的持久化调度定义，让一次闲时执行在用户未明确
操作的情况下扩散为后续定时任务。

**结论：每次闲时派发在 sendPrompt 的 turn 作用域显式 deny `CronCreate`。**

```text
首跑 createTask ──┐
                  ├─ sendPrompt(toolDenylist=[CronCreate], turnRuntimeModel=idle plan)
续跑 resumeTask ──┘
                              |
                              +-- CronCreate：本 turn 不暴露
                              `-- CronList / CronDelete：保持可用
```

- denylist 只随本次 prompt 下发，不写 session 常驻配置；自动 turn 结束后，普通用户 turn 的工具面
  仍由 session 自身策略决定。
- 不复用 cron automation 的 `automationId` 标记。闲时任务与 cron 是兄弟实体，伪造该标记会污染
  cron 会话归属、任务聚合和历史语义。
- 首跑与续跑在 `sendPrompt` 前路径不同，但必须收敛到同一闲时 turn denylist，避免恢复段重新暴露
  `CronCreate`。

## D46 Pause 取消二次确认并更新提示文案（已定 2026-07-28，取代 D29-3/D30-2 的 UI 口径）

用户明确要求 Pause 不再弹二次确认，选择菜单项后立即执行；Pause 行尾的信息图标与 Tooltip
继续保留，并使用产品指定文案：

- English: `Tasks paused beyond the queue wait time will be placed back in the queue`
- 中文：`暂停时长超过队列等待时限的任务，将会被重新放回队列。`

本次只修改 UI 交互与展示文案，不改变已有票据状态机；Tooltip 是面向用户的简化说明：

```text
queued -- Pause（无确认弹窗） --> paused
                                  |
                                  +-- ticket 未过期 -- Continue --> 恢复派发
                                  `-- ticket 已过期 -- Continue --> 重新排队
```

因此 D29-3 中“暂停后不自动重取、Continue 时按票据有效性恢复或重排”的运行时事实继续成立；
D29-3/D30-2 中要求 Pause 确认弹窗及旧 Tooltip 文案的 UI 部分由本决策取代。

## D47 移除 All 混排 tab，主视图只保留 Scheduled / Idle 两个 tab（已定 2026-07-28，收窄 D28 的三 tab 口径）

产品定案：Automations 主视图去掉「All / 全部」总览 tab，默认落在 Scheduled tasks；
Idle-time task 仍按 D31 灰度控制。随之作废/调整的派生约束：

- All 专属的两类任务共享混排栅格（两列 / 132px 行高 / 16px 间距、idle 在前连续排列、
  隐藏 `Task created` 分区标题）整体删除，不再提供跨类型总览；两类卡片只在各自 tab 内
  保持独立列表语义。
- 灰度关闭时已选中的 Idle tab 收敛回 Scheduled（原为 All）；闲时不可见时只剩
  Scheduled 单 tab，action row 仍承载刷新与创建入口，不隐藏整行。
- keep-awake 提示栏系全局开关（镜像设置页「常规」，powerSaveBlocker 不绑定闲时活跃
  计数），定时任务运行会话同样受益：改为 Scheduled / Idle 两个 tab 都展示——列表态位于
  任务卡之前，空态保持大空卡在前、横幅在后，不再绑定闲时可见性。
- `offPeak.tabs.all` 文案键删除。

对应实现：`AutomationsTab` 收敛为 `"scheduled" | "idle"`，`resolveVisibleAutomationTabs`
与 `resolveAutomationTabAfterOffPeakChange` 按上述口径实现；populated-list fidelity 与
tab 契约测试以本决策（及 spec.md 同步后的条目）为断言依据。

## D48 侧栏闲时分组收敛为 tasks-index 一等行（已定 2026-07-28，取代同日虚拟 id 折叠/renderer 排序机制）

背景：Idle-time 侧栏分组此前是独立组件（OffPeakSidebarGroup），只借用 Scheduled 的
TASK_GROUP_* 视觉类。两次用户反馈（组内不可拖拽、收起全部不覆盖）暴露"视觉一致、行为
双轨"的持续成本；2026-07-28 早间先以虚拟分组 id + localStorage 排序补齐两项行为，随即
经 grilling 会话定案彻底收敛。核心机制 = 照抄 cron：`offPeakTaskId` 成为 task meta
持久标记（不复用 cronAutomationId，D45 兄弟实体边界不变），`ensureOffPeakGroupMembership`
写真实系统分组，UI 走 grouped 原生管线。

grilling 定案的关键取舍（完整契约见 spec §5.1）：

1. **幻影行保排队可见**（否决"严格照抄 cron、排队只留 Automations"的 3–5 人日方案）：
   创建时预分配 `sessionId` 写 tasks-index 行，不建会话——D30-8 继续成立；派发时
   `session/create` 携带同 id 无缝升级，行身份恒定。协议早已支持带 id 创建
   （zcodeSessionCreateParamsSchema.sessionId optional）。
2. **作用域降级**：接受 grouped 视图的 open-workspaces-only scope，跨项目聚合入口收敛
   到 Automations 主视图；不给单个分组开查询例外。
3. **成员关系照抄松散**：可拖出/拖入，不加封闭守卫；标记跟行不跟组。
4. **统一归档**：行关闭 = 归档，含幻影行（"静音"语义：任务照跑、跑完见归档列表），无
   确认弹窗；删除/取消收敛到 Automations 卡片菜单。原侧栏"确认后取消并删除"退役。
5. **组内排序、空组常驻照抄 cron**；组头「+」是唯一不照抄点（进 Automations，
   cron 的建草稿语义对闲时是错误）。
6. **全面抑制**：幻影行仅侧栏闲时组可见，Project/Timeline/Pinned/搜索/web 远控一律
   不出现；点击幻影行 → Automations。
7. **退役与迁移**：虚拟 id 机制、`zcode-off-peak-sidebar-order`、投影去重整体删除；
   本地折叠/排序偏好接受重置（未随正式版发布）；存量迁移幂等（有 session 回填标记+
   成员，无 session 补幻影行）；`OFF_PEAK_DEFAULT_GROUP_ID` 进 shared 与
   CRON_DEFAULT_GROUP_ID 并列（"不进 shared"的旧边界前提随真实 membership 出现而消失）。
8. **不加临时功能开关**；分三个 MR 落地（打点 → 原子切换+迁移 → 测试收尾），spec 先行。

**同日晚间修订（D48-A）**：实施审计后第 1 条改选"严格照抄 cron"——排队/暂停任务派发前
不上侧栏、无幻影行，Automations 主视图是唯一队列管理面。改判依据（grill 时未知的实证）：
① 抑制无单点 chokepoint——`fetchTaskListMembershipSets` 的 taskIndexItems 同时喂
grouped 与平铺列表，全面抑制需散布在 renderer 列表构建、服务端 listTasks、搜索等 5+ 处，
"三态不变量"永久税具体化；② `sessionId` 预填破坏"存在 = 已跑过"的隐含契约
（OffPeakHistoryTab Go-to-session 门控、OffPeakTaskList 卡片入口等多处依赖）；
③ 收益重估——幻影行只买到一个跳转 Automations 的侧栏书签，位次/暂停/删除本就只在
Automations。A→幻影行是纯增量升级路径，幻影行方案在 spec §5.1 标"暂缓"，触发条件 =
真实用户反馈要求排队任务侧栏可见。第 4 条统一归档随之简化为"已派发行关闭 = 归档"
（无幻影行归档语义）；第 6 条全面抑制作废（无可抑制对象）；其余各条不变。

**MR review 修订（D48-B，2026-07-28）**：明确远程 workspace 不在闲时任务支持范围
（v1 桌面本地专属）。归组写入与 bootstrap 成员关系回填对远程行一律跳过——存量远程行的
`workspace_identity` 列可能缺失，remote 判定看主键 `workspace_key`，否则回填会用
`workspacePath` 重算出本地 key 造成成员关系串写（review CR-01）。同时补齐 resumeTask
正常 snapshot 路径的 `offPeakTaskId` 盖章，与 legacy 分支同语义（review SG-01）。

## D49 会话内创建闲时任务（已定 2026-08-24，推翻 D30-4 的 Create-via-chat 砍除）

feat/offpeak_v2 恢复 v1 砍掉的「Create via chat 接入闲时」：用户在任意会话里用自然语言让
agent 创建闲时任务，与定时任务的 `CronCreate` 范式对齐——**统一创建入口 = OffPeak* 与 Cron*
兄弟工具族并列**，agent 按语义分流（tool description 互相区分「定时触发 vs 闲时队列、无确定
执行时间」），底层两套体系保持 D28 独立。grilling 三轮拍板：

1. **工具面 = `OffPeakCreate` + `OffPeakList`（只读）**；不做 update/cancel 工具。修改唯一
   入口：聊天轮尾卡片 → Automations idle tab 编辑表单（D30-7 编辑窗口期不变，running/终态
   由 OffPeakEditView 既有 readOnly 判定自然只读）。
2. **闲时自动 turn deny `OffPeakCreate`**（与 D45 对称：闲时任务创建闲时任务 = 免费池自我
   放大）；`OffPeakList` 保留可用（对齐 D45 保留 CronList 的处理）。落点：闲时派发 turn 的
   toolDenylist 从 `["CronCreate"]` 扩为 `["CronCreate", "OffPeakCreate"]`。
3. **cron automation 自动 turn 允许 `OffPeakCreate`**（组合玩法：用户可搭「定时派生闲时
   任务」链条）。放大防护不加本地计数，服务端额度是唯一权威（`POST /ticket` 3103，
   D38/D39 精神）。⚠ 照抄陷阱：cron 工具的 `assertNotAutomationTurn` 防御方向与此相反，
   OffPeakCreate 绝不能混入任何一份 `AUTOMATION_MUTATION_TOOL_NAMES` 副本。
4. **参数面**：`title`/`prompt` 必填；`permissionMode`/`model`/`thoughtLevel` 可选（agent 按
   用户显式要求覆盖），**缺省 = 全自动（yolo）/ `allowed_models` 最后一个（假设服务端顺序
   末位≈最新最强）/ 推理最高档**。与表单缺省（Ask + allowedModels[0] + workspace 默认档，
   D29-4/D34）是**有意分叉**：工具路径面向「说完就走」的无人值守语义——Ask 缺省会让任务
   半夜卡在权限确认上，违背闲时核心价值；表单路径保留安全缺省与警示行。缺省解析在 host
   端（灰度配置可读处）；model 入参时预校 allowed_models，3006 服务端兜底。
5. **不冻结会话标题**：不照抄 CronCreate 的 `setCustomSessionTitle`——闲时创建多发生在任意
   工作会话中途，任务运行在自己的新 session（D30-8），与创建会话无绑定。
6. **静态轮尾卡**（cron 同款 ConversationTurnGroup 轮尾管线，回复完成后渲染）：月亮图标 +
   任务标题 + 创建时位次快照（#N in queue，取自取号返回）+「去到闲时任务」按钮 →
   `onOpenAutomationsMain(offPeakTaskId, "idle")` → idle tab 编辑视图。不订阅后续状态，
   历史回看无过期活数据问题。
7. **入口面仅工具**：Automations 主视图按钮与 New task 首页入口不动；`needsApproval: true`
   照抄 cron（创建消耗取号额度）。
8. **门禁**：灰度未命中（D31）/ 远程 workspace（D37-3/D48-B）/ subagent_child 不暴露工具，
   经 session create/resume params 的 `offPeakToolEnabled` flag 下发（旧 host 不下发 →
   工具不注册，fail-closed）；灰度中途翻转接受「本 session 工具面不变 + 服务端取号
   fail-closed 兜底」，不做 turn 级灰度重查。D30-8 的「创建不预建对话、sessionId 首跑回填」
   不变量不受影响——工具创建与表单创建走同一 `OffPeakTaskService.createTask`。
   **2026-09-04 补充**：门禁是 workspace 级事实，权威载体改为 host 在 agent 客户端就绪时调用的
   `workspace/updateOffPeakToolPolicy`（旧 CLI method-not-found 降级忽略），覆盖 legacy create/resume、
   v4 createSession 与 v4 冷恢复（subscribe 无参数通道）三条路径；per-request flag 作为同源冗余保留。
   卡片跳转以「收到导航后强制刷新完成」为就绪信号（agent 落库不经 UI store）；刷新失败时不做 found/missing
   终审，改提示列表加载失败（review CR-01）。**灰度中途翻转**：handler 对灰度关闭/配置缺失直接返回
   `offpeak_disabled` 稳定失败，不走空白名单推导；model 预校 trim + 大小写不敏感（review SG-02/03）。

连带修订：spec §5「已砍入口」删除「Create via chat 接入闲时」一项（composer 月亮开关与
429 toast 引导维持已砍）；§7 明确不做清单同步。D30-4 其余定案（入口收敛、砍 429 toast）
继续成立。

### D49-8 修订：3.12.2 聊天启动不等待灰度（2026-09-14）

本修订取代上文注册阶段的灰度曝光判断：支持的本地 Host 只按服务装配与 workspace 类型
决定工具注册，不读取远端配置。workspace 策略与 legacy/V4 创建、恢复 flag 保留为本地能力通道。
灰度关闭/未知时模型仍看到 OffPeakCreate/OffPeakList；实际创建进入 Host handler 后才读取灰度、
校验套餐与模型，通过后才能 createTask/取号。失败保持现有稳定工具错误且无创建副作用。
OffPeakList 只查当前 workspace 本地任务。页面入口灰度、远程不支持、子 Agent 不注册、闲时轮拒绝
递归创建、审批与绑定守卫不变。无需为已开会话异步补工具，也不新增配置后台刷新。

原缺陷：注册与创建命令重复解析远端灰度；失败不缓存导致普通聊天串行重复等待。工具可处理的
本地能力和账号是否允许创建是两个边界，前者不应等待后者。

## D50 会话内创建的闲时任务绑定并运行在创建会话（已定 2026-09-07，修订 D49-5 的"与创建会话无绑定"）

用户诉求：会话内创建的闲时任务要「基于现有会话」执行。备选 B（创建时 fork 子会话继承历史）被否决，
选定 A：**逻辑对齐 CronCreate 的 targetTaskId**——创建时绑定当前会话，派发时 resume 该会话并发送
任务原 prompt。六项拍板：

1. **始终绑定，不加开关**：会话内 `OffPeakCreate` 一律绑定当前会话（`boundSessionId` 由 CLI 端口从
   工具上下文填入，经 `offPeak/create` 协议到 host，`repo.create` 写 `session_id`；`conversation_id`
   仍等首跑回填，保持"非空 = 已跑过"契约）。表单创建路径不变，仍新建独立 session（D30-8 对表单继续成立）。
2. **缺省权限模式维持 D49-4 的 yolo，且任务结束后不回滚**：与 cron 的差别是可见的——cron 快照的是
   会话当下 mode，写回无感；闲时会把用户会话切成完全访问并保持。用户明确接受。
3. **不冻结会话标题**（维持 D49-5）：绑定的是用户的工作会话。
4. **重复绑定只拒未终态**：本会话已有 queued/running/paused 闲时任务时拒绝再建（两个无人值守 prompt
   抢同一会话），任务终结后允许再建；与 cron 的"一会话一任务永久拒绝"不同（闲时任务一次性）。
   判定复用 `offPeak/list` 最小快照（含 sessionId/status），查询失败 fail-closed。
5. **派发撞忙先探测**：绑定首跑先读 tasks-index 的 `status === "running"`，忙则直接 transient 交给
   调度器退避（30s 起翻倍，上限 15 分钟，无次数上限），**不碰任何会话配置**。原因：CLI `session/send`
   以 -32010 拒绝并发 prompt，但 `setMode` 没有活跃 turn 检查，先写配置再撞忙会悄悄改掉用户会话的
   权限模式。绑定会话已被删除 → permanent（不再退避到票过期重取号）。
6. **Stop 即取消**：任务在用户会话里跑时用户点 Stop，停掉的是任务那一轮，结果追踪把 stopped 映射为
   `cancelled`，票作废（不做"回 queued 等下一票"）。用户在任务轮期间的输入进 v4 队列排在其后。

UI 连带：Automations 闲时卡片脚注与编辑页露出**绑定会话标题**（`repo.list` 联查同库 tasks 表得到只读
派生字段 `sessionTitle`，不落库），编辑页附 Stop 即取消提示；聊天轮尾卡状态行追加「将在本会话中运行」。
侧栏：绑定会话在首跑盖章 `offPeakTaskId` 时归入闲时系统分组（D48 机制同 cron targetTaskId）。

连带修订：D49-5 中"任务运行在自己的新 session，与创建会话无绑定"仅对表单创建成立；tech-design §4.7
的派发分支由两分支改为三分支（resume / bound-first-run / init）。

## D50 补充：2026-09-08 机审回应

- **CR-01**：`OffPeakCreate` 的 description / modelInstructions 仍写"fresh session / NEW session /
  self-contained prompt"，与 D50 绑定会话执行相反。已改为"later continues THIS conversation with the
  full history"，并允许 prompt 引用会话内既有上下文，但仍要求写明交付物（无人值守无法追问）。
  第二轮机审指出 contracts 里 `prompt` 参数的 `.describe()` 漏改（经 zodToJsonSchema 进入模型可见
  inputSchema，与工具描述互相矛盾），已同步修正并加 JSON schema 级文案断言。
- **CR-02**：CLI 端口的绑定守卫（D50-4）读 `offPeak/list`，而该方法为展示截断 top-20，任务多于 20 且
  绑定任务较旧时守卫放行。第二轮机审再指出预检与 INSERT 之间夹着取号网络往返，存在 TOCTOU。最终收敛为
  两层：① `OffPeakTaskService.createTask` 在取号前调 `repo.hasActiveBoundTask(workspaceKey, sessionId)`
  精确预检（不再复用展示 list），命中回 `client_validation / session_bound`；② 存储层部分唯一索引
  `idx_off_peak_bound_active ON (workspace_key, session_id) WHERE session_id IS NOT NULL AND status
  NOT IN 终态`，并发穿过预检的一方 INSERT 被拒，同样映射为 `session_bound`（已取的票随任务作废，服务端
  按过期回收，不加释放接口）。存量库若已有重复行则建索引失败，跳过索引只剩预检，等人工巡检。host
  `offPeak/create` 处理器不再自带预检；CLI 端口读 top-20 的守卫保留为快速路径。CLI 翻译为稳定文案。
- **SG-02**：`workspace/updateOffPeakToolPolicy` 同步失败只吞 -32601，其他错误会让客户端就绪 reject。
  改为所有错误记 warn 不上抛：失败方向是 fail-closed（CLI 缺省不注册工具），不值得阻断启动。
- **SG-03**：缺省思考档由 `defaultLevel ?? levels[0]` 改为按已知强度表
  （max > xhigh > high > medium > low > minimal > nothink > none）取最高，落实 D49-4 的"最高档"口径；
  目录全为未知命名时才退回 defaultLevel / 首位。用户拍板：最高档优先于目录 defaultLevel。
- **SG-01 不改**：灰度关闭不向已启动 CLI 推送 `enabled:false`，是 D49-8 已定的"本 session 工具面不变 +
  服务端 fail-closed 兜底"，且只推 true 是 pre-push 回归后刻意收窄的方向。

## D51 闲时 turn 禁止 Bash 后台执行（已定 2026-09-07）

问题：后台 Bash 命令完成后，`runTaskNotificationBatch` 会另起一轮通知 turn，而该 turn 不带
`turnExecutionModel`/`offPeakTaskId`；闲时 turn 结束或失败后 session 模型已还原成用户 provider，
这一轮完整 agent loop 就跑在用户自己的套餐上，且没有任何用户操作（D33 计费边界被绕过）。

决策：**不修通知 turn 的归因，直接在闲时 turn 关掉 Bash 后台面**——`bashHandler` 读
`context.offPeakTurn`：显式 `run_in_background` 抛 recoverable `ToolExecutionFailed`（提示改前台重跑），
超时自动转后台（`isBashAutoBackgroundEligible`）同时关闭，长命令按前台超时处理。与 subagent runner
已有的 `BACKGROUND_UNAVAILABLE`（闲时 turn 拒绝后台 Agent）对称，两条后台入口在闲时轮统一 fail-closed。

不做：通知 turn 带模型/延后（需要跨 turn 持有临时凭据，与 D33 清理边界冲突）；cron automation turn
不受影响（走用户 provider，后台面照旧）。

## D52 闲时 turn 禁止 SendMessage 与 Workflow（已定 2026-09-14，hotfix/3.12.2）

问题（ZCT-2099408932463325184，3.12.1）：主 Agent 用 `SendMessage` 续跑已完成的子 Agent 时，
`subagent/runner.ts` 的 `resumeTerminalAgentInBackground → runBackgroundAgent` 只传 signal，不带闲时轮的
`subagentModelOverride`；`runExploreAgent` 的模型解析在无 override、profile 无显式模型时回落
`getSessionModelSelection()`，而 D33 规定常驻选择永远是用户 Provider，于是续跑轮全部计入用户 Coding Plan。
3.11.2 同路径靠 runner 读 `turnExecutionModel` 仍走 idle plan，属 provider 重构（1ccc89c5d4..eb8b9deee5）回归。
同类路径还有 `Workflow`：脚本子会话由 `script-workflow-child-runtime` 按父会话常驻选择建模型。
该路径同时绕过了 D51 的 `modelOverride.background === "deny"` 检查（没有 modelOverride 就没有 deny）。

决策：**不给续跑路径补 override，直接在闲时轮禁掉这两个工具**（用户拍板）。三层同 D49：turn denylist
（core `OFF_PEAK_MUTATION_TOOL_NAMES`、V4 `prompt-turn.ts`、legacy `server-operations.ts` 同值扩为
`["OffPeakCreate","SendMessage","Workflow"]`）隐藏工具；handler 复用 `assertNotOffPeakTurn` 抛 recoverable
`PermissionDenied` 并提示改用前台 Agent；`isOffPeakCreateRestrictedTurn` 的 denylist 兜底只认 OffPeakCreate
哨兵（旧 host 派发的 denylist 可能尚未带新工具）。闲时轮内子 Agent 均为前台同步完成，SendMessage 没有
其他有效用途，禁用无功能损失。

不做：resume 路径透传 override（与 D51 的后台 deny 语义冲突，需另定前台等待方案）；标题生成沿用本轮模型
（`session-title.ts` 仍走常驻选择，每会话 1 次小额请求，另行处理）。

## 待讨论队列

（已全部收敛，最终形态见 `spec.md`。）
