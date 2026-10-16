# Conversation Product State Space

目标：把对话产品里的 compact、fork、goal、消息队列、query 编辑等功能组合成可执行的产品状态空间模型。模型先枚举用户在 GUI 中可能做的下一步，再用产品规则剪枝，最后输出可人工 review、可转 E2E 的 trace case。

协议声明的基础概念见 [Conversation Behavior Protocol Declaration](./conversation-protocol-declaration.md)。这份文档先定义节点类型、输入事件、decision、rule、不变量和 case review 语义；可视化页面只是这份协议展开后的一个视图。

## 为什么不是普通流程图

对话 GUI 不是单线流程。用户在每个时刻都可能继续输入、触发 `/compact`、设置 goal、fork 某个轮次、编辑 query、点击历史轮次，系统同时还会完成运行、完成 compact、进入 goal 验证或返回异步错误。

因此模型的基本形状是：

```text
产品上下文 × 用户动作 × 目标对象 × 系统阶段 -> guard -> effect -> 下一产品上下文
```

辅助对话参数命令是 parent-scoped 的创建动作，不是 parent 的普通输入：

```text
parent composer `/btw <text>`
  -> App command parser (text-only, CLI same-name wins)
  -> createSelectionSideSession(parent, firstInput=<text>)
  -> child registration + child startNow
  -> open child tab
  -> parent active turn/queue unchanged
```

这不是纯数学笛卡尔积。笛卡尔积只负责暴露候选组合；guard 和 effect 才是产品需求本身。

## 第一版建模范围

状态维度。`compacting` 与 `goalVerifying` 不再作为顶层 phase；它们是 `running` 内的
completion-blocking active work：

| 维度              | 值                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| runPhase          | draft、prewarming、running、completed(success/interrupted)、error                               |
| activeWork        | none、primaryTurn、foregroundSubagent、compact、goalVerifier、goalContinuation、turnSteer       |
| queue             | empty、text、goal、compact、mixed                                                               |
| queueAutoDrain    | true、false                                                                                     |
| queueAuthority    | cliCommandInbox（desktop/mobile 共用；其他值剪枝为 invalid）                                    |
| followupDelivery  | queue、guide、guideFallbackQueue                                                                |
| deliveryProfile   | desktopContinuous、mobileReplayable                                                             |
| forkTarget        | completedSuccessFinalAssistant、middleAssistant、streamingPartial、failedPartial、nonAssistant  |
| compactMemory     | never、compactable、justCompacted、notNeeded                                                    |
| canCompactAgain   | true、false                                                                                     |
| goal              | none、active、paused、budgetLimited、complete                                                   |
| verifierTerminal  | none、explicitPass、failOpenPass、failedContinue、manualCancel                                  |
| selectedTurn      | latest、old                                                                                     |
| toolShape         | none、singleReadonlyTool、parallelTools、activeTool、completedTool、failedTool、interactionTool |
| toolResultBatch   | none、pending、committed                                                                        |
| modelConfig       | native、customProvider、sameModelDifferentProvider                                              |
| modelMarkerSource | adjacentTurnSwitch、explicitSourceLessBoundary、none                                            |
| collaborationMode | build、edit、plan、yolo                                                                         |

用户动作：

| 动作          | 目标                      |
| ------------- | ------------------------- |
| sendText      | 当前输入框                |
| slashCompact  | 当前输入框输入 `/compact` |
| setGoal       | goal 控件或 prompt        |
| compact       | compact 按钮/命令         |
| fork          | latest turn、old turn     |
| editQuery     | latest turn、old turn     |
| sendQueuedNow | queue item                |

系统事件：

| 事件               | 适用阶段                                |
| ------------------ | --------------------------------------- |
| assistantComplete  | running                                 |
| compactComplete    | activeWork=compact                      |
| compactNoop        | activeWork=compact                      |
| goalVerifyPass     | activeWork=goalVerifier                 |
| goalVerifyFail     | activeWork=goalVerifier                 |
| goalVerifyFailOpen | activeWork=goalVerifier                 |
| goalVerifyCancel   | activeWork=goalVerifier                 |
| toolBatchComplete  | activeWork=primaryTurn/goalContinuation |

## 第一批产品规则

这些规则来自当前产品预期。它们在模型中不是注释，而是可执行 guard。

| 场景                                                            | 结果                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| running + sendText                                              | 入消息队列                                                                                                                                                               |
| running + `/compact`                                            | 以 compact 维护意图入 CLI FIFO，不打断当前 active work                                                                                                                   |
| running + setGoal                                               | 入消息队列                                                                                                                                                               |
| running + fork completedSuccessFinalAssistant                   | allow，conversation-only fork；父继续运行，共享 workspace 不 rewind                                                                                                      |
| running + fork middle/streaming/failed/nonAssistant             | reject，目标不是稳定逻辑 turn 边界                                                                                                                                       |
| running + edit latest query                                     | allow，先 stop 当前 active work，再从最后一轮 query 重跑                                                                                                                 |
| running + edit old query                                        | reject，只允许最后一轮 real user query edit                                                                                                                              |
| completed + fork                                                | allow                                                                                                                                                                    |
| completed + compact                                             | allow，进入 compacting                                                                                                                                                   |
| completed + compact after fork                                  | allow                                                                                                                                                                    |
| activeWork=goalVerifier + compact                               | enqueue；等待整个 goal completion 链结束后再按 FIFO 执行                                                                                                                 |
| activeWork=goalVerifier + fork stable                           | allow，可 fork 更早稳定历史；不复制 verifier                                                                                                                             |
| activeWork=compact + compact                                    | reject，正在 compact                                                                                                                                                     |
| activeWork=compact + sendText/setGoal                           | enqueue 到 CLI FIFO，不打断 compact                                                                                                                                      |
| activeWork=compact + fork                                       | reject，compact operation lock                                                                                                                                           |
| justCompacted + compact + canCompactAgain                       | allow，进入 compacting                                                                                                                                                   |
| justCompacted + compact + !canCompactAgain                      | reject，提示刚压缩完，不需要压缩                                                                                                                                         |
| completedTool + compact                                         | allow，工具历史作为普通 completed assistant turn 参与压缩上下文                                                                                                          |
| completedTool + fork                                            | allow，fork 点应包含工具调用块和工具结果投影                                                                                                                             |
| completedTool + setGoal                                         | allow，goal 更新不改写既有工具历史                                                                                                                                       |
| activeTool + sendText/setGoal                                   | enqueue，当前工具调用归属原 active turn                                                                                                                                  |
| sameModelDifferentProvider + session switch                     | allow，按 session 恢复 provider + model 身份，不能只按 model 名回显                                                                                                      |
| running + apiRetry                                              | 只在当前 live turn 底部消费 `control.apiRetry`；`attempt<=2` 视为普通 loading，`attempt>=3` 才显示 retry 次数并替代 loading；有效进展/终态清除，CLI 冷启不恢复           |
| modelMarkerSource=explicitSourceLessBoundary                    | 显式 `∅→X` 生成 source-less `modelChange`；fresh child 持久化该边界，普通 Main 首轮与旧 child 不生成                                                                     |
| desktop/mobile busy + accepted input                            | 按 CLI 串行 admission 顺序进入同一 FIFO；不存在双队列竞态                                                                                                                |
| guide ineligible/attachment/compact/verifier                    | 保留完整 Submission（含 ModelSelection）并 fallback CLI queue；compact 不进入 guided row；模型/provider 不参与 eligibility                                               |
| guide + ordinary queue nonempty                                 | guide 进入当前 active turn；普通 queue 保持未来 turn FIFO，不构成 guide eligibility guard                                                                                |
| guide + toolResultBatch=committed                               | 全部 sibling tool results 先落事实，再最多内联消费一条 guide；同一 product turn 继续，Session Selection 与下一 model step 的 Active Model 切到该 Submission 的 Selection |
| accepted guide + current visual work segment                    | 关闭上一 segment，在同一 product turn 以 guided user entity 开启新 segment；各段工时与折叠独立                                                                           |
| guide + parallelTools + toolResultBatch=pending                 | 不消费；单个 sibling 先完成不能构成 guide boundary                                                                                                                       |
| guide + turn terminal + toolResultBatch=none                    | 同一 intent 原地 fallback queue；保留 IDs、payload、admission order                                                                                                      |
| ordinary queue + session ready + goal=none/complete + autoDrain | 按 FIFO 提升一个队首，并按原 text/goal/compact kind 执行                                                                                                                 |
| ordinary queue + goal=active/paused/budgetLimited               | 保持完整 FIFO；verification marker 或 assistant terminal 都不能提前消费                                                                                                  |
| verifierTerminal=explicitPass/failOpenPass                      | 先 target→complete，再重新评估普通 queue guard                                                                                                                           |
| verifierTerminal=manualCancel                                   | target→paused、autoDrain=false；不自动消费 queue                                                                                                                         |
| activeWork=goalVerifier + stop                                  | 按投影携带的 `foregroundExecutionId` 取消同一 goal execution；verifier→continuation 阶段切换不改变 execution 身份；已切到无关新 execution 时 noop                        |
| CLI restart + admitted nonterminal input                        | explicit discarded；`queue/guide` 静默结算，只有未进 transcript 的 `startNow`/`unknown` 提示确认重发；不自动重放                                                         |
| accepted input ACK + projection silent                          | 宽限期后对当前 owned subscription single-flight resync；权威 queue/user row 到达后收口；不补造 UI 事实、不自动重发                                                    |
| sendQueuedNow                                                   | reserve -> stop barrier -> promote；成功才 remove，失败原位保留                                                                                                          |
| collaborationMode=plan + goal command                           | UI admission reject；toast；保留 composer 原文；不创建 session、不发 command                                                                                             |

传输维度不是产品 guard 的自由变量。host 根据 attachment 可信注入 profile，并按 connection-owned
subscription 路由：

```text
desktop attachment / continuous ── sub-a ──┐
                                            ├─> same terminal projection
mobile attachment  / replayable ── sub-b ──┘

slow/gapped sub-b -> resync sub-b only -> sub-a unchanged
```

最终不变量是：每条已提交输入必须且只能落在 `queue / guided row / transcript /
explicit rejected|failed|discarded` 之一，并沿全链路保留原始 `sourceCommandId`。

guide 与普通 queue 的状态层级不能折叠成一个 generic round-trip drain：

```text
Guide inline path
  admitted -> wait complete tool batch -> one guided drain -> same product turn
       \-> no batch before terminal -> same intent becomes ordinary queue

Ordinary queue path
  queued -> autoDrain -> session ready -> target absent/complete -> future turn
                                      \-> target noncomplete -> stay queued
```

`deliveryProfile` 只影响事实如何到达客户端。desktop continuous 与 mobile replayable 不再与
`followupDelivery × toolResultBatch × goal` 做业务全排列；用同一 CLI terminal projection 的 live/cold
等价测试代表该维度。

模型/provider 不参与 guide eligibility，也不建立模型名白名单或 provider 叉乘。ModelSelection 属于
Submission：guide 被接收后，runtime 在 model-step 边界追加 user history、更新 Session Selection，并为
下一次普通 provider request 创建对应 Model；接收前已经发出的请求保持原 Model。

没有被规则覆盖的组合必须进入 `undefined`，由人判断是新需求、无效状态、可忽略路径还是 bug。

## Review 输出

每个叶子 case 至少包含：

- 初始上下文。
- 用户动作或系统事件。
- 命中的 guard。
- effect：allow、reject、enqueue、system-transition、undefined。
- 下一上下文。
- 建议 E2E 断言。

人工 review 状态：

| 状态      | 含义                     |
| --------- | ------------------------ |
| accepted  | 产品预期正确，可以转测试 |
| undefined | 需要补产品定义           |
| invalid   | 这个组合应从产品入口剪掉 |
| ignored   | 组合存在但暂不覆盖       |
| bug       | 当前实现不符合预期       |

## Vite 可视化

运行：

```sh
pnpm --filter @zcode/formal-proof dev
```

打开：

```text
http://127.0.0.1:4176/
```

页面采用大画布优先布局：左侧固定面板承载参数枚举、语义统计和规则命中；右侧剩余空间全部用于状态空间图及其工具栏。节点详情不占独立列，点击节点后以浮层显示在画布上，避免压缩图的可视面积。

可视化不再使用普通思维导图，而使用分层状态空间 DAG：

- 横向按 `State -> Action -> Guard -> Effect -> Case/Next State` 展开，下一轮枚举继续向右追加同样的语义列。
- `State`、`Guard`、`Effect` 节点按等价语义合并，节点上的 `×N` 表示有 N 条 trace 命中同一个语义节点。
- 用户动作和系统事件都显示在 `Action` 层，系统事件使用同一协议入口，避免把异步长任务隐藏在注释里。
- `Guard` 层体现产品规则剪枝，`Effect` 层体现副作用或状态迁移，`Case` 层保留需要人工 review 或可转 E2E 的叶子。
- `Reject`、`Undefined`、`Queue`、`Allow`、`System` 仍可按规则和结果过滤，高亮的是协议路径而不是布局分支。
