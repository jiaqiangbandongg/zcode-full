# Ghost cursor：对话轮次结束时主动隐藏

## 问题

ghost cursor 只靠 20s 活动租约（`kPointerActivityLeaseMs`）到期后淡出。对话已经结束、
目标 app 也被用户挪走时，光标在租约期内仍停在最后一次动作的位置，看起来像残留的鬼影，
与「Agent 已经不在操作电脑」的事实不符。

## 决策

复用宿主已经在发的 PiP 会话生命周期事件，不新增协议：

- 宿主（`packages/services/src/cua-permission-broker/cuaPipSessionService.ts`）在每轮对话
  开始/结束时发 `turn-started` / `turn-ended`，会话关闭时发 `session-closed`；Helper 内的
  PiP 会话协调器（`createPipSessionCoordinator`）先更新会话状态，再调用副作用。
- Helper 用 `withGhostCursorTurnEndHide` 包装这组副作用：`turnEnded` / `sessionClosed`
  照常转发给 PiP 调度器，之后若**没有任何会话处于 running**，调用 native `ghostHide()`。
- `ghostHide()` 是会话级隐藏：清空目标、停止计时器、`orderOut` overlay，但不关闭 enabled
  开关；下一次 CUA 动作经正常反馈路径恢复显示，无需额外信号。

### 多会话

多个对话同时使用 CUA 时，只有最后一个仍在运行的轮次结束才隐藏，避免 A 对话结束把仍在
操作的 B 对话的光标藏掉。判据取协调器快照（`snapshot().sessions` 中 `status === "running"`）；
协调器在调用 `turnEnded` 前已把该会话置为终态，因此快照反映的是结束之后的状态。

### 不做的事

- 不缩短 20s 活动租约：租约服务于轮次内 cell 之间的思考间隙，缩短会让同一轮内光标闪烁。
- 不在 `turn-started` 时主动显示：没有动作时显示光标没有意义，首个动作自然会显示。

## 验证

- 单测：`withGhostCursorTurnEndHide` 在最后一个运行中的轮次结束、或会话关闭时调用一次
  `hideGhost`；仍有其他会话运行时不调用；原副作用始终被转发且先于隐藏执行。
- 真机：一轮对话操作完 Maps 后结束，光标立即消失；下一轮首个动作光标重新出现。
