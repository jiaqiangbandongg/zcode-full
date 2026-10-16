# V4 Session Find Highlight

本文记录 V4 对话区搜索高亮的产品语义与实现边界。该能力覆盖两条入口：

- `Cmd/Ctrl+F` 打开的任务查找框中的「对话」范围。
- Command Center 中搜索并选中对话结果后的跳转临时高亮。

## 产品语义

- 搜索内容第一版只包含 `userInput.text` 和 `assistantText.text`，不搜索 tool、reasoning、timeline marker 或折叠区内部文本。
- 匹配为大小写不敏感的纯文本查找，不支持正则；同一文本节点内命中不重叠。
- V4 timeline 使用虚拟滚动，计数基于已加载投影 row 的数据索引；视觉高亮只作用于当前挂载 DOM。
- 搜索会自动补拉更早历史，但最多补到本地窗口 `1200` 个投影 row。超过上限时只更新当前已加载范围的计数，不额外显示状态文案。
- 分屏时只有 focused pane 消费 Cmd/Ctrl+F 搜索状态并上报计数，非 focused pane 不绘制高亮、不覆盖全局计数。
- 会话处于 `running` 或 `prewarming` 时不启动历史补拉，不随 streaming delta 实时重排结果；当前轮稳定后重新计算并恢复高亮。
- 后台补拉旧历史导致当前命中前方插入更多结果时，当前高亮按 `rowId + row kind + row 内命中序号` 锚定，不跳到别的匹配。

## 状态链路

```text
Cmd/Ctrl+F
  -> App conversationFindQuery / activeIndex
  -> focused V4 SessionPane
  -> ConversationTimeline 建立数据级 match index
  -> report count / rebased activeIndex
  -> virtualizer.scrollToIndex(unitIndex)
  -> mounted row DOM
  -> CSS Highlight base + active ranges
```

```text
Command Center result
  -> App searchResultHighlightRequest
  -> Shell 按 taskId + workspaceKey 过滤
  -> 目标 focused/primary V4 timeline
  -> snippet/query 定位 match
  -> virtualizer scroll + temporary CSS Highlight
  -> 3000ms 后清理并 onSearchResultHighlightDone(requestId)
```

## 实现边界

- 不新增 app/agent 协议，复用现有 `rowsRange` / `loadOlder`。
- CSS 使用 `--color-find-highlight` 和 `--color-find-highlight-active`，不新增颜色 token。
- CSS Highlight API 不可用时保留计数与滚动能力，不实现 `<mark>` fallback。
- Command Center 跳转高亮不打开 Cmd/Ctrl+F 查找框，也不写入 `conversationFindQuery`。

