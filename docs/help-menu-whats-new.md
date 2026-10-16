# Help Menu What's New

- Desktop 帮助菜单新增 `What's New` / `更新日志` 入口。
- 链接由主进程按当前应用语言统一分流：`zh-CN` 打开 `https://zcode.z.ai/cn/changelog`，其他语言打开 `https://zcode.z.ai/en/changelog`。
- 菜单文案走 `packages/shared/src/desktopMenu.ts`，点击行为走 `DesktopCommandIds.OpenChangelog -> desktopCommandHandlers.openChangelog`，避免 URL 规则散落在菜单模板里。

## Workspace / Settings 问号菜单

- Workspace header、新建任务 header 和 Settings 页面共享同一个问号菜单组件。
- 问号菜单统一承载高频帮助动作：问题上报、给产品提需求、用户社群、产品文档、导出日志。
- 导出日志不在 UI 层直接访问 Electron API，继续走 `IPlatformService.exportLogs()` 和统一 toast 状态，保证 Desktop / Web fallback 边界一致。
- Settings 页面把问号入口放在右侧内容面板顶部，并复用 new task 的窗口按钮避让偏移，避免和 Windows / Linux 自绘窗口控制按钮发生点击区域冲突。
- Sidebar footer 账户菜单不再重复展示问题反馈、用户社群、导出日志和设置入口，避免同一组动作同时出现在两个入口里；footer 外侧保留设置齿轮，账户菜单保留用量、主题、语言、缩放和登录态动作。
