# Streaming Tool Input Preview

## 背景

部分模型会在思考或正文结束前以流式 function call 形式输出工具参数。例如 `Write`
会先产生 `tool_input_start`，随后持续输出 `tool_input_delta`，最后才得到完整
`tool_call`。如果 app/agent 协议只透出正文和 reasoning delta，UI 会停留在“思考”，
直到模型回合结束后才突然出现文件工具调用。

## 目标

- agent 在模型参数流出现时，尽早向 app 暴露工具调用占位。
- UI 在参数流期间展示 pending 工具卡片，并用已有文件变更卡片展示文件路径和按秒采样的行数。
- 有副作用工具仍然只在模型回合结束后的 tool execution 阶段执行，参数预览不能触发文件写入。
- desktop `desktop-continuous` 主链路保持实时；web remote `web-remote-replayable`
  继续以 replayable snapshot/event seq 为恢复边界。

## 协议

`@zcode/protocol` 增加 `model.streaming` session event。当前只对 app 暴露以下
模型 streaming kind：

- `text_delta`
- `reasoning_delta`
- `tool_input_start`
- `tool_input_delta`
- `tool_input_end`
- `tool_call`

`tool_input_delta` 在 agent runtime 层合并为较大的文本块后再进入 protocol，
避免大文件 `Write` 参数产生每秒数百条 stdio 小包。最终工具执行结果仍以
tool execution 阶段事件为准。

v4 会话不再把这组事件直接暴露给 renderer，而是在 CLI `ProductProjection` 中投影为
`ToolCallRow`：

```text
model tool_input_*
  -> core ModelStreaming
  -> v4 ProductProjection
       row.appended(toolCall, inputStreaming)
       row.delta(inputText)           [Write/Edit 最多每秒一次，首包与收尾除外]
       row.upserted(input,inputText)  [continuous/replayable 都可恢复]
  -> UI v4 adapter
       buildZCodeStreamingToolInputPreview(inputText)
  -> ToolCallBlocks
       Write/Edit 路径、内容、行数按同一采样点刷新
```

delivery profile 边界：

- `desktop-continuous` 保留 `row.delta(inputText)`，用于 active 桌面会话实时展示工具参数预览。
- `web-remote-replayable` 过滤 `row.delta(inputText)`，只通过最终 `row.upserted`
  或 snapshot 恢复完整 `input` / `inputText`。
- 因为 replayable 会过滤输入流 delta，任何工具输入定稿事件都必须在不可过滤的
  `row.upserted` 中携带完整 `inputText`，否则手机远控恢复会缺少工具输入终态。

### Write/Edit 一秒采样

`Write` / `Edit` 的累计参数会触发半截 JSON 恢复、diff 计算和 React 更新。模型输出很快时，
逐 delta materialize 没有可读收益，因此 desktop continuous 的文件工具预览采用确定性的
一秒采样；其他工具继续沿用原有增量节奏。

```text
tool_input_start ───────────────> 立即创建 pending 工具卡
首个 tool_input_delta ─────────> 立即发布，尽早显示路径/工具形态
后续 delta（距离上次 < 1000ms）─> 只追加 projection buffer
首个达到 1000ms 的 delta ─────> 合并 pending suffix，发布一次 row.delta
end / call / scheduled / cancel ─> 立即冲刷或以完整 input 定稿
```

- 时间预算使用 `SessionEvent.timestamp`，不使用 renderer timer；同一事件账本在 live 与 replay
  中得到相同投影。
- 采样单位是整张文件工具预览：路径、内容、inline diff、`+N/-N` 在同一个采样点更新，
  不分别追赶。
- 第一个 delta 不等待一秒。正常定稿、调度、取消等终止边界也不等待一秒，且不能丢失尚未
  发布的 suffix。
- 采样只减少预览投影次数，不改变工具参数账本、权限检查或工具执行时机。
- `Write` 流式预览的 `+N` 是当前已恢复 `content` 的逻辑行数；`Edit` 是
  `old_string` 与当前部分 `new_string` 的行级 LCS 结果，所以流式过程中允许增减，最终
  completed 文件 diff 才是实际变更事实。

## UI 投影

legacy service adapter 将 `model.streaming` 中的工具参数事件投影为现有
`tool_call` / `tool_call_update`：

- `tool_input_start` 创建 pending 工具卡片。
- `tool_input_delta` 累积 JSON 参数片段，尽力解析出 `file_path`、`content` 等常见字段。
- `tool_input_end` 保留最后一次参数预览。
- `tool_call` 使用完整 input 覆盖预览 input，但仍保持 pending，直到真正的
  `tool.updated` execution 事件到达。

如果后续 `tool.updated` 的 scheduled 事件与预览工具使用同一个 `toolCallId`，
UI 需要更新已有工具卡片，而不是追加重复卡片。

v4 renderer 侧继续复用同一套工具卡片。`ToolCallRow.input` 是最终结构化输入；
当它缺席且 `inputText` 仍是半截 JSON 时，adapter 使用
`buildZCodeStreamingToolInputPreview` 尽力提取 `file_path`、`content`、
`new_string`、`old_string`、`command` 等字段。空预览不展示为 Parameters；
raw metadata 只保留输入长度和是否完整，不复制完整 streaming raw input。

## 执行边界

流式参数预览不改变工具调度规则。`Read` 这类只读且并发安全的工具仍可走已有
streaming tool coordinator；`Write`、`Edit`、`Bash` 等有副作用或需要审批的工具
不会在参数流期间执行。文件落盘、权限请求、失败/成功状态都继续来自 tool execution
阶段的 `tool.updated` 事件。
