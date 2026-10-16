# Side Pane Terminal Tabs

## 背景

Workspace 现在有底部 Terminal 面板，也有右侧 side pane tabs。用户希望在 side pane 的 `+` 菜单中直接新建 Terminal tab，让终端可以和 Browser、Review、Code Viewer 等内容并排保留在右侧 tab 容器里。

## 行为定义

- side pane 新增 `terminal` tab 类型。
- `+` 菜单每次点击 Terminal 都新建一个 side pane Terminal tab，不复用单例。
- 外层 side pane Terminal tab 按当前 workspace 名命名：
  - 第一个：`workspace-name`
  - 第二个：`workspace-name 2`
  - 第三个：`workspace-name 3`
- workspace 名来自当前 workspace path 的最后一级目录；如果无法解析，回退为 `Terminal`。
- 每个 side pane Terminal tab 对应一个独立终端实例，内部不再嵌套 terminal tabs，也不提供第二层新建终端按钮。
- side pane Terminal tab 复用底层 `TerminalSession` 能力，因此仍支持 xterm 主题、链接打开和复制粘贴行为。
- 底部 Terminal 面板保持原有行为，不和 side pane Terminal tab 共享终端 session 状态。
- 关闭某个 side pane Terminal tab 会卸载该 tab 内部的 `TerminalSession`，并释放对应终端进程；切换到其他 side pane tab 或收起 side pane 时保持挂载，不中断正在运行的命令。

## 兼容边界

- workspace 级命名继续使用当前 workspace path；远程/本地服务隔离仍由当前窗口 services 和 `workspaceIdentity` 上下文承载。
- 远程 workspace 继续通过当前窗口的 services 和 `workspacePath` 创建终端，不新增独立 Agent runtime、local host、SSH/WSL/Docker session。
- 该功能只改变 UI 承载位置，不修改 ZCode session/task realtime 消息流，不涉及 `desktop-continuous` 与 `web-remote-replayable` 传输边界。
- 手机 Web 远控复用现有 side pane overlay 渲染路径；Terminal tab 不改变 replayable 恢复语义。

## 实现入口

- `packages/ui/src/lib/workspaceSidePane.ts`：新增 `TerminalSidePaneTab` 状态类型和创建函数。
- `packages/ui/src/hooks/useAppPanels.ts`：新增打开 Terminal side pane tab 的 handler，并按 workspace 名生成唯一标题。
- `packages/ui/src/app-shell/AnimatedSidePanePanel.tsx`：在 `+` 菜单和 tab 内容区接入单实例 Terminal。
- `packages/ui/src/SidePaneTerminalPane.tsx`：承载无内嵌 tabs 的单个 `TerminalSession`。
- `packages/ui/src/app-shell/SidePaneTabTrigger.tsx` / `SidePaneTabOverview.tsx`：补标题、图标和搜索标签。
