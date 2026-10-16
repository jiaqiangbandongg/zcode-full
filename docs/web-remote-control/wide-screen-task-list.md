# 宽屏 Web 远控任务列表

## 背景

手机 `/remote` 窄屏已经有独立任务首页，使用 `listWorkspaces()` 返回的
`WebRemoteControlWorkspaceListResult` 作为跨工作区任务事实源。宽屏 `/remote` 仍复用桌面
sidebar 外壳，但左侧任务列表区域需要遵守同一远控事实源，否则用户在宽屏远控看到的任务、搜索、视图切换和归档入口会彼此不一致。

## 范围

- 仅影响宽屏 Web remote control shell 的左侧任务列表区域。
- 桌面端 sidebar 继续使用原有 `WorkspaceGroupedTasksSection`、`WorkspaceTimelineTasksSection`、
  `WorkspaceArchivedTasksFlatSection`、`WorkspacePinnedTasksSection` 和 continuous 实时链路。
- 不改变 relay、desktop main、host process、task realtime、snapshot、queue 或 owner command 语义。
- 宽屏 Web remote 继续通过 shared-host attachment 访问已有 desktop host，不启动独立 runtime。

## 行为

宽屏 Web remote 在任务工具栏内保留现有视图、排序、搜索和归档入口，但这些入口在远控模式下必须消费
`listWorkspaces()` 返回的同一份任务索引：

1. `workspace` 视图按 desktop 返回的 workspace 顺序分组，只展示非置顶任务；置顶任务仅在独立置顶区展示，避免重复。
2. `timeline` 视图跨所有可见 workspace 展示非置顶任务，并使用与桌面一致的两层排序：running 先于非 running，running 内按 `createdAt` 倒序稳定排列，非 running 再按用户选择的 `created` 或 `updated` 字段排序。运行层成员 = `displayStatus === "running"` 或 `hasBackgroundWork === true`（2026-09-09 追记：会话挂着后台 workflow run 时只推进 `updatedAt`、不改图标，不并入运行层就会随进度事件换位）。
   任务行在标题下绘制与桌面一致的工作流运行行（`WebRemoteControlTaskTarget.workflowActivity`，2026-09-14 追记）：Workflow 图标 + 迷你轨道灯 + 当前 phase 名；结束的 run 行由远控端自己的已确认集合折叠，不依赖桌面 localStorage。
3. 归档视图展示远控任务索引中的归档任务。归档任务仍按同一排序字段排序，并保留 workspace label，避免退回当前 bridge workspace。
4. 搜索只过滤当前宽屏远控任务区里的任务和 workspace label，不打开桌面 Command Center；搜索词为空时恢复完整列表。
5. `workspace` 视图的收起/展开全部只控制宽屏远控分组展开状态，不写入或复用桌面 sidebar 的展开状态。
6. 切换排序、视图、搜索词或归档状态不得改变桌面端任务列表行为。
7. 普通和置顶任务行在 hover 后展示置顶/取消置顶与归档入口，交互语义对齐桌面端侧栏：置顶直接切换 membership，归档先进入确认态，第二次点击才归档。
8. 任务操作通过当前 shared-host bridge 可解析到的 `zcodeTaskService` 执行。本地 workspace 走 base services；远端 workspace 只有在已注册 remote session services 时才允许操作，避免把远端 `workspacePath` 误交给本机 host。
9. 操作成功后宽屏远控本地任务索引立即按返回的 membership 更新，等待 desktop renderer 后续 task snapshot 同步收敛；失败时保留原索引并提示用户。
10. 置顶、取消置顶、归档、取消归档属于 task list membership 变化。服务层必须广播明确的 membership reason，desktop renderer 收到后重新刷新对应 task list，不能把这类事件当作普通 `task_meta_changed` 增量保留 membership。
11. Desktop renderer 把更新后的 Web remote task snapshot 同步给 desktop main 后，desktop main 只通过既有 app payload 通道通知已连接 Web remote 重新采用最新 `WebRemoteControlWorkspaceListResult`。relay 和 main 不新增 task 业务状态，只转发 renderer 已同步的任务索引快照。

## 数据约定

`WebRemoteControlTaskTarget` 的 `pinned` 表示任务属于置顶分区；`archived` 表示任务属于归档分区。旧客户端可能没有
`archived` 字段，缺省按普通任务处理。宽屏远控模型在 UI 层过滤这两个标记，不改变协议和 realtime 数据流。

宽屏远控的置顶/归档动作不新增 relay 业务协议，也不把 task 状态下沉到 desktop main。mobile Web 仍通过已经 attach
的 host/service 调用任务服务；desktop main 只继续提供 `workspace-list-request` 的索引快照和 `rpc-frame` 透传。
当 desktop renderer 由于 task list membership 变化调用 `syncWebRemoteControlTasks` 时，desktop main 可以发送
`workspace-list-updated` app payload，把同一份 `buildWorkspaceListResult()` 快照推给 Web remote，避免 Web 端继续展示旧列表。

## 测试要求

- 单元测试覆盖排序字段切换、置顶去重、时间线跨工作区、归档跨工作区、搜索过滤、分组收起，以及操作后 task membership 更新。
- 单元测试覆盖 `task_archived` / `task_unarchived` / `task_pinned` / `task_unpinned` 会触发跨端列表刷新，并覆盖 service 广播这些明确 reason。
- 单元测试覆盖 desktop main 在 task snapshot membership 变化后推送 `workspace-list-updated`，Web payload schema 接受该消息。
- 布局测试覆盖宽屏远控任务行渲染置顶和归档操作入口。
- 运行 `pnpm typecheck` 和 `pnpm lint`。
