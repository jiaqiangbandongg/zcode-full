# Assistant Message History Layout

> **历史状态**：本文记录 V4 迁移前 `ChatMessage` 的 DOM 方案，不是当前实现规范。
> 当前 assistant 内容由 `packages/ui/src/v4/ConversationTurnGroup.tsx` 与
> `packages/ui/src/v4/ConversationRowView.tsx` 按 projection rows/render units 渲染。

## 目标

调整 assistant 消息 DOM 结构，让同一条 `.is-assistant` 内部可以稳定区分“历史片段”和“最新片段”，方便样式和行为按层处理。

## 历史结构

- `packages/ui/src/ChatMessage.tsx`
  - `.is-assistant` 仍然是单条 assistant 消息的根容器
  - 任务运行中，所有片段统一包进 `.history-message`
  - 任务结束后，最后一个普通文本响应 `content part` 才会从 history 提升到 `.latest-message`
  - `.history-message` 现在使用 `Collapsible` 承载
  - 当前轮运行时历史区强制展开且不可收起，trigger 文案为 `Working for ...`
  - 当前轮结束后历史区默认收起且可手动展开，trigger 文案为 `Worked for ...`
  - 被提升出来的最后一个普通文本响应作为最新片段，挂在 `.history-message` 后面
  - `MessageChangeSummaryPanel` 继续挂在 assistant 容器尾部，不进入 `.history-message`

## DOM 语义

```html
<div class="is-assistant">
  <div class="history-message">
    <button>Worked for 1m 18s ></button>
    <div>...</div>
  </div>
  <div class="latest-message">latest part</div>
  <div>change summary</div>
</div>
```

## 约束

- `.history-message` 只在存在历史片段时渲染
- 单片段 assistant 消息保持原样，不额外制造空容器
- `latest-message` 只承载普通 assistant 文本响应，不承载 thought 或 tool block
- `change summary` 仍然归属于当前 assistant 消息，但语义上独立于 history/latest 分层
- 工作时长按语言使用自然的单位间距：英文数字与单位紧贴（如 `Worked for 7m 30s`），中文数字与单位之间保留空格（如 `已工作 7 分 30 秒`）；多个时长片段之间统一用一个空格分隔
