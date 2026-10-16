# Task List Membership Cache Sync

## 背景

用户在归档、取消归档、置顶、取消置顶和删除 task 后，侧栏或远控任务列表会出现整表刷新。原因是这些操作会广播 `workspace_task_list_changed`，但 UI 没有统一的本地 membership 变更处理链路，收到事件后只能让 query cache 失效并重新请求列表。

## 目标

- 桌面端 `desktop-continuous` 主链路中，归档 / 取消归档 / 置顶 / 取消置顶 / 删除 task 不触发整表刷新。
- 手机远控 `web-remote-replayable` 收到 shared-host 推送时，继续根据广播事件同步列表成员关系，但不绕过 replayable 的 task snapshot 恢复边界。
- 搜索结果等无法只靠 task meta 精确判断成员关系的缓存，可以标记 stale，但不清空可见列表。
- sessions-index 不携带的 tasks-index 元数据（当前包括 `unreadAt`、历史终态、手动标题和 `cronAutomationId`）必须经统一 join 回填，避免切换列表数据源后丢失未读点、状态、标题或定时任务 clock icon。

## 方案

- service 删除 task 时显式广播 `task_deleted` reason，避免 UI 把删除误判成普通 `task_meta_changed`。
- UI 收到 `task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` 且携带 `taskMeta` 时，根据当前 query cache 中该 task 所在列表推断旧 membership，再用现有 `applyTaskQueryCacheMutation` 移动到目标列表。
- UI 收到 `task_deleted` 时按 `workspace + taskId` 从所有 query cache 中移除该 task，并同步清理 workspace task list cache / optimistic meta。
- `workspace_task_list_changed` 由全局列表和 workspace 行共享一个事件级 coordinator 处理；membership / delete 广播只执行一次 query cache mutation，后续订阅者复用第一次的刷新决策，避免已处理的删除事件被误判成隐藏项删除。
- 普通 meta / status 广播不参与 coordinator 去重；这类写入是幂等的，重复应用比吞掉 2 秒内连续标题、错误详情或摘要更新更安全。
- 删除事件命中当前可见 query cache 时不触发整表刷新；未命中可见缓存的隐藏/分页项无法从 `taskId` 推断成员关系，保留刷新兜底以修正 `total` / `hasMore`。
- 只有事件缺少必要 task 信息，或删除项未命中可见缓存时，才保留刷新兜底。
- `task_meta_changed` 会使 membership join 缓存换代；已有会话首次获得 `cronAutomationId` 后，workspace、grouped、timeline、pinned/archived 列表都必须在同一轮刷新中看到该身份。
- tasks-index 的 `deleted=1` 是持久负向 membership。membership 读取必须显式返回 deleted task id 集，所有 sessions-index 派生列表在 kind 判定前统一排除；不能用“未出现在 archivedIds”推断任务仍是普通成员。
- `task_deleted` 除了立即移除可见 query cache，还必须使 membership join 缓存换代。这样后续 live sessions-index upsert、App/CLI 冷启动和 mobile replayable 恢复即使再次看到仍存在的 CLI session，也不会把 tombstone 对应任务复活。

## 删除 tombstone 的边界裁决

| 边界 | 裁决 | 剪枝理由 |
| --- | --- | --- |
| 数据所有权 | CLI session store 继续拥有会话内容；tasks-index `deleted` 拥有任务列表不可见性 | 删除归档任务不等价于物理擦除会话存储，避免扩大数据破坏范围 |
| 列表 surface | regular、pinned、archived、timeline、workspace、grouped 全部排除 deleted | `deleted` 是所有列表 kind 之前的负向 guard，不按 kind 做重复实现 |
| 归档对照 | `archived=1, deleted=0` 仍只在归档列表显示 | 防止修复把正常归档一并隐藏 |
| session type | interactive、fork、workflow parent 共用同一 deleted guard；side chat/subagent/workflow child 仍由 task-type guard 排除 | task type 决定能否成为 task，deleted 决定已成 task 后是否仍可见，两个维度正交 |
| client/delivery | desktop continuous 与 mobile replayable 收敛到同一最终 membership | delivery 只改变事实到达方式，不新建第二份 deleted 状态 |
| workspace | 读取和事件继续使用 `workspaceIdentity?.trim() || workspacePath` | 同 path 的远程 workspace 不能串 tombstone |

确认轨迹：用户报告“之前归档后删除的对话重启后都出来了”，并确认直接修改。采用保留 CLI 会话内容、增加 deleted membership 字段的方案；不执行物理删除。

## 验证点

- 本地桌面归档/置顶/删除不应让 workspace 行或全局列表整表重拉。
- 远控端发起 membership 变更后，桌面端列表应通过事件增量同步。
- 删除 archived task 后，归档列表应立即移除目标项，不把它恢复到普通列表。
- App/CLI 重启或 mobile replayable 恢复后，已删除 task 即使仍存在于 CLI session store，也不得出现在任何任务列表；同 scope 的普通归档 task 仍留在归档列表。
- tasks-index 已持久化 `cronAutomationId` 而 sessions-index summary 不含该字段时，各列表仍应在时间左侧显示 clock icon。
