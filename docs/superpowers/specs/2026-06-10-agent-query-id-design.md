# Agent Query ID 设计

## 背景

`sessionId` 标识一整个会话，`traceId` 标识技术观测链路，`inputId` 主要用于 UI stop、队列和终态收口。模型请求还缺少一个面向用户语义的归因字段：从一条真实用户输入被消费开始，到下一条真实用户输入被消费前，中间所有模型请求都应该归属到同一个 query。

## 目标

- 新增 `queryId`，表示“一条真实用户输入”的生命周期。
- 普通 prompt、queued prompt drain、turn steer 都必须带 queryId。
- 一条用户输入触发的多次模型请求、tool loop 后续请求、stream retry 继续沿用同一个 queryId。
- 模型 adapter 层在 `generateText` 和 `streamText` 请求 header 中写入 `x-query-id`。
- 旧调用没有 queryId 时，agent 侧回落到 `inputId`，避免历史客户端丢失主路径归因。

## 非目标

- 不把 `queryId` 替代 `traceId`、`sessionId` 或 `inputId`。
- 不改变 UI 终态收口、stop 路由和 task owner command 的 `inputId` 语义。
- 不为纯辅助请求伪造新的用户 query。标题、压缩、goal verifier 等辅助模型请求只继承已有 traceContext 上的 queryId；没有真实用户 query 时可以为空。

## 语义

一条真实用户输入创建一个 queryId：

```text
user message/query A
  -> model request 1, x-query-id=A
  -> tool calls
  -> tool results
  -> model request 2, x-query-id=A
  -> retry/recovery request, x-query-id=A
until next consumed user message/query B
```

steer 是新的真实用户输入。它不是修改正在运行的模型请求，而是在 tool result 之后、下一次 model request 之前注入新的 user message。每条 steer 必须拥有自己的 queryId。

## 传播规则

- UI 创建普通输入时同时创建 `inputId` 和 `queryId`。
- renderer-local queued prompt 保存 queryId，真正 drain 时继续使用原 queryId。
- web remote replayable host command queue 保存 queryId，owner host 真正发送时继续使用原 queryId。
- `session/send` 和 `session/steer` 协议参数新增可选 `queryId`，主路径调用必须传。
- agent runtime 在 `executeTurn` 创建 turn traceContext 时写入 queryId。
- `steerTurn` 把 queryId 保存到 pending input；drain 时把下一次 model request 的 traceContext 切到该 queryId。
- model adapter 从 request traceContext/metadata 读取 queryId，并写入 `x-query-id`。

## 兼容

协议字段保持可选，原因是旧客户端、辅助请求和历史测试路径可能暂时没有 queryId。兼容策略：

- `session/send`：`queryId ?? inputId`。
- `session/steer`：`queryId ?? inputId`。
- adapter：只有 status context 中存在 queryId 时才写 `x-query-id`。

## Edge Cases

- 多条 steer 连续到达：每条 steer 是独立 query，不能合并成一个 queryId。
- steer 已经 drained：queryId 已进入模型请求，不能按“撤回 pending 输入”的语义撤回。
- steer 仍在 pending queue：未来可按 `pendingInputId/queryId` 增加撤回协议。
- tool call 和 tool result 中间不能插 user message；steer 只能在 tool result 之后、下一次模型请求之前注入。
