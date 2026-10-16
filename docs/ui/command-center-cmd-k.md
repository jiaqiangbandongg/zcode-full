# Command Center Cmd+K Initial State

## 目标

`Cmd/Ctrl+K` 打开的 Command Center 需要同时承担工作区快捷入口和当前任务上下文入口。默认打开时优先展示当前任务最近变更、最近任务和按语义拆分的命令分组；输入搜索词后继续复用现有 commands / tasks / files 混合搜索能力。

## 默认内容

空搜索且范围为 `All` 时按以下顺序展示：

1. `Recent changes`
   - 数据来源是当前 active task 已加载的 assistant messages。
   - 与聊天区每轮 `summary changes` 保持同源：从 assistant tool calls 的 `raw` / `input` / `output` / `display` 结构中解析文件变更摘要。
   - 不读取 sqlite 的 `summary_*` 字段，不读取 `ZCodeTaskMeta.changeSummary`，也不从 `perTurnFileChangesByTaskId` / `perTurnSummariesByTaskId` 做兜底。
   - 只展示当前任务最近修改过的文件，不能使用整个 workspace 的 Git unstaged/staged 变更。
   - 默认展示最多 3 条。
   - 每行展示文件图标、workspace 相对路径、`+added -removed`。
   - 当前任务没有变更摘要时隐藏该分组。

2. `Recent tasks`
   - 数据来源是当前 workspace 已加载任务列表。
   - 默认展示最多 3 条最近更新任务。
   - 点击后切换到对应任务。

3. 命令分组
   - 原先单一 `Quick actions` 拆成 `Suggested`、`Chat`、`Navigation`、`Panels`、`Configure`、`App`。
   - 分组模型保持稳定；本轮没有默认命令的分组不展示空标题，但不能从 registry / i18n / section order 中删除。
   - `Suggested` 只展示 `New task`、`Open workspace`、`Settings`。
   - `Chat` 与 `Navigation` 暂无默认命令项，后续对话和导航动作仍回到对应分类承接。
   - `Panels` 展示 `Toggle sidebar`、`Toggle terminal`、`Toggle preview`、`Add terminal tab`、`Add browser tab`、`Add review tab`。
   - `Configure` 展示 `Settings`、`Switch theme to light/dark`、`Skills`、`MCP Servers`。
   - `App` 展示 `Feedback`、`Community`、`Product docs`、`Connect/Disconnect`。

## 范围 Tabs

搜索框下方始终展示范围 tabs：`All`、`Actions`、`Tasks`、`Files`。tabs 是范围筛选，不只是搜索前缀快捷入口；因此即使没有输入内容，切换 tab 也必须展示对应范围的默认内容。

- `All`
  - 空搜索时展示完整默认首页：`Recent changes`、`Recent tasks`、命令分组，其中上下文分组只展示最多 3 条预览。
  - 输入搜索词后混合搜索 actions、tasks、files；任务和文件结果按首页预览节奏折叠。
- `Actions`
  - 空搜索时只展示命令分组：`Suggested`、`Chat`、`Navigation`、`Panels`、`Configure`、`App`。
  - 输入搜索词后只搜索 actions。
- `Tasks`
  - 空搜索时只展示最近任务，不能沿用 `All` 首页的 3 条预览限制。
  - 输入搜索词后只搜索 tasks，并直接展示任务结果列表，不沿用 `All` 的 3 条预览限制。
- `Files`
  - 空搜索时只展示当前 active task 修改过的文件，即 `Recent changes`，不能沿用 `All` 首页的 3 条预览限制。
  - 输入搜索词后只搜索 workspace files，并直接展示文件结果列表，不沿用 `All` 的 3 条预览限制。
  - workspace files 与 Composer `@` 文件候选复用同一个 Host 侧 `listWorkspaceFiles` 索引和[默认过滤器](../superpowers/specs/2026-08-07-workspace-file-search-default-filter-design.md)；UI 不维护独立黑名单，本期不提供自定义规则配置入口。

视觉上搜索框和范围 tabs 属于同一个 header block，header block 使用紧凑的 8px 横向 padding，中间不放分割线；只在 tabs 下方进入结果列表前使用弱分隔。搜索框本体使用带边框的胶囊输入壳，遵循 input 背景、边框、hover 与 focus token。tabs 使用小尺寸胶囊按钮，保持紧凑、可横向滚动，避免移动端长文案挤压搜索框。

## 搜索状态

输入搜索词后，保留现有 Command Center 搜索语义：

- 无前缀时同时搜索 commands、tasks、files。
- `>` 限定 commands。
- `#` 限定 tasks。
- `@` 限定 files。
- 搜索结果仍按命令、任务、文件分组展示，并保留搜索历史。

## 视觉细节

- Command Center 与 QuickPick 的列表 item 使用 `rounded-xl`，让键盘选中态和 hover 态更柔和。
- 底层 `CommandItem` 保持 `rounded-lg` 默认值；Cmd+K/QuickPick 通过共享 item class 覆盖为更大圆角，避免影响其它命令列表。
- 命令图标优先复用对应既有入口的 Lucide 图标；同一动作在 Header、Sidebar、Side pane 与 Cmd+K 中不能使用不同语义图标。

## 兼容边界

- UI 必须兼容桌面端和 Web 端。
- 主快捷键继续遵循平台规则：macOS 使用 Command，Windows/Linux 使用 Ctrl。
- 本地和远程 workspace 的最近任务仍走已有 task list 服务边界，UI 不直接读取 session JSON。
- `workspaceIdentity?.trim() || workspacePath` 继续作为任务与历史隔离 key。
