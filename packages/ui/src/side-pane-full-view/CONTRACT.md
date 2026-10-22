# side-pane-full-view

Side Pane 完整视图：面板占满窗口，对话成为第一个 tab，并在面板 tab 上方提供浮动输入窗口。行为合同见 `docs/ui/side-pane-full-view.md`。

不变量：

- 唯一状态 owner 是 `useSidePaneFullView`，记录按 workspace + 对话 owner 存在 `taskSidePaneMemory`；侧栏、WorkspaceHeader、浮窗显隐都只读派生，不回写原有状态。
- 对话区只有一个 `SessionPane` 实例；宿主只改变定位方式，不移动 DOM、不重新挂载，草稿与附件因此只有一份。
- 不覆盖 react-resizable-panels 管理的 panel flex：库以各 panel 的 `offsetWidth` 之和作为 group 尺寸，压成 0 会让 resize 得到 NaN。完整视图通过面板外框 `absolute inset-0` 铺满 Group。
- controller 对象引用只在状态变化时更新，它会进入 memo 的 WorkspaceShellLayout。

交集：

- `SessionPane` / `ConversationTimeline` / `V4WorkspaceChatArea` 通过 `useConversationPanePresentation` 读取展示形态并上报运行状态、阻塞交互与输入区高度；不在完整视图下读到默认 docked，行为不变。
- 浮窗形态下 `ConversationTimeline` 经 `onLatestTurnSummaryChange` 上报最后一个回合（turnKey、运行状态、运行时长、最终回答，同一个 render unit），`SessionPane` 把时长交给单行输入框占位，把 turnKey / 运行状态 / 回答经 `reportFloatingStatus` 交给宿主；宿主按 owner 记录基线并推进回答气泡（`reduceFloatingAnswerBubbles`）：基线之后出现的已结束回合才弹出，不要求观察到运行中。
- 快捷键 `toggleSidePaneFullView` 在 `packages/shared/src/shortcutCommands.ts` 命令表登记，处理器只在桌面端注册。
