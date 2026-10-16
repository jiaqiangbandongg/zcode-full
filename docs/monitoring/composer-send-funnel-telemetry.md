# Composer 发送漏斗埋点（ARMS：send_input_focus / send_click / send_result）

**状态**：**已实现**，随 MR !2000 合入——三个事件与 `send_result` 的端到端耗时口径在同一个 MR 里落地（新建 `sendFunnelArmsTelemetry.ts`；supervisor 的 `awaitSendRender()` / `notifyUserInputRendered()` 与 `resolveSendAckSettlement()` 的 `awaitRender` 分支；`SessionPane` 的渲染信号 effect；单测见 `v4ComposerSendFunnelTelemetry.test.ts` 的「待渲染等待」小节）。耗时口径已从「ACK accepted」改为「用户消息呈现到对话历史」，桌面端**真机**验证端到端 230 ms 上下（其中 ACK 段 55 ~ 100 ms）；**尚未发版**，线上分位数待上线后回看。
**待观察**：上线满两周后按 ARMS 分位数回看两件事。其一，校准 §5.4 的 30 s `render_timeout` 阈值——真机 p50 仅 230 ms，30 s 大概率过宽，但要有线上长尾佐证才好收窄。其二，看 `send_cost_ms − ack_cost_ms`（投影回流 + 渲染那一段）在低配设备上的占比是否与真机一致；若该段显著膨胀，优化重心在渲染而非网络。
**已知缺口**：composer 的 slash 命令路径尚未接入 —— `dispatchSlashCommand()` 未接 `telemetrySeed`，已有会话里的 `/compact`、`/goal`，以及 `emptyGoal` / `unsupportedGoal` 的本地同步拒绝，都只会上报 `send_click` 而不落定 `send_result`。ARMS 侧按 `send_click_id` 算成功率时该子集会计入分母当作放弃，需另行剔除；修复另行跟进。
**上报通道**：**只走阿里云 ARMS RUM 自定义事件**（`platform.reportArmsCustomEvent`）。不走自研 `/event/report`。
**生效端**：**仅 Electron 桌面端**（`isDesktop`）。Web / 手机远控不装 reporter，不上报。
**范围**：仅 UI 层（`packages/ui`）。不改 Host/Runtime，不改 `send_btn` 既有语义。

## 1. 目标

补齐用户从「看到输入框」到「消息真正发出去」这一段的漏斗，回答三个问题：

1. 点了输入框的人里，有多少真的按下了发送？（输入意图 → 发送意图的流失）
2. 按下发送的人里，有多少真的发送成功？失败的原因分布是什么？（发送通道成功率）
3. **从点击发送到自己的消息出现在对话历史里要多久？**（用户可感知的发送耗时，不含模型排队与推理）

## 2. 现状与缺口

现状链路（全部已存在，无需改动）：

```
点击输入框 focus ─► recordComposerFocus()      只写 inputStartTime 到内存，不上报
输入首字符      ─► recordComposerTextChange()  只写 inputFirstCharTime 到内存，不上报
点击发送/Enter  ─► submit() 冻结 sendTime      无事件
                     │
                     └─► sendCommand(envelope) 等 ACK
                           accepted  ─► acceptPromptSeed() ─► 上报 send_btn（/event/report）
                           其余 ACK / 抛异常 ─► 完全静默
```

三个缺口：

- 「点击输入框」「点击发送」只留了内存时间戳，作为 `input_start_time` / `input_first_char_time` / `input_send_time` 三个字段搭 `send_btn` 的车上报。**没有点击发送就没有 `send_btn`，漏斗只有分子没有分母。**
- ACK 为 `rejected` / `stale` / `failed`，以及 `sendCommand` 抛异常（transport-error、provider_not_ready）时完全静默，只写了 `recordV4CommandAck` 的本地有界调试缓冲，上报侧看不到。
- 发送通道耗时无字段。`message_completion.duration_ms` 是「发送到整轮结束」，`time_to_first_token` 是「发送到首 token」，两者都包含模型排队与推理，无法度量发送通道本身。

**用户消息没有乐观渲染。** `conversationProjectionStore.markCommandPending()` 只把命令写进 `optimisticCommands`，该字段与 `pendingCommands` 全仓**没有任何 UI 消费者**（`reconcileOptimistic` 只用它做清理）。用户气泡必须等服务端投影回流、`snapshot.rows.window` 里出现 `row.kind === "userInput" && row.sourceCommandId === commandId` 才会画出来。因此「ACK accepted」远早于「消息可见」，两者之间还隔着一次投影推送与一次 React 渲染。

## 3. 设计决策

### 3.1 通道：只上报 ARMS

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 走哪条通道 | **只走 ARMS**，不双发 `/event/report` | 本次三个指标里最核心的是**耗时分布**；ARMS 自定义事件的 `value` 是数值型，天然支持 avg/p50/p95/p99 与按 `app_version` / `platform` 下钻，`/event/report` 的 `event_extra_detail` 全是字符串，做分位数要数仓再解析一层 |
| 生效端 | 仅 Electron 桌面端 | `packages/web/src/main.tsx` 的 `reportArmsCustomEvent` 是空实现，Web 本就收不到；沿用 `setUiPerfArmsReporter(isDesktop ? platform : null)` 的既有门控写法，语义显式 |
| 与既有 `send_btn` 的关系 | `send_btn` 语义、字段、时机、通道**一律不动** | 数仓已把 `send_btn` 当作 `message_completion` 的配对 seed；两条通道彼此独立，本次改动对 `/event/report` 零影响 |

**双发被否的理由**：同一动作在两条通道各留一份，指标口径会随时间漂移（一条改了另一条忘了），且 `/event/report` 侧已有 `send_btn` 覆盖成功路径，重复计数反而污染既有看板。

### 3.2 事件语义

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 「发送成功」取哪个时刻 | **用户消息首次出现在对话历史里**（`snapshot.rows.window` 首次出现 `kind === "userInput"` 且 `sourceCommandId === commandId` 的 row） | 度量的是用户能感知到的「我的话发出去了」；ACK accepted 只代表 Host 收下了命令，此时屏幕上还什么都没有 |
| ACK 那一段是否单独留 | 留，另开 `ack_cost_ms` | 端到端耗时变慢时要能一眼分清是「上行慢」还是「回流+渲染慢」，两者相减即后半段 |
| ACK 已 accepted 但 row 迟迟不回流 | 30 s 超时兜底，报 `status=fail` / `reason_code=render_timeout` | 不落定会留下悬空的 `send_click` 污染成功率分母；30 s 远超正常回流耗时，落到这里就是真出问题了 |
| 失败要不要报 | 要，与成功共用 `send_result`，靠 `status` + `reason_code` 区分 | 成功率是本次埋点的核心指标，只报成功等于只有分子 |

**「ACK accepted 即成功」已被推翻。** 该口径下真机实测只有 66 ~ 142 ms，量的是命令上行到 Host 被受理的往返，与用户看到自己消息的时刻不是一回事——见 §2 「用户消息没有乐观渲染」。原口径保留为 `ack_cost_ms`，不再作为 `send_result` 的落定信号。

**命名**：结果事件定名 `send_result` 而非 `send_success`。项目既有惯例里 `xxx_success` 是**只报成功**的事件，带成败的结果事件用 `xxx_result`；ARMS 是全新命名空间，不存在与 `send_btn` 抢名的问题，直接对齐惯例。

## 4. 目标链路

```
点击输入框（用户真实 focus）
   └─► ARMS send_input_focus                    ← 新增
输入内容…
点击发送 / Enter（通过发送门禁，冻结 sendTime + send_click_id）
   └─► ARMS send_click                          ← 新增
        │
        ├─ 附件预传二次门禁失败 ──────────────────► send_result status=fail  reason_code=attachment_not_ready
        ├─ onSendText 产品 guard 拒绝 ────────────► send_result status=fail  reason_code=blocked
        ├─ 队列二次确认（ACK `reasonCode=guard.heldQueueConfirmationStale`）── 不落定，等用户确认后复用同一 seed
        │
        └─► dispatchCommand → sendCommand(envelope)
              ├─ ACK accepted / duplicate ─► send_btn（既有 /event/report，不动）
              │      └► 记 ack_cost_ms，登记「待渲染」（挂 30 s 超时），**此时不落定**
              │            ├─ 投影回流出现 userInput row（sourceCommandId 匹配）
              │            │     └► ARMS send_result status=success  value=send_cost_ms（端到端）  ← 新增
              │            └─ 30 s 内未等到 ────► send_result status=fail  reason_code=render_timeout
              ├─ ACK rejected / stale / failed / noop ─► send_result status=fail（立即落定）
              └─ throw ────────► send_result status=fail  reason_code=transport_error | provider_not_ready
```

上报出口：

```
supervisor ─► sendFunnelArmsTelemetry.emit()
   └─► platform.reportArmsCustomEvent(payload)
        └─► IPC PlatformChannels.ReportArmsCustomEvent
             └─► buildFinalArmsCustomEventPayload()   注入 app_version / arms_env / device_mid / platform / renderer_id
                  └─► RUM SDK sendCustom()
```

## 5. 事件定义

三个事件同属 ARMS group **`send_funnel`**。ARMS payload 形状为 `{ name, group, value, properties }`：

- `value` 是**数值型**，是该事件在 ARMS 侧的主指标；
- `properties` 的值允许 `string | number | boolean`，主进程 `buildFinalArmsCustomEventPayload` 会统一 `String()` 化后落库；
- **值为 `undefined` 的 property 直接不下发**（而不是写 `""`），ARMS 侧表现为该属性缺失。

### 5.1 `send_input_focus` — 点击输入框

| 字段 | 值 |
| --- | --- |
| `name` | `send_input_focus` |
| `group` | `send_funnel` |
| `value` | `1`（计数事件） |

`properties`：

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `focus_time` | number | focus 发生的 renderer 时钟（毫秒） |
| `composer_scope` | string | `session`（已有会话）/ `draft`（新建草稿） |
| `talk_id` | string? | 当前 `sessionId`；草稿态缺省不下发 |

**只报用户真实聚焦，不报程序性聚焦。** `ConversationComposer` 的自动聚焦（新建任务、切会话、挂载后交还光标、上下文块移除后回焦）统一经 `flushPendingFocus` 调用 `inputApiRef.current.focus()`，会触发同一个 DOM focus 事件；实现时在该处置位标记，`handleEditorFocus` 消费标记后跳过上报。既有的 `recordComposerFocus()` 时间戳写入**不受影响**，两种 focus 都照旧记录，`send_btn` 的 `input_start_time` 口径不变。

不做时间窗去重：一次真实 focus 一条事件，字面对应「点击输入框」。需要按会话去重由 ARMS 侧按 `talk_id` 聚合。

### 5.2 `send_click` — 点击发送

| 字段 | 值 |
| --- | --- |
| `name` | `send_click` |
| `group` | `send_funnel` |
| `value` | `1`（计数事件） |

`properties`：seed 冻结的模型/模式/套餐字段（与 `send_btn` 同源，即 `buildV4ConversationPromptTelemetryExtraDetail` 的产物）加上：

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `send_click_id` | string | 本次发送的关联 ID（uuid），与 `send_result` 配对 |
| `input_send_time` | number | 冻结的 `sendTime`，与 `send_btn` 同名字段同值 |
| `send_trigger` | string | `button`（点击发送键）/ `shortcut`（Enter 提交） |
| `composer_scope` | string | `session` / `draft` |
| `talk_id` | string? | 当前 `sessionId`；草稿态缺省不下发 |

**上报时机**：`submit()` 内发送门禁通过、`pendingRef` 置位、冻结 `telemetrySeed` 的那一刻。被门禁挡下的调用（空草稿、`pendingRef` 已占用、附件未就绪）不报——此时发送按钮本就是 disabled，不构成一次有效发送。

**复用 seed 不重报**：队列二次确认（`clearQueueAndSend` / `keepQueueAndSend`）会带着首次点击的 `existingTelemetrySeed` 再次进入 `submit()`，此时不重报，保证与 `send_result` 严格 1:1。

`send_trigger` 的取值靠发送按钮的 `onClick` 置位标记实现——按钮是 `type="submit"`，与 Enter 共用 `LexicalChatInput` 的 `onSubmit`，DOM 事件顺序保证 click 早于 submit；标记在每次 `submit()` 读取后立即复位，默认值为 `shortcut`。

### 5.3 `send_result` — 发送结果（成功与失败）

| 字段 | 值 |
| --- | --- |
| `name` | `send_result` |
| `group` | `send_funnel` |
| `value` | **`send_cost_ms`**：点击发送 → 本次落定的**端到端**耗时 = 落定时刻 − `sendTime`，失败时同样填写 |

把耗时放在 `value` 而不是 `properties`，是本次选择 ARMS 通道的核心原因：ARMS 侧可直接对该事件做 avg / p50 / p95 / p99，并按下列 property 切分。

`properties`：同 `send_click` 的 seed 字段，加上：

| 键 | 类型 | 含义 |
| --- | --- | --- |
| `send_click_id` | string | 与 `send_click` 配对的关联 ID |
| `status` | string | `success` / `fail` |
| `reason_code` | string? | 成功时缺省不下发；失败时见下表 |
| `ack_status` | string? | ACK 的原始 status（`accepted` / `duplicate` / `rejected` / `stale` / `failed` / `noop`）；未拿到 ACK 时缺省不下发 |
| `send_cost_ms` | number | 与 `value` 同值，冗余一份便于在 property 维度直接看数 |
| `ack_cost_ms` | number? | 点击发送 → 收到 ACK 的耗时 = ACK 时刻 − `sendTime`；未拿到 ACK 的失败路径缺省不下发 |
| `send_queue_confirmed` | boolean | `true` 表示中途经过队列二次确认弹窗 |
| `talk_id` | string? | 落定时已知的 `sessionId`；首发未 promote 时缺省不下发 |
| `message_id` | string? | ACK 对应的 `commandId`；未进入 dispatch 的失败路径缺省不下发 |

**`send_cost_ms` 与 `ack_cost_ms` 的关系**：`send_cost_ms − ack_cost_ms` 即「投影回流 + React 渲染」那一段。端到端变慢时先看这个差值落在哪边，避免把渲染问题误判成网络问题。

`reason_code` 取值：

| 值 | 触发点 |
| --- | --- |
| `attachment_not_ready` | `attachmentsApi.prepareForSend()` 返回 `null`，附件预传二次门禁失败 |
| `blocked` | `onSendText` 返回 `"blocked"`，产品 guard 拒绝 |
| `rejected` / `stale` / `failed` | ACK 的对应 status |
| `render_timeout` | ACK 已 `accepted` / `duplicate`，但 30 s 内投影始终没回流出对应的 `userInput` row |
| `transport_error` | `sendCommand` 抛异常（非 provider 未就绪） |
| `provider_not_ready` | `sendCommand` 抛 provider 未就绪异常 |
| `composer_error` | `submit()` catch 到的其余异常 |

`attachment_not_ready` 与 5.2 「附件未就绪不报 `send_click`」不矛盾：前者是点击时 `hasUnreadyAttachments` 已为真、按钮 disabled，压根没进 `submit()` 主体；后者是点击时附件看起来就绪、`send_click` 已上报，随后 `prepareForSend()` 才失败。后一种若不落定会留下悬空的 `send_click`，污染成功率分母。

**`noop` 的归口**：`CommandAck.status` 还有一个 `noop`（命令被 Host 判定无需执行）。它不单列 `reason_code`，统一记为 `failed`——从「消息有没有发出去」的用户视角看它就是没发出去；原始值保留在 `ack_status=noop`，需要区分时按该字段下钻。

**不落定的 ACK**：`ack.reasonCode === "guard.heldQueueConfirmationStale"` 是队列二次确认的信号，语义是「等用户裁决后复用同一 seed 重发」，不是终态。此时**不得**调 `settleSendResult()`，也**不得**登记待渲染——一旦落定，first-wins 会把随后真实的成败结果吃掉。该判断优先于 `ack.status`（这条 ACK 的 status 本身非 `accepted`）。

`ConversationSendFailureReason` 与 ACK 的映射由 `resolveSendAckSettlement()` 一个纯函数收口（`conversationTelemetrySupervisor.ts` 导出），`dispatchCommand` 只负责调用，不自己写分支。**该函数的返回语义本次调整**：`accepted` / `duplicate` 不再返回终态，而是返回 `{ kind: "awaitRender" }`，由调用方登记待渲染；其余 ACK 仍返回 `{ kind: "settle", status: "fail", … }` 立即落定。

### 5.4 待渲染等待机制

ACK 为 `accepted` / `duplicate` 时，supervisor 以 `commandId` 为键登记一条待渲染记录，内含 seed、`ackCostMs`、以及一个 30 s 定时器：

| 触发 | 动作 |
| --- | --- |
| `snapshot.rows.window` 出现 `kind === "userInput" && sourceCommandId === commandId` | 落定 `status=success`，`send_cost_ms` = 渲染时刻 − `sendTime` |
| 30 s 定时器先到 | 落定 `status=fail` / `reason_code=render_timeout`，`send_cost_ms` = 30000 |
| `dispose()` | 清空所有定时器，不补报 |

两条路径 **first-wins**：任一方落定后立即注销记录并 `clearTimeout`，`settledSendClickIds` 的既有去重再兜一层，保证一次 `send_click` 只有一条 `send_result`。

渲染信号由 `SessionPane` 在投影更新的 commit 阶段（`useEffect` 依赖 `snapshot`）产生：遍历 `snapshot.rows.window` 的全部 `userInput` row，把每条的 `sourceCommandId` 交给 supervisor；supervisor 内部按待渲染表过滤（`Map.get` O(1)），没登记过的 commandId 直接忽略，故历史消息回填、切会话重载都不会误触发。

**不能只取最后一条 `userInput`。** 用户消息回流后，后台结果行（`origin=backgroundResult`）可能紧随其后插到窗口尾部，只看尾部会漏掉用户自己那条，把一次正常发送误判成 `render_timeout`。全窗扫描的代价与同文件既有的 `hasPluginReferenceUserRows()` 同量级，且只在 effect 里跑一次。

**为什么取 `useEffect` 而不是 store 订阅回调**：`useEffect` 在 DOM commit 之后执行，此时用户气泡已经真的画到屏幕上；store 订阅回调只代表数据到了，React 还没渲染。口径是「呈现到对话历史里」，必须取 commit 之后。

**耗时口径**：`send_cost_ms` 从**首次**点击发送算起。若中途出现队列二次确认弹窗，这段用户停留时间被计入，故用 `send_queue_confirmed=true` 标记，纯通道耗时分析应剔除该子集（ARMS 侧按该 property 过滤）。

**去重**：按 `send_click_id` first-wins，一次 `send_click` 只对应一条 `send_result`。`duplicate` ACK 与 `accepted` 同样进入待渲染等待——命令确实存在于 Host 侧，用户视角仍应看到自己的消息，等到 row 就记 `status=success`。

**悬空样本**：目前有两个来源。其一，队列二次确认弹窗被用户取消时，该次 `send_click` 永远不会有配对的 `send_result`——这是真实的用户放弃行为，ARMS 侧按 `send_click_id` 无配对识别，不做补报。其二，slash 命令路径尚未接入（见文首「已知缺口」），属实现缺口而非用户行为，算成功率时需要剔除；该路径接上 `telemetrySeed` 后本条即失效。

## 6. 不上报的场景

以下场景**不得**产生这三个事件，与既有「不伪造用户动作」原则一致：

- 非桌面端（Web、手机远控）：reporter 不装，整组静默。
- 后台自动任务（Off-Peak、automation）：不经过 composer，seed 没有 `sendClickId`，落定时直接跳过。
- 队列 promotion（排队消息被激活为当前轮）：不是新的用户点击。
- 程序性自动聚焦：见 5.1。

## 7. 失败不得反噬主流程

ARMS 属观测链路，与既有 `uiPerfArmsTelemetry` 同构：`emit()` 内 `try/catch` 包住同步异常，并对返回的 Promise 挂 `.catch()`，失败只 `logger.warn`，**绝不阻断发送主链路**。reporter 未安装（Web / 未初始化）时直接 `return`，不排队不缓存。

三个事件都是同步 fire-and-forget，不经 `enqueueReport` 串行队列——那条队列是 `/event/report` 通道的顺序保证，ARMS 无此需求（与 `reportUiFirstToken` 等既有 ARMS 事件写法一致）。

## 8. 实现落点

| 文件 | 改动 |
| --- | --- |
| `packages/ui/src/lib/sendFunnelArmsTelemetry.ts` | **新建**。导出 `SEND_FUNNEL_ARMS_GROUP` 与三个事件名常量、`setSendFunnelArmsReporter()` / `clearSendFunnelArmsReporterForTest()`、`reportSendFunnelInputFocus()` / `reportSendFunnelSendClick()` / `reportSendFunnelSendResult()`。结构照抄 `uiPerfArmsTelemetry.ts`。`SendFunnelReasonCode` 增加 `render_timeout`，`reportSendFunnelSendResult()` 增加可选 `ackCostMs` → property `ack_cost_ms` |
| `packages/ui/src/Root.tsx` | 既有 `useEffect` 内增加 `setSendFunnelArmsReporter(isDesktop ? platform : null)`，cleanup 置 `null`（与 `setUiPerfArmsReporter` 并列） |
| `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | `recordComposerFocusClick()` / `recordSendClick()` / `settleSendResult()` 改为调上述 ARMS helper，**不再 `enqueueReport`**；`resolveSendAckSettlement()` 改为返回 `await-render` / `settle` 两态；新增 `awaitSendRender()`（登记待渲染 + 挂 30 s 定时器）与 `notifyUserInputRendered(commandId)`（渲染信号入口）；`dispose()` 清理全部待渲染定时器 |
| `packages/ui/src/v4/ConversationComposer.tsx` | 接线不变（方法签名未变） |
| `packages/ui/src/v4/SessionPane.tsx` | ACK 分支按 `resolveSendAckSettlement()` 的新返回分流：`awaitRender` 调 `awaitSendRender()`，`settle` 调 `settleSendResult()`；新增一个依赖 `snapshot` 的 `useEffect`，遍历 `snapshot.rows.window` 的全部 `userInput` row，把 `sourceCommandId` 交给 `notifyUserInputRendered()` |

`send_click_id` 生成复用 `globalThis.crypto?.randomUUID?.()` + 降级实现（同 `codingPlanFunnelTelemetry.createPurchaseFunnelId`）。

## 9. 测试要求

按 AGENTS.md，先补测试再实现。

- `packages/ui/test/v4ComposerSendFunnelTelemetry.test.ts`：断言对象为 **ARMS payload**（`name` / `group` / `value` / `properties`），覆盖——真实 focus 上报 / `recordComposerFocus` 保持零上报、`send_click` 与 `send_result` 的 `send_click_id` 配对、`send_trigger` 两种取值、九类失败 `reason_code`、`send_click_id` 去重 first-wins、`value` 即 `send_cost_ms` 与队列确认口径、后台任务不报、reporter 未安装时静默、dispose 后静默，以及 `resolveSendAckSettlement()` 的 ACK 映射（含 `noop` 归口与队列二次确认不落定）。
- **待渲染等待专项**（本次新增口径的核心护栏）：
  - ACK `accepted` 后**不立即**上报 `send_result`；
  - 收到匹配的渲染信号后才上报，且 `value` / `send_cost_ms` 等于**端到端**耗时（渲染时刻 − `sendTime`），`ack_cost_ms` 等于 ACK 那一段；
  - `duplicate` 与 `accepted` 走同一条等待路径；
  - 30 s 未等到 → `status=fail` / `reason_code=render_timeout` / `send_cost_ms=30000`；
  - 渲染信号与超时之间 first-wins，先到者落定、后到者静默（两个方向都要测）；
  - 未登记的 `commandId` 渲染信号不触发任何上报（历史消息回填 / 切会话重载）；
  - 队列二次确认的 ACK 既不落定也不登记待渲染；
  - `dispose()` 后定时器不再触发上报（用假时钟推进到 30 s 后断言零上报）。
- **`/event/report` 零污染**：必须断言这三个动作**完全不调用** `platform.reportTelemetryEvent`，且既有 `send_btn` 的时机与字段保持不变——这是「不动 `send_btn`」与「只走 ARMS」两条约束的回归护栏。

**不纳入 legacy↔V4 差分 parity**：`conversationTelemetryParityScenarioDefinitions.ts` 的 `minimumReportInventory` 名为「最小」，实际在 `conversation-session-telemetry-parity-all-cases.test.ts` 里是 `toEqual` 精确匹配，且同一份期望要同时约束 legacy 与 V4 两个 bridge variant。这三个事件只由 V4 的 `ConversationTelemetrySupervisor` 产生，legacy 回放驱动没有 supervisor，无从产生对应事件——把它们写进期望表会让 legacy 变体必然失败。parity 的职责是证明新旧两版最终出口等价，V4 独有的新增事件不属于该职责范围，改由上面的单测覆盖。该表约束的是 `/event/report` 出口，本次三个事件不走该通道，天然不在其射程内。

这不构成埋点盲区：全仓只有 `packages/ui/src/v4/ConversationComposer.tsx` 一个发送入口，legacy 的 `queuePromptTelemetry` 等 helper 现今只被 V4 supervisor 与该回放驱动引用，不存在未插桩的真实发送路径。
