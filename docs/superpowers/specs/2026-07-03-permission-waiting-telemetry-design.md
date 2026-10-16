# Permission Waiting Telemetry 设计

## 变更摘要

恢复 `message_completion.waiting_ms` 的权限等待计时，并为现有
`agent_step` 增加同口径的 `waiting_ms`。权限等待归属于触发授权的
`tool_call`，不新增 `permission_wait` step，不改变 `agent_step_cnt` 和
`loop_index` 语义。

## 指标口径

### `message_completion`

- `duration_ms = max(finishedAt - sendTime, 0)`。
- `duration_ms` 是整轮消息的墙钟耗时，包含模型、工具和用户授权等待。
- `waiting_ms` 是本轮所有权限等待区间的累计值。
- 同一轮有多个 `tool_call` 需要授权时，逐段累加：

```text
message_completion.waiting_ms = Σ permissionWaitDuration
```

### `agent_step`

- 保留现有 `reasoning`、`tool_call`、`generation` 三种 step。
- 所有 step 均上报 `waiting_ms`，非 `tool_call` 固定为 `"0"`。
- `tool_call.duration_ms` 保持从工具开始到工具收口的墙钟耗时，包含权限等待。
- `tool_call.waiting_ms` 只累计归属于当前工具调用的权限等待：

```text
tool_call.waiting_ms = Σ max(permissionWaitEndAt - permissionRequestedAt, 0)
```

- 不从 `duration_ms` 中减去 `waiting_ms`。需要纯执行时间时，由消费端计算：

```text
execution_ms = max(duration_ms - waiting_ms, 0)
```

## 状态模型

`messageTelemetry` 继续作为 UI telemetry 生命周期的唯一状态所有者。

- 活跃 prompt 保存按 `requestId` 索引的权限等待区间。
- 每个区间至少包含 `requestedAt` 和归属的 `toolCallId`。
- 活跃 `tool_call` step 保存自己的累计 `waitingMs`。
- 已收口但尚未出现对应 tool step 的区间，按 `toolCallId` 暂存
  `waitingMs` 和 `earliestRequestedAt`，等待后续工具事件回填。
- prompt 保存整轮累计 `waitingMs`，用于 `message_completion`。

`toolCallId` 优先从 permission 原始 payload 读取；取不到时使用协议当前的
`requestId` 回退匹配。无法匹配活跃工具时，等待仍计入
`message_completion`，但不错误归入其他工具 step。

## 事件处理

### 权限请求

收到 `permission_request` 时：

1. 仅在当前 prompt 已激活时登记。
2. 按 `requestId` 幂等；重复 stream/replay 不重置 `requestedAt`。
3. 记录对应 `toolCallId`，供 step 归因。

### 权限响应

以下两条入口都允许收口，并依赖 `requestId` 幂等去重：

- 当前客户端成功提交权限响应；
- stream 收到 `permission_response`，包括另一客户端完成的响应。

收口后把区间耗时累加到 prompt。若对应 `tool_call` 已存在，同时累加到 step；
若 tool step 尚未出现，则写入按 `toolCallId` 聚合的 pending attribution，随后删除该
`requestId` 的开放区间。这样既保留 request 级幂等，又不会因乱序响应丢失工具归因。

### 工具或任务终止

- 对应 `tool_call` 收口时，先把仍开放且归属于该工具的等待区间按工具终止时间收口。
- 终态 `tool_call_update` 缺少前置 `tool_call` 时，fallback step 必须吸收该工具已收口
  和仍开放的等待归因；其 `startedAt` 不得晚于最早权限请求，并须保证
  `duration_ms >= waiting_ms`。
- `task_complete`、`task_error`、用户停止等消息终态到达时，把所有仍开放的等待区间按
  消息终止时间收口。
- 因此用户未授权便停止任务时，`permission_request → finishedAt` 仍计入
  `tool_call.waiting_ms` 和 `message_completion.waiting_ms`。

## 多端与重复事件边界

- 桌面 `desktop-continuous` 和手机 `web-remote-replayable` 使用同一 telemetry
  聚合口径，不改变各自的消息恢复协议。
- replayable 重放、前后台监听重复看到同一请求或响应时，不得重置起点或重复累计。
- 手机完成授权后，桌面 observer 收到的 `permission_response` 可以正常收口。
- 本变更不修改 relay、main、host 或 ZCode protocol 的业务职责。

## 校验与测试

单元测试必须覆盖：

| Case | 场景 | 断言 |
| --- | --- | --- |
| PW01 | 单个工具请求并完成一次授权 | tool 与 completion 的 `waiting_ms` 相同；两级 `duration_ms` 均包含等待 |
| PW02 | 一轮消息内多个工具分别等待授权 | completion 等于各 tool `waiting_ms` 之和 |
| PW03 | 同一工具连续多次请求授权 | tool 和 completion 均累加全部区间 |
| PW04 | 权限未响应时用户停止/任务终止 | 开放区间计到终止时间 |
| PW05 | request/response 重复投递 | 起点不重置，等待不重复累计 |
| PW06 | 另一客户端响应权限 | stream response 能收口等待 |
| PW07 | permission 无法匹配活跃工具 | completion 计入等待，其他 tool step 不被污染 |
| PW08 | reasoning/generation step | `waiting_ms="0"` |
| PW09 | permission request → response → terminal tool update，缺少前置 tool call | fallback tool step 回填已收口等待，且 `duration_ms >= waiting_ms` |
| PW10 | permission request → terminal tool update，缺少前置 tool call | 开放等待在 terminal 收口并归入 fallback tool step，且 `duration_ms >= waiting_ms` |

`duration_ms` 的回归断言：

- `message_completion.duration_ms` 始终等于 `max(finishedAt - sendTime, 0)`；
- `agent_step.duration_ms` 始终等于 `max(stepFinishedAt - stepStartedAt, 0)`；
- 增加 `waiting_ms` 不改变上述两个公式。

实现完成后执行相关单元测试，以及仓库强制要求的：

```bash
pnpm typecheck
pnpm lint
```

## 非目标

- 不新增 `permission_wait` agent step。
- 不改变 `agent_step_cnt`、`loop_index` 或现有 step 类型。
- 不把 elicitation / AskUserQuestion 等待纳入本次 `waiting_ms`。
- 不修改服务端 telemetry 存储结构或外部看板计算。
