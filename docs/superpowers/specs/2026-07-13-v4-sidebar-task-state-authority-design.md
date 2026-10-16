# V4 左侧任务状态权威收敛设计

## 目标

修复 V4 左侧任务列表的状态不同步，并防止修复状态后重新引入“打开历史任务就跳到顶部”的排序回归：

- 打开任务后未读蓝点立即清除，并与 tasks-index 最终一致；
- 后台会话进入 `prewarming/running` 时显示转圈，进入 `error` 时显示错误状态；
- permission 与 userInput 阻塞请求在侧栏显示轻量 attention 标签；
- 标题、未读、pin/archive、打开/resume、snapshot replay 不得伪造会话活动时间；
- 重启后从非当前 workspace 点击“新建对话”时，显式草稿意图优先于该 workspace 的 last-session/group/pane 恢复；
- desktop `desktop-continuous` 与 mobile `web-remote-replayable` 从同一字段权威恢复终态，同时保持各自 delivery 边界。

这不是移除 Zustand。Zustand 继续承载 `activeTaskId`、导航历史、草稿和 renderer-local UI；本次只移除侧栏业务事实对旧 `taskRuntimeByTaskId`、`taskUiByTaskId`、`taskUnreadByTaskId`、`taskListCache` 的读取依赖。

## 根因与性质

这是一次设计遗漏叠加实现 bug：

1. V4 sessions-index 已替换旧 runtime monitor，但 `TaskListItem` 仍从旧 Zustand runtime map 读取 running，因此实时 `SessionSummary.phase` 到达列表后也不会转圈。
2. `useWorkspaceTaskNavigation` 清未读仍先查旧 `taskListCache`/optimistic cache；当前任务实际在 task query cache，导致已点开但判断不到 `unreadAt`。
3. active pane 从 `ConversationSnapshot.pendingInteractions` 渲染阻塞卡片，侧栏仍读旧 `taskUiByTaskId`；`SessionSummary` 又没有轻量 attention 字段，权限和用户输入请求无法同步。
4. `mapSessionSummaryToTaskMeta` 把实时 `phase/lastActivityAt` 填入持久化语义的 `status/updatedAt`，而 query cache 的 whole-meta merge 使用“较新 updatedAt 获胜”。tasks-index mutation 因此可以篡改列表排序，旧 optimistic `unreadAt` 也可以压住权威清除结果。
5. V4 `usePaneSessionPersistence` 把 `activeTaskId=null` 同时解释成“冷启动尚未恢复”和“用户明确进入新草稿”。当用户从 workspace A 点击非当前 workspace B 的“新建对话”时，B 先执行 `startDraft`，随后首次挂载的恢复 effect 仍会读取 `zcode-v4-last-session` 并选择旧 task。workspace 行入口还绕过了全局新建已有的 `deactivateActiveGroup + resetToPrimaryPane`，导致 last-session、group primary binding 和 pane layout 都可能覆盖新建意图。

现有“配置/打开任务不 bump activity”的修复是正确的；本设计保留该修复，并进一步禁止 membership/meta mutation 进入 activity 排序字段。

## 已确认的产品边界

1. 新产生的 permission/userInput 请求属于用户可感活动，可以更新 `lastActivityAt`；refresh、resume、replay 同一 pending request 不更新时间。
2. Project / Timeline 使用两层排序：`prewarming/running` 任务先形成置顶运行层，运行层内部固定按 `createdAt` 倒序；非运行层才按用户选择的 `Created` / `Updated` 规则排序。运行中的 `lastActivityAt` 仍可更新展示和活动事实，但不能参与运行层内部排序，避免两个并发 task 因流式事件交替而来回换位。清未读、改标题、pin/archive 等 tasks-index mutation 不改变顺序；grouped view 继续只认显式 `sort_order`。
3. 选择任务立即乐观清除蓝点；持久化失败时撤销 overlay 并重新拉取，蓝点可以回来，不能让 UI 长期撒谎。
4. 主 leading icon 优先级为 `error > unread > running > none`。permission/userInput 使用独立 attention 标签，可与 leading icon 共存。
5. 转圈只认当前 sessions-index snapshot/实时投影的 `prewarming/running`；tasks-index 历史 `status=running` 不能单独触发转圈。
6. 桌面完整验证 continuous 交互闭环；手机验证 replayable snapshot/gap 后的字段一致性，不与分屏、queue、subagent 做全排列。
7. 用户显式点击“新建对话”的意图优先于本地恢复。冷启动且 `draftFocusVersion=0` 时允许恢复 last session；`startDraft` 已递增版本时必须保留 draft、清除对应 last-session，并退出 desktop workbench group / 重置 primary pane。普通 workspace 激活（未点击新建）仍可恢复上次 task。
8. 普通后台 task 在 turn 终态时可产生未读；存在 Goal 时，只有权威投影进入 `verified`
   才是完成提醒边界。`notSatisfied`、自动 continuation、Stop/取消和未通过的 verifier 都不产生完成未读；
   真实 error 仍作为失败提醒产生未读。
9. workspace 收起时聚合其普通（非 pinned、非 archived）task 的未读状态；展开只把蓝点还原到
   具体 task 行，不等于已读。聚合必须在分页裁剪前计算，不得漏掉当前未渲染的隐藏 task。

## 状态所有权

```text
CLI conversation projection
  └─ sessions-index/<workspaceKey>
       ├─ phase --------------------------┐
       ├─ lastActivityAt (唯一排序权威) --┤
       ├─ hasBackgroundWork --------------┤
       └─ pendingInteractionSummary -------┤
                                           v
tasks-index.sqlite ----------------> TaskListRowState ------> TaskListItem
  ├─ pinned / archived / group             ^
  └─ unreadAt ------------------------------┤
                                           │
renderer field overlay --------------------┘
  └─ 仅覆盖正在提交的 owned field，不覆盖整行

Zustand（继续保留）
  ├─ activeTaskId / navigation / draft / local UI
  └─ draftFocusVersion（显式新建意图代次）

localStorage layout persistence
  ├─ last-session（仅冷启动、无显式 draft intent 时恢复）
  └─ workbench group / pane layout（显式新建时退出/重置）
```

### 行存在权威补充（2026-07-20）

上图只裁决字段 owner，不允许把 `sessions-index` 扩张为持久 task 行全集。Project、Timeline、Pinned、
Archived 与 Grouped 的持久行集合统一由 tasks-index 决定，sessions-index 只覆盖命中的 activity/detail
字段；summary 暂缺时保留静态 task 行。新建未落库窗口继续使用 renderer optimistic overlay，落库后由
task row 接管。完整边界和用例见
`docs/superpowers/specs/2026-07-20-sidebar-task-row-authority-design.md`。

身份 key 始终使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；文件路径展示和服务调用中的执行路径继续使用 `workspacePath`。远程服务选择还必须保留 `remoteSessionId`，不能只按路径命中。

## 数据合同

### Activity 摘要

sessions-index 保持轻量 conflated topic，并向 `SessionSummary` 增加可选的阻塞交互摘要。摘要只包含 kind/count，不包含命令、问题、答案或其它敏感 payload。旧 frame 缺字段时等价于没有 attention。

```ts
type PendingInteractionSummary = {
  permissionCount: number;
  userInputCount: number;
};
```

`SessionSummary.phase`、`lastActivityAt`、`hasBackgroundWork` 和该摘要由同一个 conversation projection 派生；active pane 仍从完整 `ConversationSnapshot.pendingInteractions` 渲染交互卡片。若两类请求同时存在，侧栏保留两个计数，展示层优先显示 userInput 文案并以总数表达待处理数量；不丢失 permission 事实。

### 侧栏行投影

新增 UI-only `TaskListRowState`（最终命名可按现有目录约定调整），不再把实时 provenance 藏进持久化 `ZCodeTaskMeta.status/updatedAt`：

```ts
type TaskListRowState = {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  title: string;
  createdAt: number;
  activity: {
    phase: SessionSummary["phase"];
    lastActivityAt: number;
    hasBackgroundWork: boolean;
    pendingInteractions?: PendingInteractionSummary;
  };
  membership: {
    pinned: boolean;
    archived: boolean;
    unreadAt?: number;
  };
  persistedMeta: ZCodeTaskMeta;
};
```

query cache 可以继续缓存列表实体和查询结果，但 mutation API 必须按字段 owner patch。禁止把 `setTaskUnread`、rename、pin/archive 返回的整个 `ZCodeTaskMeta` 覆盖 activity 字段；禁止用 tasks-index 的 `updatedAt` 排 Updated 视图。

### 指示器派生

```text
phase=error                         -> error icon
else membership.unreadAt is set    -> unread dot
else phase in prewarming|running   -> spinner
else                               -> none

pending userInput/permission       -> separate attention tag
```

`completedInterrupted` 不显示 error；历史 tasks-index terminal error 只可作为 sessions-index 尚未 hydration 时的静态错误 fallback，绝不能产生 running spinner。snapshot 一旦到达，activity 全字段由 sessions-index 替换。

## 未读产生与聚合时序

```text
sessions-index terminal summary
  ├─ phase=error ---------------------------------> unreadSignal
  ├─ no goal + completed/interrupted -------------> unreadSignal
  ├─ goalStatus=verified --------------------------> unreadSignal
  └─ active/paused/verifying/notSatisfied/failed --> status refresh only

unreadSignal
  -> renderer exact workspaceKey + inactive-task guard
  -> setTaskUnread(true)
  -> task row blue dot + Dock badge
  -> collapsed workspace aggregate dot
```

`task_status_changed` 只是状态收敛事件，不再隐式表示“新完成”。只有 Host 在观察到权威
`SessionSummary.phase + goalStatus` 后显式携带的 `unreadSignal` 才能制造未读。同一终态的 task-index
patch 与 snapshot 回源最多一条广播携带 signal，renderer 保留幂等对账。

workspace 聚合从完整 regular-task membership 计算 `hasUnread`，再裁剪到当前分页窗口。
collapsed workspace 在名称后、操作区前显示与 task row 同尺寸/颜色的蓝点；expanded workspace
不显示聚合点，且不执行任何未读 mutation。

## 未读清除时序

```text
select task
  -> activate exact workspace tab / resolve workspaceIdentity + remoteSessionId
  -> read membership.unreadAt from current task query row
  -> apply renderer overlay { unreadAt: undefined }
  -> setTaskUnread(unread=false)
       ├─ success: reconcile tasks-index membership; remove overlay
       └─ failure: remove overlay; refetch membership; warn through UI logger
  -> set activeTaskId
```

overlay 只描述 `unreadAt`。成功响应里的 `updatedAt/status/title` 不参与 activity 合并，因而清蓝点不会改变排序。重复选择已读任务是幂等操作，不发无意义写入。

## 活动与排序时序

Project / Timeline（包括桌面和 Web 远控）统一使用两层 comparator：

```text
第一层：运行状态
  prewarming/running --------------------------> 位于非运行任务之前

第二层：层内排序
  running tasks -------------------------------> createdAt DESC, taskId tie-break
  non-running + Created -----------------------> createdAt DESC, updatedAt DESC
  non-running + Updated -----------------------> updatedAt DESC, createdAt DESC
```

运行层禁止使用 `updatedAt` 作为 tie-break。两个 task 即使在同一毫秒创建，也必须使用稳定
`taskId` 决胜，否则流式事件仍可能通过次级排序键制造换位。进入 running 时 task 移入运行层；
running 期间位置保持稳定；进入 completed/error 后退出运行层，再按当前非运行排序规则落位。

```text
new PermissionRequested / userInput request
  -> projection pendingInteractions changes
  -> record.lastActivityAt bumps once
  -> sessions-index upsert
  -> running task stays in its createdAt slot
  -> non-running task in Updated view may move row

refresh / SessionResumed / replay same request
  -> rebuild identical summary
  -> no activity bump, no reorder

rename / unread / pin / archive
  -> tasks-index membership/meta patch
  -> lastActivityAt preserved
  -> Updated order unchanged

new message / tool / turn lifecycle
  -> real session activity
  -> lastActivityAt advances
  -> running peers do not reorder
  -> non-running Updated order may change
```

grouped view 不消费该排序链，继续由 SQLite group item 的显式 `sort_order` 决定位置。

### 追记 2026-09-09：后台工作并入运行层

现象：两个会话各跑一个动态工作流 run，侧栏里两行随 run 进度快速互换位置。

根因：运行层成员只按 `phase ∈ {prewarming, running}` 判定，而 workflow run 是**后台工作**——
启动轮收口后父会话 `phase` 已回到 `completedSuccess`，只有 `hasBackgroundWork` 为真。与此同时
每条 `DynamicWorkflowRunProgress` 事件都走 `onSessionEvent` 推进 `record.updatedAt`
（= `lastActivityAt`），并立即触发 sessions-index 增量帧（只有 `ModelStreaming` 被跳过）。
于是两个会话都落在按 `updatedAt` 排序的非运行层，以引擎事件的频率互相换位。后台 bash /
分离子代理的 `BackgroundTaskUpdated` 同样会推进活动时间，只是更短更安静。

```text
engine RunEvent ──▶ DynamicWorkflowRunProgress ──▶ record.updatedAt = now
                                                   └─▶ sessions-index upsert (lastActivityAt)
UI: isRunning(phase) = false  ──▶ 非运行层 ──▶ 按 updatedAt 排 ──▶ 两行互换
```

决定：运行层成员改为 **`prewarming/running` 或 `hasBackgroundWork`**（桌面
`isTaskListRowActive`，手机远控 `displayStatus === "running" || hasBackgroundWork`）。
`lastActivityAt` 的语义不变（仍是活动事实与未读依据），只是有后台工作的会话在运行层内按
`createdAt` 固定，后台工作结束后退出运行层、按当前偏好落位。转圈图标仍只认 `phase`
（边界 5 不变）。备选方案「把 run 进度事件列入非活动事件、不再推进 `lastActivityAt`」被否：
它会改变"最后活动"的含义，让在跑 run 的会话在列表里显得沉寂。

### 追记 2026-09-14：工作流运行行（workflow run line）

现象：会话挂着动态工作流 run 时，侧栏只有排序位置变化，没有任何可见指示，用户无法分辨"哪个会话在跑工作流、跑到哪一步"。

决定：sessions-index 摘要新增可选 `workflowActivity`（每会话 ≤ 4 条 run：在跑的按启动顺序，其后是最近结束的；
每条含 `runId/toolCallId?/name?/status/stopReason?/startedAt?/phases[]/currentPhase?/agentsWorking`），由 CLI 投影从同一
snapshot 的 `workflowRuns` + `backgroundWorks` 派生，随 sidecar `TaskListRowActivity.workflowActivity`、桌面 host controller
`taskActivity`、远控 `WebRemoteControlTaskTarget` 三条链一起下发。phase 状态只按控制流规则派生（在跑：当前 phase running、
已进入 done、其余 pending；completed：已进入 done；errored：当前 failed；stopped：当前 pending），站点表来自
`run.phaseNames`（由 `run-launched` 事件携带，提交方从因果图填入），否则退化为已进入的 phase。

UI：`TaskListItem` / grouped row / timeline row / 远控行在标题下追加一行「Workflow 图标 + 迷你轨道灯 + 当前 phase 名」，
行高 32 → 52（每多一行 +20，最多两行，其余折成 `+n`）。前置 16px 槽（error > unread > spinner）不变——运行行是第二条通道，
不是第四级优先级。结束的 run 行**不靠计时器**折叠：渲染端维护有界（256）持久化的已确认 runId 集合，打开会话即确认其当时所有
已结束 run；活动会话内 run 结束立即确认。折叠的项目组头在未读点旁显示脉冲灯（>1 时带数量），只统计在跑的 run。
点击运行行 = 选中会话 + 打开 run pane（与 composer 徽标相同跳转）。

边界不变：`hasBackgroundWork` 仍是运行层排序依据；`workflowActivity` 只用于绘制，不参与排序或未读判定。
`summariesEqual` 把该字段纳入 JSON 比较，phase 翻转 / 结算 / 在跑子代理数变化因此永不被 conflation 吃掉；
它不会让列表更安静——每条 run 进度事件本就推进 `lastActivityAt`（同一判等里比较的字段，2026-09-09 追记的语义不变）。
虚拟化 grouped 列表改为 `measureElement` 实测行高，估算值 32 仅作初值。
详见 `docs/dynamic-workflow/presentation.md`「The sidebar run line」。

跨端：`WebRemoteControlTaskTarget` 新增可选 `hasBackgroundWork`（renderer 从 sessions-index
sidecar 填入；desktop main 的手机快照签名把它计入，run 起止即使 `displayStatus` 不变也推新快照；
旧快照缺省视为 false）。

## 重启恢复与显式新建时序

`activeTaskId=null` 不是充分的恢复判据。恢复入口还必须读取 workspace store 中的
`draftFocusVersion`：默认值 `0` 表示本次 renderer 生命周期没有收到显式新建意图；
`startDraft` 每次递增表示用户已经选择 draft。该版本只属于 renderer-local 导航态，不进入
sessions-index/tasks-index，也不跨 renderer 重启持久化。

```text
冷启动 + 普通激活 workspace B
  activeTaskId=null, draftFocusVersion=0
  -> restore last-session(B)
  -> select old session（允许）

冷启动后从 workspace A 点击 B 的“新建对话”
  -> activate exact B by workspaceKey
  -> deactivate desktop workbench group
  -> reset pane layout to primary
  -> startDraft(B), draftFocusVersion: 0 -> 1
  -> B shell mount sees explicit draft intent
  -> clear last-session(B), skip restore
  -> activeTaskId remains null（必须）
```

所有桌面新建入口（workspace 行、全局按钮、菜单、Cmd/Ctrl+N、draft workspace selector）必须
收敛到同一个导航事务，不能由叶子组件直接组合 `activateTab + startDraft`。事务按
`workspaceKey = workspaceIdentity?.trim() || workspacePath` 精确定位；`workspacePath` 相同的远端
workspace 不得互相清除 last-session。手机 `/remote` 不恢复、不消费 desktop workbench group/pane
localStorage，只沿 `web-remote-replayable` bridge 的 workspace/task/draft 意图导航。

## 跨端恢复边界

```text
desktop-continuous              web-remote-replayable
  sessions-index delta             snapshot / resume / gap resync
           │                                  │
           └──────── TaskListRowState ─────────┘
                    field-level reconcile
```

- desktop continuous 不拼接 mobile replayable 的运行态恢复消息；收到 delta 后直接更新 activity。
- mobile replayable 在完整 snapshot assembly 后整体替换 activity；gap/resync 期间保留上一份 valid base，不自行从 tasks-index猜 running/attention。
- relay/main 继续只透传，不保存 task/session/sidebar 业务状态。
- permission/userInput 摘要与其它 sessions-index 字段同 topic 恢复，不使用 `task_meta_changed` 触发 membership RPC。

## 错误处理与日志

- unread 写入失败：UI logger `warn`，撤销 field overlay，并失效对应 workspace membership 查询；不保留永久本地已读假象。
- sessions-index gap/fault：沿用现有 owned-subscription resync；不回退旧 Zustand runtime/ui map。
- 缺少 optional attention 字段：按无待处理解释，兼容旧 producer/frame。
- 远程 identity/service 无法精确解析：沿用现有导航失败保护，不按相同 `workspacePath` 猜另一个 remote session。
- last-session 恢复：仅当 `activeTaskId=null && draftFocusVersion=0`；显式 draft 必须同步清理精确 workspaceKey 的持久化键并跳过恢复。
- 不新增高频 `info` 日志；frame/stream 细节若需诊断只能走既有 debug 路径。

## 跨源 join 的并发提交合同

workspace 行需要异步读取 tasks-index membership；该 RPC 与 sessions-index activity 更新不在同一事务中。
每轮 join 必须捕获以下三类输入版本：

```text
sessions-index {scope, logEpoch, seq, serviceGeneration}
tasks-index    {membershipVersion}
renderer query {requestGeneration}
                    │
                    v
             async membership join
                    │
      任一版本变化 ──┴──> 丢弃旧结果，不清 stale，自动重算
```

- 相同 query signature 的请求在途时，新 invalidation 不能被简单去重丢弃；必须记录 rerun intent。
- 旧请求只能在 activity revision、membership version 与 request generation 仍匹配时提交。
- `stale` 不能承担唯一的失效代次；连续 invalidation 必须可观察，旧回包不得把更新后的 query 标成 fresh。
- revision 只在 renderer 内协调 read model，不新增 shared wire 字段，也不改变 SQLite schema。
- desktop continuous 与 mobile replayable 共用相同提交门禁；mobile 的 snapshot/gap 仍只由 owned subscription 恢复。

## 测试与证据

### 单元/组件

- sessions-index schema/projection：phase、attention counts、request/resolution、snapshot/cold hydration、等价 replay 不产新活动；
- row projection：activity 与 membership 按 owner join，tasks-index mutation 不覆盖 phase/lastActivityAt；
- indicator：error/unread/running 优先级及 attention 共存；
- unread navigation：从 query row 判断、乐观清除、成功对账、失败 rollback/refetch、workspaceIdentity/remoteSessionId 精确路由；
- unread creation：普通终态/Goal verified/error 产生显式 signal，Goal 中间终态与 resume/status-only 事件不产生；
- workspace aggregate：收起态、分页窗口外未读、多未读逐个清除、pinned/archived 剪枝和 workspaceIdentity 隔离；
- ordering：running 永远位于非 running 之前；多个 running 按 `createdAt` 倒序且 `updatedAt` 交替不重排；任务结束后回到用户选择的 Created/Updated 顺序；title/unread/pin/archive 不重排；grouped sort_order 不变；
- restart/new-draft：非当前 workspace 有 persisted last-session 时，workspace 行新建保持 draft；普通激活仍恢复；显式新建退出 active group、重置 pane；相同 path 的不同 workspaceIdentity 隔离；
- static guard：TaskListItem/navigation 不再读取四个 legacy sidebar fact maps。

### E2E 剪枝

- desktop `desktop-continuous` 作为完整代表：后台运行显示 spinner，permission/userInput 显示 attention，error 显示红态，点开 unread 清蓝点且不跳序。
- TSL18 使用 E2E-only membership gate 精确暂停 tasks-index `listTasks` 回包：先确认 running row 与 spinner，
  再启动并确认旧 membership refresh 已在途，Stop 收敛为 `completedInterrupted` 后释放旧回包；最终等待
  对应 workspace query 重新 fresh，并断言释放窗口内 spinner 未重现。gate 只在
  `VITE_ZCODE_E2E_STORE_BRIDGE=1` 时通过 `window.__testActions` 暴露，不进入普通生产 renderer。
- Goal 只取 `ordinary terminal / notSatisfied / verified / cancelled / error` 的通知边界，不与 queue kind、provider、分屏做笛卡尔积。
- desktop restart 代表：先为 workspace B 持久化 last-session，从 A 点击 B 的 workspace 行“新建对话”，断言 draft 意图获胜且无旧 session 回写；另证普通激活 B 仍恢复 last-session。
- mobile `web-remote-replayable` 只证明 snapshot/gap 恢复后同一 phase/attention/unread 投影一致，并验证 workspace identity 隔离。
- 不与 queue、compact、fork、subagent、分屏、模型/provider、主题/locale 做全排列；这些维度不改变字段 owner，以单元/既有用例守护。

## 非目标

- 不删除 Zustand 包或整个 `zcodeSessionStore`。
- 不把 pin/archive/group/unread 移入 sessions-index。
- 不把完整 pending interaction payload 放入列表 topic。
- 不重写 task list 虚拟化、搜索、分组拖拽或全局通知系统。
- 不删除 last-session 刷新恢复能力；只把“允许恢复”和“用户显式新建”拆成两个可判定状态。
- 不改变 desktop/mobile 的 delivery profile、owner/lease 或 command queue。

## 实施顺序

1. 先补协议/投影、row/indicator/unread 失败与 restart/new-draft 用例，使现有错误行为失败。
2. 收敛显式新建导航事务，让 `draftFocusVersion` 阻止 last-session 恢复，并统一退出 desktop group / 重置 pane。
3. 增加轻量 attention summary，并贯穿 CLI → shared → services → UI sessions-index。
4. 建立 field-owned row projection和字段级 optimistic mutation，迁移排序与 TaskListItem。
5. 迁移 task selection 清未读，删除侧栏四个 legacy 事实源的读取点；仅在引用确认归零后删除死 action/type。
6. 补 desktop 代表 E2E 与 mobile replayable 恢复合同，执行 typecheck、lint 和相关测试。
