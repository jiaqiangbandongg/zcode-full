# 内存泄漏修复规划：CLI 内存 event store 的保留策略

状态：**已实现**（spec 见 `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`；用户已确认一 turn 滞后淘汰。本文保留为决策过程记录）

关联：审计报告 `docs/analysis/memory-leak-audit-2026-09-03.md`；观测能力 `docs/monitoring/memory-diagnostics-log.md`（已落地，`eventRows` 计数器就是本项的前后对照证据）。

## 一、审计隐患回顾与优先级

| 优先 | 进程 | 隐患 | 增长节奏 | 为什么排这里 |
| --- | --- | --- | --- | --- |
| **1** | agent CLI | `InMemorySessionEventStore` 把每个 `ModelStreaming`（逐 token）和 `ToolCallProgress` 事件永久驻留，append 还 `[...events, e]` 全量拷贝；无人调 `deleteSession` | **每 token 一条**，session 驻留期只增不减 | 唯一一个按 token 频率增长的点；所有长会话、所有用户都命中；桌面端 legacy `session/subscribe` 又把 session 钉死不回收，两者叠加就是"越用越大" |
| 2 | main | `will-download` 监听挂 defaultSession，关窗时跳过清理 | 每关一窗 +N 闭包 | 一行修复，独立 MR |
| 3 | main | `TaskRealtimeBus.streamBatches` 非终态 run 不删，还向新窗口重放 | 每次中断/断连 +1（≤512KB） | 几行修复，独立 MR |
| 4 | renderer | shiki `tokensCache` 无淘汰，流式 Edit 每 chunk 一条 | 每个 Edit 工具输出 +N | 加 LRU，独立 MR |
| 5 | renderer | task snapshot 内存缓存无上限 | 每打开一个 task +1 | 套用持久层已有的上限 |
| 6 | host | bots per-task 订阅只靠流内终态释放 | 每次远端断连/崩溃 +1 | 抽 `releaseTaskWatch` |
| 7 | agent CLI | subagent 子 session publisher 无父→子映射 | 每次 subagent +1 套 | 需父子映射 |
| 8 | host/services | RPC 断连不回收 pty / fs.watch；session close 不清镜像表 | 每次断连 / 每 session | 结构性，需统一边界 |

2～5 是小改动，可与本项并行各开一个 MR；本文只规划第 1 项。

## 二、修复目标与必须守住的合同

修复只改**保留策略**，不改接口、不改序号分配位置、不改 live sink 拿到的对象。下面每条都是代码里读到的事实，任何一条不成立就不能裁剪。

```text
                        AgentRuntime.appendEvent (core/src/runtime/methods/events.ts:101)
                                       │ eventStore.append → 补 sequenceNumber
                                       │ persistDurable → sqlite messages
                                       │ notifyEventSinks（live：V4 gateway / legacy sink）
                                       v
   ┌──────────────── InMemorySessionEventStore (adapters/src/storage/index.ts) ────────────────┐
   │ eventsBySession: Map<sessionId, SessionEvent[]>                                             │
   └──┬──────────────┬──────────────────┬──────────────────┬───────────────────┬────────────────┘
      │ getEvents    │ getEvents        │ getEvents         │ getEvents          │ getLatestSequenceNumber
      v              v                  v                   v                    v
 legacy 回放      V4 冷恢复          rewind/fork/         file-changes/       assistant-feedback /
 readProtocol-    v4-bridge:1506      checkpoint          subagent 子会话      v4-bridge:457
 SessionEvents    sourceEventSeq =    只 filter            只 filter            (+1 追加新事件)
 (server-ops:715) max(seq) ←风险     ModelComplete /      ToolCallResult /
 对 ModelStreaming                    RewindTriggered /    CheckpointCreated
 合批为 model.streaming               CheckpointCreated
```

| 合同 | 出处 | 对修法的约束 |
| --- | --- | --- |
| seq 单一来源 | `events.ts:79-82` 注释；`v4-gateway.ts:2375+ normalizeRuntimeEventSequence` 按 raw seq 连续 drain | 瞬态事件**仍必须经 store 分配 seq 并原样交给 live sink**；不能绕过 store |
| `getLatestSequenceNumber()+1` 生成新事件 | `assistant-feedback-persistence.ts:53`、`v4-bridge.ts:457` | 序号必须来自独立单调计数器，不能取"最后一个仍驻留的事件" |
| V4 冷恢复游标 | `v4-bridge.ts:1506-1516` 用 `max(events.sequenceNumber)` 作 `sourceEventSeq` | 裁剪后该值会偏小 → 改为 `getLatestSequenceNumber()` |
| legacy 协议 seq | `server-operations.ts:800 getProtocolEventSeq` 通过重放全部事件取 lastSeq | 改为直接读 record 上的 `lastSeq`（`server-types.ts:63` 已有） |
| V4 投影对流式事件的依赖 | `product-projection.ts:463` 只在 `isRunning()` 时消费 `ModelStreaming`；`cold-event-merge.ts:138` 把 `ModelStreaming/ModelComplete` 列为 TRANSCRIPT_DERIVED，已完成 turn 由 `transcript-hydration.ts:1480 synthesizeEventsFromMessages` 从持久化消息重新合成 | **进行中 turn** 的瞬态事件必须保留；**已完成且已持久化** turn 的瞬态事件是冗余的 |
| `ModelComplete.content` 携带全文 | `contracts/src/events/session.events.ts:566` | 完成 turn 的文本不依赖 delta |
| reducer / rewind / fork / checkpoint | `contracts/src/events/event-reducer.ts` 无 `ModelStreaming/ToolCallProgress` handler；各消费者只 filter 低频类型 | 不受裁剪影响 |
| usage 统计 `firstTokenAt` | `usage-observability.ts:373` 用 per-turn `events` 数组 | 不受影响 |
| legacy 回放行为变化 | `readProtocolSessionEvents` 会失去已完成 turn 的 `model.streaming` 合批 | 需确认 `session-mapper.ts` 对 `ModelComplete` 的映射携带全文（实现前第一件事） |

## 三、分阶段方案

### Phase 1：零语义变化（可单独上线）

- `append` 改原地 `push`，去掉 O(n) 拷贝；`getEvents` 保持返回拷贝（调用方有 `[...events]` 习惯，不冒险）。
- `getLatestSequenceNumber` 改独立单调计数器 `latestSeqBySession`。
- session 记录释放时调用 `eventStore.deleteSession(sessionId)`：`session/close`、创建失败、idle 去激活、进程退出四条路径（`bootstrap/src/zcode-protocol/server.ts` / `session-residency.ts`）。
- `v4-bridge.ts:1506` 的 `sourceEventSeq` 与 `server-operations.ts:800` 的 `getProtocolEventSeq` 改读计数器 / `lastSeq`（此时行为等价，先改好为 Phase 2 铺路）。
- 验收：现有全部测试绿；`eventRows` 在 session 关闭后归零。

### Phase 2：turn 窗口保留策略（真正的内存修复）

- 新增纯模块 `adapters/src/storage/session-event-retention.ts`：
  - `TRANSIENT_SESSION_EVENT_TYPES = {ModelStreaming, ToolCallProgress, StreamingToolLedgerUpdated, ModelNetworkStatus}`（单一出处，供 store 与文档引用）。
  - 状态机：`onAppend(event) → { retain: boolean; evictTurnIds: string[] }`。规则：瞬态事件按 `turnId` 分桶；观察到 `TurnStarted(T+1)` 时淘汰 `T` 及更早已 `TurnComplete/TurnError` 的桶（**一 turn 滞后**，给 sqlite 持久化留时间）；`RewindTriggered` 到达时不淘汰任何桶（rewind 期间的 turn 归属复杂，交给 `deleteSession`）。
  - 非瞬态事件永久保留（数量与消息同阶，本身有 compact 边界）。
- `InMemorySessionEventStore` 接受 `retention?: SessionEventRetentionPolicy`，默认 turn 窗口；`unbounded` 模式保留现状供回滚与对照测试。
- `getStats()` 增加 `evictedEvents`、`retainedTransient`，随内存诊断日志一起落盘，作为线上效果证据。
- 唯一可观察行为变化：legacy `session/events` / `session/subscribe afterSeq` 对**已完成 turn** 不再重放 token delta；当前 turn 与刚完成的上一 turn 仍可回放。写进 spec 与 `docs/conversation-product-protocol.md`。

### Phase 3（可选）

单 turn 内瞬态事件也设上限（防单个跑飞 turn），超限时把最早的 delta 合批成一条；等 Phase 2 上线后看 `retainedTransient` 分布再定。

## 四、如何测试

### 单元（先写）

| 用例 | 断言 |
| --- | --- |
| retention 状态机 | 瞬态事件在所属 turn 进行中 retain；`TurnStarted(T+1)` 后 `T` 桶淘汰；`T+1` 未结束前 `T+1` 桶保留；非瞬态永不淘汰；rewind 不触发淘汰 |
| store：seq 单调 | 淘汰后 `getLatestSequenceNumber` 不回退；`append` 返回的 seq 严格递增 |
| store：读路径 | `getEvents/getEventsAfter` 返回非瞬态 ∪ 窗口内瞬态，按 seq 排序；`deleteSession` 后 `getStats` 归零 |
| store：性能 | append 10^5 次线性（防回到 O(n²)），用现有 `ZCODE_PERF_REPRO=1` 门控写法 |
| Port 合同测试 | `describeSessionEventStoreContract(factory)` 同时跑 unbounded 与 turn-window 两种模式，保证接口语义一致 |

### bootstrap 集成（现有 + 新增）

- 必跑现有：`zcode-protocol.test.ts`（含 5 处 `model.streaming` 回放/seq 断言）、`v4-gateway*.test.ts`、`v4-cold-resume.test.ts`、`cold-event-merge.test.ts`、`transcript-hydration.test.ts`、`product-projection*.test.ts`、`session-resident-pool.test.ts`。
- 新增：
  1. turn 进行中 `session/subscribe afterSeq` 仍回放当前 turn 的 delta；
  2. 连续两个 turn 后回放只含消息与低频事件，protocolSeq 连续无洞；
  3. 冷恢复 `sourceEventSeq` 在淘汰后等于最新 seq，且 gap 补齐正确；
  4. raw seq 乱序到达（N+1 先于 N）在淘汰后仍能正确 drain；
  5. rewind / fork / checkpoint 在淘汰后结果与 unbounded 模式逐字节相同（两种模式跑同一脚本对比）。
- 基线已知无关失败：`v4-gateway.test.ts` "旧 revision retry"、`zcode-protocol.test.ts` "三类 v4 subscribe response"，修复前先在干净基线确认它们的状态，避免误判。

### 内存回归（新增）

`bootstrap/tests/session-event-store-retention.perf.test.ts`：`ZCODE_PERF_REPRO=1` 门控，`--expose-gc`，跑 N 个 turn × M 个 delta，断言 `getStats().events ≤ 非瞬态数 + 2 个 turn 的瞬态数`，且 `heapUsed` 增量有界；同一脚本在 unbounded 模式下作为对照输出。

### 手工 / E2E

- 桌面端连本地 CLI 跑 >30 分钟流式长会话，看 `~/.zcode/cli/log` 里 `memory_sample` 的 `eventRows` 曲线：修复前随 token 线性上升，修复后在 turn 间回落。
- V4 pane 与 legacy bot 流同时订阅、断网重连走 `afterSeq` 回放；rewind / fork / compact 后再回放。
- 跑 `pnpm test:e2e:container:conversation`（conversation 验证集覆盖 streaming / replay 语义）。

## 五、如何保证对其他模块修改的可测试性

1. **依赖注入取代硬编码构造**：`server-operations.ts:3493` 与 `:2883` 直接 `createInMemorySessionEventStore()`。新增 `context.deps.createSessionEventStore?(sessionId)`（`server-types.ts` 的 `ZCodeProtocolAgentDependencies`），默认 turn-window store；测试可注入 spy store 断言 append / delete 调用，也可注入 unbounded store 做 A/B 对照。`create-app.ts:558` 已有 `options.eventStore` 口子，沿用。
2. **策略与容器分离**：淘汰规则是无 IO 的纯状态机，单测穷举分支；store 只做"调用策略、维护 Map"。以后改规则不碰 store，也不碰任何消费者。
3. **一份 Port 合同测试**：`describeSessionEventStoreContract` 放 `adapters/tests`，现有 `core/tests/test-event-store.ts` 这个手写替身（与生产实现同款 O(n) 拷贝）删掉，core 的 40 处测试改用真实 store，消除"替身与生产行为漂移"这一类假绿。
4. **单一出处常量**：`TRANSIENT_SESSION_EVENT_TYPES` 从 contracts 导出，store、spec、`readStreamingDeltaBatchableEvent`（`server-operations.ts:382`）引用同一集合；新增事件类型时只改一处，测试断言该集合与 reducer 忽略集一致。
5. **消费者按 seq 契约而不是按数组长度**：把 `max(events.sequenceNumber)` 这类推断统一改为 `getLatestSequenceNumber()` / `record.lastSeq`，并为每个消费者补"淘汰后仍正确"的用例；这样未来任何保留策略变化都不会悄悄破坏游标。
6. **运行时断言**：`getStats()` 的 `events / evictedEvents / retainedTransient` 进内存诊断日志，线上可直接验证策略是否生效；perf 测试用同一 `getStats()` 断言上界。
7. **可回滚**：保留模式是构造参数，出问题把默认值切回 `unbounded` 即回滚，无需 revert 消费者改动。

## 六、交付顺序

1. `docs`：本文转 spec 到 `apps/zcode-cli/docs/design/v2/session-event-store-retention.md`，同步更新 `docs/design/v2/session-idle-deactivation.md`（record 释放时 `deleteSession`）与 `docs/conversation-product-protocol.md`（legacy 回放行为变化）。
2. `refactor(cli): in-place event append, seq counter, deleteSession on release`（Phase 1 + 消费者改读计数器 + DI seam + 合同测试 + 删除测试替身）。
3. `feat(cli): turn-window retention for transient session events`（Phase 2 + 新增集成/perf 用例 + getStats 扩展）。
4. 并行小 MR：main `will-download` / `streamBatches`，renderer shiki / snapshot LRU。

## 七、需要你决策的点

- 一 turn 滞后淘汰是否可接受（代价：内存里始终多保留一个已完成 turn 的 delta；收益：不依赖持久化时序）。
- legacy `session/events` 不再重放已完成 turn 的 `model.streaming`，桌面 replayable / bots 侧是否有依赖它渲染历史文本的地方（实现前先查 `session-mapper.ts` 的 `ModelComplete` 映射与 `packages/services/src/zcode-agent/zcodeAgentService.ts:5640` 的消费方）。
