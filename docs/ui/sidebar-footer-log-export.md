# Sidebar Footer Log Export

## 目标

左下角账号菜单补齐“导出日志”入口，让用户不需要进入 Windows 标题栏菜单或系统菜单也能导出诊断包。

## 行为

- 入口位于账号菜单的支持动作区，和“问题反馈”“用户社群”同组。
- 菜单文案复用 Windows 菜单的 `titleBar.menu.help.exportLogs`，toast 文案复用已有 `sidebar.exportLogs.pending`、`sidebar.exportLogs.error`。
- 点击后复用 `platform.exportLogs()`，由 desktop main 负责打包日志并在系统文件浏览器中显示导出结果。
- Web 端继续使用平台层 fallback，返回不支持时展示错误 toast，不新增 desktop-only 分支。

## 实现位置

- 菜单入口：`packages/ui/src/WorkspaceSidebarFooter.tsx`
- 共享动作：`packages/ui/src/lib/exportLogsAction.ts`
- Windows 标题栏菜单复用同一动作：`packages/ui/src/WindowsCaptionMenuButton.tsx`
