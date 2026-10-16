# Synthetic Timeline Dividers

## 背景

聊天区存在几类非正文 timeline divider：上下文压缩、session fork、模型切换、goal 校验目标。这些消息用于解释会话状态变化，不属于 assistant 正文。新的 turn 视图模型见 [conversation-turn-view-model.md](./conversation-turn-view-model.md)，持久化存储规范见 [conversation-transcript-storage.md](./conversation-transcript-storage.md)。

## 行为约束

- timeline divider 需要先归类为 worklog 或 boundary，再生成 ChatView render row。
- compact 是 assistant turn 的 worklog：auto compact completed 可以挂到后续 assistant 的 history prefix，被“已工作 xxx”折叠；running / retrying compact 仍要保持可见。
- goal verification 和 session fork 是 boundary：不得挂到前一个或后一个 assistant 的 history prefix / suffix 中。
- 上下文压缩开始时，发送 `/compact` 后本地立即插入 `context_compaction` started divider，用户应马上看到“上下文正在压缩”状态；完成后同一 divider 更新为 completed。
- 本地 optimistic compact divider 和 agent lifecycle divider 必须合并为同一条 UI 消息。agent lifecycle 可能没有 `inputId`，此时用“最新的本地 running compact divider + 非本地 operationId”作为兜底匹配。
- running `context_compaction` 与 `goal_verification` timeline 已经是专用进度反馈，对应 active work 期间底部 ChatLoading 必须隐藏。`session_fork` 与 `model_change` 只是说明性 divider，本身不续住主轮 running 状态。
- running / retrying compact 和 goal verification 是 assistant 输出边界，不属于前一条或后一条 assistant 的工作耗时；进入这类 divider 前必须冻结此前仍处于 streaming 的普通 assistant。completed auto compact 作为后续 assistant 的 worklog prefix 渲染，不再单独冻结为顶层边界。`session_fork` 与 `model_change` 不冻结 assistant 耗时。
- `session_fork` 和 `goal_verification` 来自 agent / snapshot 的 synthetic timeline，需要随 snapshot 恢复。
- legacy `model_change` 是 renderer 本地 UI timeline，用来标记模型切换发生的位置；transcript v2 后，新发生的 model change 应写入 agent 侧 `part.type="timeline"`。它仍不注入 agent 上下文，也不作为 agent message 持久化。

## 稳定身份

- `ZCodePersistedMessage.id` 保存协议侧原始 `messageId`。snapshot 恢复时优先使用该 id，避免实时消息与恢复消息使用不同 id。
- 旧 snapshot 没有 `id` 时，UI 根据 timeline 语义生成 fallback id：
  - `context_compaction`: `operationId`
  - `goal_verification`: `targetId + goalIteration`；`verificationId` 只表示 verifier attempt
  - `session_fork`: `parentSessionId + targetMessageId + targetCheckpointId`
- terminal snapshot 对齐时，timeline 去重同时检查 id 和语义身份。这样旧数据、replayable 恢复和 desktop continuous 终态 snapshot 都不会把同一个 divider 重复插入或挪到错误位置。

## 多端边界

本规范只调整消息投影、恢复去重和 ChatView 渲染，不改变任务实时链路：

- 桌面端仍走 `desktop-continuous` direct realtime。
- 手机远控仍走 `web-remote-replayable` snapshot / gap 恢复。
- relay、main process 不新增 task/session 业务状态。
