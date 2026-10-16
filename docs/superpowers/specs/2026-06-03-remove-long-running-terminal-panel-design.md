# 移除「运行中终端」面板设计

日期：2026-06-03
状态：已实施；本文保留为历史设计记录

> 当前 V4 会话 UI 已移除旧 `ChatView`、`ChatViewSupplementPanels` 和
> `LongRunningToolCallPanel` 组件。下文文件名与调用链只描述当时的删除方案，不能作为当前
> UI 结构依据；当前会话入口见 `packages/ui/src/v4/SessionPane.tsx`。

## 背景

zcode app 当前有一套逻辑：当某个 bash/shell 工具调用运行时间超过阈值（30 秒）时，会在聊天辅助面板区显示一个「运行中 N 个终端」面板（`LongRunningToolCallPanel`），列出长时间运行的 shell 命令并提供「强制结束任务」按钮。该显示完全依据 tool 的 `startedAt` 与当前时间之差判断。

需求：删除这个基于 tool 时间判断的「运行中终端」面板。

## 范围

**只删终端面板本身。** 当时保留旁边复用同一 30 秒阈值的「thinking shimmer 抑制」逻辑，思考中动画行为完全不变。

后续变更：2026-06-16 起，ChatLoading 的工具覆盖逻辑不再复用 30 秒阈值，改为 `hasCurrentTurnForegroundActiveToolCalls()` 只看当前轮 active foreground tool；下一轮消息到达后由新轮状态接管 loading 显隐。

### 关键区分

`packages/ui/src/lib/longRunningToolCalls.ts` 内三个函数分属两套功能：

- `collectLongRunningToolCalls()` → 驱动**终端面板**（删除目标）
- `hasActiveToolCalls()` / `hasCurrentTurnForegroundActiveToolCalls()` → 驱动 **thinking shimmer 抑制 + panelNow 时钟**（保留）

`panelNow` 时钟链路（`hasActiveToolCalls` → `hasRunningToolCalls` → `useChatViewEffects` 里每秒 `setPanelNow`）必须保留。本次只摘面板，不动时钟。

## 改动清单

### 1. 删除整文件
- `packages/ui/src/LongRunningToolCallPanel.tsx`

### 2. `packages/ui/src/ChatView/ChatViewSupplementPanels.tsx`
- 删 `LongRunningToolCallPanel` import
- 删 `isTaskRunning ? <LongRunningToolCallPanel … /> : null` 渲染块及其上方对应注释
- 清理因此变为未使用的 props：`displayedMessages`、`closeTask`
- `taskId` 仍被 `QueuedPromptList` 条件使用，保留

### 3. `packages/ui/src/ChatView.tsx`（调用处，约 653 行）
- 去掉传给 `ChatViewSupplementPanels` 的 `displayedMessages`、`closeTask` 两个 prop
- `hasActiveToolCalls` / `hasRunningToolCalls` / `panelNow` 链路保持不变（shimmer 仍需）

### 4. `packages/ui/src/ChatView/useChatViewDisplayFlags.ts`
- 删 `collectLongRunningToolCalls` import 与 `hasVisibleLongRunningPanel` memo
- `shouldShowSupplementPanels` 改为 `planLength > 0 || queuedPromptsLength > 0`
- 从返回对象删 `hasVisibleLongRunningPanel`（源码已无消费者）
- 保留 ChatLoading tool blocker import 及其用法（后续已替换为 `hasCurrentTurnForegroundActiveToolCalls`）

### 5. `packages/ui/src/lib/longRunningToolCalls.ts`
- 删 `collectLongRunningToolCalls` 函数与 `LongRunningToolCall` interface
- 保留 `hasActiveToolCalls`、ChatLoading tool blocker、`LONG_RUNNING_TOOL_CALL_THRESHOLD_MS`
- 文件名不改（改名牵连多处 import，价值低）

### 6. `packages/shared/src/test-ids.ts`
- 删 `TID_CHAT_LONG_RUNNING_PANEL`、`TID_CHAT_LONG_RUNNING_STOP_BUTTON`

### 7. i18n
en-US.ts / zh-CN.ts 删除 5 个面板专用 key：
- `chat.longRunning.title`
- `chat.longRunning.description`
- `chat.longRunning.stop`
- `chat.longRunning.elapsedSeconds`
- `chat.longRunning.elapsedMinutesSeconds`

**保留** `chat.longRunning.collapse` / `chat.longRunning.expand` —— `TodoPanel.tsx:144` 仍复用这两个 key。

### 8. 测试
- `packages/ui/test/chatViewSupplementPanels.test.ts`：两条用例均为面板显隐断言，面板移除后无独立可测行为 → 删除整文件
- `packages/ui/test/longRunningToolCalls.test.ts`：删 `collectLongRunningToolCalls` 相关用例，保留 `hasActiveToolCalls` / ChatLoading tool blocker 用例

## 验证

- 跑 ui 包 typecheck，确认无悬空引用（尤其 `hasVisibleLongRunningPanel`、被删 props、被删 test-id）
- 跑剩余 `longRunningToolCalls.test.ts`，确认 shimmer 辅助函数用例通过
- 手测：思考中 shimmer 动画、Todo 面板、排队提示行为不变；长时间 bash 不再弹出终端面板

## 注意

- 不删用户自己加的调试日志
- `chatLoadingDebug` 在源码中已无对应文件（仅 dist 残留），无需改动
- 共享工作树有并发写入者：提交时只按 pathspec 提交本次涉及的文件
