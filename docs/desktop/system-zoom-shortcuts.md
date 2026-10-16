# System Zoom Shortcuts

## 背景

桌面端之前移除了 ZCode 自定义界面缩放设置，避免历史 `localStorage` 缩放倍率继续影响首屏。移除后，应用菜单也不再包含 Electron 原生页面缩放 role，导致系统常用的 `Cmd/Ctrl + +/-/0` 快捷键无法缩放当前窗口内容。

## 目标

- 恢复桌面端系统级页面缩放快捷键。
- 使用桌面命令承接 `Cmd/Ctrl + 0/+/-`，并限制当前窗口页面缩放等级在缩小 `-3` 档、放大 `+5` 档之间。
- macOS 每次缩放后同步调整左上角红黄绿原生按钮纵向位置，并通知 renderer 反向调整顶部浮层左侧安全区；红绿灯宽度本身不随页面缩放变化，横向位置暂时保持系统初始值。
- 仅作用于桌面端当前窗口的页面缩放，不重新引入 UI 设置页、账户菜单入口、持久化缩放等级或专用 platform API。

## 非目标

- 不恢复旧的三档界面缩放偏好。
- 不读写历史 `zcode-zoom-level`。
- 不改变 Web / 手机远控链路；手机端仍使用浏览器自身缩放能力和现有 replayable 恢复边界。

## 实现

- `packages/shared/src/desktopMenu.ts` 增加 View 菜单的 Actual Size、Zoom In、Zoom Out 桌面菜单文案。
- `packages/desktop/src/main/desktopApplicationMenu.ts` 在 View 菜单中添加 `CmdOrCtrl+0`、`CmdOrCtrl+Plus`、`CmdOrCtrl+-` accelerator，并保留隐藏的 `CmdOrCtrl+=` zoom-in 兜底以兼容不同键盘布局。
- View 菜单的 Actual Size、Zoom In、Zoom Out 按当前聚焦窗口 zoom 档位设置禁用态：默认大小时禁用 Actual Size，最大 `+5` 档禁用 Zoom In，最小 `-3` 档禁用 Zoom Out；隐藏的 `CmdOrCtrl+=` 兜底项和 Zoom In 使用同一禁用态。
- `packages/desktop/src/main/desktopCommandHandlers.ts` 统一处理 `ResetZoom`、`ZoomIn`、`ZoomOut`，读取当前 `zoomFactor` 换算为内部档位，调用 `webContents.setZoomFactor(1.1 ^ level)` 并把缩放等级夹在 `[-3, 5]`。
- 每次执行缩放命令后刷新应用菜单；主窗口重新聚焦时也刷新菜单，避免系统菜单保留旧禁用状态。
- `packages/desktop/src/main/desktopWindowButtonPosition.ts` 复用 macOS 初始红绿灯位置 `{ x: 24, y: 25 }`，横向 `x` 暂时保持 `24`，纵向 `y` 按统一 zoom factor `1.1 ^ level` 计算位移并乘以 `1.5` 的视觉跟随增益，再设置 `setWindowButtonPosition`；顶部浮层按 `96 / zoomFactor` 接收 `leftPaddingPx`。Windows 不调整原生按钮坐标，但会把 `titleBarOverlay.height` 按 `48 * zoomFactor` 同步到当前缩放档位，让右上角最小化/最大化/关闭按钮继续跟随缩放；renderer 以 Window Controls Overlay 的 `titlebar-area-*` CSS 几何作为右侧安全区事实源，并保留 `136 / zoomFactor` 作为环境变量不可用时的 fallback。自绘 caption 按钮宽度由真实安全区除以三个原生按钮派生，避免缩放或 DPI 差异让下拉按钮进入最小化按钮区域。Linux 暂不补偿原生按钮区。
- `packages/desktop/src/main/desktopWindowChrome.ts` 在窗口创建后立即读取当前 `zoomFactor` 并同步 macOS 红绿灯位置；`packages/desktop/src/preload/index.ts` 在 React 接管 root 前同步读取 `webFrame.getZoomFactor()`，一边缓存顶部浮层安全区给 `RootStartupLoading` 首次渲染使用，一边通过 `WindowControlsOverlayReady` 通知 main 提前重置红绿灯位置，避免等进入 App 页面后才调整。
- 通过 `packages/desktop/test/desktopApplicationMenu.test.ts` 验证 View 菜单把快捷键转发到受控桌面命令，通过 `packages/desktop/test/desktopCommandHandlers.test.ts` 验证缩放上下界。
