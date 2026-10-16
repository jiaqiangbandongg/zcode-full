# Timeline Authority 实施计划

> 依据：[`15-timeline-resolver-design.md`](./15-timeline-resolver-design.md)（方案）、
> [`15-timeline-resolver-design-review.md`](./15-timeline-resolver-design-review.md)（前审 F1–F10）、
> 第二轮代码级评审（R1–R13，2026-07-07）。
> 出发点：彻底解决 v4 重构后仍存在的「消息/timeline 顺序错位」与「消息莫名不渲染」，
> 并最大限度兼容用户已有历史数据（`~/.zcode/cli/db/db.sqlite`：2,989 sessions / 26,942 messages / 96,112 parts）。

## 实施状态（2026-07-08）

P0–P4 全部实现并提交（feature/v4-vertical-slice）：

| 阶段                                                                               | 提交        | 状态                   |
| ---------------------------------------------------------------------------------- | ----------- | ---------------------- |
| P0 止血（on-conflict 漂移修复 + 0015 backfill/触发器）                             | `eef7ed7a9` | ✅                     |
| P1 读取端归一（goal/model part 消费、session_entry 合并、head-skip、守恒扩项）     | `5d08dfbb5` | ✅                     |
| P2 顺序权威（drain 切轮、工时拆分、GV 身份/落位、隐形行清零、S2 平铺、S11 冷路径） | `d35fa2123` | ✅                     |
| P3 session_input 账本（0016，原子 promote，wake 记账，resume 清扫留痕）            | `fb13f9940` | ✅                     |
| P4 收尾（fork provenance/remap、三路径归一、轮尾闸、守恒 resync、影子重放）        | `f57146467` | ✅                     |
| P5 持久 session_event journal                                                      | —           | 冻结（§6-5，本轮不做） |

影子重放验收（`apps/zcode-cli/scripts/shadow-replay.mjs`，2026-07-08 本机全量）：
3,014 会话 → 0 重放崩溃、0 assistant 正文丢失、0 goalVerify marker 丢失；
21 个 userInput flag 均为 legacy 文本嗅探消息（无结构标记的 goal-continuation
reminder / fork notice）的启发式误报，分类器行为正确。

P1 已知余量：守恒判据仍是顺序不敏感的 `>=`（顺序敏感节点级等价随 P2 的单一
normalizer 后续升级）；文档回写清单（§7 表）尚未执行。

2026-07-10 补充裁决：P1 原提交虽然补了 goal/model 冷恢复，但
`v4-bridge.loadPersistedEvents` 仍然是「内存 eventStore XOR transcript 合成」，不符合
本节已冻结的三源合并语义。读取端必须收敛为一个可单测的 cold merge：

```text
message / part durable transcript  ----\
                                        +--> cold merge --> canonical SessionEvent stream
session_entry goal legacy source  -----/
in-memory eventStore ------------------/     只补 in-flight / ephemeral
```

- 已持久 user/assistant/reasoning/tool/timeline 正文一律以 message/part 为权威；
  同一 `assistantMessageId` / `partId` / `toolCallId` 的内存正文事件不得再投影一次。
- 未终态 turn 是例外：为了保留未持久流式尾部，该 turn 由内存事件整体补齐，
  不再同时合成该 turn 已落盘的半截 parts。
- queue / permission / control / background 等无 transcript 持久形态的状态从
  eventStore 补入；未识别或无法对齐的老事实必须保留并输出 diagnostics，不得静默丢弃。
- 内存 goal / compact / fork boundary 若带 `anchorMessageId` / `targetMessageId`，必须仅按
  该持久实体解析到 synthesized product turn，并插入该轮 tail；禁止用文本或时间猜测。
  无锚点或锚点不可解析的 legacy boundary 放到最后一个已知宿主之后，并输出 diagnostic。
- `SessionInputPromoted` 是 queue 的已知终态：cold merge 计算 pending 集合时必须摘除对应
  `pendingInputId`，不得把它当未知事件保留或产生 unclassified 告警。
- `timeline/goal_verification` 与 session_entry 继续按 `targetId+goalIteration`
  去重；`timeline/model_change` 必须显式消费 `fromModel/toModel`，不能仅依赖
  下一条 user message 的 model 快照碰巧重建。

2026-07-11 projection closure 裁决补充：message、part、session metadata 与 goal 是
持久权威；live/cold 统一先生成 canonical facts。`rowId` 降为 display-only，所有可操作
row 用 `entityId/productTurnId` 寻址。latest real-user input（text/goal）的统一 edit 走 rewind；若已被
稳定 compact 覆盖则原子 fork child 并导航。primary/continuation/verifier running edit 先过
stop barrier，active compact 统一锁定 fork/edit/retry/send-now。用户 goal input 必须生成
canonical visible real-user row、与 text query 共用 `editUserQuery` target 且重发保留
`sendGoalCommand` intent；`goalSet` lifecycle 本身不产 marker。background model-only wake
总是独立 product turn；retry 恢复完整 intent；
stable fork 只有在所有 child-local 引用原子 remap 后才发布。以上只补足既有 P1/P2/P4
闭环，不引入新的 client-mode 产品分支。

## 0. 根因裁决（为什么 v4 重构没解决原始问题）

v4 把状态收敛到 CLI 投影、UI 无脑渲染——这一步是对的，协议层（delta 封闭枚举、
apply、profile 收口不变量、snapshot+afterSeq 恢复）也已验证正确，本计划**不动协议 delta 形态**。

真正没被考虑的是投影层的四个系统性缺口，它们逐一对应用户可见故障：

| #   | 缺口                                                                                                  | 代码事实                                                                                                                                                                                                                                              | 用户可见故障                                                |
| --- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| G1  | 无权威排序：marker 靠 append 到达位置落位，事件 payload 里的 anchor 被无视                            | `product-projection.ts:1391-1408`（goalVerify）、`:1225-1226`（compact 注释「落在事件到达时的行尾」）；`TimelineMarkerRow` schema 无 anchor（`rows.ts:224-231`）；`turnIdOf` 回落 `"turn-unknown"`（`:1621-1623`）                                    | goal verify / compact / fork marker 漂到错误轮次            |
| G2  | 无实体身份：rowId 是进程内自增，user 输入无稳定 id，goalVerify 以易失 verificationId 为身份           | `rowBase` `nextRowId++`（`product-projection.ts:1612-1619`）；`buildUserInputRow` 无 messageId/sourceCommandId；`verificationId = spanId ?? traceId`（`target-completion-verification.ts:108`）                                                       | 同一 verify 出两个 marker；守恒无法判定；fork/edit 反查失败 |
| G3  | live/cold 双路径语义相反：drain/model-only wake 在 live 落同 runtimeTurn，cold 按 real-user 切轮/并轮 | live：`turn-loop.ts:33-55` + `onTurnSteerDrained` 同 turnId；cold：`transcript-hydration.ts:708-771`；UI 按 turnId + latestAssistantText 折叠（`conversationTurnRenderUnits.ts:77-174`）                                                              | 上一轮 assistant 被折进「已工作」（Case A）；刷新后结构变样 |
| G4  | 输入生命周期不 durable：事件日志纯内存、队列纯内存、唤醒命令纯内存                                    | `InMemorySessionEventStore`（`adapters/storage/index.ts:21-55`，`create-app.ts:342`）；`runtimeCommandQueue` 内存数组（`command-queue.ts:98-99`）；resume 丢弃 pending steer（`steering.ts:825-869`）；drain 跨 store 非原子（`steering.ts:726-760`） | queue 消失且不进 transcript（Case B）；重启丢队列/丢唤醒    |

两个修正后的关键事实（决定修复成本比 15 号设计估计的低）：

1. **goal verify / model change 的持久事实已经完整**：verification 每次都写 timeline part
   （身份 `targetId_goalIteration`、`anchorMessageId/anchorTurnId`，`events.ts:217-291`）+ session_entry；
   model change 也有持久 timeline part（`timeline-persistence.ts:44-87`）。丢失发生在**读取端**：
   hydration 只消费 `context_compaction`（`transcript-hydration.ts:165-198,641-643`），
   守恒判据不数这两类（`:807-862`）。
2. **冷恢复是「事件日志 XOR 全量合成」二选一**（`v4-bridge.ts:320-338`），而事件日志是内存的
   ——真正的跨进程冷启动 100% 走有损合成路径。

## 1. 故障 → 修复阶段映射（验收对照总表）

| 用户可见故障                                                    | 根因                                                                                                                                                                                                                                                    | 修复阶段                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **assistant 回复整段消失**（用户原始痛点，非折叠）              | live：投影仅 phase=running 接收流式文本，「迟到终态不复活」闸静默拒收整段（`product-projection.ts:527`）；cold：首条真实用户消息之前的 assistant/合成消息整段跳过（`transcript-hydration.ts:708-711`，会话头部是 rewind notice/compact summary 时触发） | P1 + P2（assistant 守恒）     |
| 上一轮 assistant 观感消失（drain 后早段 text 被折进「已工作」） | G3 + UI latestAssistantText 推断                                                                                                                                                                                                                        | P2                            |
| queue 消息消失且不进 transcript                                 | G4（drain 非原子/投影内存态承接）                                                                                                                                                                                                                       | P3（durable）+ P2（投影承接） |
| goal verify 冷恢复后消失                                        | G4→读取端不消费                                                                                                                                                                                                                                         | P1                            |
| goal verify 位置错 / 重复 marker                                | G1 + G2                                                                                                                                                                                                                                                 | P2                            |
| compact / fork marker 错位                                      | G1；fork anchor 近似行尾                                                                                                                                                                                                                                | P2 + P4                       |
| model change 冷恢复消失 / 幽灵折叠区                            | 读取端不消费 + 隐形 row 进 window                                                                                                                                                                                                                       | P1 + P2                       |
| background wake 归属错 / 出现用户气泡                           | G3                                                                                                                                                                                                                                                      | P2                            |
| 刷新/重启后顺序与 live 不一致                                   | G3 + 二选一 hydration                                                                                                                                                                                                                                   | P1 + P2                       |
| marker 状态不更新（停在 running）                               | 窗口外 upsert 静默 no-op（`apply.ts:64-65`）                                                                                                                                                                                                            | P4                            |
| 重启后队列/待唤醒静默丢失                                       | G4                                                                                                                                                                                                                                                      | P3                            |

## 2. 总体方案（对 15 号设计的采纳与修正）

采纳 15 号设计的分层，按评审修正三处：

```text
Persisted Facts（权威）：message / part / session metadata / goal（+ 内存事件日志仅作 live 加速）
        |
        v
Event Normalizer（唯一入口，P1 重心）
  live 事件与 cold 事实都归一为 typed semantic events
  三源合并 + 去重，废除 XOR 二选一
        |
        v
Semantic Ledger（P2）
  typed entities，entityId 全部由持久事实派生
        |
        v
Timeline Resolver（P2，弱化版）
  主序 = normalizedOrderKey 近乎全序（定义见下）
  + 有界 anchor 局部重挂（boundary 挂到目标 productTurn 尾，不做通用拓扑求解）
        |
        v
Materializer：兼容期继续输出 rows.window（带 entityId/productTurnId/visibility）
        |
        v
UI：按 resolver 结果渲染，删除 turnId+latestAssistantText 推断
```

**normalizedOrderKey 定义**（现状四套序号互不可比：message.sequence 是 session 内序、
part.sequence 是 message 内序、session_entry 无序号、event 序独立——必须先归一，
否则实现会退回 timestamp/append 猜测）：

```text
normalizedOrderKey = (
  branchEpoch,        # rewind/fork 换代，最外层
  hostMessageSeq,     # 事实所在或锚定的 message 的 session 内 sequence
  hostPartSeq,        # message 内 part sequence；message 级事实取 -1
  boundaryRank,       # 同宿主位置的 lane 序：trigger < assistantWork < turnTailBoundary
  lifecycleOrdinal,   # 同一实体生命周期内第 N 次状态变化
)
```

- 非 message 宿主的事实（session_entry goal verify、live 事件）先经 anchor 解析到
  宿主 message（`anchorMessageId` → 其 messageSeq）；解析失败 → 落到已知最后宿主
  之后 + diagnostics，不猜 timestamp。
- live 尚未持久化的 in-flight 输出排在全部已持久事实之后、按事件序内部排序；
  持久化落地后由 hostMessageSeq 接管（entityId 不变，仅权威源切换，位置不跳变）。

三处修正：

1. **重心从 constraint graph 移到 normalizer**（前审裁决）：排序骨架近乎全序，
   难点是把每条事实归一成「带稳定身份、带 anchor、带 visibility」的 typed entity。
2. **resolver 输出不落库**：`productTurnId/orderKey/lane/placement` 只可缓存（15 号设计已裁决，维持）。
3. **durable/ephemeral 切分**：streaming delta 永不进入持久事实层；
   若未来建持久 session_event journal（P5，独立裁决），只收 durable 事件。

## 3. 历史数据兼容原则（贯穿全部阶段的硬约束）

1. **历史行只读**：message/part/session_entry 的历史行一律不改写；禁止任何「重保存修复」
   ——在 P0 修好 on-conflict 之前，重保存 NULL-sequence 行会把它漂到队尾（`messages.ts:41-44`）。
2. **顺序确定性**：历史行沿用现读序 `sequence is null, sequence, time_created, rowid/id`，
   用 golden 钉死「同一 session 多次 hydrate 得到同一顺序」（含 NULL 混排、同毫秒时间戳 case）。
3. **缺字段由读取期推导**：缺 semantics/anchor 的老数据由 normalizer 推导 + 显式 fallback placement
   （按事实序落位 + diagnostics 标记），不得静默丢、不得崩。
4. **双源去重**：goal verify 跨 `session_entry`（legacy 主体，1,402 行）与
   `timeline/goal_verification` part（新写入）按 `targetId+iteration` 合并；
   fork 三条路径的产物差异（有/无 timeline part）都要能恢复。
5. **NULL sequence 增量 backfill 只做一次**：先封死写入源（P0），再幂等复跑 0014 的窗口函数
   backfill（仅 `where sequence is null`），留审计日志。
6. **老 fork child**：part 内嵌 anchor 指向父 id 的引用（`clonePartForFork` 未 remap，
   `steering.ts:60-65`）在 resolver 中降级为 originRef/diagnostics，不参与 placement。
7. **可见性不回归**：normalizer 以 semantics 为权威后，靠文本嗅探分类的老消息
   （compact summary、goal continuation、task notification、rewind notice、fork notice）
   可见性不得变化——用全类别分类 golden 锁定。
8. **协议兼容**：rows.window 形态保留，desktop/web 客户端不需要 lockstep 升级。
9. **影子重放验收**：提供 dev 命令对本机全量历史 session 过新管线，
   输出守恒失败清单与新旧投影 diff；上线门槛 = 守恒失败清单人工审查完毕、无静默丢弃。

## 4. 分阶段计划

### P0 止血：封死坏数据来源（不改任何行为语义）

改动面：

- 修 `messages.ts` on-conflict 两个分支：NULL 行再保存不得漂队尾；
  跨 session 改绑（导入 upsert）分支显式化或禁止。
- 加 DB 触发器/约束：新写入 message/part 的 sequence 不得为 NULL
  （触发器可对旧二进制的写入自动补 `max+1`，防版本偏斜继续产 NULL）。
- 定位 NULL 来源：迁移后仍新增 1,690 条 NULL 的首要嫌疑是**版本偏斜**
  （旧二进制并存写同一 DB），用触发器审计验证，不再 grep 代码找旁路。
- 封死后幂等复跑 backfill（兼容原则 5）。

不做：不改投影、不改 hydration、不改 UI。

验收：`null-seq-determinism` golden（L1）；触发器上线后 NULL 新增归零（DB 审计）。

### P1 读取端归一：Event Normalizer + 三源合并（纯读取期，历史兼容性最好）

目标：**冷恢复不再丢事实**。修复「goal verify / model change 刷新后消失」「fork child 恢复丢事实」。

改动面：

- 新建 Event Normalizer 模块（bootstrap/zcode-protocol-v4），live 事件与 cold 事实共用同一分类入口；
  `getConversationMessageProjectionPolicy` 收敛为 normalizer 内部实现细节：
  semantics 优先，文本嗅探仅对无 semantics 的 legacy 数据启用并计 diagnostics。
- `v4-bridge.loadPersistedEvents` 从「事件日志 XOR 合成」改为**三源合并**，
  合并规则分两层：
  - **权威优先级（正文事实）**：message/part 是 durable transcript authority——
    user/assistant text/reasoning/tool/timeline 正文一律取自 message/part；
    内存事件日志只允许补两类：① 尚未持久化的 in-flight 流式状态；
    ② 无持久形态的 ephemeral 状态（queue 展示、permission 交互、control 相位）。
    同一 `assistantMessageId`/`partId` 两源同现时以持久源为准（事件源仅供流式中间帧），
    杜绝同一段正文被投两遍。
  - **boundary 去重键**：compact=`operationId`、goal=`targetId+iteration`、
    fork=`parentSessionId+targetMessageId`、model=`anchorMessageId+from/to`；
    session_entry 只作为 goal verify 的 legacy 源，与 timeline part 跨源合并。
- hydration 补消费：`timelineType=goal_verification / model_change` part、session_entry
  （`SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION`）。
- **修 hydration 头部跳过**（「assistant 回复整段消失」的冷路径向量，
  `transcript-hydration.ts:708-711` 现状直接 skip）。产物形态固定为：
  能解析出可恢复 parent/anchor（对应的 model-only 输入消息、rewind/compact 上下文）
  → 建 **preface productTurn**（model-only trigger，无可见气泡，assistant 内容可见）；
  解析不出 → **diagnostics 可见行**。两种都进 live≡cold golden，禁止静默丢。
- 守恒判据升级：`eventsCoverTranscript` 的 footprint 子集判据替换为**顺序敏感、含 goal/model 计数**
  的节点级等价（后续 P2 升级为节点级 golden）。

不做：不改排序规则、不改 UI、不写任何新库字段。

验收（L1/L2）：`GV-cold` / `MC-cold` / `GV-cold-session_entry` / `classifier-golden` /
三源合并 golden（任意子集在场终态相同）/ `assistant-head-skip`
（头部为 rewind notice / compact summary 的会话冷恢复后 assistant 回复仍可见——整段消失冷路径向量）。

### P2 顺序权威：实体身份 + productTurn 切分 + anchor 落位（修「错位」与「折叠吞消息」的核心）

目标：live ≡ cold 单一结构；A1/A2 都可见；marker 按 anchor 落位。

改动面：

- **CanonicalFact 同时承载可见性与命令寻址**。live `SessionEvent` 与 cold
  message/part 不能分别拼一套“看起来相同”的 payload；进入 ProductProjection 前必须
  归一出同一组持久实体字段：`entityId/productTurnId/runtimeTurnId/transcriptMessageId/
visibility/origin/placement`。cold hydration 手里已有的 `message.info.id` 必须作为
  `transcriptMessageId` 传入，禁止重新用 `hydrate-turn-N` 去匹配持久 runtime anchor。
- **row、command target 与 row.actions 原子 materialize**。`rowId` 只属于展示/虚拟滚动，
  不能进入服务端业务寻址。`entityId/productTurnId -> transcript message/turn boundary` 的
  映射属于 ProductProjection 的命令投影，不是可选缓存；生成或更新一条可操作 row 时，
  必须在同一次归约中同时生成稳定 command target 和
  `actions.canEdit/canRetry/canFork`。必须满足：

  ```text
  row.actions.canEdit
    <=> resolveEditTarget(entityId, productTurnId) 成功
    <=> target 是最后一条 real user transcript message

  row.actions.canRetry
    <=> resolveRetryTarget(entityId, productTurnId) 成功
    <=> target 是全时间线最后一条稳定 assistant transcript message
  ```

  UI 只能渲染 CLI 下发的 row.actions，禁止再按 rows 数组位置、phase 或 raw message
  自行推导 edit/retry/fork。command handler 仍做最终 guard，但不能出现“入口可见、同一
  revision 下 target 必然解析失败”的半投影状态。

- **live/cold 等价升级为可寻址性等价**。shadow replay/golden 除可见 row、正文和 marker
  外，还必须逐 row 对比 `entityId/transcriptMessageId` 对应的 command target 与 actions；
  至少覆盖 provider 首字前失败、tool-only、empty assistant、cold resume 后 latest query
  edit，以及普通 completed assistant。`0` 丢消息不再等价于投影闭环完成。
- **entityId 派生规则**（冻结为契约）——queue item 与 promoted user message 是**两个实体**，
  不得共用身份：
  - `QueueItem.entityId = pendingInputId/inputId`（P3 账本落地后 = session_input.id）；
  - `Promoted UserIntent.entityId = persisted user messageId`（drain 事件的
    `injectedMessageIds` 与 `pendingInputIds` 一一对应，runtime 先 `persistUserPrompt`
    再发 drain 事件，`steering.ts:741-756`）；
  - 两者以 cause ref 关联：`UserIntent.cause = { pendingInputId, sourceCommandId }`；
  - 输入守恒据此改写：每个 pendingInputId **要么**仍在 QueueItem，**要么**存在
    cause 指向它的 promoted UserIntent，二选一；
  - assistant=assistantMessageId；compact=operationId；
    goalVerify=`targetId+iteration`（verificationId 仅 attempt alias）；
    fork=`parentSessionId+targetMessageId`。禁 `nextRowId++` 作身份、禁 DB 字典序。
- **productTurn 切分规则**（一等 invariant，2026-07-07/11 已裁决，见 §7）：同一 runtimeTurnId 内，
  边界由 trigger 类 UserIntent（**queue drain / model-only continuation / background wake**）
  的事实序划定；background model-only wake 无条件新建独立 productTurn，且不生成可见 user
  trigger row。**steer（guide 模式注入）不是边界**——内联在当前轮，需要 delivery=steer/queue
  两种语义（session_input 账本天然承载）。live 路径在边界处产出 productTurn 边界，
  cold 路径经同一 normalizer 得到相同结构。
- **drain 粒度配套调整**：runtime 改为每次只 drain 一条队列项，每条队列项 1:1 对应
  一个 productTurn 与一段回复（§7 裁决）。
- **工时归属**：productTurn 按边界拆分工时，各轮显示 trigger→下一边界的时长，加和等于总工时（§7）。
- **assistant 守恒（live 拒收向量）**：「迟到终态不复活」闸（`product-projection.ts:527`）
  不得静默丢弃流式文本——拒收时记 diagnostics 并从持久事实触发 resync 补齐，
  保证每条持久化 assistant message 对应一个可见 segment 或 diagnostics 行。
- **多段正文显示**：同一 productTurn 内所有 assistant text 段全平铺可见，
  只有 tool/reasoning/subagent 活动折叠进「已工作」（§7 裁决，消除折叠吞正文观感）。
- **不产 marker row 的 lifecycle facts**（§7 裁决）：`retryNotice`、`goalSet`、父侧
  `forkCreated` 不再产生 timeline marker row（当前三者都是「进 window 渲染 null」的隐形行）；
  `goalSet` state fact 归 goal 面板，但触发它的每条用户 `sendGoalCommand` input 仍必须
  materialize 为 canonical visible real-user row，并与 text query 共用 `editUserQuery` target；
  fork 关系归 sessions 树，retry 不留痕。background 唤醒轮无触发行（S14）。
- **残缺轮形态**（协议 PB-AUTO-COMP-STOP-G12 + S15）：resolver/UI 必须支持
  「只有 trigger（+ 可选 cancelled compact marker）、没有 assistant segment」的
  interrupted 轮——auto-compact 被 stop 的 pendingAction、已注入 steer 被 stop
  都会产出这种形态，不得被守恒检查误判为丢失，也不得被折叠规则吞掉。
- **goal verify boundary**：身份 `targetId+iteration`，**upsert-by-lifecycleKey**
  （started/terminal 任一先到都能创建实体，废除「无 started marker 则终态丢弃」
  与 `if (!goal) return []` 的静默丢）；placement 走
  `anchorAssistantMessageId || anchorTurnId || 显式 fallback`，废除 `"turn-unknown"` 黑洞。
- **多段 assistant**：一个 productTurn 多 segment 全保留；fork 只挂所属 turn 最后完成段；
  retry 只挂全时间线最后一条 assistantText row（resolver 出口保证，UI 不再自行推断）。
- **edit/retry 意图闭环**：统一 `editUserQuery` 只解析 active branch 的 latest real-user
  canonical intent（text 或 goal）；未被 compact 覆盖时 rewind，已被 stable compact 覆盖时
  conversation-only 原子 fork child 并在投影可用后导航。用户 goal input 是普通 real-user row，
  共用稳定 `entityId/productTurnId` action target；重发必须保持 `sendGoalCommand` intent，禁止
  退化成 `sendText`。retry 从 canonical cause 恢复 text/goal kind、attachments、delivery/
  fallback 与来源 cause，禁止从 row 文本重建。primary/goal continuation/goal verifier running
  edit（包括 latest goal input）统一先过 stop barrier；barrier 失败不得 rewind、不得启动新
  text/goal，保留旧 active work、原输入和 branch。active compact 对 fork/edit/retry/send-now
  保持统一操作锁。
- **stateOnly 通道**：modelChange 等不渲染 marker 不进 rows.window
  （或产品裁决为可见 row，二选一，不允许「进 window 渲染 null」的隐形行）；
  materializer 出口硬校验：stateOnly/hidden 不进 rows、hidden trigger 不影响 turn count。
- **UI**：`conversationTurnRenderUnits` 改为消费 resolver 结果
  （rows 带 `entityId/productTurnId/visibility`），删除 turnId+latestAssistantText 推断。
- 守恒检查按 15 号设计 §守恒不变量全量落地，失败不发坏 snapshot、记 diagnostics。

验收（L1/L2/L4）：`QD-node`（A1∈T1、A2∈T2 都可见，live≡cold）；`GV-identity` /
`GV-terminal-only` / `GV-late-anchor`；`BG-wake-cold`（独立 model-only 轮、无用户气泡）；
live≡cold 节点级 golden；`assistant-conservation-live`
（流式文本在非 running 相位到达 → 不静默丢，diagnostics+resync——整段消失 live 向量）；
`steer-inline`（S1：steer 不切轮、一段工时、编辑回退整轮）；`drain-per-item`（S3）；
`worked-time-split`（S5）；multi-segment text 全平铺 + fork 只挂最后段（S2）；
retryNotice/goalSet/forkCreated 不再产生 lifecycle marker row（S7/S9/S10，隐形行清零）；
用户 `sendGoalCommand` input 的 canonical real-user row 必须保留。

### P3 写入端 durable：session_input 账本 + promoted 原子性（修「吞消息」的根）

目标：队列/唤醒的存在性不再依赖任何进程内存。

改动面：

- 新表 `session_input`（migration 0015）：
  `id`（= **input/command id**，admission 时即存在）、`session_id`、`kind`、
  `delivery`（steer/queue）、`payload_json`、`admitted_sequence`、`promoted_sequence`、
  `promoted_message_id`（**nullable**，promoted 时与 user message 持久化同事务写入）、
  `status`（admitted/promoted/**cancelled/discarded**——cancelled/discarded 承载 TurnSteerDiscarded 与
  stop-held 语义）、`time_created/updated`。
  status 迁移需覆盖协议既有裁决：`discarded(session_resumed)`（§6-1 重启不保留）、
  `discarded(user_cleared)`（heldQueueInputRequiresChoice 的 clearQueueAndSend）、
  steer 的 submitting 被 stop → 退回 `admitted`（回 held queue），已 drained 被 stop →
  `promoted`（消息留轮内 interrupted，S15）。账本同时为输入类 command 提供 durable
  幂等（当前 command-inbox 幂等表是内存 LRU，进程重启即失效）。
  注：ZCode 的 messageId 在 drain 时才 `createMessageId()`，admission 时没有预分配的
  message id 可复用为 input id；选 nullable 外键对现有 id 流侵入最小，且账本能表达「已接受但未消费」态。
- **promoted 原子性**：drain/promote 与 user message 持久化同事务；
  drained row 文本从账本取，投影不再依赖内存 `queue.items`
  （废除 `onTurnSteerDrained` 的 `if (!item) continue` 静默丢）。
- background wake：`task-notification` 命令入账本（admitted），唤醒执行后 promoted；
  崩溃后 pending wake 可恢复。
- **崩溃/重启语义（已裁决）**：重启后**不保留队列**；账本将未消费项记为
  `discarded(session_resumed)` 留痕，不允许无账本的静默消失。
- 新写入 message/part 增量补 `semantics/anchor/sourceCommandId/cause/visibility` JSON 字段
  （老数据不动，由 P1 normalizer 推导）。

验收（L2/L4）：崩溃窗口重放——admitted 未 promoted 的项冷恢复后恢复为
`discarded(session_resumed)`、**不进 queue**（与 §6 裁决 1 一致）；
promoted 后崩溃 → transcript 必有对应 user message 且不重复（无孤儿、无双写）；
重启后 queue 行为 L4（空队列 + 账本可查 discarded 痕迹）。

### P4 传输与 fork 收尾

改动面：

- **迟到变更送达（已裁决，§7）**：CLI resolver 不感知用户视觉区域，只维护完整 timeline
  authority；窗口外 anchor 的迟到变更**不立即渲染、不 append 到尾部、不丢弃**——
  publisher 记录 dirty range / revision，客户端 materialize 到对应 productTurn 时返回最新结构。
  同规则覆盖「upsert 目标不在已送达窗口」（现状 apply no-op 静默丢，`apply.ts:64-65`）。
- **fork 修补**（只影响新 fork，老数据走兼容原则 6）：
  新复制的 message/part 写 `origin*` provenance；child session metadata、message/part、goal
  snapshot、fork provenance 与 projection anchor 在同一原子事务中写入。所有 child-local
  message/part/tool/timeline/compact/goal 引用（包括 anchorMessageId、compaction
  tail_start_id/summaryMessageId）经同一映射表 remap；只允许显式 originRef 继续指向 parent。
  任一 child-local 引用不可 remap 时整次 fork 失败且不发布 child，不能降级成半成品；
  三条 fork 路径持久产物归一（`forkWorkspaceAtMessage` 补 timeline part）；
  **父侧不再产 forkCreated row**（§7 裁决：fork 关系只在 sessions 树体现，
  child 首部 forkNotice 保留）——原「精确 anchor 替代行尾近似」问题随之消解；
  fork 入口 core 层强校验：只允许每轮结尾最后一段完成态 assistant（§7 裁决 3）。

  fork 原子/remap 要求不改变 workspace 策略：running stable fork 是 conversation-only，
  不 rewind 共享 workspace；compact-covered edit 已改为原 session append-only branch cut，
  不再复用 fork bundle；completed/idle fork 的既有 checkpoint 行为不扩大也不收窄。

验收：窗口外 upsert L2；`fork-remap` golden（逐项检查 child-local 引用且失败回滚）；
`resync-scope`；fork graph cut L4（防回归）。

### P5（独立裁决项，不阻塞 P0–P4）：持久 session_event journal

现状没有持久事件日志（R1）。P0–P4 全部基于「message/part/session metadata/goal 为权威 + 内存事件日志为
live 加速」的现实，不依赖本项。若裁决要建：

- 表形态 `session_event(id, session_id, sequence, kind, data_json)` + per-session allocator；
- 必须 durable/ephemeral 切分（streaming delta 不入库）；
- 收益：session 内全序、账本可退化为 `command.*` 事件、web remote replay 免合成。
- 代价：写放大、retention 策略、与既有 message/part 双写一致性。

## 5. 测试与验收基建

- L1/L2/L4 用例清单见各阶段验收项（与评审列表一一对应），accepted 语义回写
  case catalog 与 coverage matrix。
- **影子重放工具**（P1 交付，P2/P3/P4 复用）：dev 命令遍历本机历史 session，
  经新管线 hydrate，输出：守恒失败清单、diagnostics fallback 计数、与旧投影的结构 diff。
  每阶段上线门槛 = 全量重放无崩溃、无静默丢弃、失败清单审查完毕。
- 守恒失败在开发态暴露诊断、服务层记日志（15 号设计 §迁移建议 12，维持）。

## 6. 裁决结果（2026-07-07 用户拍板，全部落定）

1. **重启后不保留队列**：账本记 `discarded(session_resumed)` 留痕（P3）。
2. **modelChange 可见时机**：输入框切模型不进 timeline；只有切换后实际发送出去的轮
   才落「模型已切换」分隔（与现 R-17 语义一致，冻结）。
3. **fork 只在每轮结尾**：UI 不暴露中间 assistant 段的 fork；core 层强校验只允许
   轮尾最后一段完成态 assistant（P2/P4）。
4. **迟到变更 = dirty range / 懒 materialize**：resolver 不感知视觉区域，只维护完整
   timeline authority；窗口外 anchor 的迟到变更不立即渲染、不 append 尾部、不丢弃，
   publisher 记 dirty range / revision，客户端 materialize 对应 productTurn 时取最新结构（P4）。
5. **本轮 P0–P4 不建持久 session_event journal**：message/part/session_entry 继续是
   durable authority，内存 event log 只做 live 加速；normalizer/resolver/session_input
   修完后如仍需统一事件溯源，再把 session_event 作为 P5 独立方案评审。

## 7. 顺序与业务语义裁决表（2026-07-07 与用户逐项对齐，L1 golden 的规范来源）

诊断纠偏（用户确认）：「上一轮回复不见」的主体是 **assistant 回复整段消失**
（live 拒收闸 + cold 头部跳过，见 §1 表首行），折叠只是次要观感问题。两者都修，
分别对应 assistant 守恒与多段正文平铺。

| #   | 场景                                                                   | 裁决                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 影响面                                 |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| S1  | steer（guide 模式运行中注入）                                          | **内联不切轮，视觉工作段独立（2026-07-19 纠偏）**：气泡内联在注入点，前后 assistant 段同属一个 productTurn；每条 accepted guide 关闭前一 visual work segment 并开启新 segment，各自显示/折叠工时；仍只有一个 fork 入口（轮尾段）；编辑 steer 消息 = 回退整轮重跑。需要 delivery=steer/queue 双语义                                                                                                                                                                                                                                                                    | 切分规则、账本 delivery 字段、turnHeader.workSegments |
| S2  | 同轮多段 assistant 正文（text→tool→text）                              | **row 全序优先**：renderer 必须按 CLI 下发的 row 全序渲染，同一 visual work segment 的早段 text、tool/reasoning/subagent/compact 不能被重新分桶排序；普通 segment 只有一个折叠控件，guide 边界按 S1 开新 segment/控件。轮尾最后一段 assistantText 作为最终正文外置，fork 只挂该 turn 最后一段，retry 只挂全时间线最后一条 assistantText row；轮尾段的复制 = 整轮全部 text 段合并                                                                                                                                                                              | UI render units                        |
| S3  | 队列多条的消费粒度                                                     | **每条一轮**：runtime 改为一次只 drain 一条，队列项:回复:productTurn = 1:1:1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | runtime turn-loop、账本守恒            |
| S4  | goal verify × 队列顺序                                                 | **队列优先（有界窗口）**：verify 调度点（上一轮 settle 时）之前已 admitted 的队列项先消费完再 verify；调度点之后新 admitted 的项进入下一个调度窗口（排在本次 verify/continuation 之后），防止持续追加导致 verify 无限饥饿。notSatisfied 的 continuation 排在本窗口用户输入之后。**补充（catalog BG03，accepted）**：任何 background 任务 running 时 verifier 推迟发请求，background 通知消费后 post-command goal loop 才重新验证——完整调度序 = drain 队列 → 等 background 通知消费 → verify → continuation                                                               | continuation loop 调度                 |
| S5  | drain 拆轮后的「已工作 xx 秒」                                         | **按边界拆分**：各轮显示 trigger→下一边界时长，加和 = 总工时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | turnHeader 计算                        |
| S6  | 轮间自动 compact（新输入触发超阈值压缩）                               | **归下一轮首个活动**：叙事为「用户发送 → 压缩 → 开始干活」（轮内 compact 维持 assistant work 内活动裁决）                                                                                                                                                                                                                                                                                                                                                                                                                                                                | compact placement                      |
| S7  | fork 后父时间线                                                        | **不显示 forkCreated**：fork 关系只在 sessions 树/列表体现；child 首部 forkNotice 保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 投影不产 row；rewind×fork 问题随之消解 |
| S8  | rewind/edit 截断含 fork 点的轮                                         | **随分支消失**：timeline 只反映当前分支；child 仍在 sessions 列表可达                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | branchEpoch 语义                       |
| S9  | retry 痕迹                                                             | **不留痕**：旧轮整段替换；retryNotice 从投影移除（消除隐形行）；要留旧分支用 fork                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 投影不产 row                           |
| S10 | goalSet 边界                                                           | **stateOnly lifecycle + visible user intent**：`goalSet` fact 本身不显示 timeline marker、由 goal 面板承载；每条用户 `sendGoalCommand` 仍生成 canonical visible real-user row，与 text query 共用 `editUserQuery` target，重发保持 goal intent                                                                                                                                                                                                                                                                                                                                 | stateOnly 与 user input 分层           |
| S11 | 多个 background 完成（idle）                                           | **每个通知一轮**：与 S3 对称，1:1 对应，串行 model-only 轮（当前行为，冻结）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | wake 调度                              |
| S12 | goal verifying 期间的动作裁决（2026-07-08/11 细化，2026-07-13 更新）    | **goalVerifier 不再是独立操作锁**：消息类（sendText//goal）与 typed `/compact` 均入队；fork **允许**（目标是稳定历史即可，对齐 catalog H06）；sendQueuedNow **允许** = 先 stop verifier（计 failed(cancelled)、goal 转 paused）再 drain（对齐 catalog 238 行）；latest real-user input edit（text 或 goal）**允许** = 先 stop verifier，再按统一 `editUserQuery` target rewind/fork 并按原 intent kind 重发；barrier 失败保留旧 work/input/branch、不启动新 goal。非 latest real-user input edit 仍拒；stop 可中断 verifier。只有 active/queued compact 命中 `compactOperationLock`。 | guard/availability                     |
| S13 | model-only 续跑轮前的模型切换                                          | **照常显示分隔**：只要某轮实际使用了与上一轮不同的模型就落分隔，不论触发者是用户还是 goal 续跑/BG 唤醒                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | modelChange placement                  |
| S14 | background 唤醒轮的可见触发形态（2026-07-08，落定 15 号设计待裁决 #1） | **无触发行**：唤醒轮只显示 assistant 内容 + 自己的「已工作」；后台任务信息由 background 抽屉/状态区承载；协议文档 rows 示例中的 `turn:t2/input:background-result` 行需订正                                                                                                                                                                                                                                                                                                                                                                                               | rows contract                          |
| S15 | steer 已提交未确认 drain 时用户 stop（2026-07-08）                     | **按是否已注入区分**：runtime 已确认 drained → steer 气泡保留在轮内原位（轮标 interrupted，stop 后可 edit/retry，对齐 G12 先例）；仍在 submitting → 回退 queue（held，autoDrain=false），账本退回 admitted                                                                                                                                                                                                                                                                                                                                                               | stop 收口、账本状态迁移                |

### 文档回写清单（S1–S15 落定后需同步的既有文档）

| 文档                                                       | 需改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/conversation-product-protocol.md`                    | ① `goalVerifierActiveWorkOperationLock` invariant 与 stable guard 两处按 S12 改写（消息和 typed compact 入队、fork 允许、sendQueuedNow=stop-barrier、latest text/goal edit=stop-barrier）；② Fork 表 `activeWork.kind=goalVerifier → reject` 行改为 allow；③ Projection Shape 的 rows 示例删去 `turn:t2/input:background-result` 行（S14 无触发行）；④ 区分不产 marker 的 `goalSet` lifecycle 与必须可见可编辑的用户 goal input；⑤ `compactActiveWorkOperationLock` 只覆盖 active/queued duplicate compact |
| `docs/conversation-session-case-catalog.md`                | 回写 S1–S15（尤其 S1 steer 内联、S3 每条一轮、S4 有界窗口、S14/S15），H06 与 238 行语义保持为准                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/formal-proof`                                    | 移除 goalVerifier 旧锁语义，对齐 S12                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | 按 §4/§5 各阶段验收用例扩条目                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docs/v4-refactor/15-timeline-resolver-design.md`          | 待裁决 #1 → S14、#2 → §6-2、#3 → S12、#4 → §6-4，标注已裁决                                                                                                                                                                                                                                                                                                                                                                                                                 |
