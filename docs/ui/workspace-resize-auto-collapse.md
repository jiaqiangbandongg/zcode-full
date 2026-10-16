# Workspace Resize Auto Collapse

## 背景

Workspace 主界面包含左侧 sidebar、聊天 conversation、底部 terminal 和右侧 side pane。用户缩小桌面窗口时，conversation 是最先被挤压的核心工作区，因此自动收起策略以 `ResizablePanel(id="conversation")` 的实际宽度为判据。

## 策略

- 只响应用户触发的 `window.resize`，不监听 conversation 自身 `ResizeObserver`，避免用户手动打开面板时被策略立即关回去。
- 每次窗口 resize 后读取 conversation panel 的实际宽度，不直接使用 `window.innerWidth`。
- 当右侧 side pane 已打开且 conversation 宽度小于 `480px` 时，自动收起 side pane。
- 当左侧 sidebar 已打开且 conversation 宽度小于 `360px` 时，自动收起 sidebar。
- 自动收起只在变窄时触发；窗口放大后不自动恢复，用户通过现有按钮或快捷键手动打开。
- side pane 自动收起只隐藏容器，不关闭 tab，避免浏览器、Git、预览等面板内容丢失。

## 兼容边界

- 桌面端和 Web 桌面端复用同一 conversation panel 监听。
- 手机远控当前使用独立 overlay / mobile shell，不依赖该桌面分栏策略。
- 该策略不改变 ZCode session / task realtime 消息流，不涉及 `desktop-continuous` 与 `web-remote-replayable` 的传输边界。
