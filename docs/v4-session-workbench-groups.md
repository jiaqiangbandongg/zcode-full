# v4 Session Workbench Groups

状态：**已实现，2026-07-17 再次确认产品边界**。Task 列表向对话区边缘拖拽
仍是正式分屏入口，支持跨 workspace 组合和 renderer-local group 恢复；
2026-07-13 只下线 pane chrome 上的显式“向右拆分 / 向下拆分”按钮，不代表
workbench 整体退役。

## 功能摘要

| Field | Value |
| --- | --- |
| Change | 左侧 session 可拖入中间 v4 workbench，并按目标 pane 的上/下/左/右 drop zone 创建分屏；多个 session 组成可保留、可恢复的 workbench group（用户口径：“壳子”）。 |
| User-visible surfaces | 左侧 session 列表、v4 中间聊天 workbench、workspace header、Git branch 入口、pane chrome、drag preview。 |
| Existing docs | `docs/v4-split-pane-workbench.md`、`docs/v4-refactor/06-ui.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md`。 |
| Existing code owners | `packages/ui/src/v4/paneLayoutStore.ts`、`packages/ui/src/v4/paneLayoutTree.ts`、`packages/ui/src/v4/V4WorkspaceChatArea.tsx`、`packages/ui/src/v4/WorkbenchPane.tsx`、左侧 task/session item 相关组件。 |
| Out of scope | 手机 Web、`/remote` web-remote replayable（必须完全绕过 group 生命周期）、agent/protocol/schema 变更、main/relay 业务状态下沉、跨设备同步 group 状态。 |

## 产品语义

用户要的不是单次“在分屏打开”，而是 IDE editor group 心智：

```text
左侧 session 列表
   drag session C
       |
       v
中间当前 workbench group
+-------------------+-------------------+
| session A         | session B         |
|  top/left/right/  |  top/left/right/  |
|  bottom drop zone |  bottom drop zone |
+-------------------+-------------------+
       |
       v
drop 成功后 session C 被移入这个 group，并在目标 pane 的指定方向拆出新 pane。
```

group 是 renderer 侧的“壳子”：

```text
Group G1
+-----------+-----------+
| session A | session B |
+-----------+-----------+

Group G2
+-----------+
| session C |
+-----------+
```

左侧点击 session 时先查 `sessionId -> groupId`：

```text
点击 A -> activeGroupId = G1 -> focus A 所在 pane
点击 B -> activeGroupId = G1 -> focus B 所在 pane
点击 C -> activeGroupId = G2/隐式单 pane -> focus C
```

如果 session 不属于任何多 pane group，点击行为保持旧语义：按原来的 session 打开路径显示一个单 pane 视图。若之后把它拖入已有 group，它从原隐式单 pane 壳子迁移到目标 group。

## 澄清记录

| Round | Question | User answer | Boundary fixed | Follow-up needed |
| --- | --- | --- | --- | --- |
| 1 | 中心 drop 区域要替换当前 pane、聚焦已有 pane，还是不接受？ | 中心不接受 drop，只允许四向拆分。 | 只有上/下/左/右四个 drop zone；center 不显示可投放态。 | no |
| 2 | 是否支持跨 workspace session？ | 支持。 | drop 使用被拖 session 自己的 `workspacePath/workspaceIdentity/remoteSessionId`。 | no |
| 3 | 已在当前视图打开的 session 再拖一次怎么办？ | 不让拖；或拖了也不触发半透明区域。 | 同 group 已存在的 session 禁止重复加入；源头禁拖，drop target 再 guard。 | no |
| 4 | 四向 drop anchor 是目标 pane 还是整个 workbench？ | 是目标 pane。 | drop 到哪个 pane 的边缘，就相对哪个 pane split。 | no |
| 5 | pane 上限 4 的含义？ | 总 pane 数；满了不让分屏。 | 一个 group 最多 4 个 pane，可横向、田字或嵌套组合。 | no |
| 6 | drop preview 形态？ | 半透明区域演示。 | 使用目标 pane 对应半区的半透明预览，不用中心替换态。 | no |
| 7 | 启用端范围？ | 桌面能用，普通 Web App 也能用；手机和 web-remote 不要用。 | 启用 `desktop-continuous` 和普通 Web App v4；禁用 mobile 和 `/remote` web-remote replayable。 | no |
| 8 | 拖入跨 workspace session 后 header/sidebar 是否跟随？ | 根据 active session 变化。 | `focusedPaneId` 派生当前 active context；workspace header、branch、左侧高亮跟随 focused pane。 | no |
| 9 | “壳子”点击语义？ | A/B 在一个壳子里，点 A/B 显示这个壳子并 active 对应 session；未分屏 session 按旧逻辑新壳子打开。 | 引入 group 概念；session 点击先定位 group，再聚焦 pane。 | no |
| 10 | group 是否保留？ | 保留。 | 切到其他 session/group 后，原 group layout 保留，可点击任一成员恢复。 | no |
| 11 | 同一 session 是否只能属于一个 group？ | 是。 | `sessionId` 唯一归属一个 group；不能跨 group 重复打开。 | no |
| 12 | group 什么时候解散？ | 只剩 1 个 session 退化，0 个删除。 | group 的特殊身份只在 2+ session 时保留；关闭/移出后按成员数 GC。 | no |
| 13 | group 是否持久化？ | 可以，存在 renderer 层即可，比如 localStorage。 | renderer-local 持久化；刷新/重启恢复，不进 agent/protocol。 | no |
| 14 | 把未分组 C 拖入 G1 后原壳子如何处理？ | C 移入 G1，原隐式单 session 壳子消失。 | session move 是唯一归属迁移；旧隐式 group 不保留。 | no |
| 15 | subagent 行内“在右侧打开”是否会替换主 session？ | 不替换；详情属于 workspace 右侧 tab。 | child 不再创建 workbench group/pane；按 parent session 显隐，完整语义见 `subagent-session-side-tabs.md`。 | no |
| 16 | 侧开的 subagent child 是否能继续输入？ | 不能；它是只读观察视图。 | subagent split 产生的 child binding 标记 `readOnly`，pane 不渲染 composer/input，也不提供新 prompt 入口。 | no |
| 17 | 当前中心是草稿态时能否拖 session 进来分屏？ | 能。 | draft 不是 session，不建 workbench group；drop 后保持 primary draft，拖入 session 进入非 primary pane。 | no |
| 18 | 只读 subagent child 聚焦时是否同步左侧 active task？ | 不同步。 | readOnly pane 只有 workbench 本地 focus；shell active task、左侧高亮、task list optimistic active 不切到 child session。 | no |
| 19 | 关闭当前 focused pane 后外层 active task 留谁？ | 留关闭后 workbench 的可导航 focused session。 | 2-pane 关闭 child 后退回 primary/main；关闭非 focused pane 不改 shell active。 | no |
| 20 | `Cmd/Ctrl+N` 在分屏里创建哪里的新任务？ | 当前 focused pane 的 workspace。 | subagent 已不进入 workbench；普通 focused pane 只取 `workspaceScope`，创建该 workspace 的草稿态 session。 | no |
| 21 | `Cmd/Ctrl+N` 是否在当前分屏内再 split 一个草稿？ | 不。 | 创建后退出当前 active workbench group，pane layout 回到单 primary panel；历史 group 保留，之后点成员可恢复。 | no |
| 22 | 删除 group 的 primary session 后显示谁？ | 回当前 workspace 草稿。 | CLI 接受删除后解散 group，并清空 shell 的已删除 session；不隐式提升 secondary。 | no |
| 23 | `/remote` 只隐藏 group UI 是否足够？ | 不够。 | remote renderer 不得恢复、创建、持久化或消费 group；侧栏与新建任务都绕过 group store。 | no |
| 24 | 2026-07-13 是关闭整个分屏，还是只关闭显式按钮？ | 只关闭显式按钮；Task 列表仍可拖到对话区分屏。 | pane chrome 不渲染拆分按钮；拖拽 drop zone、group 状态和跨 workspace 隔离仍是正式合同。 | no |
| 25 | 草稿 A 旁拖入已有任务 B 后，A 首发应该如何升级？ | A 原地绑定首发创建的新 session；focus B 后 A 仍保留。 | `createSession` accepted 时先把 primary draft 绑定为 A′ 并原子提升整个布局为 group，再同步 shell active；后续 pane focus 只能改变 active context，不能让 A′ 回退成 draft。 | no |
| 26 | 右键目标 session 已经在另一个 workbench group 时，是重复分屏还是切换？ | 切换。 | 「在分屏打开」先按 `workspaceKey + sessionId` 查已有 pane/group；命中其他 group 时激活并 focus 已有 pane，不创建副本。 | no |
| 27 | 草稿 primary 旁已通过右键打开 B，随后普通点击未分组 C，应退出分屏还是替换某个 pane？ | 保留分屏，C 替换当前 focused 的 B，结果为 `[draft A | C]`。 | 普通 session 点击在 draft 临时布局中只重绑 focused non-primary pane；primary draft 不参与替换。 | no |

## 边界决策

| Boundary | Decision | Includes | Excludes / prunes | Source |
| --- | --- | --- | --- | --- |
| Drop target | 只接受四向边缘区。 | top/right/bottom/left half preview and split。 | center replace、center focus、drop-to-nowhere。 | user |
| Anchor | 相对鼠标所在 pane split。 | 在目标 pane 上/下/左/右插入新 pane。 | 整个 workbench 最外层固定插入。 | user |
| Cross workspace | 支持。 | 本地、SSH/WSL/Docker，只要 session meta 带完整 scope。 | 用当前 shell workspace 覆盖被拖 session scope。 | user + `docs/v4-split-pane-workbench.md` |
| Duplicate session | 一个 session 只能属于一个 group。 | 已在 group 内时源头禁拖；drop guard 不显示 preview。 | 同 session 多副本视图。 | user |
| Group lifetime | 2+ session 形成 group；1 个退化；0 个删除。 | 点击任一成员可恢复 group。 | 保留空 group、保留只有 1 个成员的特殊 group。 | user |
| Pane limit | 每个 group 最多 4 pane。 | 横向 4、田字 4、嵌套 4 都允许。 | 超过 4 继续分屏。 | user + current `MAX_WORKBENCH_PANES` |
| Active context | focused pane 派生 header/sidebar。 | Workspace header、branch、sidebar 高亮跟随 focused session。 | drop 后只改 pane 不改 active context；或直接切 shell tab 破坏 group。 | user |
| Subagent split entry | 只在当前 pane 旁边打开 child。 | child session 进入侧边 pane；primary pane 继续显示 parent session；child pane 是只读观察视图。 | 复用旧全局 split open，导致 child focus 后把 shell active session 反灌成 primary；或把 child 当普通会话显示 input。 | user |
| Draft drop entry | 草稿 pane 也接受四向拖拽分屏。 | primary 保持 draft；拖入 session 进入 `paneLayoutStore` 的非 primary pane；之后 draft 首发仍原地绑定。 | 因 `sessionId === null` 禁止 preview/drop；或强行建 group 要求 draft 有 sessionId。 | user |
| Drop preview layering | 半透明预览覆盖整个目标 pane。 | preview 层级高于 composer dock/input 与 pane 内容。 | 被 composer/input 的 sticky `z-20` 遮住底部。 | user |
| Pane focus vs shell active | readOnly pane focus 不等于 shell active task。 | 普通 pane focus/关闭会同步 shell active；readOnly child focus 只改变 workbench focus。 | child session 出现在左侧列表高亮或 optimistic task active。 | user |
| Close focus repair | 关闭 focused pane 后同步剩余可导航 session。 | focused child 关闭后回 primary/main；3+ pane 时按关闭后 workbench focus 同步。 | 关闭非 focused pane 时强行切 active。 | user |
| New task shortcut | `Cmd/Ctrl+N` 创建 focused pane workspace 的单 panel 草稿。 | 桌面菜单 `NewTask`、普通 Web `Cmd/Ctrl+N`、顶部按钮复用 Root 创建任务入口；目标 workspace 来自 workbench focused pane，含 readOnly child。 | 在当前 group/paneLayout 中 split draft；只按 shell active tab workspace 创建。 | user |
| Persistence | renderer-local localStorage。 | group layout、pane binding、focused pane、session-to-group 映射。 | agent/runtime/main/relay 持久化、跨设备同步。 | user |
| Client modes | 桌面和普通 Web App 启用。 | `desktop-continuous`、普通 web v4。 | 手机、小屏、`/remote` web-remote replayable。 | user |
| Explicit split buttons | pane chrome 拆分按钮下线。 | Task 列表 drag session 到对话区边缘。 | pane chrome 的“向右拆分 / 向下拆分”按钮。 | user |
| Primary draft promotion | draft + existing session 的临时布局在 draft 首发时原子升级。 | primary draft 的新 session binding、secondary bindings、root/focus 一次转移到 group；shell active 随新 session 更新。 | 只更新 shell `activeTaskId` 而让 primary 继续依赖它；focus secondary 后把已发送 primary 重置为 draft。 | user |
| Context-menu split parity | 左侧右键「在分屏打开」与拖拽共用 pane/group owner。 | 单 session 创建 group；已有 group 追加 pane；draft 使用临时 paneLayout；其他 group 的既有 session 只切换/focus。 | 菜单直接无条件写全局 paneLayout；重复打开同一 session；已有 group 时创建第二份视图。 | user |
| Current-session guard | 当前 focused pane 已显示目标 session 时菜单项禁用。 | 普通单 pane、group focused pane、draft 临时布局的 focused secondary pane。 | 仅以 shell `activeTaskId` 判断，漏掉 group/pane local focus。 | user |
| Draft focused replacement | draft 临时布局内普通点击未分组 session 时原位替换 focused secondary binding。 | `[draft A | B] --click C--> [draft A | C]`，workspace scope 与 sessionId 一起替换。 | 把 shell `activeTaskId=C` 直接灌给 primary；替换 draft；无意新增第三 pane。 | user |

## 状态模型

在现有 pane layout 的基础上增加 renderer-local group store。核心不是把 protocol 改成 group，而是在 UI 层维护“session 属于哪个可恢复 workbench group”。

```text
WorkbenchGroupState
  activeGroupId: string | null
  groups: Record<groupId, WorkbenchGroup>
  sessionIndex: Record<sessionKey, { groupId, paneId }>

WorkbenchGroup
  id: string
  root: PaneLayoutNode
  panes: Record<paneId, PaneBinding>
  focusedPaneId: string
  updatedAt: number

PaneBinding
  workspaceScope: {
    workspacePath: string
    workspaceIdentity?: string
    remoteSessionId?: string
  }
  sessionId: string
  readOnly?: boolean  // subagent 行内侧开的 child session：只读，不渲染 composer/input
```

`sessionKey` 必须包含 workspace identity 边界：

```text
sessionKey = `${workspaceIdentity?.trim() || workspacePath}::${sessionId}`
```

`workspacePath` 继续用于路径展示和执行；身份/隔离语义统一使用 `workspaceIdentity?.trim() || workspacePath`。

### 单 session 与 group 的关系

普通未分屏 session 不需要提前写入 group store。点击未分组 session 时可按旧逻辑显示单 pane。只有以下动作会创建/保留 group：

- 拖一个未分组 session 到另一个 session/pane 旁边，形成 2 pane group。
- 在已有 group 中继续拖入新的未分组 session，形成 3/4 pane group。
- 恢复 localStorage 中 2+ 有效成员的 group。

当 group 只剩 1 个有效成员时：

```text
remove group
remove remaining session from sessionIndex
下次点击该 session 按普通单 pane 逻辑打开
```

## 事件顺序

### 左侧点击 session

```text
User click sidebar session
        |
        v
build sessionKey(workspaceIdentity?.trim() || workspacePath, sessionId)
        |
        +-- sessionIndex 命中 group
        |       |
        |       v
        |   activeGroupId = groupId
        |   focusedPaneId = indexed paneId
        |   active context = focused pane binding
        |
        +-- 未命中
                |
                v
            旧逻辑：打开单 session 视图
```

draft 临时布局是上述“旧逻辑”的一个显式例外：它没有可写入 group index 的 draft
sessionId，但仍必须保留 editor-group 的 focused pane 语义。

```text
paneLayout = [draft A | B]，focused=B
        |
        | 普通点击未分组 C
        v
原子替换 pane B 的完整 binding（workspaceScope + sessionId）
        |
        v
paneLayout = [draft A | C]，focused=C

禁止路径：shell.activeTaskId=C -> primary 读取 C -> [C | B]
```

### 右键「在分屏打开」

```text
drag / context-menu / sidebar-select target T
        |
        v
workbenchSessionPlacement resolver（只决策，不写 store）
        |
        +-- T == 当前 focused session -> disabled / no-op
        +-- T 已在其他 group/pane ------> context focus existing；drag reject duplicate
        +-- 当前是普通 session A ------> create / extend group
        +-- 当前 primary 是 draft -----> split temporary paneLayout
        `-- draft split 普通点击 -------> replace focused secondary
        |
        v
executor：先提交 pane/group owner，再同步 shell active
```

### 拖入分屏

```text
dragstart sidebar session
        |
        +-- session 已在任何 group -> draggable=false / no payload
        +-- pane count full in current target group -> payload 可存在但 target 不显示 preview
        v
dragover target pane
        |
        +-- client 不支持 -> ignore
        +-- target group full -> ignore
        +-- dragged session 已在 target/current group -> ignore
        +-- pointer in center -> ignore
        +-- pointer in edge zone -> show preview
        v
drop
        |
        v
split target pane by direction
bind new pane to dragged session workspaceScope + sessionId
sessionIndex[sessionKey] = { groupId, paneId }
activeGroupId = groupId
focusedPaneId = newPaneId
persist localStorage
```

### 关闭 pane / 删除 session 后恢复

```text
close pane or restore guard removes missing session
        |
        v
remove pane binding + sessionIndex entry
        |
        +-- group pane count >= 2 -> keep group
        +-- group pane count == 1 -> collapse to ordinary single session, delete group
        +-- group pane count == 0 -> delete group
```

删除 primary 是独立的会话生命周期事件：group store 的 GC 与 shell session 导航必须原子收口。

```text
delete primary A accepted
        |
        +-- remove group/session index
        `-- shell.onSessionDeleted -> activeTaskId/sessionId = null -> workspace draft
```

`web-remote-replayable` 不只是隐藏 split affordance。remote shell 启用期间，所有 sidebar/new-task
入口必须绕过 group context，renderer 不读取或写入 `workbench-groups:v1`；旧残留状态也不能成为
workspace target。

### paneLayout → group 唯一所有权

```text
draft / ungrouped split: paneLayout:v2 owns root
        |
        | secondary pane binds a normal session and promotion succeeds
        v
session group: workbench-groups:v1 owns root
        |
        +-- consume/reset paneLayout source to single primary
        +-- divider ratio writes group.root
        `-- group GC falls back to the consumed single primary
```

promotion 不是复制布局后保留双写。成功后旧 paneLayout split 必须被消费；否则 divider 会把 ratio 写到不可见 owner，group close 后旧 secondary pane 还会复活。workspace scope/binding 在 ratio 更新中原样保留，隔离 key 仍为 `workspaceIdentity?.trim() || workspacePath`。

### subagent 详情迁移边界

```text
User click "在右侧打开" on subagent child
        |
        v
row context provides parentSessionId + childSessionId + subagentType
        |
        v
open/reuse workspace side tab keyed by workspace + parent + child
        |
        +-- workbench group/pane count unchanged
        +-- child tab is full readOnly SessionPane
        v
activate child tab, but shell active task remains parent
        |
        v
all open child tabs keep live leases; parent switch only filters tab triggers
```

这个入口不再进入 `paneLayoutStore` 或 workbench group。恢复历史 localStorage 时包含
`readOnly` child binding 的旧 group 会被丢弃；普通 session group 保持原恢复语义。
同时，child pane 不能当作普通可输入 session：subagent 的 child session 由父会话编排产生，
行内侧开只是查看它的执行过程和结果，不应该允许用户在 child pane 继续输入新 prompt。

## UI 设计约束

- Drag preview 是目标 pane 的对应半区覆盖层，使用 design token：
  - 背景：brand/accent 的低透明度表达；
  - 边框：brand 或 focused border；
  - 不写死蓝色，兼容 light/dark/Zai 主题。
- 多 pane 时，非 focused pane 使用弱遮罩表达“非 active”状态：
  - 遮罩使用 background token 的低透明度混合，不直接降低 pane 内容 opacity，避免文字、代码块、图片一起变淡；
  - 遮罩 `pointer-events: none`，点击/聚焦仍由 pane shell 接收；
  - drop preview 层级必须高于非 active 遮罩，拖拽演示不能被遮住；
  - 单 pane 不显示遮罩，避免草稿/普通单会话出现无意义的暗化。
- Center 区域不显示 preview，也不触发 drop。
- 已属于任何 group 的 session item 不显示可拖 affordance；若浏览器仍触发 dragover，workbench 不显示 preview。
- 达到 4 pane 时，不显示 drop preview，不触发 split。
- Header 和左侧高亮跟随 focused pane 的 active context：

```text
focused pane binding
        |
        +--> workspace header path/remote label
        +--> Git branch switcher workspacePath
        +--> sidebar workspace/session highlight
        +--> focused pane command routing
```

- 跨 workspace pane 的 branch/status 不得复用 shell 当前 workspace 的 Git summary。若目标 workspace 的 Git summary 尚未加载，可先显示 workspace badge/path，branch 入口按该 workspace 独立加载或降级为空态。
- 手机和 `/remote` web-remote 不启用拖拽分屏；对应入口不显示，drop target 不注册。

## Domain Scope

| Domain | Include? | Why it can change behavior | Primary sources |
| --- | --- | --- | --- |
| UI shell/theme/locale/responsive | yes | drag affordance、drop preview、header/sidebar active context 都是 UI shell 行为。 | `DESIGN.md`、`packages/ui/src/v4/*` |
| Conversation/session behavior | yes | session 点击、focus、pane command routing 影响当前 active session。 | `docs/conversation-protocol-declaration.md`、`packages/ui/src/v4/SessionPane.tsx` |
| Workspace identity/remote runtime | yes | 跨 workspace group 必须保持 `workspaceIdentity` 隔离和 remote session scope。 | `docs/v4-split-pane-workbench.md`、`docs/remote-workspace-session-unified-settings.md` |
| Persistence/index/snapshot | yes | group layout localStorage 恢复、删除/归档后清理。 | `packages/ui/src/v4/paneLayoutPersistence.ts` |
| Mobile remote/replayable realtime | limited | 仅用于明确禁用 `/remote`，避免 replayable 语义扩散。 | `docs/web-remote-control/web-remote-control-architecture.md` |
| Protocol/agent runtime | no | group 是 renderer-local UI 状态，不改 v4 protocol。 | `docs/v4-split-pane-workbench.md` |

## High-Risk Cross-Products

| Cross-product | Candidate risk | Initial handling |
| --- | --- | --- |
| focused pane x header/sidebar active context | Header 显示 A，但命令/高亮仍指向 B。 | active context 必须从 focused pane binding 单源派生。 |
| cross workspace x Git branch switcher | 非当前 shell workspace pane 复用错误 Git summary。 | branch/status 读取必须按 focused pane workspace scope。 |
| group persistence x deleted/archived session | localStorage 恢复出已不存在 session。 | 恢复后按 sessions-index 验证；无效成员移除并 GC group。 |
| duplicate session x drag preview | 已打开 session 还能看到可投放蓝区。 | drag source 和 drop target 双 guard。 |
| desktop/web x web-remote replayable | 把 group 状态误下沉到 replayable remote 链路。 | client gate：普通 desktop/web only；remote/mobile disabled。 |
| pane limit x dragover | 满 4 后仍预览但 drop 失败。 | 满 4 时不显示 preview，不接受 drop。 |
| context menu x current/group ownership | 当前 session 仍可点，或已在其他 group 的 session 被重复创建。 | focused target 禁用；其他 owner 命中时只激活/focus。 |
| draft paneLayout x sidebar navigation | 普通点击 C 通过 shell session 单值覆盖 primary draft。 | 先原子重绑 focused secondary，再提交 shell 导航；primary draft 始终无 session binding。 |

## Candidate Combinations

| Candidate ID | State | Event | Target/surface | Expected guard/effect | Initial status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| SWG-01 | 单 pane session A，session B 未分组 | 拖 B 到 A 右侧 | desktop/web workbench | 创建 G1，A/B 左右分屏，focus B。 | accepted | 基础路径。 |
| SWG-02 | G1 已有 A/B | 左侧点击 A | sidebar | 显示 G1，focus A，header/sidebar 跟随 A。 | accepted | group 恢复语义。 |
| SWG-03 | G1 已有 A/B，C 未分组 | 拖 C 到 B 下方 | pane B bottom zone | C 移入 G1，B 下方 split，原隐式 C 壳子消失。 | accepted | 唯一归属迁移。 |
| SWG-04 | G1 已有 A/B | 拖 A 进入 workbench | sidebar/workbench | 源头不可拖；若 dragover 发生，不显示 preview。 | accepted | duplicate guard。 |
| SWG-05 | G1 已有 4 pane | 拖 E 进入任意 pane | workbench | 不显示 preview，不触发 split。 | accepted | pane limit。 |
| SWG-06 | pointer 在目标 pane center | dragover | workbench | 不显示 preview，不触发 drop。 | accepted | center disabled。 |
| SWG-07 | G1 A/B 跨 workspace | focus B | header/sidebar | Header 和 left highlight 显示 B 的 workspace/session。 | accepted | active context 派生。 |
| SWG-08 | web-remote/mobile | 拖 session | remote shell | 无 drag split affordance，drop target 不注册。 | pruned | 明确禁用。 |
| SWG-09 | localStorage 恢复 G1，但 B 已删除 | restore | renderer boot | 移除 B；只剩 A 则 group 退化删除。 | accepted | restore guard。 |
| SWG-10 | session A 的 foreground subagent child B 已生成 | 点击 Agent 展开区 `Prompt` 标题旁的“在右侧打开” | Agent 工具块 | 不创建 workbench group；workspace 右侧激活 B 的完整只读 tab，A 仍为主 session。 | migrated-to-SAT | 现行语义见 `subagent-session-side-tabs.md` 与 SAT01-SAT10。 |
| SWG-11 | primary pane 是草稿态，session B 未分组 | 拖 B 到草稿 pane 右侧 | workbench draft pane | 显示完整右半区 preview；drop 后 primary 仍是 draft，B 在右侧 pane；不创建 group。 | accepted | draft 不是 session，走 paneLayoutStore。 |
| SWG-12 | 历史状态含 readOnly subagent child B pane | renderer restore | workbench migration | 丢弃旧 readOnly group；B 只能从父 Agent 行重新打开为右侧 tab。 | migrated-to-SAT | 普通 session group 不受影响。 |
| SWG-13 | session A primary + session/subagent B focused pane；若 draft split 已 promote，paneLayout source 已消费 | 关闭 B pane | workbench close | workbench 退回 A；shell activeTaskId/sidebar highlight 同步回 A；group GC 后不得从 shadow paneLayout 复活 B。 | accepted | close 后不能保留已关闭 session；visible layout 同时只有一个 owner。 |
| SWG-14 | workspace A 的 main session + 历史 workspace B readOnly subagent pane | renderer restore | migration | 旧 readOnly subagent group 不恢复，不再参与 `Cmd/Ctrl+N` focused pane 路由。 | migrated-to-SAT | 新 subagent 右侧 tab 不改变 shell active workspace/task。 |
| SWG-15 | 当前 focused pane 已显示 session A | 右键 A | sidebar context menu | 「在分屏打开」保持可见但 disabled；不写 paneLayout/group/shell。 | accepted | current guard 必须按 focused owner 判定。 |
| SWG-16 | session B 已属于非当前 G2 | 在当前单 pane/G1 中右键 B | sidebar context menu | 激活 G2 并 focus B 的既有 pane；pane 数与唯一 membership 不变。 | accepted | 用户确认“切换”。 |
| SWG-17 | primary 是 draft A，B 未分组 | 右键 B 选择「在分屏打开」 | sidebar context menu | 与拖拽相同形成 `[draft A | B]` 临时 paneLayout，focus B；不创建真实 session 或重复 group。 | accepted | 菜单与拖拽共用 owner/action。 |
| SWG-18 | 临时布局 `[draft A | B]` 且 focus B，C 未分组 | 普通点击 C | sidebar | 原位替换 focused secondary 的完整 binding，得到 `[draft A | C]`；pane 数不变，draft A 不被 shell session 覆盖。 | accepted | 本轮 bug-candidate。 |

## Accepted Cases

| Case ID | Setup | Action | Assertions | Evidence layers | E2E status |
| --- | --- | --- | --- | --- | --- |
| SWG-E2E-01 | 普通 desktop/web，A 当前单 pane，B 未分组。 | 从 sidebar 拖 B 到 A right zone。 | 出现右半区 preview；drop 后 A/B 两 pane；focus B；localStorage 有 G1。 | UI + localStorage + v4 pane testids | planned |
| SWG-E2E-02 | G1 A/B 已存在。 | 左侧点击 A，再点击 B。 | 中间不重建 group；focused pane 切换；header/sidebar 跟随对应 session。 | UI + store probe | planned |
| SWG-E2E-03 | G1 A/B，C 未分组。 | 拖 C 到 B bottom zone。 | 目标是 pane B 下方；G1 三 pane；C 从未分组变为 G1 成员。 | UI + localStorage | planned |
| SWG-E2E-04 | G1 A/B。 | 尝试拖 A。 | A item 不可拖或 dragover 不显示 preview；pane 数不变。 | UI | planned |
| SWG-E2E-05 | G1 四 pane。 | 拖 E 到任意 pane。 | 不显示 preview；drop no-op。 | UI + store | planned |
| SWG-E2E-06 | G1 A/B persisted。 | reload renderer 后点击 A/B。 | G1 可恢复；focus 对应 pane。 | UI + localStorage restore + sessions-index guard | planned |
| SWG-E2E-07 | mobile 或 `/remote` shell。 | 查看 session list/workbench。 | 无拖拽分屏入口；现有点击行为不变。 | UI | planned |
| SWG-E2E-08 | session A timeline 展开 subagent child B。 | 点击“在右侧打开”。 | 不增加 workbench pane；右侧 child tab 完整只读，左侧 active task 仍为 A。 | UI + store probe | migrated-to-SAT |
| SWG-E2E-09 | primary pane 是新会话草稿。 | 拖 session B 到草稿 pane edge zone。 | 预览不被 input 遮挡；drop 后草稿+B 两 pane；workbench group 仍为空。 | UI + store probe | planned |
| SWG-E2E-10 | session A 右侧打开 subagent child B。 | 激活、关闭 B tab。 | 左侧始终高亮 A；关闭只释放 child tab/lease，不改变主区。 | UI + store probe | migrated-to-SAT |
| SWG-E2E-11 | workspace B 有隐藏的 subagent child tab。 | `Cmd/Ctrl+N` / New task menu。 | 快捷键仍按 shell/workbench focused 普通 pane 路由，隐藏 child tab 不成为任务创建目标。 | UI + store probe | migrated-to-SAT |
| SWG-E2E-12 | 当前单 pane/group focused session A。 | 右键 A。 | 「在分屏打开」disabled；pane/group snapshot 保持原引用。 | UI + store probe | planned |
| SWG-E2E-13 | B 已在其他 group G2。 | 在当前视图右键 B 并选择「在分屏打开」。 | 直接恢复 G2、focus B；没有新增 pane/session membership。 | UI + localStorage + store probe | planned |
| SWG-E2E-14 | primary draft A；B/C 都是同 workspace 未分组 session。 | 右键 B 在分屏打开，再普通点击 C。 | 先得到 `[draft A | B]`，再得到 `[draft A | C]`；pane 数始终 2；primary sessionId 始终为 draft。 | UI + paneLayout store + v4 pane testids + UI debug log | planned |

## 实施建议

推荐方案 B：新增 `workbenchGroupStore`，不要把 group 概念塞进现有单个 `paneLayoutStore`。

```text
packages/ui/src/v4/workbenchGroupStore.ts
  - activeGroupId
  - groups
  - sessionIndex
  - openSessionFromSidebar(scope, sessionId)
  - splitSessionIntoGroup(targetPaneId, direction, draggedSession)
  - closePane(groupId, paneId)
  - focusPane(groupId, paneId)
  - restore/persist localStorage
```

现有 `paneLayoutTree.ts` 的纯函数可以复用：二叉分割树、`splitPaneAt`、`closePane`、`setSplitNodeRatio`、`effectiveFocusedPaneId` 等仍然成立。实现时要把“一个全局 layout”提升为“每个 group 一份 layout”。

拖拽 payload 只带 UI 所需最小事实：

```ts
type DraggedSessionPayload = {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
};
```

drop target 必须重新从 store 校验 payload，不能信任 drag source：

- session 是否已经属于任何 group；
- target group 是否存在且未满；
- client mode 是否允许；
- pointer 是否落在 edge zone；
- workspace scope 是否完整。

## Matrix Backfill

| File | Change |
| --- | --- |
| `docs/conversation-session-case-catalog.md` | 增加 session workbench group / drag split 的产品 case 条目。 |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | 增加 SWG-E2E-01 至 SWG-E2E-07，初始标记 planned。 |
| `docs/v4-split-pane-workbench.md` | 实现阶段需要把“单 workbench layout”现状更新为 group-aware workbench，并指向本文。 |

## E2E Handoff Notes

- Provider fixture: 复用 v4 conversation fixture；不需要 provider 特殊响应。
- File-system fixture: 至少两个 workspace，覆盖 local + remote identity 的代表用例；远程真机回归可后补。
- Timing strategy: dragover preview 用 Playwright mouse move + data-testid 断言；drop 后等待 pane testid 和 focused state。
- Docker preset: 非必须；remote workspace 覆盖可走现有 SSH/WSL/Docker 专项。
- Review risks:
  - Header/sidebar active context 不能通过修改全局 `activeTabId` 粗暴实现，否则会破坏 group 保留语义。
  - 普通 Web App 可用，但 `/remote` 和 mobile 禁用；client gate 要可测试。
  - localStorage 恢复必须容忍 session 删除、workspace 断连、schema 损坏。
