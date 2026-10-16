# Workspace Layout

当前工作区主界面采用三段式结构：

- 左侧固定为 `WorkspaceSidebar`
- 右侧上方为工作区 `Header`
- 右侧下方为主内容区

补充约束：

- 侧栏显隐入口挂在 `packages/ui/src/App.tsx` 的最外层 shell，而不是放进 `WorkspaceSidebar` 内部。
- 这样侧栏隐藏后，左上角仍然保留“重新展开”的入口，不会把恢复操作一起藏掉。
- 该入口使用绝对定位覆盖在 shell 左上角，高度固定 `h-11`，宽度跟随按钮内容。
- macOS 需要额外给左侧留出红绿灯安全区，避免按钮和窗口控制区重叠。
- 展开态只显示 `PanelLeftClose`；收起态显示 `PanelLeftOpen` 和 `MessageCirclePlus`，后者直接触发新建 task。
- `WorkspaceSidebar` 的默认宽度和可拖拽最小宽度均为 `264px`，即 256px 内容宽度加 8px 安全余量；拖拽、键盘 Home 和 `aria-valuemin` 必须共享这一边界。
- 全局 Pinned 区只在有置顶任务或正在加载置顶任务时显示，并在列表上方使用 `taskList.pinnedSection` 作为独立标题。
- `WorkspaceSidebar` 在每个 workspace 行右侧操作区提供文件树入口，位置在更多菜单和新建任务之间；点击后任务列表整体向左滑动，右侧滑入 `WorkspaceFileTree`。文件树实现细节见 `docs/ui/workspace-file-tree.md`。

主内容区再拆成上下两层：

- 上层为双列布局：左边 `Conversation`，右边 `Browser`
- 下层为横跨整行的 `Terminal`

布局原则：

- `Header` 只属于右侧工作区区域，不再和左侧 `WorkspaceSidebar` 混排
- `Browser` 打开后占据上层右侧独立列，不再和 `Terminal` 争夺底部空间
- `Terminal` 独立位于底部整行，和上层内容区之间支持纵向拖拽
- `PreviewPane` 仍作为最外层附加面板存在，避免和 `Browser` 的职责重叠
