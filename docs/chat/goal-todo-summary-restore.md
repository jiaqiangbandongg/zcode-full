# Goal Todo 摘要恢复与闪烁修复

记录时间：2026-06-10

## 背景

历史 goal task 恢复后继续发送新消息时，摘要面板可能短暂把当前 5 个 todo 展示成
20 多个历史 todo。现场日志显示，恢复时 session store 的当前 todo 仍是 5 个，
但发送新消息后的快照合并阶段出现了 `goalIteration=none` 的本地 streaming assistant，
并且普通 todo 摘要把所有 `session` todoGroups 展平成一个列表。

## 状态来源

- `session_target` 是 goal 的权威持久化状态。
- `todo` 是当前 session 短期 todo 列表的权威持久化状态，`TodoWrite` 会整体替换该列表。
- `todoGroups` 不是独立持久化状态，而是 snapshot 读取时由历史消息、当前 todo、
  当前 goal target 和 verification timeline 投影出来。

因此 UI 不能把多个 `session` todoGroups 当成“当前 todo 列表”的累加结果。

## 设计

摘要面板的普通 todo fallback 只展示最新的 `session` todoGroup：

- 有 live/runtime `plan` 时，继续优先展示 `plan`。
- 没有 `plan` 时，从 `todoGroups` 中选择最新的 `source: "session"` 分组。
- 不再把所有 session 分组 `flatMap` 展开，避免历史 TodoWrite 在 goal target 变化或恢复边界
  暂时丢失时膨胀成累计列表。

snapshot metadata 回填要支持 UI-only timeline 消息造成的下标错位：

- 当前消息和 snapshot 消息同下标、同角色时，继续按原路径回填。
- 如果当前列表里有 synthetic timeline 等 UI-only 消息，则按非 timeline 消息的可见顺序对齐。
- 回填仍只补展示元数据和更完整的 snapshot 字段，不改变 replayable/continuous 的传输边界。

## 边界

- 不修改 `todo` / `session_target` 表结构。
- 不新增协议字段。
- 不把 goal iteration 分组结果持久化。
- 桌面端 `desktop-continuous` 继续保持 direct streaming 主链路。
- 手机端 `web-remote-replayable` 仍由 snapshot/gap 语义恢复，不绕过 replayable 边界。
