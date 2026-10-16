# Conversation Session Validation Matrix

目标：把会话区 MVP case 变成可执行验证任务。case catalog 负责描述“产品应该怎样”，本文件负责描述“怎么证明它真的这样”。

协议来源：

- [conversation-protocol-declaration.md](./conversation-protocol-declaration.md)
- [conversation-session-case-catalog.md](./conversation-session-case-catalog.md)

## 验证原则

每条 E2E case 至少要有一条用户可见断言和一条非 UI 证据。UI 是主断言，因为产品最终由用户体验定义；日志、协议、网络、文件是辅助证据，用来定位异步、队列、持久化和跨 session 问题。

UI 断言必须是工程化、确定性的：用全局 `data-testid` 定位元素，用 DOM 属性、输入值、normalized text、disabled 状态和元素数量判断结果。截图和录像只作为失败复盘 artifact，不作为自动化通过条件。会话区 test id 合同见：[conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md)。

默认无错误横幅规则：除非 case 在产品预期里明确声明“应该出现错误横幅”，任何正向 case 或非故障路径在测试过程中出现 `ChatViewErrorBanner` / `ChatErrorBanner` 都判定为失败。典型反例是 compact、goal、queue、fork、edit、model switch 这些正向路径里弹出错误条；即使其他 UI 状态最终看起来正确，也不能把该 case 记为通过。允许出现错误横幅的 case 必须在 catalog / coverage matrix / spec 名称或备注里显式标注为 fault、negative、error recovery 或 provider/network failure，并写清楚期望的错误来源、是否可 dismiss、后续按钮/queue 状态。

| 证据层        | 证明什么                                 | MVP 采集方式                                                                                      |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| UI            | 用户实际看到的状态和可操作性             | WDIO `data-testid` locator、DOM 属性、输入值、normalized text、disabled 状态、元素数量            |
| Runtime/Store | renderer 内部投影是否符合产品状态        | 测试专用状态导出，记录 `sessionId`、`phase`、`queue.length`、`autoDrain`                          |
| Protocol      | app 和 agent 的真实命令是否符合预期      | 捕获 `session/send`、`session/compact`、`session/goal`、`session/stop`、`session/fork` 请求和响应 |
| Log           | 异步流程是否命中正确分支                 | UI logger、service logger、agent log，按 `caseId/runId/sessionId/inputId` 关联                    |
| Network/SSE   | 模型流、错误、compact 重试是否按预期发生 | mock provider 记录请求、SSE event 和事件时间                                                      |
| Files         | 会话历史、配置、fork 结果是否落盘正确    | 测试结束导出 session snapshot、配置快照、相关文件树                                               |
| Artifact      | 失败后可复盘                             | 每条 case 独立目录，保留截图、录像、日志、协议帧、网络帧、snapshot；不参与 pass/fail              |

## Artifact 结构

每条 case 生成一个目录，避免多个 session 并发时证据混在一起。

```text
artifacts/conversation-session/<caseId>/<runId>/
  screenshots/
    01-before.png
    02-after-action.png
    03-final.png
  video.mp4
  ui-log.ndjson
  service-log.ndjson
  agent-log.ndjson
  protocol-frames.ndjson
  network-events.ndjson
  session-snapshots/
    before.json
    after-action.json
    final.json
  files/
    workspace-tree-before.txt
    workspace-tree-after.txt
```

截图和录像是证据归档，不是断言来源。自动化通过条件必须写在 UI / Runtime / Protocol / Network / Files 等确定性层里。

所有日志和帧都必须带这些关联字段：

```text
caseId
runId
workspaceIdentity
workspacePath
sessionId
inputId
queryId
clientMode
```

没有某个字段时显式写 `null`，不要省略；这样后续可以机械 join。

## MVP Case 选择

第一批只选最能证明闭环的 10 条，不覆盖外部异常、磁盘满、429/503、移动端 replayable 等环境维度。

| MVP ID | Catalog ID  | 为什么先测                                                     |
| ------ | ----------- | -------------------------------------------------------------- |
| MVP-01 | A01         | 跑通首发、建 session、进入详情页的最小闭环                     |
| MVP-02 | A03         | running 中普通消息入队，是队列能力根节点                       |
| MVP-03 | A08         | running 中 `/compact` typed 入队，验证 FIFO 与禁止伪装普通消息 |
| MVP-04 | A07/H03/H04 | running 中 `/goal` 入队，验证命令和普通 prompt 的区别          |
| MVP-05 | B02         | stop 后 queue 保留且不自动消费                                 |
| MVP-06 | B06/B08     | 停止后的 held queue：继续输入入队、立即发送才消费              |
| MVP-07 | D03         | edit 历史 user query 时 queue 保留                             |
| MVP-08 | E07/K08     | fork 稳定 assistant 不复制父 session queue                     |
| MVP-09 | F03/F08     | 手动 compact 与 held queue 共存                                |
| MVP-10 | G01/G10     | 自动 compact 成功后继续 pendingAction                          |

## Probe Matrix

### MVP-01 首发进入详情页

Catalog：A01

| 层            | 断言                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| UI            | 输入“这是个什么项目”并发送后，进入 session 详情页；用户消息可见；composer 清空；显示正在生成或预热状态 |
| Runtime/Store | 产生非空 `sessionId`；`phase` 进入 `prewarming` 或 `running`；queue=0                                  |
| Protocol      | 只有一次首发相关的 session 创建和发送；`content` 等于“这是个什么项目”                                  |
| Log           | 记录 workspace prepared、session created、first prompt accepted                                        |
| Network/SSE   | mock provider 收到一次模型请求并开始输出 SSE                                                           |
| Files         | session snapshot 中存在首条 user message                                                               |
| Artifact      | before、after-send、first-token 三张截图，仅用于失败复盘                                               |

### MVP-02 Running 中普通消息入队

Catalog：A03

| 层            | 断言                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| UI            | 当前轮 streaming 时发送“继续解释”；queue 面板出现 1 条待发送消息；当前 assistant 仍继续生成 |
| Runtime/Store | `phase=running`；`queue.length=1`；queue item 内容为“继续解释”                              |
| Protocol      | 不应立即出现第二次同 session `session/send`                                                 |
| Log           | 记录 enqueue 分支，不能记录 queue drain started                                             |
| Network/SSE   | 当前模型请求持续；没有第二条模型请求                                                        |
| Files         | 当前已落盘历史不包含“继续解释”的 user turn，除非队列之后被消费                              |
| Artifact      | queue 面板截图、protocol frame 截取，仅用于失败复盘                                         |

### MVP-03 Running 中 `/compact` 入队

Catalog：A08

| 层            | 断言                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| UI            | streaming 时发送 `/compact`；出现“已加入队列”反馈；queue 追加 `/compact` 维护项；此时没有 compact timeline marker |
| Runtime/Store | `phase` 仍为 `running`；queue 末尾新增 kind=`compact`；`activeTurnKind` 不变                                      |
| Protocol      | 当前 work 完成前不新增 compact 模型请求；queue promotion 后才执行 compact；不把 `/compact` 当普通 `session/send`  |
| Log           | 记录 compact admission/enqueue；ready 边界后记录 typed promotion                                                  |
| Network/SSE   | 当前模型请求持续；其完成前没有新增 compact 模型请求                                                               |
| Files         | session snapshot 不新增 `/compact` user message；compact 真正执行后才新增 summary/marker                          |
| Artifact      | queue/toast 截图、协议 FIFO 顺序摘要；通过判定以 queue item kind 与请求时序为准                                   |

### MVP-04 Running 中 `/goal` 入队

Catalog：A07、H03、H04

| 层            | 断言                                                                                  |
| ------------- | ------------------------------------------------------------------------------------- |
| UI            | streaming 时发送 `/goal 修完登录流程`；queue 面板新增一条 goal 队列项；当前轮不被打断 |
| Runtime/Store | queue 新增 item，类型或内容能保留 `/goal` 语义；`phase=running`                       |
| Protocol      | 发送当下不出现 `session/goal`；当前轮完成且 queue 消费时才出现 `session/goal`         |
| Log           | enqueue goal，随后 drain goal；已有 goal 时记录 update 语义，无 goal 时记录 set 语义  |
| Network/SSE   | 当前模型请求不新增；goal 消费是否触发后续模型请求由 goal 结果决定                     |
| Files         | goal 消费前 session target 不变；消费后 target 设置或更新                             |
| Artifact      | 入队前后 snapshot、消费后的 target snapshot                                           |

### MVP-05 Stop 后 Queue 保留且不自动消费

Catalog：B02

| 层            | 断言                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| UI            | running 且 queue=1 时点 stop；当前轮显示停止/中断结果；queue 仍显示 1 条；没有自动 loading 下一轮 |
| Runtime/Store | `phase=completed(interrupted)`；`queue.length=1`；`queue.autoDrain=false`                         |
| Protocol      | 出现 `session/stop`；stop 后不立刻出现队首 item 的 `session/send`                                 |
| Log           | stop accepted；没有 queue drain started                                                           |
| Network/SSE   | 当前 SSE 被中断或结束；没有新模型请求                                                             |
| Files         | session snapshot 保留 interrupted assistant 状态；queue snapshot 保留原 item                      |
| Artifact      | stop 前、stop 后、等待稳定后三张截图，仅用于失败复盘                                              |

### MVP-06 Held Queue 下继续输入和立即发送

Catalog：B06、B08

| 层            | 断言                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| UI            | `completed(interrupted), queue=1, autoDrain=false` 时继续输入“再补充”；queue 变 2；点击第二条“立即发送”后，第二条移到队首并开始消费 |
| Runtime/Store | 继续输入只追加 queue，不改 `autoDrain`；立即发送后目标 item 成为 active input                                                       |
| Protocol      | 继续输入发送一次 `sendText` 并由 CLI 投影为 queue item；“立即发送”发送 `sendQueuedNow`，消费时不得重复 admission command            |
| Log           | append queue item；send now/promote queue item；queue drain started                                                                 |
| Network/SSE   | 立即发送后才出现新模型请求                                                                                                          |
| Files         | 消费前 session 历史不含“再补充” user turn；消费后出现对应 user turn                                                                 |
| Artifact      | queue 顺序变化截图、protocol frame；通过判定以 queue item id 顺序为准                                                               |

### MVP-06b Running Guide 模式引导消息保留

Catalog：M06a、M06b、M06c

| 层            | 断言                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | 初始 settings 明确为 `zcodeInteractionBehavior=guide`；`running, queue=0` 时继续发送普通文本；引导消息显示为 `turn-steer` queue item，或投影为 user message；短暂等待后不得从两处都消失 |
| Runtime/Store | 选中 provider 为 `glm`，发送前本地 queue=0；引导 item 带 `turnSteer.status=submitting/queued`；若运行时终态先到，必须 strip turnSteer 回退本地 queue，而不是移除消息                    |
| Protocol      | guide 模式仍发送 `sendText`；CLI 根据 `inputRouting`/follow-up mode 投影为 guide 输入，不创建独立普通 turn；不满足 guide 条件时由 CLI queue 收口，不回退 renderer-local queue           |
| Log           | 记录 agent-side steer queued / drained / rejected / fallback；若事件乱序，应能从 pendingInputId/messageId 关联回原引导 item                                                             |
| Network/SSE   | 引导消息不应生成一条独立的普通模型请求；若被 drained，后续内容应归入当前 turn；若回退，后续 queue drain 再发普通请求                                                                    |
| Files         | drained 后 session 历史包含带 guided 标记的 user turn；未 drained 时 queue snapshot 保留原引导文本                                                                                      |
| Artifact      | settings snapshot、发送后 queue item `data-kind=turn-steer` / guided user message、等待稳定后的 queue/history 状态；通过判定以 marker 和 queue item id 双锚点为准                       |

### MVP-06c Running Queue 立即引导后续复现矩阵

Catalog：M07a、M07b、M07c、M07d、M07e、M07f、M07g、M07h

| Case | 断言                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| M07a | `running + queue text + 点队首立即`：队首文本在 stop 后成为下一轮 active input；消息进入 user history；无重复请求           |
| M07b | `running + queue text + 点非队首立即`：被点项提升并消费；未点项保持相对顺序；目标消息不丢失                                 |
| M07c | `running + queued /goal + 点立即`：goal item 按 goal 语义消费并更新 target；不得当普通文本发送或吞掉                        |
| M07d | `active turn 处在 tool call / approval window 时点立即`：tool/approval 路由仍归属旧 turn；抢占只影响 queue drain            |
| M07e | `stop terminal event 迟到时点立即`：late terminal event 只能收口旧 active input；不得覆盖新一轮消息、queue 或 activeInputId |
| M07f | `activeInputId 缺失时桌面 fallback 还能 stop + drain`：fallback 日志可见；被点 item 仍能进入下一轮；不静默跳过              |
| M07g | `连续快速点两次立即`：send-now 幂等；同一 item 不重复发送；未点 item 不被误删                                               |
| M07h | `running 中切模型后再立即`：旧 in-flight 请求不变；被点 queue item 消费请求使用最新 session 模型/思考深度                   |

### MVP-07 Edit User Query 保留 Queue

Catalog：D03

| 层            | 断言                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| UI            | `completed(interrupted), queue>0` 时 edit 任意历史 user query 并提交；session 开始重跑；queue 仍显示原内容 |
| Runtime/Store | edit 后 `phase=running`；queue 内容、顺序、`autoDrain=false` 保持                                          |
| Protocol      | 出现 rewind/edit 相关请求和后续 send；不出现 queue clear                                                   |
| Log           | rewind accepted；queue preserved                                                                           |
| Network/SSE   | 出现 edit 重跑的新模型请求                                                                                 |
| Files         | snapshot 活跃历史切到新分支；queue snapshot 未变                                                           |
| Artifact      | edit 前后历史截图、queue snapshot diff；通过判定以 message id、queue item id 和 snapshot diff 为准         |

### MVP-08 Fork 稳定 Assistant 不复制 Queue

Catalog：E07/K08

| 层            | 断言                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | fork 点为父 session 中已稳定 `completed(success)` assistant；父 session 即使有 held queue，fork 后进入或创建 fork session；父 queue 保留；新 session queue 为空 |
| Runtime/Store | parent queue 不变；fork session 有新 `sessionId`，queue.length=0                                                                                                |
| Protocol      | 出现 `session/fork`，target 指向 assistant message；不出现复制 queue 的命令                                                                                     |
| Log           | fork accepted，记录 parentSessionId、forkedSessionId、targetMessageId                                                                                           |
| Files         | fork session 历史只包含 fork 点前内容；没有父 session queued prompt                                                                                             |
| Artifact      | 父 session queue 截图、新 session queue 空状态截图，仅用于失败复盘                                                                                              |

### MVP-09 手动 Compact 与 Held Queue 共存

Catalog：F03、F08

| 层            | 断言                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI            | `completed, queue>0, autoDrain=false` 时手动 compact；出现 compact started timeline；compact 成功后同一 timeline 更新 success；queue 仍保留且不自动消费 |
| Runtime/Store | compacting 时 `origin=manual`；完成后 `phase=completed(success)`；queue 未变；`autoDrain=false`                                                         |
| Protocol      | 出现一次 `session/compact`；不出现 queue item 的自动 `session/send`                                                                                     |
| Log           | manual compact started/completed；没有 queue drain started                                                                                              |
| Network/SSE   | 出现 compact 模型请求；没有 queue 消费模型请求                                                                                                          |
| Files         | session snapshot 有 compact summary 或 marker；queue snapshot 未变                                                                                      |
| Artifact      | compact started/success timeline 截图、queue 保留截图；通过判定以 compact marker test id 和 queue item id 为准                                          |

### MVP-10 自动 Compact 成功后继续 PendingAction

Catalog：G01、G10

| 层            | 断言                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| UI            | 触发普通发送时系统判定需要 auto compact；先显示自动 compact timeline；compact 成功后继续显示用户消息并进入生成 |
| Runtime/Store | `compacting(origin=auto)` 后恢复到 pendingAction 的 `running`；pendingAction 不丢失、不重复                    |
| Protocol      | compact 相关请求先发生；成功后才发生 pendingAction 对应的 `session/send` 或 `session/goal`                     |
| Log           | auto compact attempt 1 success；continue pendingAction                                                         |
| Network/SSE   | compact SSE 先结束；随后 pendingAction 模型请求开始                                                            |
| Files         | snapshot 中 compact marker 在 pendingAction 对应 user turn 之前；没有重复 user turn                            |
| Artifact      | timeline 顺序截图、protocol/network 时间线；通过判定以 marker/message DOM 顺序和 protocol/network 时间线为准   |

## 需要补的测试能力

这些是为了跑通 MVP 而需要的最小能力，不代表完整自动化平台。

| 能力                    | 用途                                         | MVP 要求                                                                                                                                                                        |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 稳定 UI selector        | WDIO 不靠文本、CSS class、截图猜元素         | 按 [conversation-session-ui-testid-contract.md](./conversation-session-ui-testid-contract.md) 补齐 queue、message、compact marker、fork、edit、toast、model selector 等 test id |
| Protocol capture        | 验证命令有没有发、顺序是否正确               | 每条请求/响应写入 `protocol-frames.ndjson`                                                                                                                                      |
| Mock provider/SSE       | 让 running、stop、compact、auto compact 可控 | 支持延迟 token、失败、三次 compact retry、成功恢复                                                                                                                              |
| Session snapshot export | 验证历史、queue、goal、模型配置              | case 关键阶段可导出 JSON                                                                                                                                                        |
| Log correlation         | 让 UI、service、agent、protocol 能 join      | 所有日志带 `caseId/runId/sessionId/inputId`                                                                                                                                     |
| Artifact collector      | 失败后能复盘                                 | 测试结束统一收集截图、录像、日志、协议帧、网络帧、snapshot；截图不参与自动判定                                                                                                  |

## 执行顺序

1. 先人工实现 MVP-01 到 MVP-03 的 probe，证明 UI + protocol + log + snapshot 能收齐。
2. 再接 queue、stop、edit、fork、compact 的 case。
3. 最后接自动 compact，因为它需要 mock provider 支持阈值触发、重试和时间线顺序。
4. MVP 稳定后，再把 case catalog 中其余 accepted case 批量映射到同一套 probe 模板。

## Todo156 Start 后续修复

验收边界使用 [Todo156 SF-01～SF-19](working-memory/provider-refactor/steps/todo-156-start-plan-followup-final-decisions.md) 的最终决策。`conversation-session-start-plan-independent` 待人工复核用例补充 SF-01/02/08/10/13：付费连接下 Start 圆环、团队下拉选中、套餐名称、带参数副屏首条的关闭／确认／不了，断言实际模型请求和主输入框草稿不变。其余缓存状态组合由 `startPlanRecommendationFreshness`、`providerFamilyConnectionVisibility` 与状态卡测试覆盖；桌面／手机视口与深浅主题另走浏览器视觉用例。此记录不是 CI 转正或全部 SF 的 E2E 覆盖声明。
