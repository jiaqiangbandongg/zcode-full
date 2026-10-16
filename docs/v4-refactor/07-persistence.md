# V4 持久化与冷恢复当前规格

更新日期：2026-07-15

V4 的持久化原则是：transcript、timeline anchor、session metadata 和输入生命周期是长期事实；
projection、topic event log、subscription、CommandInbox LRU 和 active runtime work 是可重建或进程内状态。

## SQLite 事实

CLI session store 位于 `~/.zcode/cli/db/db.sqlite`。迁移入口是
`apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`，当前迁移到 `0018`：

| 迁移 | 当前作用 |
| --- | --- |
| `0014_message_part_sequence` | 为 message/part 建立稳定顺序 |
| `0015_message_part_sequence_backfill_and_guard` | 修复空 sequence，并用 trigger 保证后续写入 |
| `0016_session_input_ledger` | 新增 durable input lifecycle ledger |
| `0017_session_input_start_now_delivery` | 将 `startNow` 纳入输入 admission 账本 |
| `0018_session_input_failed_status` | 区分 accepted 后运行时启动失败的终态 |

message/part 仍采用索引列加 JSON data 的 additive 演进。可选锚点缺失时读侧宽容兼容；需要查询、唯一性
或事务约束的结构才通过 append-only migration 增加。

## Transcript 与 timeline anchor

`MessageProjectionAnchor` 当前可保存：

- `turnId`、`productTurnId`；
- `origin`；
- `sourceCommandId`；
- stable fork 的 ordered/boundary message ids 与 goal boundary。

timeline part 保存 compact、goal verification、fork、model change 等可见 marker，并可带
`sourceCommandId`。新写入必须尽量保留这些锚点；历史数据缺字段时由唯一 resolver 降级解释，禁止由
多个 UI/helper 各写一套启发式。

stable fork 复制 conversation 事实时必须重写 child-local 引用。指向未复制父消息的本地 anchor 要清空，
只把原引用保留为 provenance；不得让 child 恢复时重新读取 parent 当前状态冒充 fork 时状态。

## 输入生命周期账本

`session_input` 记录：

```text
admitted
  |-- promoted  -> 与 transcript user message 原子关联
  |-- cancelled -> 用户删除或取消
  |-- discarded -> 重启/清空 queue 等明确原因
  `-- failed    -> 已接受，但 runtime 无法启动
```

delivery 是 `startNow | guide | queue`。id 与 `sourceCommandId` 对齐，payload 保留完整
`ConversationInputIntent`，包括附件、提交端与 dispatch 信息。

该表解决“ACK 后、消息落库前崩溃导致输入无痕消失”的问题，但不意味着 CLI 重启后自动执行旧输入。
resume 时遗留 `admitted` 记录转为 `discarded(session_resumed)`；`commands/query` 可返回明确失败事实，
再由用户决定是否重新提交。

## Command 幂等事实

不建立持久化 CommandInbox 表。settled LRU 之外，`commands/query` 从以下持久来源重建结果：

1. transcript anchor；
2. timeline part；
3. child/session entry command fact；
4. input ledger 终态。

查询必须按 `(sessionId, commandId)` 精确命中。global `createSession` 通过 command id 对应的 input/child
事实找回真实 session，不能只靠 title、workspace path 或最近创建时间猜测。

## Cold hydration

V4 冷订阅遵守：

```text
persisted message/part + timeline + session input + session metadata
  -> transcript-hydration / cold-event-merge
  -> canonical SessionEvent
  -> ProductProjection
  -> snapshot + 新 logEpoch
```

恢复覆盖 text、reasoning、tool、subagent、compact、goal、model/config、queue/input 终态等可见事实。
历史 `pending/running` tool 或 active work 不能在 CLI 重启后伪装成仍执行；hydration 必须收口成只读历史
终态。compact marker 的权威顺序仍是新 timeline part 优先，legacy compaction boundary 只用于 runtime
history，不应重复渲染可见横条。

事件日志只用于当前 CLI 进程内的有界 resume。logEpoch 变化表示旧 base 失效，客户端必须接受新 snapshot；
不能把数据库 message 直接送给 renderer 绕开 projection，也不能把旧 seq/revision 当成跨进程稳定游标。

## Draft 与运行态边界

- 纯 draft session 可出现在 sessions-index，但没有 transcript 时不会作为长期会话事实恢复；
- active runtime work、pending network request 与 subscription 不持久化；
- queue 的可见 input 有 durable ledger，但重启不自动恢复执行；
- desktop continuous 与 mobile replayable 共享上述持久事实，恢复帧仍按各自 delivery profile 生成。
