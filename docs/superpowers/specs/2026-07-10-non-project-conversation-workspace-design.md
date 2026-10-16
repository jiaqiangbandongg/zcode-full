# 非项目对话工作区设计

## 目标

新用户不再必须先选择项目，也不再自动创建 `~/ZCodeProject`。应用在内部使用一个稳定的 conversation backing workspace：

```text
workspacePath = <dataBaseDir>/.zcode/workspace/default
workspacePurpose = conversation
selectedProject = null
```

默认 `dataBaseDir` 为用户 home，因此默认路径是 `~/.zcode/workspace/default`。该目录提供 Agent、session、terminal 和文件工具需要的真实 cwd，但不作为项目展示给用户。所有非项目对话共享这一目录；本期不实现每条对话独立目录及对应的 Agent 回收、目录注册和 GC。

## 状态与边界

新增 `WorkspacePurpose = "project" | "conversation"`。缺少该字段的旧数据按 `project` 处理。purpose 只表达产品分类，不改变 workspace identity：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

本地 conversation workspace 不合成 `workspaceIdentity`，也不修改 App/Agent 的 ZCode Protocol。purpose 需要存在于 app-owned 的 workspace session、tab、task meta、task-index 和 Web remote workspace 描述中，以便恢复、查询和展示使用相同事实。

本地桌面启动时先幂等确保 conversation backing directory，供非项目对话和任意失效历史 workspace 的
Agent spawn cwd fallback 共用；有真实项目时只创建目录，不激活为当前 workspace。随后分为两条路径：

```text
ensure conversation backing directory
  -> 有可恢复 workspace session
  -> 恢复原 descriptor 与 active index

ensure conversation backing directory
  -> 无可恢复 workspace session
  -> Main 预热该路径
  -> Renderer 激活 purpose=conversation 的内部 tab
  -> composer 可直接首发
```

Main 是首次 bootstrap 权威；Renderer 只消费完整 descriptor，或在用户显式切换到非项目模式时幂等 ensure。不得由 Main 和 Renderer 各自分配不同默认目录。

## 侧栏信息架构

一级仍为 `分组 / 项目`，不增加一级“任务”。`项目 + 按项目` 视图包含两个可排序的二级 section：

```text
已置顶                         仅有数据或加载中时显示
项目             [drag]    [chevron] [+]
  Workspace A
  Workspace B
任务             [drag]    [chevron] [MessageCirclePlus]
  非项目任务
```

- 首次、旧版偏好或坏数据默认按“项目 → 任务”展示；用户可通过标题行的专用手柄拖拽换位，顺序在 renderer-local 偏好中持久化。两个标题始终显示并各自独立展开/收起，空列表分别显示“尚未打开项目”和“还没有任务”。
- 拖拽手柄与折叠 trigger、右侧 action 相互独立；支持鼠标、触摸和键盘排序。空 section 或收起 section 仍可整体移动，原展开态和内容跟随 section，不清理 workspace/task 排序或缓存。
- 标题及右侧 action 外的剩余标题行是折叠 trigger；展开显示向下箭头，收起显示向右箭头。箭头和 action 默认只在 hover 出现，键盘 `focus-within`、菜单打开和无 hover 设备保留可见回退；action 是 trigger 的 sibling，不触发折叠。
- “任务”右侧图标调用同一 `startDraft` 流程，但 target 固定为 conversation backing workspace，不能继承当前活动项目。
- “任务”中的任务使用普通单行 row，不显示内部 backing workspace 的 `default` 目录名，也不显示无业务含义的普通 idle 灰点；未读、错误和运行中状态继续复用共享 leading indicator。
- “项目”右侧 `+` 菜单只含“打开文件夹”和“远程连接”，复用 Root 已有操作；按 capability 隐藏不可用项。
- 两个 section 的展开态和 `sectionOrder` 通过 renderer-local `zcode-sidebar-purpose-section-preferences` 持久化，首次、坏数据或 storage 不可用时使用默认值；右侧 action 不改变展开态。本地偏好不进入 Host/Agent，不要求其它已打开窗口实时同步。
- 顶部 `Expand all` / `Collapse all` 在按项目视图中同时控制“项目”section 和所有 workspace 行，不影响“任务”；section 收起不清除 workspace 行展开态、任务缓存或 DnD 顺序。
- 顶部全局“新建任务”与快捷键仍使用当前活动 workspace。
- conversation 列表只包含非 pinned、非 archived 的 `purpose=conversation` 任务；默认折叠数量和“显示更多”沿用单 workspace 列表。
- pinned conversation task 只显示在“已置顶”；取消置顶后回到“任务”。archived conversation task 只显示在归档视图。
- 原有 `按项目 / 时间线` 和 `Created / Updated` 偏好保留；时间线继续聚合所有 purpose。

必须拆分两个 scope，禁止为了隐藏内部 workspace 而提前过滤任务源：

```text
allTaskWorkspaceTargets = project + conversation
  -> pinned / conversation / grouped / timeline / archived
  -> sessions-index / service resolver / task actions

projectWorkspaceTabs = purpose=project
  -> project section / workspace DnD / expand-collapse / empty state
```

`workspaceTabs.length === 0` 不能作为整个任务区的早退条件。即使没有真实项目，conversation backing target 仍要参与 task 查询，Group 视图也必须挂载。

## 分组语义

- 普通非项目任务默认是 Group 顶层未分组任务，可以通过拖拽或菜单进入任意普通分组。
- conversation task 的 group membership、排序、重命名、归档和未读状态与项目任务使用同一 task service。
- pinned/archived 仍按现有 membership 规则从活动 Group 列表排除；取消置顶后恢复原 group membership。
- workspace bootstrap 只为 `purpose=project` 的 scope 生成项目组，禁止为 backing path 生成名为 `default` 或旧/新用户文案“对话 / 任务”的自动组。
- Group 的 sessions-index、structure、membership、optimistic overlay 和 service lookup 都必须使用 `allTaskWorkspaceTargets`。

## Composer workspace 交互

- workspace 菜单顺序为“打开文件夹 → 远程连接 → 不在项目中工作”。
- conversation 状态的 trigger 显示“选择项目”，不显示关闭按钮；“不在项目中工作”显示 checked，重复选择为 no-op。
- project 草稿态在 hover、`focus-within` 时显示独立关闭按钮；点击后切到 conversation backing workspace，不关闭项目 tab，不展开菜单。
- 关闭按钮只作用于未发送草稿；已创建 task 不迁移 workspace。
- 切换必须先确保目标 workspace 可用，再改变 active target。失败时保留原 workspace 和草稿，展示可重试错误。
- 项目选择使用 `{ workspacePath, workspaceIdentity?, workspacePurpose }`，不能只按 path 匹配远程 workspace。
- conversation purpose 隐藏 Git branch selector；文件树、终端和复制路径仍使用真实 workspacePath。

## 多端和生命周期

- Desktop 继续使用 `desktop-continuous`，conversation backing workspace 复用一个本地 runtime。
- 手机 `/remote` 继续使用 `web-remote-replayable` 和 shared-host attachment，不得创建新的本地/远程 Agent runtime。
- 手机已有 conversation attachment 时可新建对话；没有 attachment 时动作不可用，并提示先在桌面端创建。
- relay 和 desktop main 不新增 task/session/queue/snapshot 业务状态。
- 关闭 tab、归档或删除 task 不删除 backing workspace 或其中用户文件。
- 多窗口 mkdir、重复点击和恢复必须幂等；路径被文件占用、权限不足或磁盘满时不得进入半激活状态。
- conversation purpose 的任务分区/工作区标签统一显示为“任务”，不得泄露内部叶子名 `default`；对话过程、手机 workspace kind badge 等其它文案不在本次重命名范围，路径语义 UI 除外。

## Accepted / Pruned

Accepted：首次启动直接对话、稳定共享 backing path、项目/非项目草稿切换、二级“任务/项目”sections、无项目 task 的 pinned/grouped/timeline/archive 行为、Desktop/Mobile shared-host 边界。

Pruned：每条对话独立目录、已有 task 改项目、手机创建独立 runtime、把 conversation 伪装成项目 workspace、按路径前缀替代显式 purpose。
