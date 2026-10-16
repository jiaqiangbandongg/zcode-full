# Task List SQLite Storage And Cache

> **当前状态**：本文描述 tasks-index SQLite 与侧栏列表缓存的当前边界；
> conversation 正文状态仍由 V4 projection 提供。

任务置顶和归档都不再写入 task meta。

> 说明：本文档早期描述过 `pinneds.json` / `archiveds.json` 方案。
> 当前实现已经收敛到 `tasks-index.sqlite` 作为索引真相源，下面内容按现状更新。

## 持久化规则

- pin task 时：
  - task 快照文件保持 `{taskId}.json`
  - 更新 `~/.zcode/v2/tasks-index.sqlite` 中对应 task 的 `pinned` 状态
- unpin task 时：
  - task 快照文件保持 `{taskId}.json`
  - 更新 `~/.zcode/v2/tasks-index.sqlite` 中对应 task 的 `pinned` 状态
- archive task 时：
  - task 快照文件保持 `{taskId}.json`
  - 更新 `~/.zcode/v2/tasks-index.sqlite` 中对应 task 的 `archived` 状态
  - 若之前已 pin，会同步把 sqlite 中 `pinned` 状态清掉

## 读取规则

- 全局 pin 列表来自 `listTaskList({ kind: "pinned", workspaceScopes })`
- 全局 timeline 列表来自 `listTaskList({ kind: "timeline", workspaceScopes })`
- 全局 archived 列表来自 `listTaskList({ kind: "archived", workspaceScopes })`
- workspace task 列表来自 `listWorkspaceTaskLists({ workspaceScopes })`
- 以上查询都统一走 `tasks-index.sqlite`
- sqlite 查询语义固定为：
  - `pinned`：`pinned = 1 AND archived = 0`
  - `archived`：`archived = 1`
  - `timeline / workspace`：`pinned = 0 AND archived = 0`
- pin 状态判断不再依赖旧本地 task 扫描，Header / Sidebar 都统一来自 sqlite 列表查询
- task 快照路径统一为 `getTaskSessionFilePath(workspacePath, taskId)` 返回的 `{taskId}.json`
- 启动迁移时会把历史 `_pinned.json` / `_archived.json` 直接改名回 `{taskId}.json`

## 前端缓存规则

- Sidebar `pinned` 分区在加入或切换 workspace 时不渲染阻塞式“正在获取任务”占位：已有缓存任务直接展示并在后台刷新；workspace scope 新增时保留已有 scope 的任务，scope 删除时只过滤被删除 scope 的任务，禁止因全局 query key 切换发布空中间帧；只有原本就没有可展示任务时才暂时隐藏整个分区，查询完成后再按结果出现。
- Pinned task row 的 hover 操作区提供文件树入口，打开该 task 所属 workspace 的文件树。入口不修改 SQLite pin membership；远端 task 必须匹配同一 `workspaceIdentity` 的已连接 tab，并携带其 `remoteSessionId`，禁止按相同 `workspacePath` 串到本地 workspace。
- query cache key 由以下维度组成：
  - 列表种类：`pinned / archived / timeline / workspace`
  - 排序：`created / updated`
  - 搜索词
  - 当前可见条数（例如 workspace task 的 5 / 10 / 15）
  - 当前参与查询的 `workspaceKey` 集合
- `show more` 的缓存规则：
  - workspace task 首屏显示 5 条，每次点击只把当前 workspace 的可见上限增加 5
  - 新一档 limit 的 cache 尚未就绪时继续展示上一档快照，不清空任务行或切换成阻塞 loading
  - 全部任务可见后隐藏入口；workspace 收起后分页进度回到 5，已有 cache 可以继续复用
- `workspace task` 的 `show more` 只更新当前 `workspaceKey` 的 limit，不再把所有已打开 workspace 一起重查
- 任务操作后的前端更新规则：
  - `rename / read / unread`：直接 patch 当前 task 的 cache 元数据，不整栏失效
  - `pin / unpin / archive / unarchive`：先局部 patch 受影响查询，再只对必要的折叠查询做后台补拉
- 后台补拉只用于补齐“折叠列表有隐藏数据时，边界可能变化”的情况，避免整个 sidebar 一起刷新

## 相关实现

- 持久化：`packages/services/src/session/taskIndexRepo.ts`
- 服务接口：`packages/services/src/session/zcodeTaskService.ts`
- UI 全局列表：`packages/ui/src/hooks/useGlobalTaskList.ts`
- UI workspace 分组列表：`packages/ui/src/hooks/useWorkspaceTaskLists.ts`
- 前端 query cache：`packages/ui/src/store/taskQueryCacheStore.ts`
- query key / descriptor：`packages/ui/src/lib/taskQueryCache.ts`
- Sidebar pinned 区：`packages/ui/src/WorkspacePinnedTasksSection.tsx`
- Sidebar timeline 区：`packages/ui/src/WorkspaceTimelineTasksSection.tsx`
- Sidebar archived 区：`packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`
- Workspace 分组 task 区：`packages/ui/src/WorkspaceSidebarItem.tsx`
- Header 更多菜单：`packages/ui/src/WorkspaceHeaderSections.tsx`
