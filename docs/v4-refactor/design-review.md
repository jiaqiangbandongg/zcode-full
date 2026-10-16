# V4 重构设计 Review：对照现有代码与历史 bugfix 的交叉验证

- 状态：**2026-07-04 迁移前审计记录**。下文“现有代码”、路径、行数和待裁决项描述的是
  V4 硬切前基线；当前实现以本目录 [README.md](./README.md) 导航的规格和代码为准。
- 日期：2026-07-04
- 输入：docs/v4-refactor/ 全部 10 篇 + conversation-product-protocol.md 全文
- 方法：先做纯设计审查；再对五个代码域（renderer 拼装层 / 流事件与快照同步 / store 与 web 入口 / 传输与远控 / CLI 事实源侧，合计约 2 万行）通读扫描，把注释里的历史 bugfix/workaround 聚成 **60 类病例**，逐类判定新设计「结构性消灭 / 需钉死规则 / 设计未覆盖 / 会换马甲回来」。病例均附代码位置与注释原文（见附录）。

## 1. 结论摘要

**方向被代码强烈背书。** 60 类病例中约 40 类被新设计结构性消灭；而且旧代码已经自发长出了 v4 的半成品——owner/observer 双流被迫合并回单 seq 流（taskRealtimeBus.ts:685）、bridge 层被现实逼出三个手工"代际"字段（bridgeSessionId/bridgeGeneration/recoveryId）、CLI 协议边界为了 replay 可复现被迫做确定性合批（server-operations.ts:3277）。这些都是「现实在朝设计的方向修补丁」的证据。

**三类主要工作项：**

1. **地基失真（最重要）**：README 地基表「rpc 可靠性层成熟：ACK、心跳、断线重放」不成立。`PersistentProtocol` 是随 VS Code 架构移植的库代码，**全仓零生产部署**（实际链路走无 ACK/重放的 `SocketProtocol` / `MessagePortProtocol`），且缺收端去重、缺服务端重连附着、从不主动发 ACK。Phase 2 的性质是「首次生产化一个未验证的可靠层」，不是「打两个小补丁」。→ §2、R-02。同级失真还有一处：**事件日志现状纯内存不落盘**（M8），「CLI 重启从 SQLite 事件重放重建」不成立，需按 §9.2 做持久形态决策。
2. **schema 缺口**：sessionConfig（provider/model/thought/followupMode 当前值）、usage/contextWindow、backgroundWorks[]、plan/todo、时间戳与工时等一批 UI 必需状态在 09 无落点——两路扫描独立发现同一缺口，对应的现存补丁群会原样带进新架构。→ §4
3. **协议规则钉死清单**：订阅代际（epoch）、重复帧三分支处理、seq/rowId/revision 确定性、snapshot 原子性等约 18 条，不写死则本次要消灭的 bug 类会换马甲回来。→ §3

**持久化最终口径（§9，经作者裁决后收敛）：** CLI 侧 SQLite **零新表、零迁移**。用户 query 队列不持久化；连锁推论 command/continuation inbox 均为内存受理台账，崩溃窗口的幂等由「效果自带 `sourceCommandId`」承担；唯一存储改动是 message/part 的 additive JSON 锚点字段。持久层哲学一句话：**唯一不可丢状态 = transcript + 锚点，其余（事件日志、投影、队列、inbox）全是可重建软状态**——与 01 自相似恢复原则完全对齐。

**裁决台账：**

| 状态 | 事项 |
| --- | --- |
| 已裁决 | queue（用户 query 队列）不持久化 → inbox 两表不建、`queue_auto_drain` 列不需要、C-03 消解（CLI 重启一律不重放，在途命令由客户端 `commands/query` 对账后交用户决定重发）；03「Inbox 落盘」与 01/02/04「SQLite 事件重放」表述待按 §9.3/M8 改写 |
| 已裁决（2026-07-05） | ① 事件日志持久形态 = **方案 B**（内存有界日志 + logEpoch，零表）；② fork/createSession 崩溃窗口防重 = **child session 记 `source_command_id`**；③ C-01 多端动作权限 = **全权对等**（幂等收口）；④ C-04 = **保留 draft**（推翻 10-P2，createSession.firstInput 改可选，draft 纯内存不落盘）；⑤ 10-P3 rewind = **删除独立命令**（editUserQuery 的 UI 入口）；⑥ 执行路径 = **硬切**（放弃双写期，见 08/11） |
| 待裁决 | §5 其余确认点（C-02 pending TTL、C-06 Phase 2 止血范围、C-07 行为变更清单、C-08 stream-animate 库化）；G-12 fault catalog；G-13 鉴权面；四个 PB-* 边界 |

建议行动顺序：**Phase 0 动手前**——按 §2.2（M1–M8）与 §7 回写设计文档；完成 §3 的 18 条规则钉死与 §4 的 schema 补章；定掉 §9.2 与 fork 防重。**实施期**——§8 黄金测试/混沌装置升为一等验收（rpc 层首次生产化必须有它护航）。

## 2. 现状诊断核实结果

### 2.1 属实（抽查全中）

四个 renderer 锚点行为与描述一致（zcodeChatMessages.ts:549/:904/:1457/:2431）；规模数字全部准确（3089 / 1056 / 2141 / 5871 行）；`afterSeq`+`includeSnapshot`（zcode-protocol:2109）、`expectedRevision`（:2270）、`reduce()`（event-reducer.ts:517）、`buildTraceTree`（model.ts:241）、channelClient.ts:173 无合批、base64 双编码（webRemoteControlManager.ts:781）、`Pause=7` 确为未实现空位（`ReplayRequest=6`/`Resume=8` 同样只在枚举里）、`@tanstack/react-virtual` 依赖与 GitPane 等参考实现、`content-visibility` 兜底（ChatConversationContent.tsx:9）、旧协议源码已清。

### 2.2 失真 / 需要改写（按影响排序）

| # | 设计原文 | 实际情况 | 影响 |
| --- | --- | --- | --- |
| M1 | README 地基表「rpc 可靠性层成熟」；05「桌面 socket 走 PersistentProtocol」 | PersistentProtocol 零生产部署；收端无去重（protocol.ts:411 无 `id <= incomingAckId` 丢弃分支，重放的重复消息原样上抛）；服务端无「新 socket 绑回旧协议实例」的握手；ACK 仅靠 5s KeepAlive 捎带；判死实际 20–40s（20s 间隔 timer 查 20s 超时）。现状是「0.5 层可靠性」（仅 relayProtocol 那套），不是「两套半吊子」 | Phase 2 工作量与风险画像重估，见 R-02 |
| M2 | README 病根 2「每个 delta 都是独立 EventFire 帧」「现有合批只省渲染」 | CLI 协议边界已有确定性字节预算合批（server-operations.ts:447、:3277「不能用 live setTimeout，否则 replay 无法复现边界」）；客户端合批还承担「控制事件到达前强制 flush 保序」职责（useTaskStreamEvents.ts:471） | 病根措辞改为「合批粒度小、每协议事件仍独立成帧、relay 两次 base64」；05 频率预算基线以实测帧数为准；并需裁决 CLI 这层合批的删留（R-14） |
| M3 | 03「queue 是纯内存（agent-runtime.ts:159 `pendingInputSequence`）」 | `pendingInputSequence` 只是 id 计数器；真正易失的是**两处**：CLI 侧 steer 队列 `activeTurn.pendingInputs`（纯内存）+ UI 侧 deferred queue（renderer 内存，刷新即丢） | 作者已裁决 queue 不持久化（§9.3）：修复形态 = 两处队列所有权统一收进 CLI 内存；03「Inbox 落盘」段的归因与 `pendingInputSequence` 表述按 §9.3 改写；UI 本地 queue 直接废弃仍成立 |
| M4 | README 地基表「协议已是 seq 单调增量事件」 | 骨架在，但协议 seq 是按 `(session record, deliveryKind)` 的**内存懒编号**（server-operations.ts:201-255、:634），重启后 afterSeq 无意义、不同 deliveryKind 各一套 seq 空间、每次订阅全史重扫 | v4 要把 seq 升格为持久日志属性，这是新增工作不是现成地基（R-04） |
| M5 | 02「ProductContext 各维度对应的 CLI 事实全部已存在」 | queue 维度例外：deferred queue 事实今天在 UI 侧 | 03 的队列收编是 02 的前置依赖，分期顺序里写明 |
| M6 | 05「五六条重连入口」；01「三条 web 链路」 | 实测重连入口约 10 条；web 实为 3+1 种形态（还有 home-only stub 模式，约 20 个手工 stub 服务） | 诊断方向对，量级低估；stub 模式消失后需定义 host 不可达的 UI 降级形态（G-11） |
| M7 | 08「旧协议仅剩约 200 个 dist 产物」 | 实测 324 个 | 无实质影响 |
| M8 | README 地基「reduce(events) 重建 projection，冷热恢复一致」；02「session resume 时从落盘事件重建，无第二条恢复路径」；01「CLI 重启 → 从 SQLite 事件重放重建投影」 | **事件日志不落盘**：`SessionEventStorePort` 全仓唯一实现是 `InMemorySessionEventStore`（adapters/storage/index.ts:21），生产装配即它（create-app.ts:340 `options.eventStore ?? createInMemorySessionEventStore()`）；CLI 重启后 `eventStore.getEvents()` 为空，冷恢复实际依赖 transcript（resume.ts:144 拿到空日志后走 messages 路径） | v4 的 `subscribe(afterSeq)` 跨 CLI 重启语义必须做持久形态决策，见 §9.2；01/02/04 相关表述需改写 |

## 3. 必须钉死的设计规则（R 类：不写死就会出 bug）

**R-01 订阅代际 + 重复帧三分支 + 重订阅纪律。**（第一轮 A1，四路扫描独立印证）
TopicFrame 无任何字段区分新旧订阅的帧；09§4 apply 只有两分支，每条迟到旧帧都触发一次 resubscribe → 风暴。旧架构已被现实逼出手工代际：`bridgeSessionId`+`bridgeGeneration`+`recoveryId`（manager:888 按 generation 丢跨代帧）、请求级 single-flight（transport:839「多个请求同时撞上 suspect 窗口必须共用一次恢复」）、mirror runId 游标残留 bug（taskStreamEventHandlers.ts:705「把新 run 的 seq=1 当成旧消息丢掉，手机端漏权限请求」）。钉死四条：
1. subscribe 响应分配 epoch，帧携带 epoch，客户端丢弃旧 epoch 帧；
2. apply 三分支：`toSeq <= store.seq` 的迟到/重复帧**静默丢弃**；`fromSeq === store.seq` 才 apply；`fromSeq > store.seq` 才 resubscribe；
3. resubscribe single-flight（进行中不重复发起）；
4. 服务端同 (client, topic) 重订阅 = 替换旧订阅并清空其 flush buffer。

**R-02 rpc 层补课清单（对应 M1）。** Phase 2 的 rpc 工作至少五项：收端按 msgId 去重；服务端协议会话注册表 + 重连令牌握手（否则 replaceSocket 只有客户端一半）；显式 ACK 发送节奏；判死粒度修正；再加设计已列的拥塞信号与重放缓冲加界。首次生产化必须配 E-01 混沌回归，且「对端去重」在实现前不是可以假设存在的能力。

**R-03 snapshot 必须从内存投影原子生成。**（P2-2，本次扫描单点最大病根）
现状 snapshot 从落盘态生成、追不上内存流：zcodeSessionEventOrder.ts:93「running snapshot 的 eventSeq 只能说明控制状态追到这里，不代表流式正文已写入 snapshot」，客户端为此长出 [0,50,100,200]ms 轮询追赶 + 半截快照补偿 + 七个 ephemeral 字段各自的恢复补丁（taskSnapshotRuntimeStateSync.ts 整个文件）。v4 的「snapshot = seq=W 时刻完整投影」必须实现为**从内存 reducer 状态原子取值**（含截至 W 的半截 row 文本与 A 区全部字段），并把 `snapshot(W) + replay(W, now] ≡ 全量 replay` 列为 Phase 1 黄金测试第一用例——否则 09§7 的走查场景不成立，「整体替换」会把现在「吞首段正文」的 bug 放大成「吞任意段」。

**R-04 seq / rowId / revision 三个标识的确定性。**（第一轮 A5，CLI 扫描强印证）
- seq：升格为持久事件日志属性，跨重启稳定，与 deliveryKind 无关（profile 差异靠区间记账，不靠重编号）；回放配 `getEventsAfter` 索引（现状 O(全史) 重扫）。
- rowId：必须是 event log 的确定性纯函数（重放重建后不变），含 07 的 fallback rows——否则「实时 id 与恢复 id 不同」（zcodeChatMessages.ts:2793）换成 rowId 马甲回来，客户端持久化的 targetRowId/已拉取 ranges 全部作废。
- revision：由 reducer 从事件派生（建议直接 revision = eventSeq 或给出明确递进表），废除现状 15+ 处手工 `stateRevision++`（server-operations.ts:1207 等）；revision 纯内存重启归零的问题一并消失。

**R-05 禁止 live-only 事件旁路。**（P5-2）
现状 subagent mirror 是 `sequenceNumber=0` 不进父 event log 的旁路流，seq 只能临时编造。钉死：凡产生 row/delta 的事实必须先进 event log。否则 09 subagent row 的 `summaryText` 流式与 `(fromSeq,toSeq]` 记账是空话。

**R-06 `rows/range` 改 rowId 游标分页 + 合并规则。**（第一轮 A2）
index 在 suffix 截断 + 新 append 后会被复用，与滞后的订阅流按 index 合并会出现瞬时重复/错位。改 `beforeRowId + count`；客户端合并一律以 rowId 为排序键；patch 命中未加载 rowId = no-op；`atSeq` 与 `store.seq` 的关系写明（rowId 单调 + truncate delta 最终收口，可不做 seq 门控，但要写出论证）。

**R-07 optimistic 收口锚点补全。**（第一轮 A4，两路强印证）
- `QueueItem` 必带 `sourceCommandId`：running 时 sendText 的权威结果是 queue 更新而非 row，现状缺锚点导致 15 秒窗口模糊去重（taskStreamEventHandlers.ts:148 按「内容+附件+时间差≤15s+id 前缀」启发式）；
- `timelineMarker` row 也带 `sourceCommandId`：compact 这类不产 userInput row 的命令，现状靠 **1 秒时钟容差**对账（zcodeChatMessages.ts:2740）；
- 权威 userInput row 的 `text` 必须是用户原文：现状 /goal 的 mirror 正文回传的是落库后的 objective，会把气泡里的 `/goal` 抹掉（handlers:165）；
- `resolveInteraction` 的乐观置灰/待确认态写进 03 overlay 纪律：幂等只保正确性，秒级 RTT 下不给乐观反馈用户会重复点击。

**R-08 connectionId 与 clientId 分离。**（第一轮 A3）
clientId 现状即存 localStorage（main.tsx:851，含 iOS private mode 指纹 fallback），两个 tab 同 clientId 两条连接。连接路由用每连接的 connectionId，幂等与归属用 clientId。

**R-09 ACK 枚举补 `noop`（或 `rejected+code=alreadyResolved` 且附已有结果）。**（第一轮 A6）
「两端同时 stop」「两端同答权限」的晚到者是**不同 commandId**，按定义不是 `duplicate`；03 冲突表与 09§5 的「晚到者收 duplicate」需要改写映射。

**R-10 tool output 终态截断策略全档统一。**（第一轮 A7）
05 的收敛性黄金测试要求「终态逐字节一致」，而 05/09§14 给了 continuous 256KB、replayable head+tail 32KB 两套终态——按字面测试必然红。钉死：完成时 `row.upserted` 的截断全档一致，`outputStreamCapBytes` 只作用于流式期 delta。

**R-11 优先级只在 topic 之间，topic 内严格按 seq 串行。**（第一轮 A8）
01「控制消息 > sessionControl > rows」若被读成同一 conversation topic 内 A 区帧可超车 rows 帧，区间连续性即碎。若 sessionControl 指 sessions-index topic，改名消歧。

**R-12 单帧字节上限与超限切分规则。**（P4-5）
现状有「单次 mirror batch 过大 → RPC/base64/JSON 多次复制 → host 堆内存打满」的前科（taskRealtimeBus.ts:497，随后 :622 被迫做超大 text op 切片）。09§1 帧信封需声明 max frame bytes 与切分语义，否则同类 OOM 在新通道层复发。

**R-13 连接健康度是客户端本地 UI 态，禁止混入 sessionControl。**（P4-8）
现状连接态/配对态/会话态混在一个状态机互相污染（「relay 偶发把已配对会话的心跳 ACK 报成 waiting → 两端状态撕裂」transport:365）。reconnecting/degraded 的展示归客户端本地，会话事实只来自投影。

**R-14 CLI stdio 合批层的删留裁决。**（P5-11，对应 M2）
05 规定唯一合并点在 host 通道层①，但 CLI→host 的 stdio 口已存在一层确定性合批。二选一并写进 05：删（严格唯一合并点）或留（声明为对区间记账透明的 stdio 降噪层）。顺带把正面收益写进 05：区间记账使「帧边界必须可复现」的约束整体卸掉，合批窗口从此可用墙钟（现状被迫用确定性字节预算就是因为没有区间记账）。

**R-15 三组语义迁移进 CLI reducer 职责清单 + 黄金测试。**（P1-5/P1-8/P5-3/P5-7）
这些规则**只是搬家不是消失**，迁移时最容易漏：
1. 迟到终态收口（stop 后 task_complete/工具完成/verifier 终态到达；`lateTerminalEventsAfterStopDoNotRevive` 全套）；
2. provider 乱序整形（helpers:228：provider 偶尔先送 tool_use 再补同句正文尾部，UI 显示成『贪 / Toolcall / 吃蛇游戏』；helpers:431 迟到 thought/tool 包）；
3. guard 输入与投影同源同事务（现状 busy 事实两层四散 + 「先释放锁再广播」的隐式顺序契约，server-operations.ts:1909）。
另：compact 后 provider replay 内容去重（现状 renderUnits:389 在 UI 做 toolId 差集 + startsWith 文本裁剪）也必须由 reducer 收敛，rows 不得出现重复活动。

**R-16 sessionKey 的 workspace 分量必须是 workspaceIdentity 键，不是裸 path。**（P3-7）
现状有明确前科：「同一路径的不同 SSH/WSL/Docker 窗口互相读到对方 task config、队列和错误态」（zcodeSessionStoreSelectors.ts:203/:241）。06 的 `sessionKey = workspace + sessionId` 与分屏二期的 `Map<workspaceKey, Connection>` 都按 identity 键控。

**R-17 模型切换 marker 的暂存语义由 CLI 定义。**（P3-5）
产品语义是「切模型后未发送前 marker 暂存、下一轮 turn 开始才落 timeline」，现状是 UI 旁路列表 + turnIndex 挂载补丁。写进 09§3 marker 定义由 CLI 实现，否则实现期以 UI 分支复活。

**R-18 滚动锚点 rowId 化 + snapshot 替换后的内容回填（从建议升级为必做）。**（第一轮 C2）
现状滚动记忆存 `scrollTop` 像素（chatSessionScrollMemory.ts），在虚拟滚动 + 动态行高下必然失效。客户端记锚点 rowId，snapshot 整体替换后按锚点 `rows/range` 回填可视范围，锚不存在贴 tail。写进 04/06。

## 4. 设计未覆盖的缺口（G 类：需要补章/补字段）

**G-01 A 区缺 sessionConfig 区（本次新发现里优先级最高，两路独立汇合）。**
provider/model/thought/followupMode 的**当前值**是 UI 必显状态，且 `switchModelConfig`/`setFollowupMode` 命令存在，但 09 snapshot 没有这块。现状为此付出的补丁群规模惊人：workspaceSlice 几乎整文件是 config 多源竞态修补（:61 thought 短暂为空、:720 requestId 防旧回包覆盖新选择、:1105 运行态忽略 config update 的例外链）、taskStreamEventHandlers.ts:1413 起的回显匹配 guard、useTaskRestore.ts 15+ 处模型 stale guard。不设 config 区（随 revision 序整体替换），这批竞态在新 UI 原样重演。

**G-02 usage / contextWindow / tokenUsage 的快照恢复语义。**
现状补丁：「usage_update 重复到达 → React 无意义唤醒掉帧」（taskSlice:537）、「窗口刷新不能重建 usage 对象，否则把正数 used 覆盖成 0」（:586）、跨端重复计账靠 128 条 eventKey 环形表（Types:180）。09§13 对 usage/* 只写「保留原样」，但证据表明它同样需要 topic 化（conflated 最新态）或进 A 区。

**G-03 backgroundWorks[] 与 cancelBackgroundWork。**
snapshot 只有 `hasBackgroundWork` 布尔；背景抽屉需要每项状态与取消入口（现状从聊天 tool startedAt 反推曾误报，后改 runtime 明确上报，handlers:1645）。product-protocol 有 `backgroundWorks[]`，09 需给落点 + 命令。

**G-04 plan/todo、goalStats/goalVerifications 摘要、apiRetry 提示的投影落点。**
taskSnapshotRuntimeStateSync.ts 为这七类旁路字段各写了恢复补丁（plan「以前只存 ChatView 组件内存，切走即丢」handlers:1200；apiRetry 不恢复则「用户只能空等」）。不进投影（A 区或独立 topic），恢复补丁换地方重写。

**G-05 时间戳、权威工时、turn 级元数据、perTurn 文件摘要。**（第一轮 B2，三路证据汇合）
09 全 schema 无 wall-clock 时间戳；「已工作 N 秒」的语义现状全在客户端推算且补丁密集：权限等待时间被误计入（zcodeChatMessages.ts:636）、进 verifier 前必须冻结耗时（:1020）、duration 三方择优不允许回退变短（:1962）。另有 perTurnSummaries/perTurnFileChanges（每轮文件变更摘要）现状分帧发布导致高度跳变（taskSlice:1535）。需要：RowBase.createdAt（服务器时钟）、CLI 下发的权威工时区间（明确哪些等待不计入）、turnsMeta 或 turn 头 marker row（含折叠组归属——auto compact 附着上一 assistant 的「已工作」块，09 的 turnId 相邻性表达不了）、turn 级摘要与 rows 同帧原子应用。

**G-06 mailbox / session-message 类消息在 rows 无落点。**（P1-8）
现状靠正则解析 XML 属性 + 文案前缀嗅探（后台 agent ACK 靠**三代文案字符串匹配**兼容，zcodeChatMessages.ts:219-252）。09 的 userInput.origin 枚举没有 mailbox 位置，迁移时会被迫继续文本嗅探。

**G-07 命令全集缺口。**（第一轮 B1 扩充）
`retry`（RowActions.canRetry 有字段无命令）、`resumeGoal`（stopPausesActiveGoalTarget 要求显式 resume）、autoDrain 恢复/held queue 排空方式、rewind-to-checkpoint 与 editUserQuery 的关系、附件上传通道（web/远控下 AttachmentRef 字节如何上行）、session 删除/改名归属域 + **删除的联动清理**（现状：删除不同步清 composer 草稿 localStorage 桶会残留，taskSlice:1924；删除正在查看的 task 后 activeTaskId 悬挂，:2001——v4 需定义他端删除时 pane 回空态 + sessionKey 本地态 GC）。

**G-08 终态失败分类与「何时放弃重连」。**（P3-8）
现状多条恢复路径各自宣判终态造成「前后冲突的两张错误页」（main.tsx:1316）。09§12 退避封顶 30s 字面是无限重试；需要 auth 失效/被踢/超阈值的分类、对应 UI 呈现与放弃条件。

**G-09 relay hub 改造可行性（前置确认项）。**
01 要求「relay 保持哑管道」，但现状外部 relay 是**有状态协议**：register/auth_challenge/pair/KICKED、按 query.mid 分片的边缘层行为（transport:205）、空闲回收需要流量规避（:377）。若 relay 是不可改的外部服务，05 的「删 pair_status、端到端 PersistentProtocol」需要一版与现有 relay 共存的过渡设计；配对生命周期归属也要明确。

**G-10 host/owner 崩溃的进程语义。**
01 把 owner 缩为「哪个进程拉起 CLI」，但没写：host 崩溃时 CLI 子进程是否随死、谁负责重新拉起、running turn 如何收口（现状有 `stream_mirror_owner_lost` 广播失效流程，taskRealtimeBus.ts:195）。另外 `session/send` 现状是「收到输入立即 ACK、persistUserPrompt 在后台 turn 内」（server-operations.ts:1662）——按 §9.3 裁决后的口径：`accepted` 不承诺跨进程存活，客户端 pending 以权威 row（sourceCommandId）收口，崩溃窗口由 `commands/query = unknown` → 用户决定重发兜底。

**G-11 host 不可达时的 UI 降级形态。** home-only stub 模式（约 20 个手工 stub 服务，main.tsx:923）被收敛掉之后，断开的远程 workspace 在新客户端呈现什么，需要定义。

**G-12 fault catalog。** product-protocol 多处「由 fault catalog 定义」的**协议级枚举**（`lastError` 的 code 集、provider 错误到 `phase=error` 的映射、可恢复性分类）还不存在，是 Phase 1 reducer 的硬前置。勘误（2026-07-05）：原料并非从零开始——[`docs/testing/conversation-session-environment-fault-catalog.md`](../testing/conversation-session-environment-fault-catalog.md) 已枚举 429/503/断网/磁盘满/进程关闭等环境故障及验证设计，缺的是把它整理成 `fault.*` reasonCode / `SessionErrorInfo.code` 的协议枚举表；同一文档也是 E-01 混沌装置的故障注入清单来源。

**G-13 安全面。** 10 篇仅 01 一个「auth」词。连接鉴权、relay 链路保密性（TLS-at-relay 还是端到端）、clientId 伪造、远端答权限的授权粒度（08 已列产品问题）。哪怕结论是「沿用现状」也应成文。

**G-14 超时分级。** 09§11 query 超时 10s 一刀切；现状已有反例「Docker/SSH 首连可能超过默认 10 秒」（main.tsx:1609）。workspace 部署类操作需要独立超时档。

## 5. 需要拍板的确认点（C 类）

| # | 问题 | 建议口径 |
| --- | --- | --- |
| C-01 | 多客户端动作权限：任何客户端都能 stop / 答权限？（08 已列） | 能，幂等收口；配合 G-13 的授权粒度说明 |
| C-02 | 幂等表保留 7d，客户端 localStorage pending 无 TTL：过期 command 会被盲重发成幽灵消息 | 客户端 pending 设 TTL（如 24h），超期转「未送达，是否重发」用户决策 |
| C-03 | ~~inbox 重启重放语义~~ 已消解（§9.3 裁决：inbox 内存化，一律不重放，在途命令由客户端对账后交用户决定重发） | — |
| C-04 | 「draft」双关：服务端 phase=draft（createSession 无 firstInput）vs 客户端 null pane | 建议 createSession 必带 firstInput，服务端删 draft 枚举值 |
| C-05 | 04 `base={revision, seq}` vs 09 `base={seq}` | 统一为 {seq}（revision 由 R-04 与 seq 绑定后冗余） |
| C-06 | Phase 2 对旧 UI 的止血范围：旧事件无五件套声明，合批收益是否兑现；叠加 M1 后 Phase 2 实际工作量 | 明确 Phase 2 只承诺帧级收敛（单入口重连/判死重放/二进制），合批到 Phase 3；或明示为旧事件写一次性 coalesce 声明的成本 |
| C-07 | 现状→目标的**行为变更清单**缺失：如 fork-while-running 现状一刀切禁止（server-operations.ts:2042）vs 目标允许稳定历史 fork；steer 收敛进 sendText 路由 | 08 补一张「语义变更表」，防灰度期被当回归上报 |
| C-08 | 06 引用 `packages/stream-animate` 为流式 markdown 落点，但该包是 demo app 形态（App.tsx/main.tsx/server） | 确认可提炼为库，或改引用其内部实现路径 |

## 6. 性能与体验（P 类）

- **P-01 真正的掉帧战场：流式 row 动态高度 + follow-bottom。** 06 认领了 markdown 增量解析，但 `@tanstack/react-virtual` 对「每 30ms 长高的 streaming row」的 measure/remeasure + 滚动锚定是同级热点。建议 Phase 3 前 spike，验收加「流式增长不触发整列 remeasure、follow-bottom 无抖动」。
- **P-02 snapshot 风暴合并。** 多客户端同时降级时，通道层允许对同 topic 并发 resync 合并（软状态缓存最新 snapshot，秒级 TTL）；与 01「host 不缓存」的口径统一见 D-04。
- **P-03 压缩分段确认。**（修正第一轮 C4）desktop↔relay 段已协商 permessage-deflate（transport:210，浏览器侧只能被动确认 extensions）；需确认手机↔relay 段及 v4 新链路各段均生效，二进制化后复测收益，重写时**不要丢掉已有的这项优化**。
- **P-04 overlay 位置随 inputRouting。** 客户端已知 `inputRouting=enqueue` 时，乐观展示直接画进 queue 面板，避免收口时消息从时间线尾「跳」进队列。
- **P-05 conflation 是防掉帧机制，不只是省带宽。** 现状有「usage_update 相同数值重复到达 → React 无意义唤醒 → 掉帧」的直接病例（taskSlice:537），A 区 conflation 落地时保留「值未变不下发」语义。

## 7. 文档一致性修订清单（D 类）

- D-01 02 vs 09：delta 操作「三种/{rowId} 单行删除」vs「五种/fromRowId 截断」，以 09 为准回写 02。
- D-02 product-protocol 的 `ConversationProductProjection`（turns/activeWorks/backgroundWorks/generatedAt/projectionVersion、command 信封 clientMode）与 09 `ConversationSnapshot` 需给映射表或回写收窄；`stopTargetKind` 两边都缺 `turnSteer`；现协议 snapshot.runtime 已携带的 eventSeq/stateRevision/activeTurnKind/pendingRequestIds（index.ts:1510）在 09 的去留列表。
- D-03 turn-steer 中间态（submitting/queued）的投影表达未定义——现状它是 queue 面板可见状态（turn_steer_queued/status 对账状态机，handlers:297），QueueItem 需能表达。
- D-04 01「连接层禁缓存消息」vs product-protocol「host 可 cache latest projection」：建议统一为「通道层可持软状态 snapshot 缓存，禁持有下游没有的状态」。
- D-05 09 引用未定义类型的归属清单：QueueItem、GoalState、SessionErrorInfo、SessionActionAvailability、AttachmentRef、TimelineMarkerPayload、PermissionRequest/UserInputRequest。
- D-06 按 §2.2 M1–M7 修订 README 地基表、病根 2 措辞、03 queue 描述、05 PersistentProtocol 现状与「删除平行可靠性层」一节、02 的 queue 依赖顺序、01 web 形态计数。

## 8. 配套建设（E 类）

- **E-01 确定性网络混沌装置升为一等验收**（因 M1 从「强烈建议」升为「必须」）：帧级注入延迟/丢包/乱序/重复/中途 kill（seed 可复现），断言不变量——无重复 row、overlay 必收口、终态收敛、resubscribe 次数有界、`snapshot(W)+replay ≡ full replay`。Phase 2 验收「手机远控断连/刷新恢复可用」由它替代人工判据。
- **E-02 新管线观测指标**：coalesce 压缩比、flush 帧率、每订阅缓冲水位/溢出次数、snapshot resync 次数与原因、ACK 延迟分布、重连次数与原因分类（挂 RUM）。
- **E-03 黄金测试用例清单（从本次病例直接派生）**：
  1. snapshot 原子性：running 中任意 W 取 snapshot + 续流 ≡ 全量重放（R-03）；
  2. 迟到终态不复活：stop 后到达的 assistant/tool/verifier 终态（P1-5/P5-7 全部病例场景化）；
  3. provider 乱序整形：tool_use 先于正文尾部、迟到 thought 包（helpers:228/431 案例）；
  4. profile 收敛：同一事件序列两档终态一致（依赖 R-10）；
  5. 被过滤事件必被不可过滤事件收口（05 已列，补 subagent summaryText 场景）；
  6. 重复/迟到帧静默丢弃、重订阅替换旧订阅（R-01）；
  7. guard 与投影同源：任何「广播先于状态释放」窗口不存在（P5-3）；
  8. formal-proof 全枚举 ↔ actionAvailability 一致（02 已列，保留）。

## 9. 持久化与表结构影响清单（对照实际 schema：migrations 0001–0014）

结论先行：按 §9.3 的作者裁决（queue 不持久化）修订后，**SQL 结构性改动收敛为零迁移**——只剩 message/part 的 additive JSON 锚点字段，07「additive JSON 优先」的原则与现状 schema（message/part = 索引列 + `data` JSON blob，0014 已有 `sequence` 列与三个配套索引）完全兼容。真正的大项不是 DDL，而是一个 07 未覆盖的**语义决策**：事件日志的持久形态（§9.2）。

### 9.1 事实基础（已核对 DDL）

- 现有表：`session` / `message` / `part` / `todo` / `session_entry` / `permission` / `input_history` / local_setting（0002）/ workflow 系列（0007-0008）/ usage 系列（0010）。
- `message.sequence` / `part.sequence` + `message(session_id, sequence, …)` 等索引已由 0014 建好——rows 冷重建的稳定排序地基成立。
- `message.time_created` / `part.time_created` 存在——G-05 所需 wall-clock 时间戳在持久层有来源，缺的是进 projection schema。
- 工具产物已有文件型存储 `NodeToolArtifactStore`（rootDir 文件存储）——09§6 的 `truncated.ref` + `toolOutput/get(ref, byteRange)` 有现成落点，无需新 SQL 表。
- `todo` 表本就持久——G-04 的 plan/todo 病根是「只存组件内存/不进投影」，不是缺表。

### 9.2 决策点：事件日志的持久形态（M8，07 未覆盖的最大缺口）

现状事件日志纯内存（见 M8），而 01/04/README 假设它在 SQLite。两个方案：

| | 方案 A：事件日志落盘 | 方案 B：内存有界日志 + logEpoch（推荐） |
| --- | --- | --- |
| 做法 | 新表 `session_event(session_id, seq, type, data, time_created)`，PK `(session_id, seq)`；每 turn 数千 delta 批量事务写入；保留窗裁剪任务 | 事件日志保持内存环形缓冲（每 session N 条）；seq 作用域 = `(session, logEpoch)`，logEpoch 每次 CLI 进程启动更新；`subscribe(base)` 的 base 带 logEpoch，不匹配 → 直接 snapshot |
| 跨 CLI 重启的 afterSeq 续传 | 支持 | 不支持——重启后所有客户端走一次 snapshot |
| 代价 | 写放大明显（流式 delta 全部进 SQLite）；裁剪任务；`getEventsAfter` 索引化 | CLI 重启多一次 snapshot（本来就要发生：running turn 随进程死，客户端必然要重对齐）；01/02/04 表述改写 |
| 对 transcript 的要求 | 锚点可以不完备（事件兜底） | **transcript 锚点必须完备**：projection 必须能仅由 transcript 确定性重建，`reduce(transcript) ≡ reduce(events)` 黄金测试从建议升为持久化验收 |

推荐 B 的理由：A 换来的唯一收益是「CLI 重启后省一次 snapshot」——低频事件 + snapshot 本来就便宜（尾部一屏），付出的是每轮数千行的写放大和一个新的裁剪运维面；且 B 强制 transcript 锚点完备，这本来就是历史会话正确展示的硬要求。注意 B 的 logEpoch 与 R-01 的订阅 epoch 是两个层次（进程代际 vs 订阅代际），可以合并编码但语义要分开写明。

### 9.3 表级改动清单（按作者裁决修订：queue 不持久化）

> 裁决记录（2026-07-04）：用户 query 队列（deferred sendText/sendGoalCommand）**不持久化**——只活在 CLI 内存，CLI 进程死亡即丢。连锁推论如下；**03「Inbox 落盘」一节与 07 的新表清单需按此改写**（03 现文把「消息发出去了但不显示」归因于 queue 不持久，归因要修正为「queue 所有权在 renderer 内存」）。

**推论：两张 inbox 表也不建，持久化改动收敛为零迁移。**

| 对象 | 改动 | 方式 |
| --- | --- | --- |
| `message.data`（JSON） | + `turnId`（07 已列）、`origin` 统一枚举含 mailbox 位（07 已列 + G-06）、**`sourceCommandId`（07 漏，R-07 的收口锚点 + 崩溃窗口幂等的依据，必须落盘）**、终态标记（interrupted/failed，若不可由 parts 推导）、`/goal` 等命令的用户原文与解析结果分字段（R-07） | 无迁移，additive JSON |
| `part.data`（JSON） | + 权威工时区间锚点（排除权限等待的起止，G-05）、输出截断元数据（`truncated: {totalBytes, ref}`，ref 指向已有 artifact store） | 无迁移，additive JSON |
| ~~`command_inbox`~~ | **不建表**。inbox = CLI 内存受理台账（串行化点 + 幂等表 + 结果缓存 + pendingCommands 数据源），进程生命周期 | — |
| ~~`continuation_inbox`~~ | **不建表**。后台 bash/subagent 本身不跨 CLI 重启存活，其未投递的结果通知与 queue 同一把尺子：随进程丢（副作用如文件改动本就落盘）。若未来后台工作要跨重启恢复，再议 | — |
| ~~`session.queue_auto_drain`~~ | 不需要。queue 内存化后 held/autoDrain 态随之内存化 | — |
| `session_event` | 仅 §9.2 方案 A 需要；方案 B（推荐）下同样零表 | 视 §9.2 决策 |
| `message.turn_id` 独立列 | 维持「暂不做」（07 已列为可选） | 暂不 |
| `todo` / `usage` / `input_history` / 0014 索引 | 不动 | — |

裁决的配套语义（必须一起钉死，否则丢掉的是正确性而不只是持久性）：

1. **修「消息发出去了但不显示」的本质是所有权上收，不是落盘**：queue 从 renderer 内存收进 CLI 内存 + 权威回显（state.updated），刷新/断线/多端场景即全部正确；落盘只影响「CLI 进程死亡」这一个窗口——此时 running turn 同样死亡，用户感知本来就是会话中断，队列同灭是自洽的产品语义。
2. **崩溃窗口的幂等改由「效果自带 commandId」承担**：`commands/query` 的查找顺序 = 内存幂等表 → transcript 按 `sourceCommandId`。有落盘效果的命令（sendText startNow、editUserQuery、compact marker）天然防重；无效果命令（stop、resolveInteraction）重发无害。唯一小口子是 fork/createSession 的重复创建：**已裁决（2026-07-05）child session 记 `source_command_id`**（一列或 metadata，additive 改动无迁移）。
3. **ACK `accepted` 不承诺跨进程存活**：客户端 pending 的最终收口以权威数据（row / QueueItem 的 `sourceCommandId`）到达为准——这正是 02 的原始原则「overlay 收口不依赖 ACK」；CLI 重启后在途命令查询得 `unknown` → 按 C-02 呈现「未送达，是否重发」。C-03（重启重放哪些命令）随之消解：**一律不重放**。
4. **pendingInteractions 不落盘**（不变）：派生自 running turn 的内存事实，turn 死弹窗消失是正确语义。

净结果：CLI 侧 SQLite **零新表、零迁移**，唯一改动是 message/part 的 additive JSON 锚点字段——与 07「持久化尽量少动」、01 自相似恢复（唯一不可丢状态 = transcript）完全对齐。注意 R-07 的 `QueueItem.sourceCommandId` 不受影响：它是协议/内存字段，不是存储字段。

### 9.4 客户端侧持久化（非 SQLite，同属本清单）

- localStorage：`clientId`（按 R-08 拆分后仅作提交者身份）、draft（按 sessionKey）、在途 commandId 列表 + TTL（C-02）、滚动锚 rowId（R-18，替换现状 scrollTop 像素）、pane 布局（06）。
- IndexedDB：`(projection, revision, seq[, logEpoch])` 原子快照缓存，后期优化（04 已列；方案 B 下必须带 logEpoch 才能判断缓存 base 是否可用）。
- 旧数据：turnId 无法回填的历史 message 留空，fallback rows 由兼容层运行时生成、不回写库（07 已列）；若现状「未读」按 seq 记，方案 B 下改按 `time_updated`。

## 附录：五区病例总表（60 类）

> 判定含义：**灭**=结构性消灭（附设计依据）；**钉**=方向对但需按 §3 钉死规则；**缺**=设计未覆盖（对应 §4）；**返**=会换马甲回来。证据为代表性位置，注释原文见各文件。

### A. renderer 拼装层（P1）

| # | 病类 | 证据 | 判定 |
| --- | --- | --- | --- |
| P1-1 | stream/snapshot 双来源归并启发式（richness 打分、滑窗覆盖、前缀比较） | zcodeChatMessages.ts:904,:1887,:2088,:2144 | 灭（04 整体替换）＋前提 R-03 |
| P1-2 | 流式容器切分错误、拼旧尾巴（turnId/inputId/traceId 三级猜测） | :549,:1481,:1068 | 灭（09§3 状态机 + 新轮新 rowId） |
| P1-3 | timeline 错位/重复/anchor 漂移（1 秒时钟容差匹配、4 种身份键互认） | :1115,:2740,:2793; zcodeTimelineIdentity.ts | 灭（marker=普通 row）＋钉 R-04(rowId) |
| P1-4 | optimistic 被合并而非覆盖（operationId 回填、本地行接管） | :787,:816 | 灭（03 纪律）＋钉 R-07(marker 锚点) |
| P1-5 | 迟到终态与内容流乱序（task_complete 先于迟到包、stop 后 Write 预览合回） | helpers:431,:595; :2403,:1280 | 灭（客户端侧）＋钉 R-15(reducer 收口) |
| P1-6 | UI 猜 turn 分组（`turnIndex ?? Math.floor(index/2)`） | :1439; chatViewMessageTurns.ts:27 | 灭（07 turnId 落盘） |
| P1-7 | 控制 flag 从消息数组反推（canFork 等 backfill、goal 续跑运行态识别） | zcodeTimelineRuntime.ts:49; renderUnits:27 | 灭（02 sessionControl/actions） |
| P1-8 | provider 语义文本嗅探（三代文案匹配、stopReason 正则、mailbox XML 正则） | :219-252,:62,:378,:1236 | 部分灭＋缺 G-06(mailbox) |
| P1-9 | snapshot 水位非一致性水位 | zcodeSessionEventOrder.ts:93 | 钉 R-03 |
| P1-10 | 客户端乱序缓存补偿（gap 检测/pending 缓存/万条去重表） | zcodeSessionEventOrder.ts 全文 | 灭（04 规则2）＋前提 R-01 |
| P1-11 | 工时/时长本地推算与双源择优（权限等待误计、verifier 前冻结、不允许回退变短） | :636,:1020,:1962; helpers:701 | 缺 G-05 |
| P1-12 | compact 归属/折叠桥接启发式 + replay 内容去重（toolId 差集+startsWith 裁剪） | renderUnits:48,:389 | a) 钉 R-15；b) 缺 G-05(折叠组) |

### B. 流事件应用与快照同步（P2）

| # | 病类 | 证据 | 判定 |
| --- | --- | --- | --- |
| P2-1 | 快照合并策略动物园（replace/terminal_reconcile/backfill/preserve/drop 五策略） | snapshotSync:615-668; useTaskRestore:1558 | 灭（04 规则1，v4 最强正面证据） |
| P2-2 | running snapshot 非原子（轮询追水位、partial snapshot、七字段各自恢复） | eventOrder:93; useTaskStreamEvents:540; snapshotSync:78,:539; runtimeStateSync 全文 | 钉 R-03 |
| P2-3 | 迟到终态归属竞态（四个 shouldTreat* 布尔、无 inputId 终态） | terminalHandlers:180; snapshotSync:576-611,:852 | 灭（turn.* 事件消失，phase 随投影） |
| P2-4 | seq 缺口客户端补偿机器（250ms 恢复定时器、trimChunkOverlap 前后缀去重、unverifiedFromSeq 游标） | useTaskStreamEvents:56,:530; handlers:247,:769 | 灭＋前提 R-01 |
| P2-5 | deliveryKind 客户端行为分叉（gap 恢复分叉、replayable 专用消费、isFilteredNonOwnerBatch） | :104,:530; snapshotSync:774; handlers:716 | 灭（05 参数表 + 区间记账） |
| P2-6 | 阻塞交互事件化丢失/覆盖/跨端不同步 | :641; handlers:1216,:1240 | 灭（09§5 pendingInteractions） |
| P2-7 | flag 数组反推（isChatTaskRunning 猜、SSH 残留 pending execute 特判） | useChatViewDisplayFlags 全文; chatStatus:42 | 灭；shimmer 可由 phase+尾行推导 |
| P2-8 | 队列 drain/held/steer 编排在客户端（终态后本地触发 drain、stopRequested 本地改写 held） | terminalHandlers:346-407; handlers:297 | 灭＋D-03(steer 中间态表达) |
| P2-9 | 乐观用户消息 15s 窗口模糊去重、/goal 原文被 objective 覆盖 | handlers:148-178,:165 | 灭＋钉 R-07 |
| P2-10 | 模型/配置回显竞态（回显匹配 guard、三层 thought preserve、15+ 处 stale guard） | handlers:1413-1497; useTaskStreamEvents:117; useTaskRestore 多处 | 缺 G-01（本区最重要发现） |
| P2-11 | 订阅/组件生命周期空窗丢数据（先释放后建订阅、plan 只存组件内存） | :682,:392; handlers:1200 | 灭（客户端不再是 reducer） |
| P2-12 | 旁路投影字段恢复补丁群（plan/todo/goalStats/apiRetry/contextUsage/背景 bash） | runtimeStateSync:139-203; handlers:1645 | 缺 G-02/03/04 |

### C. store 与 web 入口（P3）

| # | 病类 | 证据 | 判定 |
| --- | --- | --- | --- |
| P3-1 | 双真相源对账（verifier 双写、客户端时钟与服务端时间比大小、未读双源） | taskSlice:840,:1884; workspaceSlice:1142 | 灭＋缺 G-01/02（字段须进投影） |
| P3-2 | 重复投递手工幂等表（usage 重复唤醒掉帧、eventKey 环形表、requestId 对象去重） | taskSlice:537,:1016,:114; Types:180 | 灭（msgId 去重+区间记账+conflation） |
| P3-3 | 运行态标识残留误判（inputId 残留、activeTurnKind 不清、stop 路由被擦） | taskSlice:437-448,:1826 | 灭（control 整体替换） |
| P3-4 | 单槽位 pending 交互覆盖、双路径清理 CPU 飙高 | taskSlice:1142,:1205,:1228 | 灭＋钉 R-07(乐观置灰) |
| P3-5 | 模型切换 marker 旁路暂存+turnIndex 挂载 | taskSlice:1406,:1434 | 钉 R-17 |
| P3-6 | 关联数据分帧发布高度跳变（messages/summary/fileChanges 三次写） | taskSlice:1535 | 灭＋缺 G-05(perTurn 摘要落点) |
| P3-7 | workspace identity 串台（path fallback 互读配置/队列/错误态） | selectors:203,:241 | 钉 R-16 |
| P3-8 | 恢复路径冲突终态（unknown→invalid-mobile 两张错误页、DEVICE_OFFLINE 抢跑） | main.tsx:1316; transport:463,:585 | 灭＋缺 G-08(终态分类) |
| P3-9 | 换桥整树 remount（key=bridgeSessionId、回前台闪「正在加载」） | main.tsx:1703,:1388,:1407 | 灭（订阅身份持久） |
| P3-10 | 半开连接发送黑洞（静默丢弃、单向通路重建重试） | transport:504,:899; main.tsx:1563 | 灭（05 判死换管重放） |
| P3-11 | 重连级联风暴（10 条入口、手工 single-flight、4 处代际比对） | transport:839,:416; main.tsx:1439 等 | 灭＋前提 R-01 |
| P3-12 | 客户端身份 localStorage 单例（多 tab 同 id、private mode fallback） | main.tsx:851,:863,:178 | 钉 R-08 |

### D. 传输与远控（P4）

| # | 病类 | 证据 | 判定 |
| --- | --- | --- | --- |
| P4-1 | seq-gap→degraded→整桥硬恢复（非幂等帧不敢重放） | manager:899; relayProtocol:194,:141 | 灭＋前提 R-02(收端去重真实存在) |
| P4-2 | 中间层 per-client 缓冲+TTL/溢出/补 degraded | manager:367,:451,:495; relayProtocol:169 | 灭（不做 per-client 队列） |
| P4-3 | owner/observer 双事件源分叉（已被迫合流回投） | taskRealtimeBus:685 | 灭（对等客户端；方向最强背书） |
| P4-4 | owner lease/命令路由竞态（NO_ACTIVE_TASK_OWNER、owner_lost 广播） | bus:838-889,:195 | 灭＋缺 G-10(崩溃接管) |
| P4-5 | 大帧 OOM（mirror batch 多次复制打满堆、被迫切片分 seq） | bus:497,:516,:622,:718 | 灭＋钉 R-12(帧上限) |
| P4-6 | 多路心跳/判死/重连级联（5-6 条 transport 入口+3s grace） | transport:288,:374,:425,:407,:436; manager:336 | 灭＋缺 G-09(relay 可行性) |
| P4-7 | 半开/休眠假活（内核不触发 close、waiting_terminal 卡死） | transport:359,:475 | 灭（应用层 ACK 判死，论证与病例全对上） |
| P4-8 | 传输状态映射 UI 状态撕裂（staleWaiting 怀疑态、防抖保持 active） | transport:365; manager:1000,:578,:1293 | 灭＋钉 R-13 |
| P4-9 | PersistentProtocol 无收端去重/服务端附着/主动 ACK | protocol.ts:411-425; remote.ts:302 | **返**（不补则 A1 风暴必现）→ R-02 |
| P4-10 | PersistentProtocol 零生产部署 | server/stdio.ts:53、http.ts:66、websocket.ts:97、host/index.ts:572 | 失真修正 M1 |
| P4-11 | 多路径重复投递末端 eventId 兜底（千条环形表、跨通道强制 flush 保序） | bus:1039,:444; transport:253 | 灭＋钉 R-01(三分支) |
| P4-12 | base64 双重编码/手写分块（0x8000 分块防栈溢出） | manager:781; relayProtocol:30-47 | 灭（二进制帧）＋P-03(保留 deflate) |

### E. CLI 事实源侧（P5）

| # | 病类 | 证据 | 判定 |
| --- | --- | --- | --- |
| P5-1 | 协议 seq 按 (record,deliveryKind) 内存懒编号、订阅全史重扫 | server-operations.ts:201-255,:634,:1567 | 灭＋钉 R-04(seq 持久化) |
| P5-2 | live-only 事件不进 event log（subagent mirror seq=0） | :637 | 缺→钉 R-05 |
| P5-3 | 互斥事实两层四散+释放/广播顺序竞态 | :2747,:1810,:2215,:1909,:2184 | 灭＋钉 R-15(guard 同源) |
| P5-4 | turn 边界扫数组猜（synthetic user 破坏轮次计数、只有最后一轮能 fork） | :3127-3130 | 灭＋钉 R-04(fallback rowId 确定性) |
| P5-5 | fork 现状 running 一刀切禁止 vs 目标允许稳定历史 | :2042 | 行为变更→C-07 清单 |
| P5-6 | fork 继承范围靠补丁逐项找回（模型被默认覆盖、goal timeline 断开） | :2072,:2121 | 灭（继承表化可黄金测试） |
| P5-7 | stop 与迟到终态收口竞态（verifier 未收 abort 保留 active goal、cancelled 无终态事件补账） | :2310; event-reducer.ts:302,:435 | 灭＋钉 R-15(进黄金测试) |
| P5-8 | revision 散点手工递增、纯内存、-32009 非结构化 | :1207 等 15+ 处; server-types.ts:152 | 钉 R-04(revision 派生) |
| P5-9 | running 后续输入双队列两处易失（steer 纯内存+UI deferred queue） | agent-runtime.ts:158; :1602-1617 | 灭＋修正 M3＋08 补迁移 |
| P5-10 | 双流式表达去重税（scheduled 重复携带大参数、跨事件去重状态机） | :504 | 灭（单 row.delta+封闭白名单） |
| P5-11 | CLI 协议边界已有确定性合批层 | :447,:3277-3279 | 钉 R-14(删留裁决) |
| P5-12 | subscribe 一次性 RPC、无订阅流身份、无保留窗 | :1561-1584 | 灭＋前提 R-01；配 G-15 索引化 |

（G-15：事件保留窗从「无限」变有限时，回放路径配 `getEventsAfter` 索引化，避免 O(全史) 重扫。）
