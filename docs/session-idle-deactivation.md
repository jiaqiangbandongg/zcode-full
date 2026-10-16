# CLI Session 混合常驻池

状态：**已确认，按本 spec 实现**

## 问题

每个 workspace runtime 对应一个常驻 `zcode-cli app-server --stdio` 进程。进程内每个已加载
session 都持有完整 `ZCodeApp`、内存事件库、MCP/runtime 接线和 V4 publisher。正常切换 task、
关闭 pane 或切 workspace 不会删除持久 session，因此同一 CLI 进程浏览过的 session 越多，
常驻内存越大。

本功能只解决**单个 CLI 进程内已加载 session 的空闲生命周期与突发数量**。它不做跨
workspace 的全局池，也不按 RSS 设置硬上限。

## 产品合同

1. 每个 CLI 对满足安全条件的空闲 session 使用 `10 分钟` idle TTL；TTL 到期后无论当前
   resident 数量多少都回收。
2. 每个 CLI 同时使用 `highWater = 16`、`lowWater = 8` 的数量迟滞：超过高水位时不等待
   TTL，按 LRU 回收可安全冷恢复的 session，直到低水位或没有候选。
3. 正在运行、排队、等待交互、被订阅或有协议操作在途的 session 永不回收。“正在运行”不仅
   包含前台 turn 和 background task registry，还包含 runtime 自己拥有的 detached sidecar，以及
   协议层释放 active lock 后尚未完成的持久化、快照和广播收尾。若这些 session 本身已经超过
   高水位，允许常驻数继续超额。
4. idle TTL 从全部保护事实消失后开始；新的 session 操作或保护事实会重置计时。长时间后台
   work 完成后必须从完成通知 drain 结束时重新计时，不能沿用后台任务开始前的旧时间。
5. 回收后，session 的内存状态与“CLI 刚启动、该 session 从未加载”完全相同：
   `context.sessions` 无 record，持久 session 和 task index 保留。
6. 后续订阅/读取按既有 cold resume 恢复，不新增第二条恢复链路。
7. 回收是内部生命周期，不发送 `session.removed`，也不向 renderer 发送“已回收”业务通知。

高低水位因此是一个**安全优先的突发保护阀**，不是会中止任务或拒绝并发的硬限制。它与
`crossSessionUnlimitedConcurrency` 不冲突；TTL 则保证少量长期不用的 resident runtime 最终也会
释放。

## 状态与时序

```text
                        任一保护事实存在
                    ┌──────────────────────────┐
                    │ ACTIVE_PROTECTED         │
                    │ · runtime owned work     │
                    │   · active/queued        │
                    │   · task registry        │
                    │   · detached sidecar     │
                    │ · protocol finalization  │
                    │ · pending interaction    │
                    │ · subscriber             │
                    │ · protocol operation     │
                    │ · deferred draft         │
                    └────────────┬─────────────┘
                                 │ 保护事实全部消失
                                 v
                    ┌──────────────────────────┐
                    │ IDLE_WARM                 │
                    │ 记录 eligibleSinceAt      │
                    └───────┬──────────┬───────┘
                            │          │
                 idle>=10min│          │resident>16
                            │          │按 LRU 回收到 8
                            └────┬─────┘
                                 v
                    ┌──────────────────────────┐
                    │ DEACTIVATING             │
                    │ 同步二次校验并摘除 record │
                    │ 异步等待 app.close        │
                    └────────────┬─────────────┘
                                 v
                    ┌──────────────────────────┐
                    │ DEACTIVATED              │
                    │ 内存无 record，磁盘仍在   │
                    └────────────┬─────────────┘
                                 ├─ V4 subscribe/rows-range → cold READY flight
                                 └─ legacy resume           → legacy activation/snapshot
```

并发 session 可以超过目标：

```text
highWater = 16
lowWater = 8

18 个 session 都在运行/订阅中
  -> resident = 18
  -> 可回收 = 0
  -> 不终止任何任务，暂时保持 18

其中 12 个变为空闲
  -> 已超过 highWater，按 LRU 回收 10 个
  -> resident = 8

11 个最近使用且已退订的 session
  -> resident 未超过 highWater
  -> 10 分钟内继续保持热状态
  -> 各自 TTL 到期后回收，即使 resident 已少于 8
```

## 生命周期与释放矩阵

这里的“生命周期”只描述 session 在**当前 CLI 进程内是否常驻**，不改变磁盘 session、task index、
pin/archive/unread 等产品状态。pool 只会从 `IDLE_WARM` 发起回收；其他状态要么仍有 owner，要么已经
不在内存中。

| 生命周期           | 进入条件                                                      | 是否可由 pool 释放 | 新请求的行为                                                   |
| ------------------ | ------------------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `DEACTIVATED`      | 当前 CLI 的 `context.sessions` 中没有 record                  | 已释放，无需再处理 | 走既有 cold resume，重建 app/runtime 并恢复持久历史            |
| `COLD_RESUMING`    | subscribe/query/resume 正在创建或恢复 record                  | 不可释放           | 复用/等待同一次恢复；operation lease 保护整个异步窗口          |
| `ACTIVE_PROTECTED` | 下表任一保护 owner 存在                                       | 不可释放           | 按原协议继续运行、排队或订阅                                   |
| `IDLE_WARM`        | record 已持久化，且所有保护 owner 都已释放                    | 可以成为候选       | 请求可直接复用热 record，并清除已有 `eligibleSinceAt`          |
| `DEACTIVATING`     | fresh 二次校验通过，record 已同步摘除，`app.close()` 尚未完成 | 正在释放，不可重复 | 等待 close settle，再走 cold resume；不会命中半拆除的旧 record |

`ACTIVE_PROTECTED` 不是一个单独布尔值，而是以下 owner 的并集：

| owner / 子生命周期      | 典型来源                                                             | 是否可释放 | 解除保护的准确边界                                         |
| ----------------------- | -------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- |
| 前台/后台 turn          | prompt、模型流、tool await、compact、goal continuation               | 不可       | runner 的 runtime work 完成                                |
| runtime command         | queued prompt、terminal notification、command drain                  | 不可       | queue 为空且 drain 完成                                    |
| background task         | background Bash、subagent、Workflow、MCP monitor                     | 不可       | task registry 不再是 running，且其完成通知已经 drain       |
| detached sidecar        | session/goal title、MCP startup、notification ledger、goal heartbeat | 不可       | tracker 包裹的 Promise 连同 fallback 写入在 `finally` 释放 |
| memory work             | project-memory extraction、recall prefetch                           | 不可       | scheduler 无 pending/running，prefetch 已 settled          |
| protocol finalization   | command fact、ensure-model、snapshot、broadcast 收尾                 | 不可       | `residencyFinalizationCount` 归零                          |
| pending interaction     | permission、elicitation、AskUserQuestion                             | 不可       | 交互已应答、取消或关闭                                     |
| gateway command         | V4 command queue、in-flight/live inbox pin                           | 不可       | command 完成并解除 pin                                     |
| conversation subscriber | desktop continuous、mobile replayable 在线订阅                       | 不可       | unsubscribe 完成                                           |
| legacy subscriber       | 旧 `session/subscribe` replayable/bot stream                         | 不可       | 旧协议没有 unsubscribe，保守保护到 CLI 退出                |
| protocol operation      | subscribe hydration、rows query、resume、配置读写                    | 不可       | request dispatch 的 operation lease 释放                   |
| deferred draft          | 尚未立即持久化的 session record                                      | 不可       | 转为 immediate persistence；否则无法保证冷恢复等价         |

因此，判断方式不是“这个功能叫不叫后台任务”，而是“是否还有会读取或修改当前
record/runtime 的异步 owner”：

```text
存在任一 owner
  -> ACTIVE_PROTECTED
  -> 即使 resident > 16 也不能回收

所有 owner 已释放 + session 可从磁盘恢复
  -> IDLE_WARM
  -> idle TTL 到期，或 resident > 16 时按 LRU，才允许回收
```

### 用户操作与功能场景

| 场景                                             | 可否释放                               | 边界说明                                                                             |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| 前台 prompt / 模型 streaming / 工具执行          | 不可                                   | active turn 或 runtime work 持有 owner                                               |
| background Bash / subagent / Workflow            | 运行中不可                             | 不能只看前台 turn；task terminal 且完成通知 drain 后才可能变为空闲                   |
| goal 长任务 / verifier / continuation            | 运行或收尾中不可                       | active/runtime 与 finalization 连续覆盖；paused/completed 且无 continuation 时可以   |
| compact / memory extraction / recall prefetch    | pending、running 或收尾中不可          | 全部 settled 后可以，不沿用工作开始前的旧 idle 时间                                  |
| browser use                                      | turn/tool await 或 cleanup 中不可      | 只保留空闲 browser 连接不构成永久 owner；session 回收时随 app/runtime 关闭           |
| MCP                                              | startup 或 monitor running 时不可      | server 已连接但空闲时可以；后续 cold resume 会重新建立连接                           |
| permission / AskUserQuestion                     | 不可                                   | 回收会丢失只存在内存里的交互状态                                                     |
| queued prompt / command inbox pin                | 不可                                   | 即使尚未开始模型调用也属于待执行工作                                                 |
| automation / 定时任务 / off-peak 闲时任务        | 本次触发运行时不可；仅有未来定义时可以 | 触发后必须进入 prompt runner 的统一 owner 链；持久的未来调度定义不应永久 pin session |
| renderer 可见 pane / mobile 在线订阅             | 不可                                   | subscriber 是保护 owner                                                              |
| renderer pane 已关闭并完成 keep-warm/unsubscribe | 可以                                   | renderer projection 已先释放，CLI 才开始自己的 idle TTL                              |
| SSH / WSL / Docker session                       | 与本地规则相同                         | 判断发生在实际承载 session 的远端 CLI；网络连接或 workspace 类型本身不是额外特判     |
| 已完成的历史后台任务                             | 可以                                   | task index / 持久历史仍保留，但 terminal 历史本身不占 runtime owner                  |

对所有“可以”仍需满足下一节的全部权威保护事实，并在真正摘除 record 前同步二次校验。任何新请求、
新订阅或新 owner 都会把 `IDLE_WARM` 重新推进到 `ACTIVE_PROTECTED`，同时重置 idle TTL。

## 权威保护事实

只有以下条件**全部满足**时 session 才可回收：

| 条件                              | 权威来源                                  | 原因                                                                                    |
| --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| 已持久化                          | `record.persistence === "immediate"`      | deferred draft 回收后无法冷恢复                                                         |
| runtime 无 owned work             | `AgentRuntime.hasResidencyBlockingWork()` | 聚合 active/queued turn、task registry、detached sidecar 和待完成的 memory work         |
| 无协议收尾 work                   | `record.residencyFinalizationCount === 0` | active lock 必须先释放才能进入 ready，但持久化、快照和广播完成前仍需要原 record/runtime |
| 无 pending interaction            | `V4InteractionRegistry`                   | permission / AskUserQuestion 等仅在当前进程内存中                                       |
| V4 command queue / inbox pin 为空 | `ConversationV4Gateway`                   | gateway queue、in-flight/live command 是当前进程运行态                                  |
| conversation 无订阅者             | `ConversationTopicPublisher`              | desktop continuous 与 mobile replayable 的在线消费者都受保护                            |
| 无 legacy stream 订阅             | `record.legacyStreamSubscribed`           | 旧 replayable/bot 流没有 unsubscribe RPC，只能保守保活到 CLI 退出                       |
| 无协议请求在途                    | `SessionResidentPool` operation lease     | subscribe hydration、rows query、resume、配置写入等 await 窗口不能被回收                |

`record.activeAbortController` 不是完整的 runtime busy 事实，不能单独用于回收判定。
`record.deliveryKind` 也不是 legacy subscription lease：`session/read` 等读取路径会写入它。兼容层只在
真正 `session/subscribe` 时写 `legacyStreamSubscribed`，避免普通读取永久豁免；旧协议因没有
unsubscribe，被标记的 stream 作为保护项可令 resident 暂时超过目标。

runtime 的权威查询必须覆盖它所拥有且会触碰 session/runtime 状态的全部异步工作：

```text
AgentRuntime.hasResidencyBlockingWork()
  = active turn / turn-start reservation
  || runtime command queue / drain
  || task registry 中 running background Bash / Agent / Workflow / MCP monitor
  || detached session title / goal title 生成与 fallback 持久化
  || MCP startup
  || detached background-notification ledger write / goal heartbeat
  || project-memory extraction schedule / drain
  || 尚未 settled 的 project-memory recall prefetch
```

detached sidecar 在同步启动时登记计数，在 Promise 的 `finally` 中释放；不能靠事后扫描 Promise，
也不能只保护真正的模型调用而遗漏 fallback 写入。这样无论成功、失败还是 abort，计数都不会泄漏。

协议层的 ready 边界需要独立 finalization lease：

```text
background prompt / compact / goal continuation
  -> acquire record finalization lease
  -> 执行模型/runtime work（activeAbortController 同时存在）
  -> clear activeAbortController       # 允许下一条输入通过 admission
  -> 持久 command fact / ensure model / snapshot / broadcast
  -> release record finalization lease
  -> 才可能进入 IDLE_WARM
```

finalization lease 不能用延迟释放 `activeAbortController` 代替，否则 queued input 会在 ready 边界
误判旧 turn 仍活跃。legacy 与 V4 background 路径必须复用同一个计数协议。

场景映射遵循同一 owner 规则，不再各自增加 pool 特判：

- automation、定时任务、off-peak/闲时任务最终都进入 prompt runner；运行期由 active/runtime
  事实保护，ready 收尾由 protocol finalization lease 保护；
- background Bash、subagent、Workflow、MCP monitor 以 task registry 为权威，terminal
  notification 入 runtime queue 后继续由 queue/drain 与 detached ledger write 保护；
- browser use 在 turn/tool await 期间属于 active work，turn/session browser cleanup 仍在 runner
  Promise 内；用户只保留一个空闲 browser session 不等于“任务仍在运行”，允许正常冷回收并关闭；
- MCP server 连接本身不是永久 pin；只有 startup 或 registry 中仍在 running 的 MCP monitor
  阻止回收，已就绪且无任务时允许冷启动重建；
- goal verifier/continuation 和长时间压缩沿用 active/runtime 事实，释放 ready lock 后再由
  finalization lease 兜住；
- SSH/WSL/Docker 仍在实际远端 CLI 内执行同一判断，workspace identity 与冷恢复边界不变。

协议请求使用进程级 operation lease，并同时记录命中的 sessionId：

```text
request admitted
  -> acquire operation lease
  -> 若该 session 正在 DEACTIVATING，等待 close 完成
  -> dispatch / hydrate / mutate / query
  -> release lease + touch LRU
  -> rebalance
```

进程级 lease 的含义是：任一协议请求的异步执行片内不启动回收。这也覆盖会遍历多个 session 的
workspace 配置同步，避免只给显式 `{sessionId}` 请求加锁后仍留下全局操作竞态。运行中的异步任务
则由 runtime/background 权威事实继续保护。

## TTL、LRU 与触发

- `eligibleSinceAt` 只在全部保护事实消失后建立；重新 touch 或再次受保护时删除。
- TTL 到期候选无视当前 resident 数量，执行前仍须重读安全事实。
- 高水位回收以 `lastUsedAt = max(record.updatedAt, pool.lastTouchedAt)` 做 LRU 排序。
- 一次 rebalance 先回收 TTL 到期项，再用剩余 resident 数判断是否超过 highWater；超过时回收到
  lowWater 或没有候选。
- 每个协议请求结束后触发一次 rebalance，使 create/resume/unsubscribe 后及时更新计时或收敛。
- 既有 process resource sampler 每 60 秒兜底，不新增 per-session 定时器；因此 10 分钟 TTL 的
  实际回收窗口是成为 eligible 后约 10～11 分钟。
- 默认参数是代码常量，测试可注入较小值与时钟；本期不新增环境变量或用户设置，也不读取 RSS
  做回收决策。
- server 装配层的兼容字段 `sessionResidentTargetCount` 只覆盖 low-water；未显式提供
  `highWaterCount` 时仍从默认 high-water 解析，不能把 legacy low-water 同时写入两端而塌掉迟滞
  窗口。若只覆盖 `targetCount` 且它高于默认 high-water，装配层必须解析出不低于 target 的有效
  high-water，不能让 Agent CLI 在构造期因默认值组合抛错；显式传入的非法 high/target 组合仍由
  pool 校验拒绝。

## 回收执行面

回收和显式 close/delete 都会释放 runtime，但产品语义不同：

```text
resident eviction
  -> gateway.assertSessionRuntimeDeactivatable() # 纯校验；失败时不得产生副作用
  -> record.unsubscribe()
  -> gateway.deactivateSession()   # 清 publisher/cache/inbox，不发 session.removed
  -> context.sessions.delete()
  -> await app.close()

explicit close/delete
  -> gateway.disposeSession()      # 保持既有 removal 语义
```

纯安全校验必须位于第一个副作用之前；校验拒绝时，record、runtime event subscription 和 gateway
运行态全部保持可用。校验通过后的 `unsubscribe`、gateway 清理和 `sessions.delete` 在同一个同步
执行片中完成。新请求要么先取得 operation lease 而阻止回收，要么看到 DEACTIVATING 并等待，
然后走 cold resume；不会命中半拆除 record。`app.close()` 属于摘除后的异步收尾，其失败由 pool
隔离和记录，不属于可回滚的同步预检事务。

## Renderer 内存边界

renderer 不镜像 CLI 常驻池，也不接收回收通知。它已有独立的 projection cache 生命周期：

```text
pane 关闭/切走
  -> release SessionDataLayer pane lease
  -> keep-warm 30s
  -> unsubscribe conversation
  -> ConversationProjectionStore.close()
  -> 从 SessionDataLayer 删除该 topic store
  -> CLI 观察到 subscriber=0
  -> 进入 CLI 10 分钟 idle TTL；突发超过 highWater 时也可参与 LRU
```

如果 renderer 仍持有需要实时更新的重 projection，它就仍有 subscription，CLI 不会回收；如果 CLI
已经可以回收，renderer 的重 projection 已按自身生命周期释放。额外的“CLI 已回收”通知会把内部缓存
策略泄漏到 UI，并可能与刚完成的重订阅发生旧通知清新状态的代际竞态，因此禁止作为业务协议。

task list membership、pin/archive/unread、workspace identity 等 shell 状态继续由 task sqlite index
和 renderer 轻量状态持有；回收不得删除它们。

## 多端与远端边界

- Desktop 保持 `desktop-continuous`。可见 pane 的 subscription 保护 session。
- Mobile/Web remote 保持 `web-remote-replayable`。V4 subscription 在场时保护 session，释放后若
  eligible 才允许回收；当前仍走旧 `session/subscribe` 的 replayable/bot stream 因协议没有
  unsubscribe，保守保护到 CLI 退出。两条兼容路径都不改变既有 snapshot/gap/cold-resume。
- 手机仍 attach 到桌面窗口现有 shared host；不新增独立 runtime。
- pool 位于实际运行 session 的 CLI 进程。SSH/WSL/Docker workspace 的 pool 在对应远端 CLI，
  不下沉到 relay、desktop main 或 host。
- 本功能按 sessionId 管理生命周期，不新增 workspace key；现有身份隔离继续使用
  `workspaceIdentity?.trim() || workspacePath`。

## 验收

focused 测试必须证明：

1. eligible 首次出现只开始 TTL，TTL 到期后即使 resident 少于 lowWater 也回收；
2. touch 或保护事实重新出现会重置 TTL，后台 work 完成后从新 idle 窗口开始；
3. 等于 highWater 不回收，超过 highWater 时按 LRU 回收到 lowWater；
4. 所有 session 都受保护时允许超过 highWater；
5. active/queued runtime、后台 Bash/Agent/Workflow、detached title/MCP/memory sidecar、协议
   finalization、pending interaction、gateway queue、subscriber、legacy stream、operation lease、
   deferred draft 各自能独立阻止回收；
6. TTL 与 high-water 同轮命中不会重复关闭，候选事实变化时执行前会跳过；
7. 回收不产生 `session.removed`；
8. 回收后重新订阅会创建新 app，并恢复真实历史 rows，而不只是返回 snapshot 外壳；
9. `app.close()` 未完成时，同 session 的新请求等待后冷恢复；
10. desktop continuous 与 mobile replayable 不共享恢复状态，remote identity 语义不变；
11. renderer 的既有 last-pane lease 测试继续证明 store close、unsubscribe 和 cache 删除。
12. 去激活会清除该 session 的 `CommandInbox` settled LRU/admission 序号；in-flight/live pin
    在解除前阻止回收。
13. legacy 与 V4 的 background prompt/compact/goal continuation 在释放 active lock 后、完成
    state mutation 收尾前仍不可回收。

本期不新增 conversation GUI E2E。容量、竞态与冷恢复由 CLI/core focused 测试覆盖；renderer 内存
生命周期复用既有 `v4SessionDataLayer` 测试。
