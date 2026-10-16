# Conversation Row 结构共享

## 背景

2026-09-29 用隔离 HOME 和 mock provider 压测 renderer 时发现，前台 GC 后 JS heap 约 200MB，其中大字符串占 138MB。这些大字符串只有 36 个不同的值，却有 730 份副本。例如同一个 200KB 的工具 `inputText` 存了 112 份，它解析出来的 `input.content` 又存了同样多份。

有两个因素叠加导致了这个问题：

1. **历史快照被闭包链留住。** `SessionPane` 切 task 时复用同一个实例，挂载点没有 `key={sessionId}`。它的 `useCallback` 闭包共享每次渲染的 V8 Context，于是交替串成一条链，留住了历史各次渲染的 `state`，也就是 projection snapshot。实测留住 220 个渲染作用域、134 份 state。
2. **整份替换时行对象零共享。** `ConversationProjectionStore` 收到 `snapshot` 帧时按“规则 1”整体替换，行对象全部来自新反序列化的结果。`row.upserted` 也换成新对象。所以每份历史 snapshot 都各自持有一套大字符串，内容相同也不共用。

第 1 点决定了能留住多少份 snapshot，第 2 点决定了每份 snapshot 有多大。本方案修第 2 点：让内容相同的数据只保留一份，历史 snapshot 被留住时只多占数组和行壳的开销。

## 设计

```
host frame ──► ConversationProjectionStore.handleFrame
                 │
   snapshot 帧   │  rows.window 每一行 ──► rowPool.shareRow(topic, row)
   deltas 帧     │  row.upserted / row.appended 命中的行 ──► shareRow
                 │  row.delta 命中的行 ──► remember（只登记，不比较）
   rows/range    │  并入的更早行 ──► shareRow
                 ▼
          ConversationRowPool（SessionDataLayer 持有，生命周期长于 store）
            Map<topic␀rowId, WeakRef<row>> + FinalizationRegistry 清理
                 │
                 ├─ 池中旧行已被 GC 或不存在 → 登记新行，原样返回
                 └─ 旧行存活 → shareStructure(旧行, 新行)
                        深相等   → 直接返回旧行（引用不变）
                        部分相等 → 新壳 + 复用未变的子值（包括旧字符串引用）
```

- **池放在 `SessionDataLayer`，不放在 store 里。** keep-warm（默认 30s）过期后 store 会被 close，冷打开会新建 store。但此时旧 snapshot 可能仍被闭包链留着，池必须跨 store 才能让冷打开的新行复用那些仍存活的旧行。
- **只用 `WeakRef`。** 池本身不延长任何行的寿命。行被 GC 后，由 `FinalizationRegistry` 删除对应条目；删除前要确认条目仍是同一个 `WeakRef`，防止误删后来登记的新行。
- **key 为 `topic + rowId`。** 不同 session 之间不共享。rewind 之后 rowId 可能被复用、内容也可能不同，但共享只发生在值深相等的地方，所以语义是安全的。
- **`shareStructure(prev, next)`：**
  - 只递归 plain object 和数组；其余类型直接返回 `next`。
  - 原始值用 `Object.is` 比较。内容相同但引用不同的字符串会返回 prev 的字符串，这样 next 的副本就能被 GC。
  - 绝不修改 `next`：`next` 可能来自 apply.ts 的结构复用，被其他地方引用着。
- **snapshot 帧**：每一行都做共享。如果共享后的每一行都和当前 window 的对应行 `===`、而且长度相同，就连 window 数组也复用。
- **`row.delta` 不做比较。** 流式追加产生的新字符串本来就是新的，逐帧深比较只会白白消耗 CPU；这里只把新行登记进池，等最终的 `row.upserted` 到来时再与它共享。
- **语义不变。** 共享只复用引用，值仍然深相等。共享逻辑放在 UI store 层，不改 `@zcode/shared` 的 `applyConversationDelta`，因为 apply.ts 约定客户端 apply 不增加语义分支。

## 影响面

- 桌面 `desktop-continuous` 与手机 `web-remote-replayable` 走的是同一个 `ConversationProjectionStore`，交付语义不变，只有对象身份更稳定。
- 引用相等的行会让 memo 过的行组件跳过渲染。这符合预期，因为数据确实没有变化。
- 闭包链本身（第 1 点）不在本次范围内；如需进一步治理，可以另外评估 `key={sessionId}` 或拆分 SessionPane。

## 验证

- 单测：`packages/ui/test/conversationRowSharing.test.ts`（shareStructure 与池），以及 `packages/ui/test/v4SessionDataLayer.test.ts` 中的 store/层级用例（重复 snapshot、upsert、keep-warm 过期后冷打开、跨 topic 隔离）。
- 运行时：用隔离 HOME 压测，只切换 task 18 次，再用 heap snapshot 统计大字符串副本，对比基线（144 份 state、790 份副本 / 150MB、heap 213MB）。

## 验证结果（2026-09-30）

A/B 条件：同一份种子数据（隔离 HOME，mock provider），冷启动 → 发送 2 轮大文件工具调用 → 9 个 task 各切换 2 轮 → GC → heap snapshot。

| 指标                              | 修复前          | 修复后             |
| --------------------------------- | --------------- | ------------------ |
| GC 后 JS heap                     | 93.3MB          | 68.1MB             |
| ≥20KB 大字符串副本（37 个不同值） | 216 份 / 39.3MB | 89 份 / 14.9MB     |
| 单个 inputText 最多副本数         | 32              | 10                 |
| 闭包链留住的 state 份数           | 37              | 37（本方案不处理） |

剩余副本主要来自 UI 派生层，如渲染用的 sliced string、`assistantWorkRows` 等，不属于 projection 行，不在本方案范围内。闭包链留住的份数越多，本方案的收益越大：长会话里 state 可达上百份，内存会按份数成倍节省。
