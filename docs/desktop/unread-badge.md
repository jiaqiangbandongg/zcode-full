# Desktop 未读 Badge

## 目标

Desktop 把 ZCode task 的未读数显示到应用 Dock / launcher badge，口径以 task meta 的 `unreadAt` 为准，也就是“后台完成后还没点开看的 task 数”。

## 数据流

1. task 的持久未读权威是 tasks-index meta `unreadAt`。V4 `sessions-index` 不携带这个组织态字段，列表通过
   `taskListMembershipSets` 平行读取后 join 到 session summary。
2. UI 的 `countAllUnreadTasks` 从各 workspace 可见 task meta 统计未读，并用
   `workspaceIdentity?.trim() || workspacePath + taskId` 去重；只有列表尚未加载时才兼容旧临时 map。
3. `useRootPlatformEffects` 调用 `IPlatformService.syncWindowUnreadCount(count)`，只同步当前窗口总数，
   不让 UI 直接感知 Electron。
4. Desktop preload / renderer bridge 通过 `PlatformChannels.SyncWindowUnreadCount` 发给 main。
5. Main 维护 `windowId -> unreadCount` map，窗口更新或关闭时重算应用总数，再调用
   `app.setBadgeCount(totalUnread)`；Windows 当前由平台实现决定是否展示，不在 UI 分支写特例。

## 约束

- Badge 不混入失败红点、permission request 等其他 UI 状态，避免语义漂移。
- automation 的 schedule / manual run 收到与本轮 `traceId` 匹配的 `succeeded`、`failed` 或 `stopped`
  终态后，host 必须通过 `setTaskUnread(..., true)` 持久化关联 task 的 `unreadAt`。该规则不使用
  renderer 的 active session 推断“正在阅读”；用户显式点击 task 后由
  `useWorkspaceTaskNavigation` 清除持久状态，并同步 task query cache 的乐观值。
- Web 平台保持空实现，保证 desktop / web 共享同一套 `IPlatformService` 接口。
- 窗口关闭时会清理对应 unread 记录，防止 badge 卡住。

## 当前代码入口

- `packages/ui/src/lib/unreadTaskCount.ts`
- `packages/ui/src/lib/taskListMembershipSets.ts`
- `packages/ui/src/root/useRootPlatformEffects.ts`
- `packages/desktop/src/main/desktopMainIpcPlatform.ts`
- `packages/desktop/src/main/desktopWindowLifecycle.ts`
- `packages/desktop/src/main/unreadBadge.ts`
