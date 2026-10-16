# Header 工作区与分支提示

Workspace Header 不再在任务名称后展示工作区胶囊与分支切换入口。工作区信息收进名称前的 ghost 图标按钮：本地显示 Folder，云端/远端显示 Cloud。

标题区元素间距为 `gap-2`（8px）；手机远控窄屏继续使用已有 `gap-1` 紧凑间距。
Header 默认左内边距为 8px（`p-2`），与右侧基础内边距一致；侧栏收起时仍按平台预留窗口控制按钮空间。

## 行为

- 已有任务显示图标入口，新任务草稿继续隐藏工作区上下文。
- Hover、键盘聚焦或点按时向下显示工作区名称、现有远端主机标识及分支；非 Git 工作区省略分支，Detached HEAD 复用现有本地化文案。
- 提示采用卡片式浮层，固定 `w-72`（288px）、`rounded-xl`、`bg-popover`、`shadow-md`，内边距 12px、行间距 12px。按「工作区图标 + 名称」「分支图标 + 分支」两行左对齐，使用 `text-ui-base`；长文字换行，图标不收缩。不增加任务统计、路径或操作项。
- 手机远控同样显示紧凑图标，可点按查看，不依赖 hover。
- 工作区与分支两行的文字和图标统一使用 `text-popover-foreground`，分支不降低透明度。
- Header 不再提供分支切换操作；聊天输入区等其他位置的 `GitBranchSwitcher` 保持原有列表、创建和未提交更改保护流程。

## 数据来源

- 提示直接读取现有 `gitSummary`，分支名称复用 `resolveGitBranchTriggerLabel`。不新增 Git 服务调用。
- 本地/远端识别、workspaceIdentity 与 remoteSessionId 沿用现有边界，不改变连接或任务状态。
