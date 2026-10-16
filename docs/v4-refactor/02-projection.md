# Conversation Product Projection 当前实现

更新日期：2026-07-15

`ConversationProductProjection` 是 CLI 面向 App/Web 的会话读模型。产品语义以
[conversation-product-protocol.md](../conversation-product-protocol.md) 为准，wire schema 以
`packages/shared/src/zcode-protocol-v4/` 为准；本文说明当前代码如何从 runtime 事实生成并恢复该投影。

## 权威链路

```text
runtime SessionEvent / persisted transcript
  -> event-normalizer.ts             统一 live/cold 的 canonical fact
  -> ProductProjection               归约 control/config/queue/rows 等产品态
  -> ConversationTopicPublisher      生成 snapshot/delta、seq、logEpoch
  -> Host connection scope           只做订阅 ownership 与 frame 转发
  -> ConversationProjectionStore     原子 apply，不重新解释业务事件
  -> SessionPane                     按 rows 与显式 availability 渲染
```

当前实现入口：

- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/event-normalizer.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/sessionDataLayer.ts`

## 投影拥有的状态

snapshot 的 A 区显式承载：

- `control`：phase、stop 状态、active works、最近错误与 API retry；
- `availability`：fork、compact、模型/模式切换、queue 操作、goal 操作是否可用；
- `inputRouting`：`startNow | enqueue | guide | reject | choice`；
- `meta`、`config`、`usage`；
- `queue`、`pendingInteractions`、`pendingCommands`、`backgroundWorks`；
- `goal`、`plan`；
- `rows` 与窗口信息。

UI 不得再从消息数组、最后一条消息、tool 状态或本地 task runtime 推导这些字段。renderer 只拥有
draft、焦点、滚动、布局以及按 `commandId` 关联的临时 optimistic overlay。

## 五种 delta

增量集合是封闭的：

```text
row.appended { row }
row.upserted { row }
row.removed  { fromRowId }
row.delta    { rowId, path, append }
state.updated { patch }
```

`state.updated` 对键整体替换，禁止深合并；`row.removed` 从指定 rowId 起截断。无法由这五种操作
无歧义表达的结构变化必须触发 snapshot/resync，不能在客户端新增修补算法。

每个用户输入、timeline marker 或 child-session 事实尽量保留 `sourceCommandId`。它是命令去重、
ACK 丢失后的 `commands/query` 以及 optimistic overlay 收口的共同锚点。

## Live 与 cold 恢复

CLI 事件日志是进程内有界日志，不是跨重启的持久化事实。正常运行时，publisher 从 live canonical
events 增量推进 projection；CLI 重启或首次冷订阅时，`transcript-hydration.ts` 从持久化的
message/part、timeline part、session input ledger 与 session metadata 合成等价事件，再交回同一个
normalizer/projection。

因此当前保证是“同一份持久事实恢复到相同产品终态”，不是“任意历史 revision 都可回溯”。如果
live 日志只覆盖部分 transcript，gateway 会按 footprint 检查选择完整 hydration/merge，禁止在 UI
旁路渲染数据库消息。

## 订阅与投递边界

- desktop 使用 `desktop-continuous`：保留在线流式 `row.delta`；
- mobile remote 使用 `web-remote-replayable`：依赖 snapshot/gap 恢复，可过滤不可重放的中间 delta；
- profile 可以改变中间帧，不能改变 command、row 终态或最终 projection；
- 每个 connection/subscription 独立维护 ownership、seq、logEpoch 与恢复代际；
- Host、desktop main 与 relay 不保存 projection，也不建立第二个 reducer。

## 长会话窗口

schema 已定义 rows window 与旧行范围读取语义。客户端必须以 snapshot 提供的窗口为准，不能假定每个
snapshot 永远包含完整历史。当前 UI 对超长历史的完整 `loadOlder` 交互仍属于待补能力；在其落地前，
这是一项明确限制，而不是由客户端扫描 legacy message 补齐的理由。
