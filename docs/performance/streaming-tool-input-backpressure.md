# Streaming Tool Input Backpressure

## 背景

ZCode Protocol 已经把工具参数流拆成 `tool_input_start` / `tool_input_delta` / `tool_input_end`，这是流式 function call 的基础能力。2026-06-13 的双任务现场显示，renderer CPU 被打满并不是 agent 计算过载，而是 UI 在每个 `tool_input_delta` 上把累计 `rawInput` 重新解析成完整预览，再写入 task message store 并触发 React render。

典型 case 是一个约 36KB 的 `Write` 输入被拆成 785 个 delta。真实网络 delta 内容不大，但 UI 每个 delta 都扫描越来越长的累计字符串，形成近似 O(n²) 的解析和渲染成本。后台任务也同频写 store，两个任务并发时会叠加到主 renderer。

## 目标

- 保留流式 function call：active 任务仍能尽快看到工具卡和参数预览。
- 非 active 任务不再每个工具参数 delta 都 materialize 到消息树。
- 大 `Write` / `Edit` 输入不再每个 delta 全量解析、全量写 store。
- 切回运行中的后台任务时，继续沿用已经累计的工具输入 buffer，不丢前半段参数。
- 工具状态事件不再因为 queued/started/closed/committed 重复把同一份 input 写进 UI store。
- 不改变 desktop `desktop-continuous` 与 mobile `web-remote-replayable` 的交付语义边界。

## 设计

### Active Live

active 任务继续消费完整 continuous stream，但工具参数预览需要预算：

- `tool_input_start` 立即创建工具卡。
- 第一个 `tool_input_delta` 立即预览，用于快速识别 `Write` / `Edit` / `Bash` 等工具形态。
- `Write` / `Edit` 的后续 delta 只按 `SessionEvent.timestamp` 的 1000ms 预算预览，并把期间 suffix 合并成一次更新；累计字节增长不能绕过这个时间预算。
- 其他工具继续沿用既有时间/字节预算，不因文件工具降频而降低命令等参数的反馈速度。
- `tool_input_end` 只作为轻量边界更新工具卡状态，不再解析完整 raw input；最终 `tool_call` 携带完整 input 时只 materialize 一次，避免 end/call 连续重复解析大 JSON。
- 预览事件的 `raw` 只保留 `streamingRawInputLength`，不把完整 `streamingRawInput` 写进 message store。

### Background Summary

非 active 任务的后台 monitor 使用 summary profile：

- `tool_input_start` 可创建轻量工具卡，保证后台任务看起来仍在推进。
- `tool_input_delta` 只进入 projection state 的 tombstone buffer，不写 message store、不触发 React render。
- tombstone buffer 记录 `rawInput`、`deltaCount`、最近预览位置和完整 input 状态。
- `tool_input_end` 仍立即传递轻量状态；最终 `tool_call`、tool result、permission、elicitation、task terminal 仍然立即传递。
- 切回 active 时，foreground subscription 继承 background projection state，下一次 delta/end/tool_call 可以用完整累计 buffer materialize。

### Tool Input Dedup

工具状态流里同一个 tool call 的 input 可能在 `tool_call_closed`、`scheduled`、`tool_queued`、`tool_started`、`tool_result_committed` 等事件中重复出现。UI projection 维护 tool input materialized 状态：

- 首次看到完整 input 时发 `tool_call` 并缓存。
- 后续带同样 input 的状态事件只发 `tool_call_update`，不再携带 input。
- duplicate raw payload 中移除完整 input，仅保留 `inputOmitted: true` 和 `inputRef: "tool_call"` 便于调试。

### Protocol Payload Backpressure

ZCode Protocol 边界也需要避免重复全量：

- 连续的 `model.streaming:tool_input_delta` 在 protocol server 边界合并成较大的 diff 包；首个 delta 立即 flush，后续按既有事件时间戳预算或确定性字节预算 flush，任何非 delta 控制事件到达前也必须先 flush。`Write` / `Edit` 的 UI 可见投影在 ProductProjection / 兼容 projection 再收敛到 1000ms，不能由 protocol 字节阈值绕过。
- 连续的 `model.streaming:text_delta` / `reasoning_delta` 也在同一协议边界合并。第一个 delta 立即 flush 保留“模型已经开始输出”的体感，后续按事件时间戳预算和确定性字节预算 flush，避免 provider 把思考流按 1-5 字符切包时唤醒 renderer 上万次，同时不能让用户感觉正文不再流式输出。
- `streaming_tool_ledger_updated` 是 runtime replay 账本，只给 agent reducer 恢复运行态使用，不再映射成 app `session.updated`。
- `model.streaming:tool_call` 已经交付过完整 input 后，同一 `toolCallId` 的 `tool.updated:scheduled` 不再重复携带 input。
- scheduled tombstone 保留 `inputOmitted: true`、`inputRef: "model_stream"` 和 `inputByteLength`，便于日志确认省略行为。
- 如果 scheduled 在 `tool_call` 之前出现，或没有可证明已交付的完整 input，协议仍保留原始 input，避免破坏恢复。

## 边界

- renderer projection/store、services 兼容 task projection 与 ZCode Protocol payload 都参与降频/去重；runtime 内部 eventStore 仍保留完整账本。
- desktop continuous 仍订阅 `deliveryKind: "desktop-continuous"`，只是确定性 projection 对 `Write` / `Edit` 的 UI 可见输入更新降频。
- protocol coalescing 仍保持 diff 语义，只合并相邻 `tool_input_delta` / `text_delta` / `reasoning_delta` 的 `delta` 字段，不把累计 full input 放回 delta 事件；batch 边界只由首包 eager、事件时间戳预算、字节预算和事件顺序决定。时间预算必须基于 `SessionEvent.timestamp` 而不是 live 定时器，保证 live 与 replay 的 `afterSeq` 恢复边界一致。
- web remote replayable 的 snapshot/gap recovery 语义不变；如果未来把 background summary 下沉到服务层，必须显式带上 `clientMode` / `deliveryKind`。
- 权限请求、用户输入请求、任务完成/失败、stream gap snapshot 不能被节流。

## 验收

- 双任务并发、大 Write 输入时 renderer CPU 峰值显著低于优化前，不再长时间 100%。
- CDP profile 中 `streaming-tool-input-preview.ts` 不再随着每个 delta 成为主热点。
- active 任务能立即看到 `Write` / `Edit` 工具卡和首段参数；运行期间昂贵预览最多每秒 materialize 一次，收尾立即显示精确终态。
- `+N/-N` 在每个采样点原子跳到该次真实统计值，不使用逐行 `requestAnimationFrame` 追赶。
- background 任务切回后能显示完整工具 input。
- 最终 snapshot 与消息工具卡 input/result 一致。
- `pnpm lint` 与 `pnpm typecheck` 通过。
