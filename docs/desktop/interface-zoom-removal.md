# Interface Zoom Removal

## 背景

ZCode 曾提供三档界面缩放：偏小、正常、偏大。入口包括桌面 View 菜单快捷键、设置页和侧边栏账户菜单，并通过 `localStorage` 与 Electron `webFrame` / `webContents` 持久化当前窗口缩放。

## 目标

- 删除用户可见的界面缩放功能。
- 删除启动时恢复 `zcode-zoom-level` 的逻辑，避免历史倍率继续影响首屏。
- 删除桌面 View 菜单中的 Actual Size / Zoom In / Zoom Out 和对应快捷键。
- 删除 UI 设置页与账户菜单中的界面缩放入口。
- 删除 platform/preload/web fallback 中专门服务界面缩放的 API。

## 非目标

- 不删除 macOS 系统窗口绿色按钮的 zoom/maximize/fullscreen 行为。
- 不删除业务画布、图谱、PDF、文档或动画类组件中自身语义的 zoom。
- 不主动迁移或清理用户机器上历史 `localStorage` 的 `zcode-zoom-level` 键；代码不再读取它后自然失效。

## 影响面

- Desktop 端：应用菜单不再注册界面缩放快捷键，主进程不再处理 `resetZoom` / `zoomIn` / `zoomOut` 桌面命令。
- Web/手机端：原本只是 no-op fallback，删除后不改变远控链路。
- UI 层：设置页和侧边栏账户菜单不再展示界面缩放。

## 后续补充

- `docs/desktop/system-zoom-shortcuts.md` 恢复了受控系统页面缩放快捷键。它只提供 `Cmd/Ctrl + +/-/0` 的当前窗口缩放能力，并限制默认大小上下 5 档，不恢复旧的持久化界面缩放设置或 UI 入口。
