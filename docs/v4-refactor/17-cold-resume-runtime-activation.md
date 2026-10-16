# V4 冷恢复：Runtime 激活与 Legacy Snapshot 解耦

> 状态：2026-07-24 accepted；2026-08-13 增补单次物化与单一 READY 水位合同。
> 范围：V4 conversation 首次冷订阅；不删除 legacy `session/resume` 协议，也不迁移 Bot 实时订阅。

## 1. 问题

改动前，CLI 冷启动后首次打开持久会话，V4 订阅间接复用 legacy `resumeSession`：

```text
v4/conversation/subscribe
  -> legacy cold-resume adapter
  -> legacy resumeSession
       ├─ 创建 record / runtime
       ├─ 恢复 workspace、模型、thought、mode、restoreWarning
       ├─ app.resume() 与事件接线
       └─ 构建完整 ZCodeSessionStateSnapshot  ──> 返回值被 V4 丢弃
  -> V4 durable transcript hydration
  -> getSessionUsageSeed
       └─ legacy readSession/full snapshot   ──> 只读取 runtime.contextUsage
  -> V4 initial snapshot
```

这里混合了两种职责：

1. **runtime 激活**：V4 后续命令和 config seed 必须依赖；
2. **legacy 表示层物化**：只为旧 `session/resume` 响应服务。

V4 已由 durable transcript、session entry、memory event 和 `ProductProjection` 生成自己的权威
snapshot。继续构建 legacy snapshot 不增加恢复能力，只会让耗时随历史 messages/parts 规模重复增长。

## 2. 目标边界

```text
                         ┌─ legacy session/resume
persisted session        │    -> activateSessionForResume
        │                │    -> build legacy snapshot -> legacy caller
        v                │
activateSessionForResume ┤
  ├─ persisted metadata  │
  ├─ workspace identity  └─ V4 cold subscribe
  ├─ record + event sink      -> activateSessionForResume
  ├─ model/thought/mode       -> V4 durable hydration
  ├─ restoreWarning           -> narrow context-usage seed
  └─ app.resume()             -> V4 initial snapshot
```

`activateSessionForResume` 是 profile 无关的 lifecycle primitive：

- record 已存在时不重复 `app.resume()` 或事件接线；显式 `runtimeModel` 仍按旧语义刷新；
- record 不存在时完整保留原 `resumeSession` 在 `snapshot(...)` 之前的全部行为；
- store 无 session、模型不可用、runtime resume 失败等错误与旧路径一致；
- 不根据 `desktop-continuous` / `web-remote-replayable` 分支。两者只在激活完成后的 V4
  publisher delivery profile 分流。

legacy `resumeSession` 继续作为兼容包装层：

```text
resumeSession = activateSessionForResume + snapshot
```

因此旧协议调用者、Bot 尚未迁移的 legacy 状态读取和测试语义不变；本次只让 V4 冷订阅调用
activation-only primitive。

## 3. 不得损失的功能

| 不变量                        | 约束                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| runtimeReadyBeforeHydration   | `app.resume()` 完成后才读取 V4 config/usage seed 和发布首帧                                                |
| historicalConfigPreserved     | 历史 model、thought、mode 继续按 session-local durable selection 优先恢复                                  |
| restoreWarningPreserved       | 历史模型不可用时仍允许读历史，但后续 `sendText` 被同一 restore warning 闸门拒绝                            |
| workspaceIdentityPreserved    | 远端恢复继续使用持久化 `workspaceID`；identity key 不退化为 `workspacePath`                                |
| eventWiringPreserved          | `createRecord` 建立的 event sink、persistence、MCP/runtime 接线不改变                                      |
| timestampsAndParentPreserved  | `createdAt`、`updatedAt`、`parentSessionId` 继续从持久会话回填                                             |
| v4HistoryAuthorityUnchanged   | rows、reasoning、tool、plan、goal、queue 和 interaction 仍由 V4 durable materialization + memory tail 恢复 |
| deliveryBoundaryUnchanged     | desktop 保持 continuous；mobile/Web remote 保持 replayable gap/snapshot 恢复                               |
| restartDiscardUnchanged       | 上一 runtime 未终态 input 仍按 delivery ledger discarded；不得因去掉 legacy snapshot 自动重放              |
| legacyResumeResponseUnchanged | `session/resume` 仍返回完整、schema 等价的 legacy snapshot                                                 |
| v4ColdReadySingleOwner         | V4 gateway 只用一个 cold READY promise 串联 activation 与 hydration                                       |
| hydrationBoundaryUnchanged     | `hydratePublisher` 仍只负责 projection hydration，不接管各入口既有的 runtime activation 前置条件          |
| registryIsNotV4Readiness       | `context.sessions` 只登记 record；V4 cold operation 完成前不能据此放行 query/command                      |

pending permission/elicitation 和当前 runtime queue 不是旧进程可无条件复活的 durable 事实。本次不增加、
删除或改写它们；新 runtime 的 V4 memory event tail 仍是在线权威。

## 4. Usage 窄投影

V4 冷恢复不能为了 `runtime.contextUsage` 再调用 `readSession`。窄投影必须复用 legacy snapshot
当前的同一计算口径：

```text
runtime projection contextUsed/contextWindow
  + active-branch persisted context usage/cache
  + latest matching main-turn ModelComplete breakdown
  -> ZCodeSessionContextUsage
  -> SessionUsageSeed
```

必须保留以下细节：

- runtime `contextUsed` 非零时优先；否则回落 active branch 最近的 assistant tokens 或
  compact boundary，具体口径见 `docs/context-window-usage-state.md`；
- cache 汇总只统计 active branch 的非 summary assistant messages；compact boundary seed
  不复活压缩前 cache；
- breakdown 只接受 main-turn、且 `used/contextWindow` 与 meter 对齐的最新 `ModelComplete`；
- 非正数 used/window 返回 `null`，保持“尚无一次模型往返”语义；
- 不读取/映射 legacy messages、settings、todos、goal、slash commands 或 model availability。

### 4.1 单次冷恢复物化

大 session 的首次 V4 冷订阅中，settings、runtime resume、durable hydration、subagent manifest
和 usage seed 使用的是同一批持久 message/part。正常路径只允许在 activation 起点完整读取一次，
后续消费者通过当前冷恢复调用栈复用该数组：

```text
activateSessionForResume
  messages() ──> M0
       ├─ derive runtime settings(M0)
       └─ app.resume({ persistedMessages: M0 })
              |
              ├─ 未修改持久 message/part ───────────────> M0
              └─ 修补中断 compact timeline ─> messages() ─> M1
                                                        |
                                                        v
gateway readyFlights[sessionId](M0 | M1)
  ├─ durable transcript
  ├─ parent subagent manifest
  └─ late usage seed
```

约束如下：

- materialization 只存在于本次 cold-resume promise 与紧随其后的 hydration 调用栈；不得挂到
  session record、不得建立 `sessionId -> messages` 长期缓存，也不增加 TTL、失效广播或数据库 schema；
- runtime 仍先取得持久 session，再消费注入的 messages；只有 V4 cold activation 显式选择
  复用本次 materialization，普通 core 与 legacy `session/resume` 不注入 messages，继续由 runtime
  自己读取，保持原入口语义；
- runtime resume 若把 `started/retrying` compact timeline 收敛并写回 store，activation 必须刷新
  一次 messages 后再交给 V4。仅该修补路径允许两次完整读取，正常路径必须严格为一次；
- durable hydration 继续读取最新 session metadata、target、session entries 与 memory events；复用
  messages 不得冻结 rewind/target/event 水位；
- usage seed 继续在 hydration 补完 live buffer 后读取最新 session/events/runtime projection，只把
  已物化 messages 作为输入，保持“新 `ModelComplete` 高于冷种子”的既有顺序；
- subagent manifest 只复用 parent messages；child session 仍各自读取自己的持久事实，不能误把
  parent materialization 扩散成跨 session cache；
- 并发 desktop continuous / web remote replayable 首订阅共享同一个 READY promise 和
  materialization，但 delivery profile、gap/resync 与首帧终态语义不变。
- gateway 每个 cold session 只维护一个 `readyFlights` entry，串联
  `activate runtime -> hydrate projection`。注册 entry 必须早于 activation
  开始；并发 cold 入口若已看到该 entry，必须等待同一个终态。改动前已有的
  `ColdSessionResumeCoordinator` 仍只负责 runtime activation 单飞与错误分型，不作为 command/query
  的 READY 水位。
- `hydratePublisher` 保持原有 projection-only 职责和独立 hydration singleflight；不得在其中根据
  `sessionExists`、detached publisher 或调用方 option 决定是否 activation。各入口继续显式保留原有
  前置条件：普通 conversation 读取按 `hasLiveConversation` 判断，file rewind/attachment read 按
  `host.sessionExists` 判断。只有确实需要 cold activation 时才进入 `readyFlights`。
- command/query 只读取调用开始时已经存在的 READY promise；存在就先等待，随后只进入一次既有
  CommandInbox query/admission 流程。该流程内部原有的锁后复核保持不变；不得在 READY 外再增加
  “先查一次、等待、再查一次”，也不得由每个 query 包装 `.finally()`。READY 注册早于 activation，
  因而恢复窗口不会创建旧 command index；READY owner 不再额外失效该索引。
- 孤立 command/query 不自动激活历史 session。legacy `session/resume` 与 `attachment/begin`
  保持原有入口，不并入本次 READY 协调，也不新增跨入口 singleflight。
- `fault.command.queryUnavailable` 只表示 transcript/timeline/child/discarded 持久事实读取失败。
  activation/hydration 的异常保留原始生命周期错误，禁止伪装成 command query 故障。
- READY 失败沿用原 activation/hydration 的既有错误与清理语义；gateway 只释放本次 map entry，
  避免永久复用已 rejected 的 promise，但不改变 `context.sessions` 的既有生命周期。只有 record 入册前
  失败时，后续请求才会重新进入 cold activation；本次不承诺 record 入册后的自动回滚或重试，也不新增
  补偿事务或失败缓存。

### 4.2 单一 READY owner

```text
gateway readyFlights[sessionId]
  absent
    -> READYING(activate runtime -> hydrate projection)
    -> absent + READY publisher

hydratePublisher(sessionId, persistedMessages?)
  -> 只复用 hydrationInFlight
  -> 不负责 runtime activation

incoming query / command
  const ready = readyFlights.get(sessionId)
  if (ready) await ready
  enter the existing CommandInbox flow once
```

状态边界如下：

- `context.sessions` 继续只负责事件接线；V4 query/command 的等待依据只有 gateway READY promise；
- 只有从未在册持久 session 开始的 cold READY 阻塞 query/command；既有 live session 的首次
  projection hydration 保持原 command 调度语义，不扩大这次 M0 修复的等待范围；
- host-dependent 读取继续在自己的入口保证 record 已恢复，不把更强前置条件编码进共享
  `hydratePublisher`；
- 改动前已有的 activation singleflight 保持原职责；CommandInbox 不维护或派生 readiness promise；
- READY owner 在成功或失败后释放 map entry；这只证明失败 promise 不会被永久缓存，不等价于整个
  activation 在任意失败点都可重试；
- resident pool 继续独立覆盖 eviction close，显式 `session/close` 保持既有产品删除语义；
- desktop continuous 与 web remote replayable 仍只在 projection ready 后选择 delivery profile。

## 5. 剪枝后的验证矩阵

不枚举所有客户端 × 所有会话状态。activation 发生在 delivery profile 分流前，按不变量选择代表样本：

| 代表样本                                | 验证重点                                                                              | 证据层                    |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| completed 本地历史 + desktop continuous | 历史 rows/tool/reasoning、续发、幂等、无 legacy snapshot 物化                         | bootstrap 集成            |
| completed 远端历史                      | workspace identity、provider registry、续发                                           | 既有 V4 cold-resume 集成  |
| 历史模型/thought/mode                   | session-local 配置与 thought hint 优先级                                              | 既有 I63 / bootstrap 集成 |
| 模型不可用                              | restoreWarning 读写边界                                                               | 既有 bootstrap 集成       |
| completed child                         | child cold hydration、只读导航                                                        | SAT09 既有证据            |
| mobile replayable                       | 与 desktop 首个完整终态等价；gap/resync 语义不变                                      | PV4-06/25 既有协议证据    |
| legacy `session/resume`                 | 完整 snapshot 和 context usage 保持                                                   | legacy protocol 单测      |
| 大会话 PERF03                           | activation 不构建 legacy snapshot；正常冷订阅只完整读取一次 parent messages；记录趋势 | 性能 fixture              |
| 并发 V4 subscribe/query/command          | 共享一个 READY promise；READY 前零查询、零 admission                                   | bootstrap 单元/集成       |
| READY 失败                              | command/query 不进入 inbox，保留原 lifecycle error；record 入册前失败会释放 READY entry | gateway 单元               |

## 6. 非目标与后续

本次不处理以下相邻 over-fetch，避免扩大回归面：

- V4 `createSession` / fork registration 为取得少量字段构建 legacy snapshot；
- Bot 的 legacy continuous subscribe、附件发送与状态查询；
- 删除 legacy `session/resume`、`readSession` 或 snapshot schema；
- 修改 publisher batch hydration、wire fragment、rows window 或 React 渲染。

这些路径应单独按调用者迁移并留下自己的功能矩阵，不能借本次 cold-resume 优化一并删除。

## 7. 2026-07-24 实测

环境：Apple Silicon、本地 production `app-server`、每个样本启动全新 CLI 进程；同一 workspace、
同一 session、同一 `desktop-continuous` subscribe。对照组从改动前 HEAD
`e3efe9006ad7489b83d1efca917b3c0df32add69` 的 detached worktree 独立构建，避免用旧安装包或
不同源码比较。文件缓存预热后各跑三次。

fixture `sess_perf_large_20260724034221_af2e36b8`：

- 2,000 messages / 6,671 parts（约 1,000 turns）
- 2,000 tool parts、334 reasoning、200 patch、60 todos
- 两组 initial V4 physical frame 均为 143,690 bytes

| 实现                                                               | 三次 cold process → initial frame |    中位数 |
| ------------------------------------------------------------------ | --------------------------------- | --------: |
| 改动前：V4 activation 构建 legacy snapshot，usage 再 `readSession` | 3352.1 / 3169.5 / 3070.2 ms       | 3169.5 ms |
| 改动后：activation-only + usage 窄投影                             | 2704.8 / 2701.5 / 2607.6 ms       | 2701.5 ms |

同机中位数减少 **468.0 ms（14.8%）**。此前该 fixture 的单次 legacy `readSession` 日志为
281–288 ms；两次 full snapshot 被移除后的端到端差值与该量级一致。这个数字仅作为本机回归证据，
不构成跨机器 SLA。

最终 production bundle 重建后，又以 Agent ready 作为起点跑了三次：

| 边界                               | 三次耗时                    |    中位数 |
| ---------------------------------- | --------------------------- | --------: |
| ready 后 subscribe → initial frame | 2040.1 / 1998.0 / 1936.5 ms | 1998.0 ms |

完整 `v4/conversation/frame` NDJSON notification（含换行）均为 143,691 bytes，stderr 为空。此前
process → initial frame 的约 2.7 秒还包含约 0.69 秒的进程启动/ready 阶段，因此两种口径一致，
不能把全部等待时间都算给 runtime activation 或 legacy snapshot。

同一 fixture 的单次阶段探针显示：持久 messages 读取/解码约 56.8 ms，transcript synth 约
49.9 ms，`ProductProjection` hydrate 约 679.9 ms，当前 usage 窄读取再次读取 active-branch
messages 约 60.0 ms。探针来自诊断 run，不与上表逐项强行求和；它只代表该 2,000-message
fixture，不能外推到 10,000-message 以上的工单形状。

2026-08-12 使用 PERF03-E 的 10,622 messages / 35,811 parts fixture 重新计数后，production
正常冷订阅会完整物化父 messages 5 次；单读中位数为 385.1ms，4 次重复读取的直接成本上界约
1540.6ms。落实本节 4.1 的 operation-scoped 复用后，fresh-process subscribe → initial frame
中位数从 3991.9ms 降到 2681.6ms，减少 1310.3ms（32.8%）。两组保持 158038-byte frame、
29950 rows、60-row window、`toSeq=74164` 与 0 running subagents。完整测量与环境见
[`v4-conversation-cold-hydration.md`](../performance/v4-conversation-cold-hydration.md#perf03-h-单次冷恢复物化2026-08-12)。
