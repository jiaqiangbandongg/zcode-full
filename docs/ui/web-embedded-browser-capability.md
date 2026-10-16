# Web Embedded Browser Capability

## 背景

当前右侧 side pane 的“浏览器”标签依赖 Electron `webview`，适合桌面端。Web app 和手机远控运行在普通浏览器环境中，本版本不支持内嵌浏览器标签，也不应展示会创建该标签的入口。

项目里已有类似边界：Web 端打开 workspace 时通过 `preferDirectoryBrowser` 走自实现目录选择 UI；桌面端继续走 `platform.selectDirectory()` 的系统目录选择框。浏览器能力也应使用同类平台能力边界，而不是在单个按钮里写零散判断。

## 目标

- 桌面 Electron 继续显示并支持右侧“浏览器”标签。
- Web app / 手机远控不显示“浏览器”标签入口。
- 命令中心不注册 `toggle-preview` 和 `add-browser-tab` 这类浏览器命令。
- 深层 browser tab 创建回调在不支持内嵌浏览器的壳层中不创建 side pane browser tab。
- 普通外链点击仍可在 Web 浏览器新标签中打开，不等同于 ZCode 内嵌浏览器功能。

## 状态链路

```text
Root platform props
  |
  |-- Desktop: supportsEmbeddedBrowser = true
  |       |
  |       |-- QuickPick registers browser commands
  |       |-- Side pane launcher/menu shows Browser
  |       |-- useAppPanels creates browser side pane tabs
  |
  `-- Web / mobile: supportsEmbeddedBrowser = false
          |
          |-- QuickPick omits browser commands
          |-- Side pane launcher/menu omits Browser
          |-- useAppPanels ignores browser tab creation requests
          `-- URL opening falls back to browser window.open
```

## 影响面

- `packages/ui/src/root/types.ts`: Root/App props 增加内嵌浏览器能力开关。
- `packages/ui/src/App.tsx`: 将能力传给 quick pick、panel hook 和 shell layout。
- `packages/ui/src/hooks/useAppPanels.ts`: 不支持时阻断 browser side pane 创建。
- `packages/ui/src/quickpick/quickPickCommands.ts`: 根据能力注册命令。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`: 根据能力渲染 open-tab 和加号菜单项。
- `packages/web/src/main.tsx`: Web 根入口显式声明 `supportsEmbeddedBrowser={false}`。

## 验证

- 单测覆盖 quick pick 在不支持内嵌浏览器时不出现 browser 命令。
- 单测覆盖 side pane open-tab launcher 在不支持内嵌浏览器时不返回 browser 入口。
- 执行 `pnpm typecheck`。
- 执行 `pnpm lint`。
