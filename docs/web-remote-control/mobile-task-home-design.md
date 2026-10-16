# 手机端远程控制任务首页改造方案

> **状态：已实施。** 当前代码入口是 `packages/ui/src/WebRemoteControlMobileShell.tsx`、
> `WebRemoteControlMobileTaskHome.tsx` 与 `hooks/useWebRemoteControlTaskOpen.ts`；下文“推荐/实施顺序”
> 保留设计轨迹，不表示待实现状态。
>
> 当前远控链路使用外部 relay 的 `data.payload` app payload。本文中涉及任务首页/切 workspace 的交互仍有效；旧 relay token、HTTP bootstrap、`bridgeToken/wsUrl` 假设已废弃，不再作为实现依据。

产品与架构总览见 [Web 远程控制概览](./web-remote-control-architecture.md)。本文记录手机首页与
聊天页的交互契约；时间线、主题和宽屏列表等专题由总览统一导航。

## 背景（改造前）

改造前，手机端 Web 远程控制复用了桌面端 `WorkspaceSidebar` 和聊天区域：

1. 手机页面在小屏下被 `WorkspaceShellLayout` 改成上下结构。
2. 上半部分仍是桌面 sidebar 的裁剪版，包含 workspace、任务入口和一些桌面侧栏能力。
3. 下半部分复用桌面聊天区。

这个结构能快速复用已有逻辑，但不适合新的手机端信息架构。新的目标是让手机端变成两个明确页面：

1. 首页：当前设备上的工作区和任务列表。
2. 聊天页：选中某个任务后的聊天界面，继续复用桌面聊天组件。

核心变化是：手机端不再复用桌面端任务列表 UI，但任务点击、跨 workspace 切换、mobile view state 上报等业务逻辑继续复用现有桌面远控链路。

## 目标

1. 手机端远控首页展示 workspace card，card 可展开，展开后展示该 workspace 下的任务。
2. 点击任务后进入聊天页，聊天页继续复用现有 header 和 V4 session chat surface。
3. 任务点击逻辑复用现有 Web 远控逻辑：
   - 同 workspace task：直接选中任务并上报 mobile view state。
   - 跨 workspace task：请求新的 workspace bridge，再进入对应任务。
4. 扫码初始态不再自动进入聊天页。
5. 如果扫码入口带有初始 task，首页自动展开该 task 所属 workspace card，并把对应 task 行显示为选中态。
6. 保持 desktop 和 mobile 选中态分离，手机端操作不反向切换桌面端当前 tab/task。
7. 遵守 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 的身份隔离规则。

## 非目标

第一版不做：

1. 手机端新建 workspace。
2. 手机端新建 SSH / WSL / Docker remote session。
3. 手机端管理桌面窗口外的 workspace。
4. 多手机同时控制同一 desktop window。
5. 重做聊天组件、ZCode runtime 或 relay 协议主链路。
6. 让桌面端同步切到手机端选择的 task。

## 2026-05-02 补充：workspace 级新建任务入口

为补齐手机端操作闭环，任务首页的每个 workspace card 右侧增加“新建任务”按钮，行为如下：

1. 同 workspace：
   - 调用 `startDraft(workspacePath, workspaceIdentity)` 进入草稿态。
   - 上报 `updateMobileViewState(workspaceKey)`（不带 taskId），避免继续高亮旧 task。
   - 进入聊天页。
2. 跨 workspace：
   - 走 `switchWorkspace(workspaceKey, { mobileNavigationIntent: "chat" })`，且不传 `taskId`。
   - 目标 Root 以 `initialTaskId=undefined` 启动，进入该 workspace 的草稿态。
3. Web 远控 `switcher` 增加可选 `startDraft(workspaceKey, { mobileNavigationIntent })` 能力，
   便于手机端统一调用；不支持该能力的实现仍可回退到 `switchWorkspace + updateMobileViewState`。

该补充保持现有身份隔离规则：`workspaceKey = workspaceIdentity?.trim() || workspacePath`。

## 推荐方案

采用移动端专用 shell，而不是继续改造 `WorkspaceSidebar`。

推荐新增一层手机远控 UI：

```text
WebRemoteControlMobileShell
  ├── home: WebRemoteControlMobileTaskHome
  │     └── workspace card list
  │           └── task rows
  └── chat: existing chat header + V4 session chat surface
```

桌面端和宽屏 Web 远控继续走现有 `WorkspaceShellLayout` 的桌面布局。只有满足 `webRemoteControlWorkspaceSwitcher` 且小屏断点时，才进入移动端两页 shell。

这样做的好处：

1. 首页 UI 可以完全按手机端体验设计，不受桌面 sidebar 的历史结构限制。
2. 聊天页仍复用现有聊天能力，降低风险。
3. task 点击、workspace bridge、mobile view state 不重新发明，只抽出为共享 hook。
4. 后续如果手机首页继续演进，例如搜索、状态筛选、设备登录态，也不会污染桌面 sidebar。

## 页面模型

### 首页

首页用于浏览当前 desktop window 内已打开的 workspace 和 task。

信息结构：

1. 顶部品牌和设备状态：
   - `ZCode Remote Control`
   - 第一版展示连接状态，不新增设备名称协议字段
2. 可关闭提示区：
   - 说明本次扫码连接可查看当前设备上的项目、任务和会话
   - 二维码失效后需要回到 desktop 重新连接
3. 工作区任务区：
   - 标题：当前设备上的工作区和任务
   - 副文案：总 workspace/task 数
   - 操作：全部收起、刷新
4. workspace card：
   - workspace 名称
   - workspace 路径
   - local / SSH remote / Docker / WSL 等弱标签，第一版可先用 local / remote
   - 最近更新时间，从该 workspace 下 task 的 `updatedAt` 最大值派生；没有 task 时不展示
   - task 数
   - 展开/收起按钮
5. task row：
   - 任务标题
   - provider CLI
   - 更新时间
   - 状态 pill
   - 未读、运行中、错误等状态标识
   - 当前选中 task 使用 selected 样式

2026-05-28 补充：手机首页顶部增加全局 pinned 分区。桌面 renderer 同步任务快照时会同时读取
`kind: "pinned"` 与 `kind: "timeline"` 两类 sqlite 列表；mobile 首页收到统一 task targets 后，
先按 `pinned === true` 拆出置顶分区，再把非置顶任务交给 workspace/timeline 普通列表。置顶任务
不再重复出现在普通 workspace card 或 timeline 列表中，但 active task 校验和选中态必须同时匹配
pinned 分区与普通分组。

首页自己拥有滚动区域，不能依赖桌面 sidebar 的滚动容器。

### 聊天页

聊天页复用现有工作区主内容：

1. 顶部保留移动简化后的 chat header。
2. 增加返回首页入口。
3. 主体继续使用 Root 注入的 V4 chat content（最终由 `packages/ui/src/v4/SessionPane.tsx` 承载会话）。
4. terminal、browser、side pane 的移动端展示规则沿用现有远控策略，第一版不主动扩展。

### 聊天页交互浮层边界

手机远控聊天页复用桌面会话组件，并保持与桌面一致的浮层层级和操作方式；手机端只收紧
浮层尺寸，避免为了适配窄视口引入另一套模型选择行为。
在 `web-remote-replayable` 且粗指针手机视口下，交互浮层必须满足：

1. 打开后的可交互内容完整位于当前可视视口内，左右不得被页面根节点裁切。
2. 模型选择继续使用与桌面一致的 provider 一级菜单和 model 二级菜单；手机端 model 二级菜单
   以更窄宽度为上限，并通过 Radix 当前方向的 available width 自动收缩到视口边缘；收缩时取消
   共享菜单的最小宽度下限，长模型名在菜单项内部截断，不把一级、二级内容改成单列长列表。
3. 右侧状态面板内的分支选择和 Todo 折叠预览优先沿纵向打开，由 Radix 在上/下之间翻转；禁止将它们固定在状态面板左侧。
4. 单个浮层宽度不得超过 `calc(100vw - 2rem)`；长模型名、分支名和中英文文案由浮层内部截断或滚动承接，不得让页面本身产生水平滚动。

当前与修复后的呈现边界：

```text
当前（手机）
provider root menu -> desktop-width model submenu -> viewport clip
status panel row    -> forced left popover             -> viewport clip

修复后（手机）
provider root menu -> narrow model submenu（保持二级交互）
                   -> min(desired width, Radix available width) -> viewport edge
status panel row    -> bottom/top popover                       -> viewport collision handling

桌面 / 宽屏 Web
provider root menu -> desktop-width model submenu（保持现状）
status panel row    -> left popover（保持现状）
```

该边界只属于 renderer presentation；不改变 mobile shell 导航、task/session 投影、
`CommandInbox`、owner/lease、relay 或 `desktop-continuous` / `web-remote-replayable` delivery 语义。

## 扫码初始态

当前链路里，desktop main 会通过 `initialViewState` 返回扫码发起时的 workspace/task。

新行为：

1. bootstrap 仍然选择 `mobileViewState -> initialViewState -> 第一个 workspace`。
2. web 仍然打开对应 workspace bridge，保证当前 Root/App 有可用 workspace 服务。
3. mobile shell 初始页面固定为 `home`。
4. 首页根据 `activeWorkspaceKey` 展开对应 workspace card。
5. 首页根据 `activeTaskId` 把对应 task row 标为选中。
6. 不自动进入聊天页。

`initialTaskId` 在这个阶段只表达“首页选中态”，不能触发 `onNavigateToChat`，也不能复用点击任务的打开流程。

这样用户扫码后首先看到当前设备上所有 workspace/task 的总览，同时能清楚知道桌面扫码时对应的 task 在哪个 workspace 下。

## 点击任务流程

任务打开逻辑从现有 `WebRemoteControlTaskIndex` 中抽出，形成共享 hook：

```text
useWebRemoteControlTaskOpen
  input:
    switcher
    activeWorkspacePath
    activeWorkspaceIdentity
    activeTaskId
    onSelectTask
    onNavigateToChat
    onSwitchingChange

  output:
    openTask(task)
    switchingTaskKey
    error
```

跨 workspace 后进入聊天页需要一份一次性导航意图，不能从 `initialTaskId` 反推：

```ts
type WebRemoteControlMobileNavigationIntent = "chat";

interface WebRemoteControlWorkspaceSwitchOptions {
  taskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  markTaskReadExpectedUnreadAt?: number;
}

interface WebRemoteControlMobileShellProps {
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
}
```

规则：

1. `WebRemoteControlWorkspaceSwitcherApi.switchWorkspace()` 的第二个参数扩展为 `WebRemoteControlWorkspaceSwitchOptions`，旧调用不传 `mobileNavigationIntent` 时行为不变。
2. web 入口在调用 `openWorkspaceBridge()` 前把 `mobileNavigationIntent` 暂存为内存中的 pending intent。
3. 新 bridge 渲染 Root/MobileShell 时把 pending intent 作为 `initialNavigationIntent` 传入，MobileShell 首次 mount 后消费并清空。
4. pending intent 不写入 URL，不写入 `mobileViewState`，也不传给 desktop main；它只解决当前浏览器页跨 Root remount 后的页面落点。
5. 扫码初始 `initialTaskId` 不设置 pending intent，因此只展开首页 card 和选中 task row。

同 workspace task：

1. 计算 `taskWorkspaceKey`。
2. 判断是否等于当前 `activeWorkspaceKey`。
3. 如果首页快照中的 task 带有 `unreadAt`，通过当前 Web 远控 bridge 的
   `switcher.markTaskRead(task)` 显式调用 `setTaskUnread(..., false)`；该动作不得依赖手机 Root
   内部 task query cache 是否已经水合。
4. 调用 `onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity)`。
5. 调用 `switcher.updateMobileViewState(taskWorkspaceKey, task.taskId)`。
6. 切换 mobile shell 到 `chat` 页面。

跨 workspace task：

1. 设置 switching 状态。
2. 调用 `switcher.switchWorkspace(taskWorkspaceKey, { taskId: task.taskId,
   mobileNavigationIntent: "chat", markTaskReadExpectedUnreadAt: task.unreadAt })`。
3. Web 端连接目标 workspace 的 shared-host bridge 后，使用目标 bridge 的
   `workspacePath/workspaceIdentity` 和首页快照中的 `unreadAt` 调用
   `setTaskUnread(..., false, expectedUnreadAt)`；失败只记录日志，不得阻止任务打开。
4. 新 bridge 渲染完成后，Root 接收 `initialTaskId` 并选中任务。
5. MobileShell 消费这次用户点击流程携带的一次性导航意图，进入 `chat` 页面。
6. 失败时记录 `logger.error`，并停留首页显示错误。

注意：扫码初始 task 只影响首页选中态，不调用这个点击流程。

### 手机打开任务后的未读清除边界

手机任务首页的蓝点来自 desktop renderer 推送的 `WebRemoteControlTaskTarget.unreadAt` 快照；手机
Root 内的 task query cache 是另一个按当前 bridge 异步水合的数据面。点击任务时不得再用 query cache
是否命中 `unreadAt` 作为是否清除未读的前置条件，否则同一 task 已经 active、冷 cache 或跨 Root
remount 时会跳过持久化。

```text
mobile home snapshot task.unreadAt
  │
  ├─ same workspace -> current bridge markTaskRead(expectedUnreadAt)
  │                     -> tasks-index compare-and-clear
  │
  └─ cross workspace -> switch option markTaskReadExpectedUnreadAt
                         -> target bridge connected
                         -> target service compare-and-clears tasks-index unreadAt

desktop task selection -> existing query-cache optimistic clear（保持不变）
```

约束：

1. 只有手机首页点击且快照明确带有 `unreadAt` 时发起写入；已读 task 不产生无意义 mutation。
2. 同 workspace 使用当前 bridge service；跨 workspace 必须等目标 bridge 建立后使用目标 service，
   禁止 main/relay 持有或修改 task 业务状态。
3. 目标参数必须贯穿 `workspaceIdentity`；路径执行语义继续使用 `workspacePath`。
4. 标记已读失败不能阻止导航。返回首页后由权威 tasks-index 快照决定蓝点是否恢复。
5. 桌面 `desktop-continuous` 的 `useWorkspaceTaskNavigation`、query-cache overlay、排序与
   `lastActivityAt` 逻辑不变；本动作只存在于手机 Web 远控 switcher。
6. 手机已读只确认本次首页快照对应的通知：repository 必须在同一原子写入边界内比较当前
   `unreadAt` 与 `expectedUnreadAt`。相等时清除；不相等时返回当前 meta 且不发变更事件，禁止迟到
   的旧点击覆盖随后产生的后台完成或错误未读。

## 组件拆分

建议新增或调整以下 UI 文件：

1. `packages/ui/src/WebRemoteControlMobileShell.tsx`
   - 手机远控两页壳层。
   - 管理 `home/chat` 页面状态。
   - 管理返回首页。
   - 消费跨 workspace 点击带来的一次性 `mobileNavigationIntent`。
   - 持有切换中 overlay。
2. `packages/ui/src/WebRemoteControlMobileTaskHome.tsx`
   - 渲染首页。
   - 加载 workspace/task 快照。
   - 管理 workspace card 展开状态。
   - 根据 active workspace/task 初始化展开和选中。
3. `packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts`
   - 抽出现有 `WebRemoteControlTaskIndex` 的 task 打开逻辑。
   - 供移动首页和旧 task index 复用。
4. `packages/ui/src/lib/webRemoteControlTaskIndex.ts`
   - 保留并扩展分组、排序、默认展开 key 计算。
5. `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
   - 在手机远控断点下渲染 `WebRemoteControlMobileShell`。
   - 移除手机远控对顶部 sidebar 高度拖拽的依赖。
   - 桌面端远控布局保持现状。

## 数据模型补充

当前 `WebRemoteControlTaskTarget` 已包含首页所需的基础字段：

1. `taskId`
2. `title`
3. `workspacePath`
4. `workspaceIdentity`
5. `remoteSessionId`
6. `workspaceLabel`
7. `workspaceKind`
8. `createdAt`
9. `updatedAt`
10. `provider`
11. `unreadAt`
12. `pinned`

首页派生展示字段：

1. 顶部设备区第一版不新增 `deviceLabel` 协议字段，只展示当前远控连接状态。后续如果要展示真实设备名，需要显式扩展 `WebRemoteControlWindowBootstrapResult` / `WebRemoteControlWorkspaceListResult` 增加可选 `deviceLabel`，并提供连接状态文案作为 fallback。
2. workspace card 的最近更新时间不新增 `workspaceUpdatedAt` 协议字段，由 mobile 首页按 workspace 分组后取该组 task 的最大 `updatedAt`。没有 task 的 workspace 不显示更新时间。

为了支持截图里的状态 pill，建议补一个可选展示字段：

```ts
displayStatus?: "idle" | "running" | "completed" | "error";
// 2026-09-09 追记：会话是否挂着后台工作（动态工作流 run / 后台 bash / 分离子代理）。
// 只参与列表运行层排序，不影响 displayStatus；来源是 sessions-index sidecar 的 hasBackgroundWork。
hasBackgroundWork?: boolean;
// 2026-09-14 追记：工作流运行摘要（≤ 4 条 run：在跑优先，其后最近结束的），来源是 sidecar 的 workflowActivity。
// 手机行在标题下绘制 Workflow 图标 + 迷你轨道灯 + 当前 phase 名（24px，13px 文字）；只绘制，不参与排序或状态 pill。
workflowActivity?: SessionWorkflowActivity;
```

字段来源按权威级别分层，不能把多个缓存当成同级事实：

1. task 行带有 sessions-index activity sidecar 时，实时 `phase` 是当前展示状态的唯一权威：
   - `prewarming` / `running` → `running`
   - `completedSuccess` / `completedInterrupted` → `completed`
   - `error` → `error`
   - `draft` 不产生持久 task 行；如果兼容数据意外带入 `draft`，不把它当成终态，继续走下一级 fallback
2. 没有 sessions-index activity 时，才读取当前 renderer 的 task runtime cache：
   - `creating` / `queued` / `streaming` / `waiting_permission` / `waiting_user_input` 等 live status → `running`
   - `failed` → `error`
   - `completed` → `completed`
3. runtime cache 也没有明确状态时，才读取 tasks-index 持久终态：
   - `completed` → `completed`
   - `error` → `error`
4. 单独的持久 `status=running` 只表示旧进程可能未正常收尾，不能证明当前 host 仍在运行，fallback 为
   `idle`。

这条优先级必须覆盖所有冲突方向，而不是只修 `running`：

| sessions-index activity | 旧 runtime / 持久缓存 | 手机展示 |
| --- | --- | --- |
| `prewarming` / `running` | `completed` / `failed` / `error` | `running` |
| `completedSuccess` / `completedInterrupted` | live / `failed` / `running` | `completed` |
| `error` | live / `completed` / `running` | `error` |
| 缺失或兼容 `draft` | 任意 | 保持现有 runtime → 持久终态 fallback |

因此 sessions-index 新帧既能把旧 `completed/error` cache 推进为 `running`，也能把旧 live cache 收口为
`completed/error`。手机首页不自行合并这些来源。

聚合边界：

1. `displayStatus` 由 desktop renderer 在构建 `WebRemoteControlTaskTarget` 快照时计算；
   `buildWebRemoteControlTaskTargets()` 先读取 task 行携带的 sessions-index activity，再按上述顺序
   fallback 到 Zustand task runtime state 和 `ZCodeTaskMeta.status`。
2. mobile 首页只消费 `WebRemoteControlTaskTarget.displayStatus`，不能直接读取 ZCode runtime、Repo、Service 或持久化实现。
3. 同步链路仍是 renderer `syncWebRemoteControlTasks()` -> desktop main -> relay -> mobile bootstrap/listWorkspaces，不新增 mobile 侧状态查询入口。
4. sessions-index activity 或兼容 task runtime state 变化都要触发重新构建并同步 task snapshot，避免
   `running` / `completed` / `error` pill 滞后到下一次 task list 刷新。
5. 该字段只用于手机首页展示，不改变 ZCode runtime 的真实状态来源。旧数据缺失时 mobile 前端 fallback 为 `idle`。

### 首页快照推送去重边界

Desktop main 只对 renderer 已构建的 `WebRemoteControlWorkspaceListResult` 做传输去重，不拥有或重新
解释 task 业务状态。去重签名必须覆盖手机首页需要即时采用、但只在生命周期节点或用户操作时变化的
字段：

1. task：`title`、`unreadAt`、`displayStatus`、`pinned`、`archived`、`remoteSessionId`；
2. workspace 连接状态：`kind`、`connectionState`、`remoteSessionId`、`lastConnectionError`；
3. task/workspace 的稳定身份字段继续参与签名，保证新增、删除和跨 workspace membership 变化可见。

字段按手机端展示语义归一化：缺失 `displayStatus` 等价于 `idle`，缺失 `connectionState` 等价于
`connected`，缺失可选字符串等价于空串，缺失布尔 membership 等价于 `false`。上述任一有效值变化都
必须发送新的 `workspace-list-updated`。

`updatedAt` 来自 sessions-index `lastActivityAt`，流式文本和工具事件期间会高频变化。本轮不把它加入
即时推送签名；如需实时刷新相对时间和时间排序，必须另行设计节流/合并策略，不能让每个流式事件推送
整份任务首页快照。

```text
低频展示/连接字段变化 ──> main 快照签名变化 ──> workspace-list-updated ──> 手机立即采用
高频 updatedAt 变化 ────> 本轮不触发整表即时推送（保留后续节流/合并边界）
```

### 状态投影影响边界

本次修复属于 presentation / state-source precedence，不改变会话 command、runtime、持久化或恢复协议。

```text
sessions-index phase (实时 activity) ───────────────┐
                                                     ├─> desktop renderer target projection
renderer runtime cache (仅 activity 缺失时 fallback) ┤       └─> relay payload ─> 手机状态 pill
tasks-index terminal status (最后 fallback) ─────────┘

desktop task list ── sessions-index continuous projection（保持原链路）
mobile /remote ───── renderer task snapshot + replayable delivery（只修正 payload 字段）
```

必须保持：

1. relay、desktop main 和 shared-host attachment 仍只透传，不持有 task/session 业务状态。
2. 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 的 snapshot/gap、owner、queue 语义不变。
3. tasks-index 继续拥有持久 row/membership；sessions-index activity 只拥有实时 phase。
4. `workspaceIdentity?.trim() || workspacePath`、`remoteSessionId` 和 pinned/archived membership 不受状态
   合并影响。
5. 手机的 running-first 排序继续消费最终 `displayStatus`，因此 stale cache 不再把终态行错误置顶或把
   真实运行行压回普通时间排序。

Focused 回归覆盖所有 phase 与冲突 cache 的组合；本次不新增 conversation E2E，因为没有新增交互、
command 或 delivery 行为，运行时 NDJSON 已证明 sessions-index 在错误窗口持续发布正确 phase，缺陷位于
纯 renderer target projection。

为了支持 pinned 分区，`WebRemoteControlTaskTarget` 增加可选字段：

```ts
pinned?: boolean;
```

字段来源：

1. Desktop renderer 在 `Root` 中分别通过 `useGlobalTaskList({ kind: "pinned" })` 和
   `useGlobalTaskList({ kind: "timeline" })` 读取任务。
2. `buildWebRemoteControlTaskTargets()` 对 pinned 查询结果标记 `pinned: true`，timeline 查询结果不标记。
3. Mobile 首页只消费该展示字段进行分区；不直接读取 task repo、sqlite、ZCode service 或 runtime。
4. `workspace_task_list_changed` 携带 task meta 的增量事件只表示标题、时间、状态等元数据变化，不表示
   pinned/archived 成员关系变化。前端缓存更新必须保留现有列表归属，避免状态刷新把置顶任务移出 pinned 分区。

## 状态与路由

第一版不需要引入真实 URL 路由，可以在 mobile shell 内部用 React state：

```text
currentMobilePage: "home" | "chat"
```

进入聊天：

1. 用户点击 task。
2. task 选择成功。
3. 设置 `currentMobilePage = "chat"`。
4. 如果当前 history state 不是 `{ zcodeMobilePage: "chat" }`，补一层 chat history state。

返回首页：

1. 点击 header 返回按钮。
2. 如果当前 history state 是 `{ zcodeMobilePage: "chat" }`，调用 `history.back()`，由 `popstate` 回到 home。
3. 如果当前没有 chat history state，直接设置 `currentMobilePage = "home"` 作为兜底。
4. 保留当前 active task 的选中态。

浏览器返回键：

1. mobile shell 初始进入 `home` 时不写 history，保留扫码入口原始历史栈。
2. 只有用户从 `home` 点击 task 并成功进入 `chat` 时，调用一次 `history.pushState({ zcodeMobilePage: "chat" }, "")`。
3. 如果当前已经是这层 `chat` state，不重复 push，避免同一个 task 多次点击堆叠历史。
4. `popstate` 命中 `{ zcodeMobilePage: "chat" }` 时设置 `currentMobilePage = "chat"`；从 chat 点返回按钮时用 `history.back()` 回到 home，而不是直接改 state。
5. `popstate` 回到非 `zcodeMobilePage` state 时设置 `currentMobilePage = "home"`，并放行浏览器后续默认返回行为。
6. 跨 workspace task 点击成功并重新挂载 Root 后，仍按“用户点击进入 chat”的规则补一层 `chat` state；这层 state 来自点击流程的一次性 `mobileNavigationIntent`，扫码初始 `initialTaskId` 不补这层 state。
7. mobile shell unmount 时移除 `popstate` listener。

不要把 workspace/task 状态塞进 URL，避免和扫码入口及配对态互相耦合。

## 样式规则

UI 必须遵守根目录 `DESIGN.md`：

1. 使用语义 token，例如 `bg-background`、`bg-card`、`border-card-border`、`text-foreground-subtle`。
2. card 使用 `rounded-lg`，不要使用过大的圆角。
3. 首页是业务工具界面，保持紧凑、清晰、可扫描，不做营销页。
4. 支持 light、dark、Zai light、Zai dark。
5. 支持中英文文案长度，不依赖固定英文短句。
6. 按钮使用现有 `Button` 组件和 lucide 图标。
7. 首页滚动、card 高度、task row 高度需要稳定，展开/收起不能造成不可控横向溢出。

## 日志

涉及交互问题时需要打日志辅助定位，不猜测状态。

UI 层统一使用：

```ts
import { logger } from "@/logger.js";
```

建议日志点：

1. 首页加载 workspace/task 快照失败：`error`。
2. 点击同 workspace task 后 mobile view state 更新失败：`error`。
3. 跨 workspace task 开始切换：`info`。
4. 跨 workspace task 切换失败：`error`。
5. 扫码初始态无法匹配 workspace/task：`warn`。

高频渲染和普通 hover 不打日志。

## 实现与回归测试

必须执行：

```bash
pnpm typecheck
pnpm lint
```

当前测试入口：

1. `packages/ui/test/webRemoteControlMobileTaskHome.test.ts`
   - workspace 按 desktop 返回顺序分组。
   - 默认展开 `activeWorkspaceKey`。
   - `activeTaskId` 对应 task 显示 selected。
   - 点击全部收起后所有 workspace card 收起。
2. `packages/ui/test/useWebRemoteControlTaskOpen.test.ts`
   - 同 workspace task 调用 `onSelectTask` 和 `updateMobileViewState`。
   - 跨 workspace task 调用 `switchWorkspace` 时带上 `{ taskId, mobileNavigationIntent: "chat" }`。
   - 切换失败时保留错误并清掉 switching 状态。
3. `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`
   - 手机远控断点渲染 mobile shell。
   - 非手机断点继续渲染现有 shell/sidebar。
   - 扫码初始 task 只展开首页 card 和选中 task row，不进入 chat。
   - 用户点击 task 进入 chat 时只补一层 history state，浏览器返回回到 home。
   - 跨 workspace 点击后重新挂载 Root 时消费一次性 `mobileNavigationIntent` 进入 chat，并在消费后清空。
4. `packages/shared/test/webRemoteControl.test.ts`
   - 如新增 `displayStatus`，补 schema/类型兼容测试。
5. `packages/ui/test/webRemoteControlTaskIndex.test.ts`
   - `buildWebRemoteControlTaskTargets()` 按 sessions-index activity → task runtime →
     `ZCodeTaskMeta.status` 的优先级计算 `displayStatus`。
   - 覆盖 live phase 与 stale runtime/persisted cache 在 running、completed、error 三个方向上的冲突。
   - activity 缺失或为兼容 `draft` 时保持原有 runtime/persisted fallback，持久 `running` 仍不得制造假
     running。
6. `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
   - 同一 task 只改变 `title`、`unreadAt`、`displayStatus`、`pinned`、`archived` 或
     `remoteSessionId` 时必须推送 `workspace-list-updated`。
   - 同一 workspace 只改变 `connectionState`、`remoteSessionId` 或 `lastConnectionError` 时必须推送；
     完全相同的有效字段快照仍应去重。
   - 单独改变高频 `updatedAt` 不属于本轮即时推送契约。

## 历史实施顺序

建议按以下顺序落地：

1. 抽出 `useWebRemoteControlTaskOpen`，保持现有 `WebRemoteControlTaskIndex` 行为不变。
2. 新增 mobile 首页组件，先用现有 task target 字段完成 workspace card 和 task row。
3. 新增 mobile shell，并在小屏远控模式下接入。
4. 调整扫码初始态：默认停留首页，只展开并选中对应 task。
5. 补充 `displayStatus` 字段和状态 pill。
6. 移除或旁路手机远控旧的 sidebar 顶部拖拽折叠逻辑。
7. 补测试，执行 `pnpm typecheck` 和 `pnpm lint`。
8. 更新 `docs/web-remote-control/web-remote-control-architecture.md` 中当前手机端 UI 描述。

## 风险点

1. 跨 workspace task 点击会重新创建 bridge，新 Root 首帧状态必须和 mobile shell 页面状态配合好，避免先闪首页再进聊天。
2. 扫码初始态仍需要打开 workspace bridge，否则聊天页无法复用现有服务；但 UI 不应自动跳聊天。
3. 远程 workspace 必须始终使用 `workspaceIdentity` 做 key，不能只用 `workspacePath`。
4. `WorkspaceShellLayout` 已有远控手机布局历史逻辑较多，接入 mobile shell 时要小心保留桌面远控行为。
5. 如果后续加入真实 URL 路由，需要避免把短期 `remoteControlToken` 和内部 task 页面状态混在一起。
