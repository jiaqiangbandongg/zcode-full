# Pinned Task Local Workspace Scope

## 背景

Pinned 任务列表以前完全跟随当前窗口的 `workspaceTabs` 查询。这个链路在“先恢复 workspace tabs，再渲染 sidebar”的启动路径下没问题，但如果后续支持持久化恢复到某个任务视图，例如直接进入 pinned/timeline 视图，UI tabs 可能还没有创建，pinned 查询就会缺少 workspace scope。

同时，远端 workspace 在没有 `remoteSessionId` 时不能混入 pinned 查询 scope。否则后续服务解析可能落到本地 services，导致同路径远端任务和本地任务串读。

## 当前策略

- `workspaceTabs` 仍然是当前窗口已打开 workspace 的 UI 状态。
- Pinned 查询使用 `useLocalWorkspaceScopes` 获取查询 scope。
- Pinned 只按当前窗口已经打开的本地 workspace tabs 查询。
- 没有本地 workspace tab 时不兜底读取 `lastWorkspaceSession`，查询 scope 为空。
- 远程 workspace 不参与这个 fallback scope；远端 pinned 查询需要等远程 session 建立后走对应远端服务链路。

## 边界

这个调整只改变 pinned 任务查询的本地 scope 来源，不改变 app 启动时是否恢复真实 workspace tabs。未来如果新增远端 pinned 视图恢复，需要在远端 session ready 后单独接入远端查询 scope，不能通过本地 scope 兜底。
