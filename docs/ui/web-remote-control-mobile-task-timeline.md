# Web Remote Control Mobile Task Timeline

移动端远控任务首页支持两种组织方式：

- 按工作区：保留原有工作区分组、展开/收起、断开远程工作区重连入口。
- 按时间线：跨工作区平铺任务，支持按更新时间或创建时间倒序查看。

时间线任务行必须保留工作区标识，避免不同工作区里的同名任务混淆。断开的远程工作区任务在时间线里同样不可直接打开，交互规则与工作区分组模式保持一致。

排序逻辑集中在 `packages/ui/src/lib/webRemoteControlMobileTaskHome.ts`，默认按 `updatedAt` 倒序；切换为创建时间时按 `createdAt` 倒序，并继续用另一时间字段和 `taskId` 做稳定兜底排序。
