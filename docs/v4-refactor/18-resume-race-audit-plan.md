# V4 Resume / Activation 竞态审计与测试计划

> 状态：draft（2026-08-28）
> 范围：V4 conversation 的 cold activation、projection hydration、legacy `session/resume` 兼容入口、查询/命令超时，以及 desktop-continuous / web-remote-replayable 的恢复边界。
> 本文是审计与测试计划，不改变运行时代码。

## 1. 目标与判定标准

要找的不是“某个 Promise 可能很慢”，而是以下三类可证明的问题：

1. 同一个 session 是否出现两个 runtime / 两个 projection owner。
2. timeout、abort、disconnect、deactivate 或 runtime replace 之后，旧 continuation 是否还能写入新状态。
3. 读取失败或状态不完整时，是否被错误地当成空状态、idle、unknown 或成功 ACK。

恢复链路的期望边界：

```text
request
  │
  ├─ server request lease（阻止 resident pool 回收）
  ├─ readyFlights[sessionId]（仅 cold activation + hydration）
  │      ├─ ColdSessionResumeCoordinator（runtime activation singleflight）
  │      └─ hydratePublisher（projection hydration singleflight）
  ├─ CommandInbox（command/query 唯一 admission authority）
  └─ publisher / durable store（projection 与历史事实）

timeout / abort / disconnect / deactivate
  ├─ 旧操作必须停止写入，或明确以 stale generation 被丢弃
  └─ 不能把“未读到”改写成“读到了空集合”
```

权威来源必须保持区分：

| 状态 / 事实 | 权威来源 | 非权威的相似状态 |
| --- | --- | --- |
| runtime 是否已激活 | `context.sessions` + activation 结果 | `readyFlights` 是否存在、客户端 RPC 是否已返回 |
| cold V4 是否可放行 query/command | gateway `readyFlights`（调用开始时的快照） | `context.sessions.has(sessionId)` |
| command FIFO / 幂等 | CLI `CommandInbox` + durable command facts | renderer optimistic overlay、RPC ACK 到达时间 |
| projection 水位 | publisher 的 `seq/revision/logEpoch` | ACK epoch、网络连接时间 |
| 历史正文 | transcript / event store 的成功读取结果 | `loadPersistedEvents` 失败后构造的空数组 |
| desktop / mobile 恢复语义 | trusted `clientMode` / `deliveryKind` | RPC 是否从 remote 返回、UI 猜测 profile |

## 2. 已确认问题（动态复现）

### R1 — hydration 持久读取失败被静默变成空 projection（高优先级）

位置：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` 的 `performHydration`。

当前代码对 `host.loadPersistedEvents` 使用 `catch`，上报 `v4.hydrate` 后返回
`{ events: [], synthesized: false, sourceEventSeq: 0 }`。因此 cold subscribe 在磁盘读取失败时仍能返回
`ack.mode=snapshot`、`revision=0` 的成功首帧。

最小 Vitest 探针（已运行，当前实现失败）：

```ts
const host = makeHost();
host.sessions.clear();
host.resumeOutcome = "resumed";
host.loadPersistedEventsImpl = async () => {
  throw new Error("persisted read failed");
};
const gateway = makeGateway(host);

await expect(gateway.subscribe(subscribeParams())).rejects.toThrow("persisted read failed");
```

实际结果：Promise resolved，快照为空。它违反 `docs/v4-refactor/17-cold-resume-runtime-activation.md` §4 的“hydration 异常保留原始生命周期错误”和 `docs/v4-refactor/10-protocol-spec.md` §7.3 的持久读取失败不可伪装原则。

风险：用户看到“成功但没有历史”，随后可在错误水位上发命令；移动端 replayable 还可能把这个空快照作为恢复基线。

### R2 — 并发 legacy `session/resume` 创建重复 runtime（高优先级）

位置：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` 的
`activateSessionForResume`。

当前只有 `await waitForDeactivation`，没有 per-session activation flight。两个请求都可能在
`context.sessions.set(sessionId, record)` 之前通过 `context.sessions.get` 检查，于是各自执行
`materializeSessionRecord`，最后后写入的 record 覆盖先写入的 record；两个 app 都可能继续
`resume()`，但只有一个仍在 registry 中。

真 sqlite + `ZCodeProtocolAgentServer` 探针（已运行，当前实现失败）：

```ts
await Promise.all([
  requestResult(server, { id: "resume-a", method: zcodeProtocolMethods.sessionResume,
    params: { workspace, sessionId } }),
  requestResult(server, { id: "resume-b", method: zcodeProtocolMethods.sessionResume,
    params: { workspace, sessionId } }),
]);
expect(createdAppOptions.filter((o) => o.sessionId === sessionId)).toHaveLength(1);
```

实际结果：同一 `sessionId` 创建了 2 个 app。服务端的 process-level residency lease 只能阻止 resident pool 回收，不能把同 session 的两个 resume 串行化。

风险：事件 sink、模型配置、`record.app.resume()` 和最终 `context.sessions` owner 互相覆盖；一次请求返回的 snapshot 可能来自已经不再是 registry owner 的 runtime。

## 3. 高风险候选（尚未修复，需补专测）

### R3 — V4 query timeout 契约未接线（高优先级）

`packages/shared/src/zcode-protocol-v4/core.ts` 定义了
`PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs = 10_000`，但仓库中没有任何消费点。
`packages/services/src/zcode-agent/zcodeAgentService.ts` 的
`commandsQuery`、`conversationUsage`、`rowsRange`、`plans`、`fileChanges`、
`fileRewindPreview`、attachment read/preview 等调用均未传 per-request `timeoutMs`，因此实际使用
`ZCodeProtocolClient` 的默认 3 分钟。

超时还会触发 `ZCodeAgentProcessManager.onRequestTimeout`，除
`workspace/cancelGenerateText` 外会淘汰整个 client/process。需要验证：

- query 是否应当 10 秒失败而不是 180 秒；
- 长时间 `fileChanges` / attachment 读取是否应该共用 query timeout，还是另有预算；
- command / subscribe 是否应明确使用独立 deadline，不能因为 query 常量接入而误杀正常 turn。

### R4 — `ColdSessionResumeCoordinator.clear()` 不取消底层操作（中高）

`clear()` 只清 `flights` map，不能中断已经交给 host 的 Promise。gateway 的
`cleanupSessionRuntime()` 也会删除 `readyFlights` / `hydrationInFlight`；若在 activation 尚未创建
hydration buffer 时发生 deactivate，旧 continuation 可能在清理后继续进入 `hydratePublisher`。

生产 server 的 request lease 会挡住 resident pool 的正常回收，因此这是“显式 gateway deactivate、
连接销毁、关闭流程”上的条件性竞态，不能只靠 unit happy path 排除。

### R5 — attachment/begin 与 READY 的边界容易被误读（中）

`attachmentBegin` 只调用 `coldResume.ensureResumed`，不等待 gateway READY / projection hydration；
`attachmentRead` / `attachmentPreviewSource` 则走 READY + hydration。当前 v4 spec 明确把
`attachment/begin` 列为 legacy boundary，不并入 READY，但 `docs/runtime-tools/embedded-search-native-build.md`
仍写成所有入口“进入同一个 singleflight materialization”。这是 spec drift，需决定：

- begin 是否只需要 runtime record；或
- begin 后立刻使用 projection 的入口是否必须等待同一 READY。

在决定前不要把它当成已确认 bug；应有 begin‖subscribe‖command 的时序测试保护边界。

### R6 — activation/hydration 失败后的 record 入册窗口（中）

spec 允许 record 入册后的失败保留 lifecycle 状态，不承诺自动回滚；实现上 READY 会释放 map，
下一次入口可能看到 `hasLiveConversation=true`，转而直接调用 `hydratePublisher`。需要测试第一次
READY 在 record 入册后失败、第二次 subscribe/query/command 的结果是否仍是可解释且不产生空 projection。

### R7 — legacy resume / UI restore 缺少 per-session generation（中）

`packages/ui/src/lib/zcodeSessionRestore.ts` 的 desktop restore 是 `resumeSession → readSession` 两个
独立 RPC；`packages/services/src/zcode-session/zcodeSessionService.ts` 的 resume 还可能追加
thought/model 修正和广播。并发打开、重连、切 workspace 时，较早 snapshot 可能晚到并广播覆盖较新状态。
需以两个 deferred restore 调用验证“迟到旧结果不能成为 UI/task-index 的最终事实”。

### R8 — `waitForSessionIdle` 双 authority + 固定 5 秒（中）

`session-flow.ts` 同时轮询 `record.activeAbortController` 和
`runtime.getActiveForegroundExecutionId()`。两者释放顺序不同、其中一方是旧兼容字段；5 秒后抛
`V4SessionIdleTimeoutError`，但没有 generation/operation token 说明超时后谁仍拥有执行权。
需覆盖 stop→new turn、runtime execution id 更换、旧 controller 晚释放、5 秒边界四种顺序。

### R9 — session_entries 读取失败被降级为空（中低）

`v4-bridge.ts` 对目标完成 verification 的 `sessionEntries` 失败返回 `[]`，主 hydration 也会继续。
这与 R1 不同：它只影响 goal/verification 派生状态，但仍可能把 pending/paused/complete 误判成无目标。
应区分“可选派生事实缺失”与“必须失败的正文/时间线读取”。

### R10 — 全局 usage 选择任意 active client（低）

`getAppUsageStats` 使用 `activeClientsByWorkspaceKey.values().next().value`。这是全局 store 的方便
复用，但第一个 entry 可能正处于 stale/disposed 或 provider sync 中。需要 process replace + concurrent
usage query 测试，确认是否有明确的 active-client 选择/重试规则。

## 4. 入口 × 状态 × 事件矩阵

| ID | 入口 | 起始状态 | 并发/超时事件 | 应保持的判定 |
| --- | --- | --- | --- | --- |
| C01 | legacy `session/resume` | cold，无 record | 同 session 第二个 resume | 一个 runtime owner；两个请求共享同一 activation 结果 |
| C02 | legacy `session/resume` | cold | A 设置 model，B 设置不同 model | 不允许两个 app 交错；最终 model 有明确 last-writer/serialization 规则 |
| C03 | V4 subscribe | cold | activation 完成、hydration 读失败 | 返回 lifecycle/hydration error，不返回空 snapshot |
| C04 | V4 subscribe | cold | A activation 中，B subscribe（desktop + mobile） | 一个 READY；两个 delivery profile 只在 ready 后分流 |
| C05 | V4 subscribe | cold | A activation 中 `disposeSession` / deactivate | A 不得在清理后复活 publisher；或明确请求失败并可重试 |
| C06 | rows/plans | cold | query 与 subscribe 同时开始 | query 只能等待调用开始时已注册的 READY；不得读旧/空索引 |
| C07 | command/query | cold | command/query 先于 READY map 注册 | 要么按 spec 允许调用时快照，要么补入口级 gate；必须固定契约并测试 microtask 顺序 |
| C08 | attachment/begin | cold | begin‖subscribe‖command | 验证其“只 activation / 不 hydration”边界，不产生隐式第二个 runtime |
| C09 | attachment/read | cold | runtime 已入册但 projection 未 hydrate | 必须走 READY + hydration，不能只看 `sessionExists` |
| C10 | hydration | warm publisher | persisted load 失败 | 不得将失败当空事件；若保留 warm publisher，必须说明 snapshot 是否仍可信 |
| C11 | hydration | load await 中 | live raw event 到达 | source cursor 与 buffer 合并后不丢事件、不制造永久 gap |
| C12 | command sendText | warm | `waitForSessionIdle` 5 秒超时后旧 turn 晚结束 | 新命令不能误 admission 或误杀下一代 turn |
| C13 | command sendQueuedNow/edit | warm | stop / foreground execution id 更换 | 旧 stop 只能 noop，不能 abort 新执行 |
| C14 | projection commit waiter | raw gap | 25 秒 timeout 后缺失事件迟到 | waiter 失败固化，迟到 event 不得 apply |
| C15 | physical wire | fragment 在途 | 30 秒 assembly timeout 后 recovery 到达 | fail-closed 只由 exact recovery 解锁，旧 online 片不污染新代际 |
| C16 | UI conversation store | live | runtime restart / proxy replace / old subscribe ACK 迟到 | generation 丢弃旧 ACK；新订阅沿用正确 clientMode/deliveryKind |
| C17 | UI restore | resume→read | 第二次 restore 先完成，第一次迟到 | 旧 snapshot 不得覆盖新 generation |
| C18 | provider/model | cold resume | registry sync 与 resume/command 交错 | provider registry revision 和 session model 不能倒退 |
| C19 | remote workspace | cold | 相同 path、不同 workspaceIdentity 并发 | session、READY、缓存、owner 不串 workspace |
| C20 | usage/query | 多 workspace active | 第一个 client dispose / replace | 选择健康 client；不把 stale client 视为 authoritative |

## 5. 测试实施顺序

### Phase A：先固化两个已确认失败

1. 把 R1 探针加入 `v4-gateway.test.ts`，先以 `it.fails` 或隔离审计 fixture 记录现状，避免把
     “空 projection”误当正常回归。
2. 把 R2 探针加入 `v4-cold-resume.test.ts`，断言同 session `createZCodeApp` 次数和最终 registry
   owner；该测试应先失败，再讨论 per-session activation owner 的修复设计。

### Phase B：补齐 timeout / cancellation harness

使用 deferred gate + fake timers，不依赖真实 10 秒/25 秒/30 秒：

- gateway：READY、hydration、deactivate、dispose 的所有交错排列；
- services：断言 V4 query 传入的 `timeoutMs`，以及 timeout 后 process manager 是否被淘汰；
- UI：assembler/recovery deadline、runtime generation、replace 后旧 ACK/旧 frame。

### Phase C：有限状态排列与属性测试

对每个 session 只枚举以下有限维度：

```text
runtime = cold | activating | warm | hydrating | disposed | replaced
entry   = resume | subscribe | query | command | attachment
event   = resolve | reject | timeout | abort | disconnect | deactivate | restart
client  = desktop-continuous | web-remote-replayable
```

先做单 session、最多两个并发入口的全排列；再加 remote identity 和 child session。每个排列只检查
不变量，不比较不可观察的内部时序。必要时把这些维度接入 `packages/formal-proof`，但不要把
`context.sessions`、READY、CommandInbox 合并成一个抽象状态。

## 6. 验收不变量

- 同一 `workspaceKey + sessionId` 在任意时刻最多一个 runtime owner。
- cold READY 未完成前，已看到 READY 的 query/command 不进入旧 CommandInbox；READY 失败不产生
  fake `unknown` 或空 projection。
- persistent read error 与“确实为空”可区分；日志只做诊断，不改变错误语义。
- timeout/abort/disconnect 后的旧 continuation 不得创建 publisher、推进 revision 或发初始帧。
- `desktop-continuous` 保持 direct continuous；`web-remote-replayable` 只通过 replayable
  snapshot/gap/resync 恢复。
- workspace 隔离始终使用 `workspaceIdentity?.trim() || workspacePath`，路径只用于执行 cwd。
- 每个 timeout 都有 owner、预算、取消传播和迟到结果处理；不能仅依赖默认 3 分钟 client watchdog。

## 7. 当前验证记录

- `node scripts/check-workspace-freshness.mjs`：通过；当前分支相对 `origin/main` ahead 31 / behind 3。
- 已运行 `v4-gateway.test.ts` + `v4-cold-resume.test.ts`：当前基线有 4 个失败（其中 3 个 cold integration
  sendText、1 个 stale retry）；这些失败不是临时探针引入，但 remote identity 那一项与 C19 直接相关，
  需要单独归因。
- 已运行 R1、R2 两个临时 deferred/真 sqlite 探针：均按预期暴露当前实现问题；临时测试已删除，
  本次没有修改运行时代码。

## 8. C01–C20 执行结果（2026-08-28）

本轮按“有限 case 矩阵”执行，不声称穷举所有 Promise 微时序。新增探针只在本地临时加入对应
测试文件，运行后删除；现有测试文件按相关入口全量运行。

| Case | 实际结果 | 证据 / 结论 |
| --- | --- | --- |
| C01 | 暴露竞态 | 两个相同 `sessionId` 的 legacy resume 创建 2 个 app。确认 R2。 |
| C02 | 暴露竞态 | 携不同 `runtimeModel` 的并发 resume 仍创建 2 个 app；模型配置不能替代 activation owner。 |
| C03 | 暴露语义错误 | cold hydration 读取抛错仍返回成功空 snapshot；确认 R1。 |
| C04 | 通过 | 桌面 continuous 与手机 replayable 并发 subscribe 只调用一次 activation，首个 snapshot 一致。 |
| C05 | 暴露竞态 | activation 尚未结束时 `disposeSession`，旧 continuation 仍创建 publisher 并返回 snapshot；确认 R4/C05。 |
| C06 | 通过 | `rowsRange‖subscribe` 与 READY 中的 command/query 共享既有 gate，未见重复 activation。 |
| C07 | 通过但需保持契约 | command 先于 READY 注册时返回 `proto.sessionNotFound`；这是当前“调用开始时快照”语义，不是自动等待语义。 |
| C08 | 通过 | `attachment/begin‖subscribe‖command` 共用一次 activation；begin 不等待 hydration 的边界被固定。 |
| C09 | 通过 | `attachment/read` 在 detached/cold 情况下等待 host activation + projection hydration。 |
| C10 | 暴露语义风险 | warm publisher 的持久读取失败被吞掉，仍返回 snapshot，同时记录 `v4.hydrate` 错误；正文未被清空时影响较小，但错误/成功不可区分。 |
| C11 | 通过 | hydration await 窗口的 live queue/stream 会合并回 projection，seq 保持单调。 |
| C12 | 通过 | `waitForSessionIdle` 5 秒超时会 fail closed，不重发 queue item；旧锁未释放时不会误发新 turn。 |
| C13 | 通过 | stop/foreground execution id 更换的 promotion lease 防住 notification 抢入。 |
| C14 | 通过 | projection commit 25 秒 timeout 后固化 failure，迟到 raw event 不再 apply。 |
| C15 | 通过 | physical wire 30 秒 assembly timeout 的 recovery/fail-closed 用例通过。 |
| C16 | 通过 | UI session data layer 在 runtime restart / transport replace 后丢弃旧 generation ACK/frame。 |
| C17 | 局部通过 | restore helper 在两个 deferred restore 交错时各自返回匹配结果；但它本身无共享 owner，不能证明上层 store/broadcast 没有旧 snapshot 覆盖。 |
| C18 | 通过 | provider registry → cold subscribe 顺序、模型切换缓存和 stale model 保护用例通过。 |
| C19 | 部分通过 | UI/服务层 remote `workspaceIdentity` 隔离用例通过；cold-resume 集成里的 remote identity + sendText 仍命中本分支既有失败。 |
| C20 | 暴露低风险选择问题 | usage 绑定任意第一个 active client；该 client 在请求中被 dispose 时请求失败，不自动切换第二个健康 client。 |

额外 timeout 检查：`PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs=10_000` 仍无消费点；
`ZCodeProtocolClient` 的默认请求 watchdog 测试确认实际默认值为 180 秒。因此 R3 是静态确认的
契约缺口，还没有用真实 10 秒等待做慢 query 集成测试。

本轮实际测试汇总：

- bootstrap 相关 7 个文件：246 tests，242 passed，4 个既有失败（3 个 cold integration sendText，
  1 个 stale retry/file rewind）；新增 C01/C02/C03/C05/C07/C08/C10 探针按上表暴露/通过。
- services 相关 4 个文件：118 passed。
- UI 相关 6 个文件：172 passed；另加 C17 临时 deferred 探针通过。
- shared/client/task-index 相关 4 个文件：126 passed。

因此当前应把 R1、R2、R4/C05 视为已复现缺陷，把 C10、C20 视为需要产品语义决策的风险，
把 C19 的 remote sendText 失败与本次 resume 竞态分开归因。

## 9. R1、R2、R4/C05 修复设计（实现前置 spec）

### 9.1 状态 owner 与边界

状态不要集中到 V4 gateway，也不要放到 renderer。运行时生命周期和投影恢复是两层不同的状态机：

```text
workspaceKey + sessionId
        │
        ▼
┌──────────────────────────────┐
│ SessionActivationRegistry     │  CLI / protocol server，共享 legacy + V4
│ idle → activating → active    │
│       ↘ failed / cancelled    │
│ flight: promise + generation  │
└──────────────┬───────────────┘
               │ activation result（唯一 runtime owner）
               ▼
┌──────────────────────────────┐
│ V4 projection gate            │  gateway，仅负责 ready/hydration
│ idle → hydrating → ready      │
│       ↘ failed / cancelled    │
│ publisher / raw seq / buffer  │
└──────────────────────────────┘

deactivate / dispose
        │
        └─ invalidate generation + abort
             └─ 旧 continuation 检查 token 后只能 noop / reject
```

| 状态 | 权威位置 | 不应承担的职责 |
| --- | --- | --- |
| runtime 是否已激活、record/app owner | `context.sessions` + `SessionResidentPool`，由 `SessionActivationRegistry` 串行化写入 | gateway 的 `readyFlights`、UI pending overlay |
| activation 并发协调 | protocol server/bootstrap 共享的 `activationFlights`，key 为 `workspaceKey + sessionId` | 仅放在 V4 gateway（legacy `session/resume` 会绕过）|
| V4 hydration/READY | gateway 的 projection state、`readyFlights`、publisher/raw sequence | 反向决定 runtime 是否存在 |
| durable history | persisted session/event store | 将读取失败当作空数组 |
| command admission/idempotency | CLI `CommandInbox` + durable command facts | renderer ACK 或 gateway 自建第二队列 |
| UI 旧请求过滤 | UI 本地 generation/pending overlay | 作为 session/runtime 的真相来源 |

`workspaceKey` 必须统一为 `workspaceIdentity?.trim() || workspacePath`；远程 workspace 还要贯穿
`workspaceIdentity` 与 `remoteSessionId`，不能只用路径或裸 `sessionId` 做 activation key。

### 9.2 R1：持久化 hydration 必须 fail closed

当前 `performHydration` 把 `loadPersistedEvents` 异常转换为成功的空 projection。这会把“读取失败”
伪装成“历史确实为空”，并让订阅方收到 `ack.mode=snapshot, revision=0`。

修复契约：

1. `performHydration` 保留原始错误 cause，转换为带 session/key 的 typed V4 fault 后向上抛出；不能返回
   `events: []` 作为错误兜底。
2. gateway 为每个 key 记录 `idle | hydrating | ready | failed | cancelled` 和 generation。失败时只清理
   **同一 flight**，不创建 publisher、不写 initial frame、不推进 revision；下一次请求用新 generation 重试。
3. durable store 的“成功空结果”和“读取失败”在类型、日志和 wire 语义上必须可区分。日志只做诊断，不能
   改写协议结果。
4. 若已有健康 warm publisher，是否允许继续返回旧快照必须写进调用契约：需要 fresh durable read 的入口
   仍应失败；不能无条件吞错。desktop `continuous` 与 mobile `replayable` 都遵守同一 fail-closed 边界。

### 9.3 R2：把 activation single-flight 放到共享 runtime owner

当前 `activateSessionForResume` 在 `waitForDeactivation`、持久化读取和 materialize 之间没有共享 promise，
两个 legacy resume 可同时看见“无 record”，各自创建 app，最后一次 `context.sessions.set` 覆盖前一次。

修复契约：

1. 新增 bootstrap/protocol server 级 `SessionActivationRegistry`（或等价的 shared owner），API 至少包括
   `ensureActivated(key, hints, signal)` 与 `invalidate(key, reason)`。
2. `ensureActivated` 在第一次 `await` 之前同步 `get-or-create` flight；后续 caller 只能 await 同一 promise。
   flight 内完整执行：等待 deactivation → 再查 `context.sessions` → load/materialize → 注册 record/app →
   `resume`。legacy `session/resume`、V4 cold gate、attachment/host bridge 必须调用这一入口。
3. finally 只能用 identity/generation 检查清理 map，旧 flight 不得清掉新 flight。失败不缓存 rejected promise；
   允许下一次请求用新 flight 重试。
4. 并发 `runtimeModel` hint 不能再 last-writer-wins。建议 persisted model 是 canonical；无 persisted model
   时由首个 activation caller 决定，后续冲突 caller 不得改写已激活 runtime（若产品需要显式反馈，再增加
   typed `session.activationConflict` fault）。该策略要补入协议 spec 和测试。
5. activation 成功后若发现 generation 已失效，不得把 app 注册成当前 owner；应 best-effort close/cleanup
   新建 app，并向等待方返回 cancelled/stale，而不是留下不可见 runtime 泄漏。

`readyFlights` 仍可保留，但它只是“activation + hydration 的 V4 投影屏障”；不能成为第二个 runtime owner，
也不能让 gateway 自己 materialize session。

### 9.4 R4/C05：取消、代际和迟到 continuation

当前 `ColdSessionResumeCoordinator.clear()` 只清 map，不取消底层 Promise；`disposeSession`/`deactivateSession`
也没有让正在 activation/hydration 的 continuation 失效，因此 dispose 后旧 continuation 能重新创建 publisher
并发出 snapshot。

修复契约：

1. activation 与 hydration flight 都携带 `{ operationId, generation, AbortController, state }`。`disposeSession`、
   `deactivateSession` 和 gateway dispose 先调用共享 `invalidate(key)`，再删除 publisher/buffer 等派生状态。
2. 在每个可产生副作用的 await 前后检查 token：至少覆盖 load 完成、buffer 创建、`ensurePublisher`、
   `hydratedSessions`/`rawSequenceStates` 写入、initial frame flush。token 非 current 时只能 noop/reject。
3. 能传 `AbortSignal` 的 host/store/app API 传递 signal；第三方 Promise 无法取消时，generation check 仍是
   必需的安全栅栏。
4. dispose 发生在 activation 尚未完成时，订阅必须收到 typed cancelled/disposed error，不能成功返回 snapshot。
   若底层 app 之后才创建出来，activation owner 必须关闭它，且旧 finally 不能触碰新 generation 的状态。
5. `clear()` 不应只做 `flights.clear()`；至少按 key 取消并标记全部 flight，清理动作必须和 flight identity 配对。

### 9.5 实现顺序与必须补的测试

先将当前临时探针固化为永久测试，再改实现：

- R2：重复执行 C01/C02（相同/不同 model），断言 app 创建次数为 1、record identity 唯一、冲突 hint 行为确定。
- R1：C03/C10 读取失败必须 reject 且无 frame/revision 写入；修复 store 后新 generation 可成功重试；成功空历史仍可正常返回。
- R4/C05：在 activation/hydration 的每个 await 窗口前后执行 dispose/deactivate/dispose gateway，断言无 publisher、
  无初始帧、无旧 map 写入、无 stale runtime 泄漏；同时覆盖旧 flight finally 晚于新 flight 的顺序。
- 回归：desktop `desktop-continuous` 与 web `web-remote-replayable` 并发入口、remote identity、attachment、
  command FIFO 均走同一个 activation owner，不把 replayable 恢复语义扩散到 desktop 主链路。

实现时应先补上述单测/集成测试，再改运行时代码；完成后运行 `pnpm typecheck`、`pnpm lint` 及受影响 E2E。
