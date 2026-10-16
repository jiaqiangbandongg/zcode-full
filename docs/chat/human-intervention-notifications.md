# Human Intervention Notifications

## 背景

ZCode 任务在后台运行时，如果进入需要用户介入的阻塞态，用户可能不会主动回到窗口查看。桌面通知需要覆盖这些阻塞态，避免任务长期停在等待确认。

## 范围

需要触发通知的人工介入事件：

- `permission_request`：普通工具权限确认。
- `elicitation_request`：用户输入/选择类确认，包括 `AskUserQuestion`、`ExitPlanMode` 计划确认，以及协议层 `interaction/requestUserInput` 映射出的通用问答。

不在本轮触发通知的事件：

- `task_complete` / `task_error`：已有独立完成/失败通知。
- `turn_steer_queued`、`runtime.pendingCommands`、queued prompt：表示未来输入或 host 队列，不是当前任务等待用户确认。
- `apiRetry` / provider retry：自动重试状态，不需要用户动作。
- `backgroundBashJobs`：后台命令运行态，不表示任务阻塞在用户输入。
- `providerRuntimeHeaders.request`：当前产品语义是模型请求前自动刷新 runtime header；官方版本安全校验中的交互是否需要系统通知另行决策。

## 通知边界

- live stream 收到 `permission_request` 或 `elicitation_request` 时，renderer 通过 `IPlatformService.showTaskNotification` 发送本地化通知。
- 通知点击只负责激活任务所在 workspace/task，不直接打开或提交弹窗。
- 通知 dedupe 使用 `taskId + status + requestId`，同一请求不会重复弹；permission 和 elicitation 使用不同 `status`，便于排查和未来统计。
- `web-remote-replayable` snapshot 恢复出的 `pendingElicitations` 只恢复 UI 状态，不主动补发系统通知，避免断线恢复时把旧阻塞请求重复通知。
- 桌面 `desktop-continuous` 主链路继续只消费 live event，不引入 replayable 恢复语义。

## UI 列表语义

任务列表的“等待确认”badge 表示任务存在人工介入阻塞请求，包含 permission 和 elicitation。该 badge 不点亮未读蓝点；未读仍只表示后台终态或内容更新未查看。

## 验证点

- 前台/后台 `permission_request` 继续发 `permission_request` 通知。
- 前台/后台 `elicitation_request` 发 `elicitation_request` 通知。
- AskUserQuestion 和 ExitPlanMode 通过 `elicitation_request` 共享同一通知通路。
- 任务列表普通视图和 grouped 视图在存在 elicitation 时显示“等待确认”。
- replayable snapshot 恢复 `pendingElicitations` 不额外触发系统通知。
