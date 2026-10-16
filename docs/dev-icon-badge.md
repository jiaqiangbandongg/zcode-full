# Dev 版应用图标角标

## 背景

本地同时运行开发版（`pnpm dev:desktop`）和正式版 ZCode 时，两套 Dock 图标完全相同，无法区分。

## 方案

未打包（`!app.isPackaged`）运行时，主进程在启动阶段给应用图标叠加一条左上角蓝色对角 "DEV" 绶带（ribbon）：

- 渲染：`packages/desktop/src/main/devIconBadge.ts` 的 `renderDevBadgeIcon()`
  - 读入 `build/icon.png`（Windows 为 `icon_windows.png`）
  - 用 `sharp` 直接合成：`buildDevRibbonSvg(size)` 生成一条绕 -45° 旋转的蓝底白字 "DEV" 绶带 SVG，几何参数随图标尺寸等比缩放
  - 绶带厚度使用图标尺寸的 `19.9%`，文字使用 `15.2%`，在上一版基础上整体再放大约 `20%`
  - 旋转中心位于图标尺寸的 `24%` 处；丝带放大后同步向右下移动，为左上角保留更明显的原图黑色区域
  - 先把绶带 `composite` 到原图，再用原图自身作 `dest-in` 遮罩，使绶带沿图标圆角轮廓裁切、不溢出到透明角
  - 结果 PNG 转 `nativeImage`，全程内存态、不落盘
  - 任何一步失败记 warn 日志并返回 `null`，回退原图标，不影响启动
  - 早期实现用隐藏 offscreen `BrowserWindow` + canvas 渲染（依赖窗口生命周期/轮询/超时，较慢且脆）；desktop 已直接依赖 `sharp`，改为纯图像合成后更精简可靠
- 应用点（`packages/desktop/src/main/index.ts`）：
  - macOS Dock：`applyAppIcon(devBadgeIcon ?? iconPath)`（`applyAppIcon` 已支持直接传 `NativeImage`）
  - Windows/Linux 窗口图标：主窗口经 `createWindowInstance()` → `createWindow()` → `createBrowserWindow()` 创建，`iconPath` 参数已扩展为 `string | NativeImage`，dev 下传入 `devBadgeIcon ?? iconPath`，任务栏/标题栏据此显示 DEV 角标；更新状态窗口同样使用角标图
- 打包版完全不走该逻辑，图标不变。

## 测试

- `packages/desktop/test/devIconBadge.test.ts`：绶带 SVG 契约（对角旋转、蓝底、尺寸等比、左上角定位）；`renderDevBadgeIcon` 成功、读取失败、空图回退路径
- `packages/desktop/test/desktopWindowChrome.test.ts`：`applyAppIcon` 直接使用传入 `NativeImage`；`createBrowserWindow` 把 `NativeImage` 图标透传给 `BrowserWindow.icon`（Windows/Linux 主窗口角标回归护栏）
