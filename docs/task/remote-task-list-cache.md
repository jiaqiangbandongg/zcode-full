# Remote Task List Cache

## 背景

全局 pinned 和 timeline 视图需要同时展示本地 workspace 与远端 workspace 的任务。远端 workspace 连接成功后，当前窗口的 active services 可能指向远端；如果全局列表直接复用当前 `useServices()`，本地列表会被远端服务上下文影响，出现本地 timeline 变空或缓存写错作用域的问题。

## 当前链路

- 本地任务列表通过 `useGlobalTaskList` 读取，内部使用 `useBaseWorkspaceServices()`，并且只接收 `useLocalWorkspaceScopes()` 返回的本地 workspace scope。
- 远端 pinned 使用 `remotePinnedTaskStore`，远端 timeline 使用 `remoteTimelineTaskStore`，两者都按 `workspaceIdentity?.trim() || workspacePath` 生成 workspace key。
- 远端 workspace 连接或重连成功后，root 层会分别预取 pinned 和 timeline 的首屏数据。
- timeline 视图点击 show more 时，会把本地与远端 timeline 的读取 limit 按 10 条阶梯增加，例如 10、20、30；不一次性读取全量。
- pin / unpin / archive / rename / unread 这类任务操作会同步维护远端 pinned 与 timeline 两个 store，避免两个全局列表各自保留旧成员关系。

## 约束

- 远端 workspace 任务查询必须传 `workspaceIdentity`，不能只靠 `workspacePath` 做隔离。
- UI 层不直接调用 repo；所有任务读写继续通过对应 workspace 的 `zcodeTaskService`。
- 远端补充读取失败只记录 warn 和 store error，不阻断 workspace 恢复。
