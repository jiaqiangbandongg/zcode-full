# 任务列表刷新语义（workspace_task_list_changed reason 分类学）

> 2026-07 定稿。背景：M5 把左侧列表数据源迁到 sessions-index 后，出现"输入框操作（切模型）/
> 任务收口 / 打开历史任务都会让左侧任务列表整刷、任务跳到列表顶部"的一串症状。根因是两个
> 消费语义从未被定义成契约：① `workspace_task_list_changed` 的 reason 分类学；② sessions-index
> `lastActivityAt` 的"活动"定义。本文是这两个语义的事实源；策略实现在
> `packages/ui/src/lib/taskListRefreshPolicy.ts`，守护测试在 `packages/ui/test/taskListRefreshPolicy.test.ts`。

## 1. reason → UI 刷新级别矩阵

发射面：`taskIndexSyncer.emitWorkspaceTaskListChanged(target, meta, reason)`——**reason 必填**（设计修正：
曾经的缺省值 `task_meta_changed` 让所有不表态的发射点静默落入最重的刷新语义，是整串缺陷的根）。

| reason                                           | 语义                                                     | 整表刷新¹        | membership 重拉² | meta 增量回写³      | 典型发射点                                        |
| ------------------------------------------------ | -------------------------------------------------------- | ---------------- | ---------------- | ------------------- | ------------------------------------------------- |
| `task_pinned` / `task_unpinned`                  | 置顶归属翻转                                             | ✅               | ✅               | —                   | setTaskPinned                                     |
| `task_archived` / `task_unarchived`              | 归档归属翻转                                             | ✅               | ✅               | —                   | archiveTask/unarchiveTask                         |
| `task_meta_changed`                              | 归属相关 meta（unread）或无更细分类的兜底                | ❌（带 meta）    | ✅               | preserve-membership | setTaskUnread、group 操作、批量归档、首发广播     |
| `task_status_changed`                            | 状态/快照收敛（收口、回源、打开/恢复任务、compact/goal） | ❌               | ❌               | preserve-membership | applyTerminalTransition、resync、resumeSession    |
| `task_model_changed`                             | 切模型（纯配置）                                         | ❌               | ❌               | preserve-membership | zcodeSessionService.setModel                      |
| `task_title_changed`                             | 标题（首条消息/自动标题/手动重命名）                     | ❌               | ❌               | preserve-membership | applyTitleChange、renameTask                      |
| `task_created`                                   | 新任务（tasks-index 正向行集合增加）                     | ✅（无 meta 时） | ✅               | insert-active       | adapter/create、首次 grouped 顺序提交             |
| `user_message_saved` / `assistant_message_saved` | 消息落盘                                                 | ❌（带 meta）    | ❌               | preserve-membership | 旧协议路径                                        |
| `task_deleted`                                   | 删除 tombstone                                           | ✅               | ✅               | —                   | deleteTask；立即移除缓存并换代 deleted membership |
| `stream_mirror_*`                                | 流恢复兜底                                               | ✅               | ❌               | —                   | 远控恢复路径                                      |
| `auto_archive`                                   | 自动归档提示                                             | ❌               | ❌               | —                   | 兼容保留                                          |

¹ `shouldRefreshTaskListForWorkspaceEvent`；² `shouldRefetchTaskListMembershipForWorkspaceEvent` →
`bumpTaskListMembershipVersion`（全局版本号，一次 bump 所有列表实例重拉 pin/archive/unread join 面，
且按事件内容去重防双订阅链路重复投递）；³ `getTaskMetaWorkspaceEventSyncMode`。

`task_status_changed` 还可携带可选的 `unreadSignal="background_terminal"`。v4 sessions-index 的
host syncer 不知道每个窗口正在查看哪个 task，所以 Host 只负责判定“这个终态是否值得
提醒”，renderer 再执行 active-task guard。普通后台终态、Goal `verified` 和真实 error 携带
signal；Goal `active/paused/verifying/notSatisfied/failed` 不携带。打开/恢复历史任务、compact/goal
快照收敛等普通 status 广播也不携带，禁止仅根据 terminal status 猜测新完成。renderer 收到
signal 且 task 非当前 active task 时调用 `setTaskUnread(true)`；这次归属变更会再发出
`task_meta_changed`，由它触发 unread membership join 重拉。

`task_deleted` 的整表刷新仍是隐藏项 `total/hasMore` 的兜底；对已命中可见缓存的任务可以先做增量移除。
无论是否命中可见缓存，它都必须 bump membership version，因为 sessions-index 仍可能在后续 live frame 或
冷启动 seed 中返回同一个 CLI session，只有 tasks-index 的 deleted id 负向集合能阻止其重新进入普通列表。

`task_created` 也必须 bump membership version。tasks-index 现在是 Project/Timeline/Pinned/Archived/Grouped
持久行的左表；即使事件携带 `taskMeta`、sessions-index 已经发布 activity，也不能再沿用旧的“只增量回写
meta”策略。事件发生在 task row 与初始 grouped 顺序提交之后，换代读取才能完成
`optimistic -> persisted row` 的收敛，并让其它窗口/手机创建的任务进入当前列表。

**新增发射点的判定规则**：变更是否影响 pin/archive/unread 归属？否 → 绝不用 `task_meta_changed`，
选精确 reason 或新增 reason 并更新本矩阵与守护测试。高频路径（每次消息/收口/打开都会走的）落错
分类的代价 = 全部列表实例 × membership RPC × 整列表重渲染。

## 2. lastActivityAt："什么算任务活动"

sessions-index 的 `lastActivityAt` = CLI `record.updatedAt`（v4-bridge `getSessionIndexMeta`），UI 侧栏按它
降序排序。**只有用户可感的会话活动才允许 bump**：

- ✅ 计入活动：消息收发、turn 生命周期、工具执行、后台任务，以及新产生的 permission/userInput 阻塞请求等用户可感 SessionEvent。
- ❌ 不计入（`isNonActivitySessionEvent`，server-operations.ts）：
  - `ModelSelected` / `SessionModeChanged`：纯配置变更（切模型/切模式）；
  - `SessionResumed`：打开/恢复会话是读取不是活动（冷恢复路径刚回填 store 真实时间，不得被冲掉）。
- ❌ refresh/snapshot/resume/replay 同一 pending interaction 不产生新的活动；只有新的阻塞请求事件可以 bump 一次。
- ❌ 配置类 mutation（`CONFIG_ONLY_MUTATION_REASONS`：model/thought_level/mode changed）与
  `updateRuntimeModelConfig` 不 bump `record.updatedAt`。
- ❌ tasks-index membership/meta mutation（unread、pin/archive、group、rename）不得把其 SQLite `updatedAt`
  合并回 sessions-index `lastActivityAt`。Updated 排序只认后者；grouped 视图只认显式 `sort_order`。

违反后果：配置操作/打开任务把任务顶到列表最前并触发整列重排。

## 3. sessions-index 冷恢复降级防御（seed↔live 切换窗口）

冷启动时列表种子来自 store（`getStoredSessionSummaries`）；打开任务后 live 投影覆盖种子。hydration
完成前 live 投影是半成品，以下字段不得用降级值覆盖非空基线（`SessionsIndexProjection.upsertFromConversation`）：

- `title` 空 → 保基线；`createdAt` 更新 → 保更早值；`lastAssistantPreview` 空 → 保基线；
- `phase === "draft"` 而基线非 draft → 保基线 phase/sessionEnded/goalStatus（会话一旦有内容不可能退回 draft）。

防御完备时，"打开一个没有变化的历史任务"产生零 delta（守护测试：sessions-index-projection.test.ts
「冷恢复 draft 窗口快照与基线等价时不产 delta」）。

## 4. renderer 差量管道（防"一帧变化放大成全列表刷新"）

当前形态是"内存全量重算 + 引用等价短路 + IO 按版本缓存"（千级会话量下重算 ~ms；
真正的实体化差量 store 是后续重构方向，见 §6）：

- `useWorkspaceSessionsIndexItems`：聚合层逐条字段比对，等价复用旧对象；整表等价复用旧数组——
  下游依赖数组身份的 effect（grouped refresh、workspace 缓存失效、republish）自然短路。
- `useWorkspaceTaskLists`：sessions-index 变化只标脏 diff 出的有变化 workspace scope，不再全量 invalidate。
- **刷新展示语义**：已有 query cache 的 workspace 采用 stale-while-revalidate——只把命中 scope 标记为
  `stale` 并保留当前任务行，后台重算完成后原位替换；只有 query cache 完全缺失的首次 hydration 才进入
  blocking loading。禁止用“清空已有列表 → loading → 回填”表达普通 sessions-index / membership 刷新，
  否则一次任务选择或恢复仍会被用户感知成整个侧边栏重新加载。
- `useGroupedTaskView`：`stabilizeGroupedView` 节点级复用，整树等价时 setState 拿同引用直接 bail。
- `taskQueryCacheStore.setQueryResult(s)`：结果与现缓存等价时跳过 setState；`mergeIncomingTaskListItem`
  内容等价保留旧引用。
- **IO 差量**：membership（pin/archive/unread）与 grouped structure 均不随 sessions-index 内容帧变化，
  按 `membershipVersion + 签名` 缓存（`fetchTaskListMembershipSetsForEndpointsCached`、grouped
  `remoteDataCacheRef`），内容帧（title/status/lastActivity）只做内存 join，零 RPC；
  分组 mutation 路径显式失效缓存。

### 4.1 workspace scope 订阅隔离

`useWorkspaceSessionsIndexItems` 消费的是多个 workspace 的集合，但订阅所有权必须落到单个
`endpoint + workspaceKey`。scope 集合变化只能按 key 做增量 reconcile，禁止把数组签名变化直接解释成
“释放全部旧订阅，再重新订阅全部新 scope”。否则删除一个 workspace 会清空其余 workspace 已经持有的
snapshot、水位和任务行，把局部导航操作放大成跨 workspace 状态重建。

```text
before = [A, B, C]             after = [B, C]
             │                         │
             └── reconcile by key ─────┤
                                       ├─ release A
                                       ├─ retain B store/subscription/watermark
                                       └─ retain C store/subscription/watermark
```

| scope 变化                            | 允许的副作用                | 禁止的副作用                       | 分类                 |
| ------------------------------------- | --------------------------- | ---------------------------------- | -------------------- |
| 删除 A                                | unsubscribe/release A       | 重建或清空 B/C                     | accepted             |
| 新增 D                                | acquire D；D 独立 hydration | 清空已有 A/B/C 行等待 D            | accepted             |
| 仅重排 scopes                         | 无                          | 任意 subscribe/unsubscribe         | pruned：集合身份不变 |
| B 的 endpoint/service generation 换代 | 只替换 B                    | 重建相同 endpoint 的其它 workspace | accepted             |
| hook 真正卸载                         | release 全部当前 entry      | 保留泄漏引用                       | accepted             |

关键不变量：从 `[A, B, C]` 变为 `[B, C]` 后，B/C 的 `SessionsIndexStore` 实例、subscription、
watermark 与 session 集合必须保持原值；renderer 不得发布 B/C 的空中间态。桌面仍使用
`desktop-continuous`，手机远控 scope 仍使用所属 endpoint 的 `web-remote-replayable`；本次改动只隔离
订阅生命周期，不改变两种 delivery 语义。identity key 继续使用
`workspaceIdentity?.trim() || workspacePath`，`workspacePath` 只用于传输参数和展示/执行。

### 4.2 grouped 视图的空白帧禁令（2026-08）

`Grouped` 是唯一把「权威列表」放在组件实例 `useState` 里、并且带首屏门禁的侧栏视图；
timeline/pinned/archived 都从模块级 `taskQueryCacheStore` 渲染。因此同一条内容帧下，
只有 grouped 会把「刷新中」表达成整块空白——用户感知为「左侧分组列表整块闪一下」。
四条不变量：

- **门禁只拦首屏**：`isGroupedTaskViewInitialized` 必须是一次性闩锁。禁止直接读当前
  Controller 列表的 `loading`——运行中任务每个流式节点（发 prompt、首个 tool、输出完成）
  都会让它重查一轮，门禁会随之回关并卸载整棵 grouped 子树。
- **画过一次就不得回空白**：`shouldHideGroupedTaskContent` 必须接受 `hasPaintedOnce`。
  已经渲染过非空列表之后，任何 loading / 未初始化 / 瞬时空态帧都继续渲染上一份列表。
- **权威视图跨挂载存活**：最后一份权威视图按 scope 签名缓存在模块级
  （`useGroupedTaskView` 的 `groupedViewCacheBySignature`），祖先重挂载 / HMR 后立即接着画，
  RPC 只负责收敛；初始化闩锁一并从缓存种下，否则重挂载第一帧仍会关门。
- **scope memo 必须用值签名**：`scopes` / `sessionsIndexScopes` 禁止 memo 在 tabs 数组身份上。
  父级重建同值数组会换掉 `refresh` 的身份，而「`refresh` 变化即刷新」的 effect 又会 setState
  触发下一次渲染——形成自激刷新环，每帧发 RPC 并给门禁/空态制造闪动窗口。口径与
  `useGlobalTaskList` 的 `workspaceSignature` 保持一致。

```txt
Controller activity 帧（phase/lastActivityAt 变化）
   │
   ├─ timeline/pinned/archived ─> 模块级 query cache ─> stale-while-revalidate，无空白
   └─ grouped ─> 实例 state + 首屏门禁 ─> 闩锁/hasPaintedOnce/模块缓存 缺一即整块空白
```

验证提示：这类修复依赖「挂载时种初始状态 + 组件内闩锁」，vite HMR 会保留已挂载组件的旧状态，
必须**完整重启应用**复测，热替换下的观察结果不作为结论。

## 5. 历史根因链（2026-07 修复对账）

同一症状（左侧列表闪/整刷/任务跳顶）由四层独立缺陷叠加，修复分别位于：

1. reason 缺省值蹭用 → reason 必填 + 高频路径精确分类（本文 §1）；
2. 配置/恢复被计成活动 → §2 非活动事件集合；
3. 冷恢复 draft 降级 → §3 phase 防御；
4. 聚合层/查询缓存引用不稳定 → §4 稳定化。

### 5.1 grouped 整块闪（2026-08 修复对账）

症状与上面同源但只出现在 `Group` 视图：切到 Group 跑一个多 tool 任务，
**发出 prompt、首个 tool 展示、最终输出完成**这三个时刻各闪一次；切到 Project/Timeline 不闪。

已用测试复现并确认的三条独立缺陷（`packages/ui/test/groupedTaskViewStreamingStability.test.ts`）：

1. **门禁跟随瞬时 loading**：`initialized` 直接由 Controller 列表的 `loading` 推导，
   每个流式节点重查一轮就关门 → 整棵 grouped 子树卸载重挂载。
2. **自激刷新环**：`scopes` memo 在数组身份上，父级重建数组即触发 render→refresh→setState→render
   （护栏用例在改前会跑到 200+ 次渲染）。
3. **重挂载退回空态**：权威视图只存在于组件实例 state，重挂载后回到「空视图 + 门禁关门」，
   要等两个 RPC 才恢复；这也是「只有 grouped 闪」的结构性原因。

同期还排除了两条曾被怀疑的路径：顶层/组内虚拟化（实测 `nodeCount 67 < 80` 阈值，未启用）、
侧栏宽度被右侧内容挤压（侧栏面板是 `flex-none` + CSS 变量宽度）。

反面教材（不要再引入）：曾用「live Controller 仍报告该 task」当作「行不该消失」的证据来抵消
瞬时丢行。该判据的口径是 `kind:"active"` = `!archived`，**包含 pinned task**，而 grouped 的口径是
「非 pinned 非 archived」，结果置顶任务会被守卫复活并赖在分组里。约束见
`docs/ui/task-grouped-view.md` 的「可见性真相源与删除收敛」。

## 6. 后续方向：实体化差量 store

当前管道每帧全量重建再做等价短路，正确但有 O(N) 重算与比对成本。终局形态是实体化差量：
sessions-index delta 直接落 by-id 实体 store（renderer 已是 Map），各视图（timeline/pinned/grouped/
workspace 分组）维护自己的有序索引并按 delta 增量维护（插入/移动/删除单条），彻底移除全量
map/sort/比对。改造涉及所有列表 hook 的数据面重排，应作为独立重构立项（先补本矩阵的 e2e 守护再动）。

## 7. 被动观察与 runtime 生命周期

`workspace_task_list_changed` 监听和 sessions-index scope acquire 都是观察行为，不是 workspace 使用意图。
它们必须满足：

- `onDynamicWorkspaceEvent` 只返回 workspace emitter，不建立上游订阅；
- task-list sessions-index 与 Host task-index syncer 只以 `existing-only` 方式 subscribe/resync；
- runtime 缺失时进入 dormant，不记录生产级错误、不启动退避 timer、不触发 Agent；
- runtime available 后只为匹配 workspaceKey 的 observer 建立一代订阅；Host task-index 的 dormant state
  第一次激活时必须先幂等安装 workspace frame listener、再发送 subscribe，确保同一次 stdio read 内在
  ACK promise resolve 后、await continuation/subscription ownership 生效前到达的 initial frame 不丢失；
  runtime 换代只重订阅，不重复安装 listener；
- unavailable 后清理 ownership、pending frame 与 retry，并隐藏失去 live 证明的 running activity；
- renderer reload 可以复用 Host 中已经存在的 runtime，但不得为其它 restored workspace 补启动。

App 冷启动预热是 Main 明确发出的启动意图，不属于上述被动观察。单窗口恢复多个本地 workspace 时，Main
只选择上次激活的 workspace 作为唯一 target（上限 1），并在首次 `InitLocal` 中交给 Host 走既有完整
`initializeWorkspace` 预热路径；`recentProjects` 中的其它 workspace 不再预热，保持 dormant，直到用户显式
打开/发送/后台任务入口才启动。没有可恢复 session、显式 open-workspace/deep-link 冷启动等单 workspace
入口同样只预热自己的 target；预热失败不扫描其它 workspace 补位。该名单只在 Host 首次创建时计算，
renderer reload 复用原 Host，不重新扩大名单。

> 2026-09-30 由最多 3 个收敛为 1 个：会话 CLI 没有 idle 回收，启动即拉起 3 个 Agent 进程会让每个
> 窗口常驻 3 份 CLI 内存，而切换到最近项目的冷启动收益不足以抵消这部分常驻成本。

```text
startup restore ─> explicit warmup target (active only, max 1) ─> Agent runtime available
                                                        │
sidebar mount/reconcile ─> passive observers ─> tasks-index rows
                                      │                 │
runtime available(workspaceKey) ──────┴─────────────────┴─> install listener -> attach sessions-index
runtime unavailable(workspaceKey) ─────────────────────────> dormant; no retry spawn
```

生产日志只保留 runtime available/unavailable 与真实订阅生命周期；observer reconcile、dormant 命中和逐帧
细节使用 `debug`，避免 workspace 数量乘以列表消费者形成新的日志风暴。
