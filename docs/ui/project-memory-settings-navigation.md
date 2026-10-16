# Settings Project Memory 分层导航

## 问题摘要

Settings 的 Project Memory viewer 需要按 Workspace Scope 查看对应的 Memory 文件，并能用用户选择的编辑器直接打开真实文件。

Memory 复用能力设置的 Scope 交互，但只提供 Workspace Scope，不提供 User Scope：

```text
Workspace Memory 开关
  └─ Workspace Scope + 当前记忆数量 + 刷新
       └─ 当前 Workspace 的全部 Memory 文件
            └─ 编辑器按钮打开真实文件
```

## 产品合同

### Workspace Scope 与文件列表

- “工作区记忆”开关卡片固定显示在 Scope 工具栏上方；它是 Memory 功能入口设置。
- 开关卡片使用单段精简说明：“在工作区中保存并复用长期上下文，新会话生效。开启后可能增加模型调用和 Token 成本。”，不再单独重复展示成本提示段落。
- catalog 加载完成后默认选择第一个 Workspace；Scope 菜单只列出有 Memory catalog 的 Workspace，不显示 User 选项。项目名称优先复用应用已打开 Workspace 与最近 Workspace 记录中的真实名称，保留原始大小写和字符。
- Scope 菜单以 `settings.json.recentProjects` 的最近使用顺序为准；能通过项目目录名匹配的 Memory Workspace 先按该顺序排列，未匹配的历史 Memory 保留 catalog 原顺序并追加在末尾。当前打开但尚未写入 `recentProjects` 的 Workspace 仅补充名称和末尾顺序，不覆盖 settings 顺序。
- Scope 工具栏复用 MCP 的按钮、菜单宽度、Workspace 图标和选中态，左侧依次展示 Scope、分隔线和当前 Workspace 的 Memory 数量，右侧展示文件名搜索；`文件` 分组标题右侧展示刷新入口。
- 切换 Scope 后直接替换下方文件列表，不经过项目列表或面包屑二级导航。Scope 表达 Memory 对项目的生效范围，不表达其物理存储位置；底层仍可存放在 User Home。
- 搜索只过滤当前 Scope 的文件名，忽略大小写；切换 Workspace 时保留查询。无匹配结果时隐藏“文件”分组标题和列表，展示统一的搜索空状态。
- 列表视觉与设置页的 MCP、Skills、Hooks 资源列表保持一致：`文件` 分组标题使用统一的 `h-7` 高度；列表容器无外边框、使用 `bg-surface`，各行之间使用独立的 `bg-border/50` 分隔元素。
- 文件图标使用 `size-9`、`rounded-xl`、`bg-background` 的图标容器；行 hover 使用 `bg-hover`。
- 数量包含该项目目录中 catalog 返回的全部 `.md` 文件，包括 `MEMORY.md`。
- 项目继续沿用 service 的最近更新时间倒序，不在 UI 重新排序。

### Memory 文件列表

- 列表平铺展示 catalog 返回的全部文件；`MEMORY.md` 是普通可选项，不再作为虚拟父节点。
- 每个文件复用 `FileDisplayIcon`，根据文件扩展名展示文件类型图标；文件行仅展示信息，不读取或展开 Markdown 正文。
- 文件行中部按两行展示文件名与更新时间：文件名使用 UI 字体、`font-medium` 主文字，更新时间使用次要小号文字；右侧保留独立的编辑器分段菜单。
- Memory 文件分组标题使用统一的 `h-7` 高度；文件列表使用无边框 `bg-surface` 容器与独立分隔元素。
- 每个文件行右侧复用顶部工具栏的 `WorkspaceEditorButtonGroup`：主按钮显示当前编辑器图标并直接打开文件，下箭头用于选择其他编辑器。
- 文件行不显示展开箭头，不设置展开状态；按钮与行主体保持独立交互。
- 文件行主体不是可展开按钮；只有右侧原生编辑器按钮组可操作。主按钮使用当前编辑器打开真实文件，箭头菜单切换编辑器。

### 滚动合同

- 与 Settings Plugin 列表/详情一致，由 Settings 主内容区统一承担纵向滚动，不为 Memory viewer 锁定外层滚动。
- Memory 工具栏和文件列表参与同一条页面滚动链。
- 不在 viewer 内创建第二条纵向滚动条，也不使用固定卡片头部。

### 刷新

- Scope 工具栏保留显式刷新入口。
- 刷新后当前 Workspace 仍存在则保留选择；当前 Workspace 消失时自动选择新的首项。

### 空状态与加载状态

- catalog loading、无已保存记忆和仅本地可查看提示统一使用透明背景、`rounded-xl border border-dashed border-border` 的提示容器；功能关闭时只显示上方开关卡片，不渲染额外提示容器。
- 空状态不伪造 Workspace Scope，不提供新建入口，也不改变现有 Memory 数据来源。

## 状态与事件

```text
memories(workspaceId)
  ├─ selectScope(nextWorkspaceId) ─────────> memories(nextWorkspaceId)
  ├─ open(file, editor) ───────────────────> external editor
  └─ refresh
       ├─ workspace exists ────────────────> memories(workspaceId)
       └─ workspace missing ───────────────> memories(firstWorkspaceId)
```

UI 的 Scope 选择只存在于 `MemorySettingsSection` 挂载期间，不写入 setting、localStorage、Host、Runtime 或 catalog service。

## 平台与架构边界

- Desktop Settings 仍固定通过本地 Base Host 读取当前本地 profile。
- Memory 目录解析和打开前的 `stat` 同样固定使用本地 Base Host；当前激活 SSH、WSL 或 Docker
  workspace 时不得把本机 Memory 路径交给远端 Host。
- catalog 返回每个文件的真实绝对路径；文件按钮将该路径交给既有 `IPlatformService.openInEditor`，Renderer 不自行拼接路径。
- Web Remote / Mobile 仍只展示开关和“前往本地桌面端查看”提示，不调用 catalog。
- 不聚合 SSH、WSL、Docker、custom-agent 或 external storage Memory。
- 不修改 `memoryEnabled` 的 app-global 持久化与 session materialization 语义。
- 不新增协议、watcher、polling、内联读取、删除、搜索或导出能力。

## 响应式与无障碍

- Desktop 和手机宽度使用相同的 Scope 与文件列表语义，不因断点改变信息架构。
- Scope 使用原生菜单键盘语义；Memory 文件行是静态信息容器，编辑器按钮组使用原生按钮键盘语义。
- Folder/FileText 图标仅辅助识别，Workspace 名称和文件名仍是可访问名称的主体。
- 长 Workspace 名和长文件名均允许截断，不展示 Tooltip。
- 所有文案使用 i18n，所有颜色、字号、间距和圆角使用 `DESIGN.md` 的语义 token。

## 验收用例

| ID    | Setup                           | Action           | Assertions                                                                                     |
| ----- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| PMN01 | Desktop、Memory 开启、两个项目  | catalog ready    | 开关在上；Scope 默认首项且无 User；工具栏显示数量；下方直接显示当前 Workspace 文件             |
| PMN02 | Scope 菜单包含多个 Workspace    | 切换 Workspace   | 文件列表替换为目标 Workspace 内容，不出现项目列表或面包屑                                      |
| PMN03 | 当前 Workspace 文件列表         | 查看并使用文件行 | 文件类型图标、名称、更新时间与右侧编辑器分段菜单正确；主按钮打开真实路径，下箭头选择其他编辑器 |
| PMN04 | 已选择非首个 Workspace          | 显式刷新         | Workspace 仍存在时保留选择；消失时选择新的首项                                                 |
| PMN05 | catalog loading、empty 或 error | 加载、重试       | loading/empty 使用统一透明虚线容器；错误保留明确反馈和显式刷新入口                             |
| PMN06 | Web Remote / Mobile             | 打开 Memory      | 只展示开关和本地查看提示，catalog 零调用                                                       |
| PMN07 | 文件列表超过视口                | 滚动             | 仅 Settings 主内容区纵向滚动                                                                   |

## 剪枝

- 不枚举 Runtime、provider、desktop continuous 与 mobile replayable 消息组合：本改动不触发 Runtime 或协议，只用零调用不变量证明隔离。
- 不新增 service 文件系统等价类：目录 containment、symlink、并发删除、原子更新和 5 MiB 上限继续由 `memoryService.test.ts` 覆盖。
- 不保留旧 selector、虚拟树、折叠和 roving-focus 用例：这些交互退出产品合同，由原生按钮列表键盘语义替代。
