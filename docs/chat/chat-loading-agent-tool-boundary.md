# ChatLoading Running Turn Boundary

## 背景

`ChatLoading` 表达主会话当前轮仍在执行。assistant 已经输出正文、reasoning、普通工具或 Agent/SubAgent 卡片，都不代表本轮已经结束。只要最后一个主轮仍为 running 且没有等待用户或维护态 blocker，就立即显示；新的 projection 事件只更新本轮内容，不重置或延迟 loading。

## 状态与时序

```text
latest main turn enters running
              |
              v
       blocker currently active?
              |
              +---- yes: AskUserQuestion / permission / compact / goalVerifier
              |                         |
              |                         +---- hide ChatLoading
              |                                      |
              |                                      +---- blocker resolved
              |                                                   |
              |                                                   +---- show immediately if still running
              |
              +---- no
                                        |
                                        +---- show ChatLoading immediately
              |
              v
 success / failure / cancelled / stopped
              |
              v
         hide ChatLoading
```

## 规则

- 只对最后一个 render turn 判断，历史轮残留的 running row 不显示 `ChatLoading`。
- turn 存在 `turnHeader` 时，`turnHeader.state` 是 running/terminal 的权威事实；已终态 header 不能被同轮残留或迟到的 running 工作行重新推成 running。
- 兼容旧投影缺失 `turnHeader` 时，才允许从工作行兜底推导 running；`backgrounded=true` 的 tool/subagent 属于 background-only work，不参与该兜底。
- `ChatLoading` 视觉上只渲染 loading 动画，不展示“正在思考”或其它可见文案；无障碍名称使用通用“加载中”语义。
- 最后一个主轮为 `running` 且无 blocker 时立即显示 `ChatLoading`，不等待静默窗口。
- assistant text、reasoning、普通 tool、Explore、Agent/SubAgent 以及它们的 descendant tool 都不终止 loading；新的 projection revision 到达时保持当前 loading 可见性。
- 当前 snapshot 存在普通 permission pending interaction，或 `toolName="AskUserQuestion"` 的 userInput pending interaction 时隐藏 `ChatLoading`。权限弹窗/问答框已经表达“正在等待用户”，不应同时展示“正在思考”。
- `toolCall.status="pendingApproval"` 是 interaction 投影暂缺、恢复或乱序窗口的行级兜底，同样隐藏 `ChatLoading`。
- interaction 解决后，如果最后一个主轮仍为 `running`，立即恢复 `ChatLoading`。
- `control.activeWorks` 中只要存在 `compact` 或 `goalVerifier`，就隐藏 `ChatLoading`；两者已有独立 timeline/status 反馈。
- `primaryTurn`、`foregroundSubagent`、`goalContinuation`、`turnSteer` 不属于 active-work blocker，running 时立即显示。
- 主轮进入成功、失败、取消或停止等终态后隐藏 `ChatLoading`。
- background task 仍运行但主轮已经 idle 时不显示 `ChatLoading`。后台任务由 background control UI 表达，不能把主聊天区永久维持在 loading。
- 普通 assistant turn 与结构化 background-result turn 使用相同的 running 生命周期规则。

## 布局与滚动时序

运行中的最后一轮不能继续作为绝对定位的虚拟行承载 `ChatLoading`。历史轮保持虚拟化，最后一个 running turn 作为正常文档流的 live tail 渲染：

```text
timeline scroll viewport
├─ virtual history spacer
│  └─ completed / historical turn（absolute + measured）
├─ running live tail（normal flow）
│  ├─ streaming assistant / tool rows
│  └─ ChatLoading reserved slot
└─ sticky composer dock
```

- projection revision 到达时，timeline 的 layout effect 先执行一次同步吸底；但 Markdown、代码块等子树可能在父 effect 之后才完成真实测高，不能假设 revision commit 已经包含最终高度。
- live tail 的 `ResizeObserver` 是真实高度变化的最终锚定点：回调同时缓存终态切换所需高度，并在仍处于 `following=true` 时于绘制前再次同步吸底。用户已经上滚或存在尚未被 scroll event 入账的上滚时，只缓存高度，不抢回滚动权。
- eligible running 期间 reserved slot 与 loading 动画同步可见；projection revision 不增减 slot 高度。
- running 结束后该轮回归历史虚拟列表；终态不显示 `ChatLoading`。

## 决策与剪枝

| 候选状态                                                           | 决策                       | 理由                                                       |
| ------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------- |
| running + primary/foreground subagent/goal continuation/turn steer | accepted（立即显示）       | 当前主轮仍在推进，loading 直接跟随 running 事实            |
| running 期间到达任意 projection revision                           | accepted（保持当前可见性） | projection 内容更新不改变主轮 running 事实                 |
| permission / AskUserQuestion / pendingApproval                     | pruned                     | UI 正在等待用户操作，不表达“正在思考”                      |
| active work 含 compact / goalVerifier                              | pruned                     | 已有专用维护/验证状态反馈                                  |
| terminal turn 或 background-only work                              | pruned                     | 主轮已经结束，不能用后台事实维持聊天 loading               |
| desktop continuous / web remote replayable                         | accepted（同一 UI 规则）   | 只消费各自交付链路收敛后的同一 V4 snapshot，不改变恢复协议 |

## 多端边界

该规则只修改 UI 对 V4 turn `isRunning` 的展示投影，不修改 ZCode Protocol、snapshot、stream mirror、queue、owner 或 runtime 状态：

- 桌面端仍使用 `desktop-continuous` direct realtime。
- 手机远控仍使用 `web-remote-replayable` snapshot / gap 恢复。
- 两端都消费同一份 turn running/terminal、`control.activeWorks` 与 `pendingInteractions` 投影，恢复后直接根据当前主轮状态和 blocker 决定是否显示 `ChatLoading`。
- background tool/subagent 可以继续通过 background control UI、状态面板和独立结果轮更新；这些更新不得把已经 terminal 的主 turn 复活为 running，也不得因此恢复底部 `ChatLoading`。
