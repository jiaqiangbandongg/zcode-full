# Session Resident Pool（app-server 进程内混合常驻池）

## 文档定位

本文定义 ZCode Protocol app-server 内的 session 常驻池实现合同。产品边界和 renderer 生命周期见
仓库根 `docs/session-idle-deactivation.md`。

## 目标

每个 CLI 进程用 idle TTL 作为主回收策略，并以高低水位限制突发 resident 数量：

```ts
DEFAULT_SESSION_RESIDENT_TARGET_COUNT = 8;
DEFAULT_SESSION_RESIDENT_HIGH_WATER_COUNT = 16;
DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
```

eligible session 空闲超过 TTL 后无论 resident 数量多少都去激活；当
`context.sessions.size > highWater` 时，不等待 TTL，按 LRU 回收到 target。若保护中的 session
数量超过 highWater，允许超额，不取消任务、不拒绝新 session、不引入 RSS 硬上限。

## 核心不变量

`DEACTIVATED` 必须等价于“当前 CLI 进程从未加载过该 session”：

- `context.sessions` 无 record；
- 持久 session、messages、entries、task sqlite index 保留；
- V4 publisher、hydration、attachment cache 和内存 event store 已释放（record 释放路径显式调用
  `eventStore.deleteSession`；驻留期间的瞬态事件淘汰见 `session-event-store-retention.md`）；
- 不发送 `session.removed`；
- V4 再次使用时由入口显式判断是否需要 activation，再进入
  `gateway readyFlights -> ColdSessionResumeCoordinator.ensureResumed -> activateSessionForResume -> projection hydration`；
  `hydratePublisher` 本身仍只负责 projection hydration。legacy resume 保持原 activation/snapshot 入口。

## 组件

### `SessionResidentPool`

位置：`bootstrap/src/zcode-protocol/session-resident-pool.ts`。

宿主窄接口：

```ts
interface SessionResidentPoolHost {
  listSessionIds(): string[];
  readResidencyFacts(sessionId: string): SessionResidencyFacts | null;
  deactivate(sessionId: string): Promise<void>;
  onDeactivated?(sessionId: string): void;
  onError?(sessionId: string, error: unknown): void;
}
```

职责：

- 保存 `sessionId -> lastTouchedAt`；
- 保存 `sessionId -> eligibleSinceAt`；
- 保存全进程 operation lease 计数和按 session 的 lease 计数；
- 保存 `sessionId -> deactivation Promise`，作为 cold resume 闸门；
- 保护事实存在或 session 被 touch 时清除 `eligibleSinceAt`，首次重新 eligible 时从当前时间开始
  新 TTL；
- 先回收 TTL 已到期的 fresh eligible session；
- 若剩余 resident 数量超过 highWater，再按
  `max(lastTouchedAt, record.updatedAt)` 升序选择 LRU，回收到 target；
- 每次执行前重读 facts，防止候选选出后出现新工作；
- 单个 close 失败只上报，不阻断其他候选。

### `SessionResidencyFacts`

```ts
interface SessionResidencyFacts {
  persisted: boolean;
  hasResidencyBlockingWork: boolean;
  hasPendingInteractions: boolean;
  hasQueuedCommands: boolean;
  hasSubscribers: boolean;
  hasLegacySubscriber: boolean;
  lastActivityAt: number;
}
```

eligible 必须满足：

```text
persisted
&& !hasResidencyBlockingWork
&& !hasPendingInteractions
&& !hasQueuedCommands
&& !hasSubscribers
&& !hasLegacySubscriber
&& pool.operationLeaseCount(sessionId) === 0
```

不得使用 `deliveryKind !== undefined` 作为保护条件。它不是订阅引用计数，读操作也可能写入。
旧 `session/subscribe` 没有 unsubscribe RPC，因此只在真正 subscribe 时设置
`record.legacyStreamSubscribed`，以该字段保守保护 replayable/bot stream 到 CLI 进程结束。

### 权威运行事实

`AgentRuntime` 暴露同步、只读接口：

```ts
hasResidencyBlockingWork(): boolean
```

它统一聚合：

- runtime command drain；
- runtime command queue；
- active turn；
- active turn start reservation。
- runtime task registry 中 running 的 background Bash、Agent、Workflow、MCP monitor；
- runtime-owned detached work 计数，包括 session title、goal title（含 fallback 持久化）和
  MCP startup、background-notification ledger write 与 goal heartbeat；
- project-memory extraction scheduler 的 pending/running work；
- 尚未 settled 的 project-memory recall prefetch。

runtime-owned detached work 必须在同步启动 Promise 时加计数，并在同一 Promise 的 `finally`
减计数。新增 detached sidecar 时必须使用同一 tracker，不能在 pool 适配层逐个猜测。

bootstrap 还要 OR：

- `record.activeAbortController !== undefined`，作为协议适配层的 active 防线；
- `record.residencyFinalizationCount > 0`，覆盖 background prompt、compact、goal continuation
  释放 active lock 后仍在执行的 command fact、ensure-model、snapshot 与广播收尾。

finalization lease 从后台 runner 启动时登记，在所有 state-mutation 收尾完成后的 `finally` 释放。
它不能通过延迟清空 `activeAbortController` 代替，因为后者是输入 admission 的 ready lock。

```text
runtime sidecar start ──sync +1──> blocking
      promise finally ───── -1───> eligible candidate

protocol background start ─ +1 finalization
      active work complete ─ clear activeAbortController
      mutation complete ──── -1 finalization
```

automation、定时/off-peak 任务、browser use、goal continuation 与 compact 不建立旁路判据：
它们必须落到上述 prompt/runtime/finalization owner 链。SSH/WSL/Docker 只改变运行 pool 的 CLI
进程位置，不改变事实来源。

## Operation lease

`ZCodeProtocolAgentServer.handleRequest` 在 dispatch 之前获取 lease，在整个 async dispatch 完成后释放：

```text
handleRequest(request)
  -> pool.acquireOperation(sessionIdFromRequest)
       -> 全进程 operationCount++
       -> 等待同 session 的 in-flight deactivation
       -> session operationLeaseCount++
  -> touch(sessionId) 并重置 idle TTL
  -> dispatchRequest(request)
  -> release
  -> touch(sessionId) 并重置 idle TTL
       -> session operationLeaseCount--
       -> 全进程 operationCount--
       -> rebalance()
```

`sessionIdFromRequest` 读取：

- 普通 params 的顶层 `sessionId`；
- V4 conversation subscribe/resync/unsubscribe 的 `conversation/<sessionId>` topic；
- `v4/commands/query` 中各 command key 的 `sessionId`；
- 无 sessionId 的 workspace/global 请求只持有进程级 lease。

进程级 lease 防止 provider registry 等跨 session await 操作与 sampler 回收并发；按 session lease
同时进入 eligibility facts，便于测试并表达所有权。

## Rebalance

触发点：

1. 每个协议请求 lease 释放；
2. 既有 process resource sampler 的 `onSample` 低频兜底。

算法：

```text
rebalance()
  if globalOperationCount > 0: return
  resident = host.listSessionIds()

  for each resident
    facts = read fresh facts
    if !eligible(facts)
      eligibleSinceAt.delete(sessionId)
    else if no eligibleSinceAt
      eligibleSinceAt.set(sessionId, now)

  expired = eligible candidates where now - eligibleSinceAt >= idleTimeout
  for candidate in expired ordered by eligibleSinceAt then LRU
    fresh = readResidencyFacts(candidate)
    if eligible(fresh) and TTL still expired
      executeDeactivation(candidate, reason=idle_timeout)

  remaining = host.listSessionIds()
  if remaining.length > highWater
    candidates = remaining fresh eligible ordered by lastUsedAt
    for candidate until remainingCount <= target
      fresh = readResidencyFacts(candidate)
      if !eligible(fresh): continue
      executeDeactivation(candidate, reason=high_water_lru)
```

排序用 sessionId 作为同时间戳稳定 tie-breaker。TTL 只基于进程内 `eligibleSinceAt`，不会把磁盘
中很旧的 `record.updatedAt` 当作刚冷恢复 session 的 idle 起点。`touch` 与保护状态转换会重置
TTL；LRU touch 与 `record.updatedAt` 只决定高水位候选顺序。

协议 request release 与既有 60 秒 process resource sampler 都调用 rebalance，不新增定时器。
因此默认 TTL 在成为 eligible 后约 10～11 分钟执行。

server 装配层按以下合同解析兼容配置：

- legacy `sessionResidentTargetCount` 只表达 low-water，不覆盖 high-water；
- 只传 `targetCount` 时，装配层必须解析出不低于 target 的有效 high-water，不能因默认 high-water
  较小而让整个 Agent CLI 在构造期抛错；
- 显式传入的非法 high/target 组合仍交给 `SessionResidentPool` 构造校验拒绝。

## 去激活执行面

`deactivateSessionRecord(context, sessionId)` 的首个同步执行片：

```text
record = sessions.get(sessionId)
v4Gateway.assertSessionRuntimeDeactivatable(sessionId)
record.unsubscribe()
v4Gateway.deactivateSession(sessionId)
sessions.delete(sessionId)
promise = record.app.close()
```

`assertSessionRuntimeDeactivatable` 是纯校验，必须位于第一个副作用之前。若校验拒绝，record、
runtime event subscription 与 gateway 运行态全部保持可用；`app.close()` 是摘除后的异步收尾，
失败由 pool 隔离记录，不纳入可回滚的同步预检事务。

`deactivateSession` 复用 `disposeSession` 的 runtime cleanup，但
`notifyIndexRemoved=false`。清理 publisher、hydration、flush state、projection waiter、attachment
cache、raw sequence、telemetry 归一化状态，以及 `CommandInbox` 的 per-session settled LRU 和
admission 序号，不调用 `indexPublisher.removeSession`。`CommandInbox` 若仍有 in-flight/live pin，
fresh facts 必须阻止去激活；执行面也会在拆 publisher 前再次拒绝。

`app.close()` 的 Promise 存入 pool 的 in-flight map。后续同 session 请求先等待它 settle。close
失败经 `onError` 记录 warn；闸门必须释放，不能永久阻塞 cold resume。

## Detached subagent child publisher

运行中的 subagent child 复用父 runtime 的外部 event sink，没有自己的 bootstrap record，但 raw child
event 会在 V4 gateway 建出独立的 conversation publisher（`ingestDetachedLiveSession`）。它不在
`context.sessions` 里，因此上文的 resident pool 与去激活执行面都管不到它。

Bug 根因：child 是一次性 session，只有一个 turn，publisher 建出后既没有 record 释放路径，也没有
后继 turn；真机上每跑一次 subagent 就多一套 publisher（完整 projection + 最多 2000 条日志）驻留到
CLI 进程退出（`v4.detachedLive` 计数器只增不减）。

生命周期合同：

1. gateway 在 `ingestDetachedLiveSession(childId, event, parentSessionId)` 记录 child → parent 归属。
2. 父 record 释放（`session/close`、创建失败、idle 去激活）走 `cleanupSessionRuntime(parent)` 时，
   连带释放其全部**没有自己 record** 的 detached child publisher；child 若已有 record（被显式 resume），
   交给 child 自己的 record 生命周期。
3. 时间兜底：child 的 `turn_complete` / `turn_error` 记录终态时间；协议 server 借既有 60s 资源采样节拍
   调用 `pruneDetachedChildPublishers()`，终态超过 `DETACHED_CHILD_PUBLISHER_GRACE_MS = 120_000`、
   当前无 conversation 订阅者、且没有 record 的 child 一并释放。child 再次 `turn_started` 撤销终态记录。
4. 释放后再被订阅走既有 cold resume：child 作为 `subagent_child` 持久化在 session store，
   `hasLiveConversation` 返回 false 即按历史 session 恢复，不新增第二条恢复链路。
5. 释放不发 `session.removed`：detached child 不在 sessions-index 中。

## Renderer

本实现不修改协议 schema，不增加通知。renderer 的 `SessionDataLayer` 在最后一个 pane lease 释放后
按既有 keep-warm timer 执行：

```text
unsubscribe -> ConversationProjectionStore.close -> entries.delete(topic)
```

该 unsubscribe 让 CLI 的 `hasSubscribers` 变为 false。CLI pool 与 renderer cache 通过现有 subscription
lease 自然衔接，互不持有对方的生命周期状态。

## 测试先行清单

### Core

- idle runtime 返回统一保护事实 false；
- active/queued/reserved/draining 任一存在时 `hasActiveOrQueuedTurnWork` 为 true；
- runtime task registry 中 running background work 使统一保护事实为 true，终态恢复 false；
- detached tracker、MCP startup、title fallback、memory extraction/recall 任一未完成时统一保护事实为 true。

### Bootstrap pool

- 默认 idle TTL 为 10 分钟、highWater 为 16、target 为 8；
- TTL 到期后 resident 少于 target 也会回收，touch/保护状态会重置 TTL；
- highWater 4、target 2、resident 5 时按 LRU 回收到 2；
- protected session 超过 highWater 时允许超额；
- runtime owned work / protocol finalization / pending / queue / subscriber / draft / operation lease
  单项保护；
- legacy stream subscribe 保护，且普通 `session/read` 的 `deliveryKind` 不作为 lease；
- 候选排序后 fresh facts 变化会跳过；
- operation lease 阻塞 sampler rebalance，释放后立即收敛；
- deactivation close in-flight 阻塞同 session 新 operation；
- close reject 后闸门释放，其他候选继续；
- 去激活清 `CommandInbox` settled/admission 内存，in-flight/live pin 拒绝清理。

### 集成

- 真 sqlite session：subscribe + unsubscribe 后开始 TTL，超时触发去激活；
- sessions-index 无 `session.removed`；
- 重订阅创建新 app，snapshot rows 同时包含持久 user 与 assistant 文本；
- close gate 未释放前重订阅不物化新 record；
- active runtime 与 running background runtime 在容量超额时保持在册。
- legacy 与 V4 background prompt/compact/goal continuation 清 active lock 后，在 state mutation
  完成前仍保持在册。

## 非目标

- 跨 CLI/workspace 全局池；
- RSS/heap 字节硬上限；
- 内存压力自适应；
- 用户设置或新环境变量；
- renderer 回收通知；
- 改变 desktop continuous 或 mobile replayable 恢复语义；
- 把 session/task 业务状态下沉到 Host、Desktop main 或 relay。
