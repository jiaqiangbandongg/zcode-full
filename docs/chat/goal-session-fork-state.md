# Goal Session Fork State

## 背景

Goal session 的 fork 不是纯 transcript 复制。一个运行中的 goal 由四类持久状态共同表达：

- `session_target`：目标本体、状态、预算和累计统计。
- model-only `goal-continuation` user message：给模型继续下一轮 goal 的边界输入。
- assistant message：每轮 goal 的可见输出。
- `target_completion_verification` session entry：verifier lifecycle、iteration、anchor assistant 和校验结果。

如果 fork 只复制消息，再重新 `setTarget`，child 会得到新的 `targetId` 和空 verifier timeline。UI 过滤 model-only continuation 后会把多条 assistant 看成同一个 goal iteration，进而被历史投影合并成一条 assistant。

## 语义

- fork goal session 必须复制 fork 点之前的 goal 状态，而不是重新创建一个空 goal。
- child 的 target identity 必须和复制后的 continuation/verifier metadata 对齐。
- 只复制 anchor assistant 已进入 child transcript 的 verifier entry；fork 点之后的 verifier entry 不得进入 child。
- copied verifier entry 的 `anchorAssistantMessageId` 必须改写为 child message id。
- child 的 goal 完成态由复制后的 verifier 结果推导：最新复制 verifier passed 才能是 `complete`；否则不能因为 parent 后续完成而把 child 标成完成。
- fork 不复制 parent queue，也不自动启动新的 model turn。

## 实现约束

- fork 状态复制应发生在 agent core 的 fork 路径中，因为那里同时拥有 transcript cut 和 parent-to-child message id map。
- bootstrap/protocol 层不得在 core fork 之后再用 `setTarget` 覆盖 child target；`setTarget` 语义是新建/替换目标，不适合 fork state branch。
- active goal run 字段不能复制到 child，避免 child 继承 parent 正在运行的 `activeInputId` / timer。
