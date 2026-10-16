# Task Unread State

## 当前约束

- task 的未读真相源统一为 tasks-index membership `unreadAt`
- UI 蓝点、Dock badge、任务选择后的已读清除，都只围绕 `unreadAt` 工作
- task query row 通过 membership join 消费 `unreadAt`；旧 `taskUnreadByTaskId`、`taskListCache` 和
  `optimisticTaskListByTaskId` 不再作为侧栏判断依据
- `lastActivityAt` 只负责 Updated 排序，不参与未读推导或清除

## 关键链路

### 主动标记未读

- 入口：task 右键菜单、Header more 菜单
- 动作：调用 `zcodeTaskService.setTaskUnread(..., true)`
- renderer 只对 query row 应用 `{ unreadAt }` 字段 overlay；成功后与 tasks-index membership 对账，
  禁止把返回的整个 task meta 覆盖 session activity/status

### 被动标记未读

- 入口：后台 task 的 `task_complete` / `task_error` / `task_warning`
- 动作：先把当前 task 的 query row membership overlay 标记为 `unreadAt`
- 然后异步调用 `zcodeTaskService.setTaskUnread(..., true)` 持久化到 task/session 索引
- v4 sessions-index 重构后，后台运行态不再由旧 renderer monitor 持有；host
  `taskIndexSyncer` 只负责把 phase 终态收敛成 `task_status_changed`，不判断某个 renderer
  当前是否正在查看该 task。
- 因此 renderer 在收到 `workspace_task_list_changed(reason="task_status_changed")` 时补回旧语义：
  如果该 task 不是当前 workspace 的 `activeTaskId`，先本地标蓝点，再调用
  `setTaskUnread(..., true)` 落盘；如果正是 active task，则不产生未读。
- `task_status_changed` 本身仍不触发 membership 重拉；只有随后 `setTaskUnread` 发出的
  `task_meta_changed` 才驱动 task-index membership join 重新拉取 `unreadAt`。

### 查看任务后清已读

- 桌面入口：`useWorkspaceTaskNavigation`
- 动作：先激活目标 tab，再按当前激活 tab 的 `remoteSessionId` 解析精确服务实例
- 从当前 task query row 读取 `unreadAt`；存在时先应用 `{ unreadAt: undefined }` 字段 overlay，再调用
  `zcodeTaskService.setTaskUnread(..., false)`
- 成功后按 tasks-index membership 对账并移除 overlay；失败时移除 overlay、重新拉取 membership，允许蓝点回来
- desktop 定时任务执行会话复用相同已读合同：用户停留在 Automations route 时，scheduler 后台终态会把带
  `cronAutomationId` 的执行会话标记为未读；显式选择「不在项目中工作」的 automation 必须把执行会话归入
  canonical conversation workspace 的「任务」分区。点击蓝点或任务行必须从被点击 query row 读取
  `unreadAt`，按精确 `workspaceKey + taskId` 清除，不得依赖当前 active session，也不得因 cron identity 跳过。
- 该流程必须保留 sessions-index `lastActivityAt`，打开任务或清未读不得让历史任务跳到顶部
- 手机 Web 远控入口：任务首页点击的 `WebRemoteControlTaskTarget.unreadAt` 是本次用户可见快照。若存在，
  同 workspace 通过当前 bridge、跨 workspace 在目标 bridge 建立后调用
  `zcodeTaskService.setTaskUnread(..., false, expectedUnreadAt=task.unreadAt)`；不得依赖手机 Root 的
  query cache 水合状态。
- 手机已读使用 compare-and-clear：tasks-index 当前 `unreadAt` 仍等于 `expectedUnreadAt` 才清除；
  如果任务在点击后又产生新的终态未读，迟到的旧清除必须 no-op 并返回当前 meta。该比较与写入必须处于
  同一 repository 原子边界，不能在 Web/UI 先查后写。
- `unreadAt` 同时承担本次未读的 CAS marker；同一 task 每次写入未读时必须由 repository 在
  SQLite 写事务内生成严格递增值。系统时间不前进或回拨时使用上一值加一，禁止由调用方直接把
  `Date.now()` 当作唯一版本。清除 `unreadAt` 只改变未读 membership，不得重置 repository
  持久化的最后分配 marker。
- 手机已读写入失败不阻止打开任务，返回首页后重新采用 tasks-index 权威快照；desktop
  `useWorkspaceTaskNavigation` 的现有 query-cache overlay 与 `desktop-continuous` 链路保持不变。

## UI 读取口径

- 任务列表蓝点：task query row 的 joined `membership.unreadAt`
- Dock badge：`countAllUnreadTasks()`

两个入口最终都只消费 tasks-index `unreadAt`；迁移期间可以复用聚合 helper，但不得回退旧
`taskUnreadByTaskId` 作为业务事实。
