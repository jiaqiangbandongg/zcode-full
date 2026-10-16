# Timeline Resolver Design — 架构/逻辑 Review

> 状态：**历史前审记录**。评审结论已经由
> [16-timeline-authority-plan.md](./16-timeline-authority-plan.md) 收敛并实施；下文路径和发现描述评审时基线。

> 评审对象：[`15-timeline-resolver-design.md`](./15-timeline-resolver-design.md)
> 评审性质：只做架构/逻辑 review，不改代码、不改被评审文档。
> 评审方式：通读设计文档 + 投影/hydration/持久化代码 + case catalog + coverage matrix，并对关键经验判断做代码级核实。

## 结论先行

方向是对的：把 CLI 从 "row append reducer" 升级为 "timeline authority" 是正解。

但**设计文档把权威性押在了 constraint graph / resolver 这一层，而真正最不权威、最容易继续吞消息的是它上游的「语义归一 + 实体身份」这一层**——这一层今天在 live 和 cold 两条路径上是两套实现，持久化锚点覆盖率 ~2%，而设计文档对它只给了字段清单，没有给归一算法和身份推导规则。

下面 10 条 finding 按严重度排序，最后给出必须冻结的 invariant、mental-model 裁决和 E2E 补充。

## 需要先纠正被评审文档的一处判断

**fork 复制 transcript 并没有绕过 sequence 写入。** `copySessionMessagesForFork`（`apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts:51-93`）走 `persistMessage/persistPart` → `sessionStore.saveMessage/savePart`（`.../methods/message-persistence.ts:331-364`），而 saveMessage/savePart 一定会分配 sequence（`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts:32-35,73-77`）。所以文档「fork/copy 之类路径绕过统一 saveMessage」的猜测，对当前 fork 主路径不成立（见 F5）。

---

## Findings（按严重度排序）

### F1 —【Blocker，命中 Q1】冷恢复 hydration 是「残缺的反向映射器」：goal verify / model change / session_entry 事实在每次冷恢复被整段丢弃

**问题。** `synthesizeEventsFromMessages` 只反向合成 text / reasoning / tool / **仅 compact 的** timeline / subtask（`transcript-hydration.ts:627-651`；`synthesizeCompactPart` 只对 `context_compaction` 返回 true，`165-198`）。`timelineType = goal_verification / model_change` 的 timeline part 落到 `synthesizeCompactPart` 返回 false 后**没有任何分支消费**；`session_fork` 靠 message 级 `isForkTimelineMessage` 单独处理。更关键：真实数据里 goal verify 主要存在 **`session_entry`（1,402 行，主体 `target_completion_verification`）**，而 hydration 读的是 `messages()`（message+part），根本不碰 session_entry。

**为什么会吞消息 / marker 漂移 / 老数据不可恢复。** 直接后果：**每一次桌面刷新恢复、web remote replay，goal verify marker 和 model change marker 都会消失**（它们只在 live 事件流里存在，冷路径不重建）。这不是边缘 case，是所有含 goal / model 切换的会话的普遍回归。而且 `eventsCoverTranscript` 的守恒判据（`transcriptFootprint`，`807-862`）只数 compact/subagent/fork，**完全不检查 goalVerify/modelChange**，且是 `>=` 子集覆盖（`footprintCovered`，`907-917`），所以它会把「缺 goal verify 的 snapshot」判为已覆盖——守恒检查对这两类 marker 是瞎的。

**建议改法。** 这恰恰印证设计 §「持久化字段与数据库关系」第 7 条。但文档必须显式把 **session_entry 与 goal_verification/model_change timeline part 列入 Event Normalizer 的输入源**，并在 L1/L2 golden 里加「含 goal verify + model change 的 transcript 冷恢复 ≡ live snapshot」。在 resolver 落地前，这是当前栈最确定、最普遍的丢 marker 根因。

### F2 —【Blocker，命中 Q1/Q6】queue drain 与 background wake 在 live 落进「当前 runtime turn」，cold 却按 real-user 切分——两条路径行为相反，正是「上一轮 assistant 被吞」的机制；而设计缺「同一 runtimeTurn 内如何切 productTurn」的算法

**问题。** runtime 侧核实：`drainPendingInput`（`.../methods/steering.ts:712-751`）发 `TurnSteerDrained`，它在 `.../methods/turn-loop.ts:39` 的 **active turn loop 内**被调用，drained 输入作为 `drainedSteerForNextRequest` 喂进同一轮的下一个 provider request——**drain 不产生新的 TurnStarted**。投影侧 `onTurnSteerDrained`（`product-projection.ts:879-903`）据此把 drained userInput row 追加进 `turnIdOf(event)`=**当前 turnId**，不建新 turnHeader、不建新 productTurn。而冷恢复按 `isRealUserTurnStarter` 给每个真实 user 起新 turn（`transcript-hydration.ts:708,714-728`）。于是：

- **live**：Q1/A1/Q2(drained)/A2 全在 T1 一个 turnId 下 → UI 若按 turnId 取 latestAssistantText，A1 被折进 history（设计 Case A）；
- **cold**：Q2 是 real user starter → 起 hydrate-turn-2，A2 归 T2 → 结构与 live 不一致。

background wake 同理：model-only user 不是 real-user-starter（`isRealUserTurnStarter`→false），冷恢复会把处理 `<task-notification>` 的 A2 并进上一轮 T1；live 则可能建 model-only 轮。**两条路径对同一份事实给出不同 turn 结构**，这就是「错位/吞消息」的结构性来源。

**为什么设计还没真正解决。** 设计 §「Queue Drain」/「Background Bash」主张 drain/wake 必须拆新 `productTurnId`，方向正确。但**设计只声明了 cause edge 和 turn edge，没有给出「当多个 productTurn 共享一个 runtimeTurnId 时，如何把线性事件流里的 AssistantSegment 分配给哪个 productTurn」的规则**。A2 与 A1 同 turnId、同 runtime turn，resolver 凭什么把 A2 判给 T2？唯一可用的判据是 `eventSeq`：drain/wake 的 UserIntent 的 eventSeq 之后、同 runtimeTurn 内的 assistant segment 归新 productTurn。这条规则是 Case A 的核心，却在文档里缺失。

**建议改法。** 把这条切分规则写成一等 invariant：*在同一 runtimeTurnId 内，productTurn 边界由 trigger 类 UserIntent（drain / model-only continuation / background wake）的 eventSeq 划定；边界之后、下一个边界之前的所有 AssistantSegment / WorkActivity 归该 productTurn*。并要求 live 与 cold 都只经这条规则（即 live 也要在 drain 处产出 productTurn 边界，不能只追加 userInput row）。

### F3 —【Critical，命中 Q5/Q2】实体身份无法从持久化事实推导：rowId 是易失计数器，UserIntent（尤其 drained/model-only）根本没有 messageId → 输入守恒 invariant 无法 keying

**问题。** `rowBase` 的 `rowId = this.nextRowId++`（`product-projection.ts:1612-1619`）是进程内自增，冷恢复从头重排，**rowId 不是稳定业务身份**。而 `messageIdByRowId` 只在 assistant 行（`openTextRow`，`597-599`）写入；`buildUserInputRow`（user/drained/model-only）**从不登记 messageId**。

**为什么导致守恒不可执行 / 老数据不可恢复。** 设计 §「守恒不变量」第一条「每个 visible inputId 必须在 QueueItem 或 UserIntent 二选一」，其 keying 依赖一个稳定的 `inputId`——但当前 UserIntent 没有任何稳定 id 可用（rowId 易失、messageId 缺失、`sourceCommandId` 只在 queue item 上有，`onTurnSteerQueued:859`）。fork/edit 的 `rowIdForMessageId` 反查（`303-309`）也因此只对 assistant 有效，user 行「暂无 messageId」在 `onRewindTriggered` 里被直接放弃（`287-289`）。结果是：核心的输入守恒、fork target 计数、「drained 文本进 history 还是留 queue」的二选一裁决，**都缺一个可 key 的实体身份**。

**建议改法。** 设计必须为**每一类实体**给出 `entityId` 的确定性推导。优先级：UserIntent 的 entityId 应由持久化的 **user message id**（runtime 侧 `persistUserPrompt` 已有 `messageID`，`message-persistence.ts:44`）派生；drained/queue 用 `sourceCommandId`；assistant 用 assistantMessageId；compact 用 operationId；goal verify 用 `targetId+iteration`；fork 用 `parentSessionId+targetMessageId`。没有稳定 id 的实体不允许承载守恒判定。这一条不定死，F1/F2 的守恒检查都是空中楼阁。

### F4 —【Critical，命中 Q6 goal verify】当前 goal verify 以 verificationId 为身份、无 targetId、无 anchor——正是设计明令禁止的反模式

**问题。** `onTargetVerification` 用 `goalVerifyMarkerRowIdByVerificationId.set(payload.verificationId, …)`（`product-projection.ts:1398,1430`）作身份，marker payload 只带 `iteration + outcome`（`1396`），**不带 targetId，也不带任何 anchor**——marker 直接 append 在 `turnIdOf(event)` 的行尾（`1393-1397`）。

**为什么会错位。** (a) 同一 iteration 的 retry 会带**新的 verificationId** → 生成**第二个 marker**（设计 §「Goal Verify」：`verificationId` 只能是 alias）；(b) 无 anchor → 事件迟到或 trace turnId ≠ 被验证 assistant 的 turnId 时，marker 落到错误轮次尾部（设计 Case C）；(c) 新 target 的 iteration 从 1 重置，单靠 iteration 会跨 target 撞号。存储文档 §「更新规则」已经把身份定为 `targetId + goalIteration`，契约里 `GoalVerificationTimelinePart` 也有 `targetId/goalIteration/anchorMessageId`——**设计是对的，是当前 reducer 落后于契约**。

**建议改法。** resolver 里 goal verify 身份必须是 `targetId + goalIteration`，`verificationId` 降为单次 attempt alias；placement 必须走 `anchor = anchorAssistantMessageId || anchorTurnId || explicit fallback`（设计 §「Goal Verify」）。并把这条写成守恒：*同一 targetId+iteration 只有一个 boundary entity*。

### F5 —【Major，命中 Q4】sequence NULL 不来自主 runtime/fork 路径（已核实），来自尚未定位的旁路；且 on-conflict 语义会把 NULL 行「再保存即漂到队尾」

**问题与核实。** 已核实两条主要写入：runtime persist 与 fork copy **都**经 saveMessage/savePart，后者永远用 `coalesce(max(sequence),-1)+1` 分配非空 sequence（`messages.ts:32-35,73-77`），on-conflict 时 `coalesce(existing.sequence, excluded.sequence)` 保留旧值。所以文档「NULL 是老数据包袱 + 疑似 fork/copy 旁路」的判断，**fork 主路径这部分不成立**。但文档观察到的 1,690 条 message NULL / 331 sessions / 迁移后仍在增长是真实信号 → 说明存在**另一条未定位的写入旁路**（raw SQL / 导入 / 修复脚本 / 迁移工具），它绕过了 saveMessage。

**隐藏风险（值得单独钉）。** on-conflict 分支 `sequence = coalesce(existing.sequence, excluded.sequence)`（`messages.ts:41-44` / `84-88`）：若一条**现存行 sequence 为 NULL**被再次 saveMessage（assistant 完成后会二次保存），`existing.sequence` 为空 → 取 `excluded.sequence`=该 session `max+1`=**队尾**。也就是说，任何 NULL-sequence 历史行一旦被再保存，会被搬到时间线末尾 → 错位。这是一个具体的数据搬移向量。

**建议改法。** (1) 先按设计 §「迁移建议」第 2 条审计并封死旁路，加 DB invariant（NOT NULL / 触发器）阻止未来再产 NULL；(2) resolver 读取期**永远保留确定性 tiebreak**（现读序 `sequence is null, sequence, time_created, rowid`，`messages.ts:117` 是对的，但要保证「同一 session 多次 hydrate 得到同一顺序」这条设计承诺在 NULL 混排时也成立——需 golden 钉死）；(3) 修 on-conflict，使「再保存 NULL 行」不改变相对位置。

### F6 —【Major，命中 Q8「看起来高级但落地会失败」】constraint graph + 全局拓扑排序，对一个近乎全序的问题是过度设计；snapshot.resync 粒度与 windowing 冲突；fallback row 放置未定义

**问题。** 排序问题的骨架其实是**近乎全序**：`(branchEpoch, eventSeq)` 已能给出绝大多数顺序，真正需要「非尾部修正」的只有一小撮 boundary（goal verify 迟到、fork notice）。设计 §「权威排序」却主张对五类边做 "deterministic topological placement"。**通用拓扑排序的风险**：边一旦缺失或成环（late event + retry + fork copy 很容易造出隐式环），会 fail 得很隐蔽，且「相同位置再用 entityOrdinal」的 determinism 依赖每个实体都拿到稳定 ordinal——这又回到 F3 的身份问题。

其次，设计 §「Delta 与 Resync」说「可见 entity 的 orderKey 落在已发送窗口中间 → snapshot resync」，但 `rows.window` 是**窗口化**的（26,942 messages / 96,112 parts 不可能全量常驻）。文档没有定义：resync 是整会话还是仅窗口？锚点落在**未加载窗口之外**时怎么放？goal verify 迟到很常见 → 频繁全量 resync 会在长会话里造成可感知的刷屏。

第三，迁移建议第 7 条的 diagnostics fallback row 很好，但**没定义 fallback row 的 orderKey/productTurn 归属**——「无法归组」的行仍然需要一个位置才能渲染，fallback 只是把放置问题往后推。

**建议改法。** (1) 把排序表述为「以 `(branchEpoch, eventSeq)` 为主全序 + 一组**有界的 anchor 局部重挂（re-parent）**」，而不是通用图求解；anchor 只影响「这条 boundary 挂到哪个 productTurn 尾」，不改全局拓扑。(2) resync 定义为**按 productTurn 子树的 scoped resync**，并明确「anchor 在窗口外 → 扩窗或延迟放置」的行为。(3) fallback row 明确放置=已知时间线末尾 + 可见诊断标记 + 计入守恒失败计数，不得静默。

### F7 —【Major，命中 Q2】四层拆分不够：branchEpoch（分支身份）、delivery/snapshot revision、visibility/semantics 都被塞进了其它层

**问题。** `eventSeq / runtimeTurnId / productTurnId / visualPlacement` 覆盖了「到达序 / runtime 归属 / 逻辑轮 / 视觉位置」，但：

- **branchEpoch**（rewind 截断、fork 后处于哪条线性历史）只出现在 `TimelineOrderKey` 里，没被抬成一等「顺序层」。rewind 会重写历史（`onRewindTriggered:275-301` 从 turn 首行整段 `row.removed`），同一 productTurnOrdinal 在 rewind 前后语义不同 → branch 必须是排序主键的最外层。
- **delivery/snapshot revision** 与 timeline order 被混在一起。`visualPlacement` 同时承担 lane、anchor、order 三件事；而「客户端已收到哪一版」（revision/epoch，`attachRevision:181-192` 已有 revision）是 delivery 维度，和视觉排序正交，应单列。
- **visibility/semantics** 是独立的归一维度（visible / modelOnly / stateOnly），现在被隐含进 lane。lane 是「放哪条泳道」，visibility 是「放不放进 rows.window」——二者正交（见 F8）。

**建议改法。** 把顺序模型显式扩成：`branchEpoch`（最外）→ `productTurnOrdinal` → `laneRank` → `entityOrdinal` → `lifecycleOrdinal`，并把 `visibility` 和 `deliveryRevision` 作为与「顺序」正交的两个独立维度写进 snapshot contract。

### F8 —【Moderate，命中 Q6 modelChange + rows.window 纯度】实现里根本没有 stateOnly 泳道：每个 marker 都是 rows.window 里的 row；modelChange 冷恢复根本不出现

**问题。** `onTurnStarted` 把 modelChange 直接 `row.appended` 进 rows.window（`product-projection.ts:388-403`）；投影里 compact/goal/fork/model 全部是 `timelineMarker` row，**没有任何 stateOnly 通道**。设计 §「Model Change」和 §「守恒·渲染守恒」要求「若 modelChange 不在 transcript 可见，应为 stateOnly，不进 rows.window」——但当前结构无法表达 stateOnly。另外，冷恢复不合成 ModelSelected，也不合成 model_change timeline part（F1），而 modelChange marker 又由 live 的 `lastTurnModel` vs `config` 比较得出（`381-410`）→ **model change 在冷恢复里既无 config 变化事件、又无 timeline 反合成 → 永远不出现**。

**为什么会错位。** hidden/modelOnly/stateOnly 的实体一旦以 row 形式进 window，会污染虚拟滚动、turn grouping、history 折叠（设计 §「Lane 与 Placement」明确点名）。当前 model-only 只在「跳过 visible userInput row」（`416-421`）这一处 case-by-case 处理，没有结构保证。

**建议改法。** 引入真正的 `stateOnly` 分类，并把「stateOnly/hidden 不得进入 rows.window」「hidden/modelOnly trigger 不得影响 visible user turn count」做成 materializer 出口的硬校验。modelChange 的 timeline part 也必须纳入冷恢复反合成（合入 F1）。

### F9 —【Moderate，命中 Q3 持久化判断】三层存储判断总体成立，但 session_entry 是 goal verify 的真实权威源，需并入 normalizer 并与新 timeline part 去重

**问题/肯定。** 文档对三库定位（CLI `db.sqlite` = transcript 权威；app `zcode.db` = 元数据/通知；`tasks-index.sqlite` = 列表/搜索，不作顺序源）与存储文档一致，判断成立。但文档自己列出 `session_entry`（1,402 行，主体 `target_completion_verification`）是 goal verify 事实，而 §「读路径」/迁移建议里对 session_entry 的读取地位着墨很轻，hydration 也完全不读它（F1）。真实数据里 `timelineType=goal_verification` 只有 10 条、session_entry 却是主体 → **goal verify 现阶段主要活在 session_entry**。

**建议改法。** 把 session_entry 显式列为 Event Normalizer 的一等输入源；goal verify 去重键 = `targetId+iteration`，跨 `session_entry`（legacy）与 `timeline/goal_verification`（new）合并。fork 侧已有 `copyGoalVerificationEntriesForFork` 改写 anchor 到 child message id（`session-fork.ts:282-354`），说明 session_entry 的 anchor 语义已在用，resolver 不能忽略它。

### F10 —【Moderate，命中 Q7】desktop continuous 与 web replayable 只有在 F1/F2/F3 统一后才能「共享 resolver」；当前「等价」判据是子集、无序，证明不了收敛

**问题。** 设计目标 6 主张两 profile 共享权威 snapshot、delivery 只影响中间帧。架构上 live（`applyEvent`）与 cold（`synthesize→applyEvent`）确实复用同一个 `ProductProjection`，这点是对的。但「共享」目前是名义的：分类机制分叉（live 用 `TurnStarted.inputVisibility`/事件 payload；cold 用 `getConversationMessageProjectionPolicy` + `isRealUserTurnStarter`），等价性只由 `eventsCoverTranscript` 的 `>=` 子集、顺序不敏感、且对 goal/model 瞎的 footprint 保证（`907-941`）。所以它能通过「覆盖」，却挡不住 F1/F2 的结构分叉。

**建议改法。** (1) Event Normalizer 成为**唯一**分类入口，live 与 cold 都先归一到同一 typed semantic event，再进 ledger；(2) 把等价判据从 footprint 子集升级为**节点级 golden 等价**（productTurn 结构、每 turn 的 segment 顺序、boundary anchor、visibility 全都要对）；delivery profile 差异只允许出现在「中间帧数量」，不允许出现在终态 snapshot。

---

## 方向对的部分 & 必须冻结的 invariant

方向认可：raw facts → **semantic normalization** → semantic ledger → constraint（建议弱化为 anchor 局部重挂）→ resolved snapshot → UI。要让它真正「不猜/不补/不吞」，以下 invariant 必须在实现前就冻结（✅=设计已有需落地；➕=设计缺）：

1. ✅→落地 **输入守恒**：每个可见 inputId 恰在 QueueItem 或 UserIntent 二选一——**前提是 F3 给出 UserIntent 稳定 entityId**。
2. ➕ **productTurn 切分规则**：同一 runtimeTurnId 内，productTurn 边界由 trigger 类 UserIntent 的 eventSeq 划定，边界后的 assistant segment 归新 productTurn（F2）。
3. ✅→落地 **goal verify 单一身份**：`targetId+iteration` 唯一，verificationId 仅 alias，必须带 anchor（F4/F9）。
4. ➕ **visibility 与 lane 正交**：stateOnly/hidden 结构上不可进入 rows.window；materializer 出口硬校验（F8）。
5. ➕ **live≡cold 节点级等价**：两 profile 经同一 normalizer，节点级 golden 相等，而非 footprint 子集（F1/F10）。
6. ➕ **身份可从持久化推导**：entityId 全部由 messageId/partId/operationId/targetId+iteration/sourceCommandId 派生，严禁依赖 nextRowId++ 或 DB 字典序（F3/F7）。
7. ✅→落地 **无静默丢弃**：无法归组的 visible message/part 必进 diagnostics fallback 且计入守恒失败（F6）。
8. ➕ **顺序主键分层**：`branchEpoch` 为最外层，rewind/fork 换 epoch，不与 productTurnOrdinal 混用（F7）。

---

## Mental-model 裁决：哪一层最不权威、最可能继续吞消息

**最不权威的是「semantic normalization + 实体身份赋予」这一层**，不是 constraint graph：

- **它今天是两套实现**（live 事件 payload vs cold projection policy），且冷路径残缺（F1：goal/model 整段丢、session_entry 不读），所以同一份持久化事实经两路径会得到不同 typed entity——下游 ledger/graph/resolver 再精巧，喂进来的语义已经分叉。
- **它依赖的持久化锚点覆盖率极低**：`semantics` 569/26,942、`anchor` 432/26,942、goal_verification timeline 仅 10 条。normalization 想稳定判 visible/modelOnly、想给 boundary 找 anchor，底层字段还不在。
- **实体身份没定死**（F3），导致守恒 invariant 无法 keying，resolver 的 determinism 无从谈起。

constraint graph 反而是最不该先重的一层（F6）：排序骨架近乎全序，真正的难点是**上游把每条事实归一成带稳定身份、带 anchor、带 visibility 的 typed entity**。落地顺序应是：先把 normalizer 做成唯一入口 + 补齐 session_entry/goal/model 反合成 + 定死 entityId + 补 4 类语义字段的写入，**再**谈 resolver 的 placement。

---

## E2E / coverage matrix 需要补的条目（命中 Q9）

现状：A09/E06/E08/F07/H08 missing、E10 failing、G01–G04 partial。resolver 专项还需新增（先落 L1/L2 golden，再挑代表性 L4）：

**L1/L2 golden（reducer/materializer，归 `LC`/新增缩写）：**
- **QD-node**：queue drain 两轮 → productTurn 切分 golden：A1 属 T1、A2 属 T2 且都可见；断言 **live≡cold 的 productTurn 结构一致**（F2/F10）。
- **GV-identity**：同 targetId 同 iteration 的 verifier retry（两 verificationId）→ 单一 boundary（F4）；跨 target iteration 重置不撞号。
- **GV-late-anchor**：`TargetCompletionVerification` 迟到到下一轮 start 之后 → 按 anchor 落回原 turn tail（Case C；现 `P03` 只覆盖「marker 先于 final assistant 到达」）。
- **MC-cold**：含 model_change 的 transcript 冷恢复后 marker 仍在（F1/F8）。
- **GV-cold / session_entry**：goal verify 存在 session_entry 时冷恢复可重建（F1/F9）。
- **coverage 守恒扩项**：`eventsCoverTranscript` footprint 增加 goalVerifyCount / modelChangeCount 且改为**顺序敏感等价**（F1，`807-941`）。

**L4 代表性：**
- **BG-wake-turn**：background completion → model-only wake 建独立 productTurn、A2 归属它、无 user 气泡（现 `BG05` 只断「无 notification 气泡」）。
- **multi-segment**：一轮 A1.1 + tool + A1.2 → 一个 ProductTurn 两个 AssistantSegment 全保留，fork/retry 只挂最后一段（现 `E10` failing、`FM` 覆盖 fork，但缺 node 断言）。
- **modelChange stateOnly**：若产品裁 modelChange 为 stateOnly，断言它不进 rows.window、不影响 turn count / 虚拟滚动（F8）。
- **fork/null-sequence**：含 NULL sequence 或再保存路径的 fork child，冷恢复顺序稳定、不漂队尾（F5）。
- **resync-scope**：anchor 落在已发送窗口中间/窗口外时的 scoped resync 行为（F6）。

---

## 附：评审读取的代码/文档锚点

| 层 | 路径 |
| --- | --- |
| 设计文档 | `docs/v4-refactor/15-timeline-resolver-design.md` |
| 投影 reducer | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts` |
| 冷恢复反合成 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts` |
| message/part 仓库 | `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts` |
| 迁移 0014 | `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts` |
| drain/turn 运行时 | `apps/zcode-cli/packages/core/src/runtime/methods/steering.ts`、`turn-loop.ts`、`turn.ts` |
| fork copy | `apps/zcode-cli/packages/core/src/runtime/methods/workspace-checkpoints.ts`、`session-fork.ts`、`message-persistence.ts` |
| 存储契约 | `docs/chat/conversation-transcript-storage.md` |
| case catalog | `docs/conversation-session-case-catalog.md` |
| coverage matrix | `docs/testing/conversation-session-e2e-coverage-matrix.md` |
