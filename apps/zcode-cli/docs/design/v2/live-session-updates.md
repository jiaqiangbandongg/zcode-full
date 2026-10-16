# Live Session Updates

## 文档定位

本文定义 ZCode runtime 的实时会话更新通道，用于让 TUI、ZCode protocol client、未来的 debug panel 或远程 UI 在一次 turn 仍在执行时看到模型、工具、权限和取消进度。

本文是 v2 的实现前 spec。它不定义 ZCode Protocol SDK 绑定，也不改变 session event 作为事实来源的原则。

## 背景

当前 `AgentRuntime.executeTurn()` 的外部形态是请求/响应：

1. 调用方提交 prompt。
2. runtime 执行模型请求、工具调用、结果回灌和后续模型请求。
3. turn 结束后返回 `TurnResult`。

这种形态适合 `--prompt` 和脚本调用，但不适合交互客户端。TUI 和 ZCode protocol client 需要在 turn 过程中实时响应：

- 模型请求已经开始。
- 工具调用已经出现，正在等待、运行、完成或失败。
- 权限请求需要用户确认。
- turn 被取消。
- 最终响应已经完成。

## 目标

- 给 core 增加一个通用 live event sink。
- 复用现有 `SessionEvent`，不引入第二套事实模型。
- 让 TUI 可以在 turn 过程中渲染状态和工具进度。
- 为 ZCode app-server `session/update` 和 `session/request_permission` 映射提供稳定输入。
- 保持 CLI 非交互路径仍可只等待最终 `TurnResult`。

## 非目标

- 不在 core 中引入 ZCode app-server 类型或 SDK。
- 不在本阶段实现 token 级 `streamText()`。
- 不在本阶段实现 ZCode app-server。
- 不在本阶段实现交互式 permission broker。
- 不把实时更新作为持久化事实；事实仍然来自 event store。

## 核心原则

### SessionEvent 是事实

runtime 内部状态变化必须先形成 `SessionEvent` 并写入 `SessionEventStorePort`。live sink 只观察这些事件，不拥有新的状态推进权。

### 实时通道是投影

不同消费者可以把同一个 `SessionEvent` 投影为不同视图：

- TUI 投影为状态行、工具行和当前 agent message。
- ZCode app-server 投影为 `session/update` notification 或 `session/request_permission` request。
- debug panel 投影为 timeline、trace waterfall 或 token/cost 视图。

subagent child session 的 tool lifecycle 是一个特殊 live projection：原始 child
`tool_call_*` 事件先写入 child session event store，然后 runtime 可把带有
`source: "subagent"` metadata 的镜像事件发到父 session live sink。镜像事件用于父
TUI/ZCode app-server 的实时展示，不写入父 session event store，也不改变父 message history；
resume/debug 需要完整事实时应追溯 `childSessionId` 指向的 child event store。

### core 不知道消费者

core 只暴露 `SessionEventSink`：

```ts
interface SessionEventSink {
  onSessionEvent(event: SessionEvent): void | Promise<void>;
}
```

consumer-specific mapper 必须位于 TUI、ZCode app-server transport 或其他外层模块。

### sink 失败不能破坏事实写入

`appendEvent()` 必须先写 event store，再通知 sink。sink 抛错只能被记录，不能导致 event store 回滚，也不能让已经成功完成的业务事件失效。

如果外部客户端断开或希望停止 turn，应通过 `AbortController` 或未来的 cancel command 取消，而不是依赖 sink throw。

## 最小事件映射

### TUI projection

| ZCode event | TUI update |
| --- | --- |
| `session_resumed` | append resumed message/part counts |
| `turn_started` | status: `Thinking...` |
| `model_request` | status: `Calling model...` |
| `model_complete` | update token usage panel and status; do not append usage to transcript |
| `turn_error` / `model_error` | append a bounded system error row and update status/sidebar error |
| `tool_call_scheduled` | create/update one tool transcript part with a structured title/detail projection from the scheduled input |
| `tool_call_started` | update the same tool transcript part to running without appending a duplicate row |
| `tool_call_result` | update the same tool transcript part to completed; for `result.display.kind=file_diff`, append a bounded diff preview |
| `tool_call_error` | update the same tool transcript part to failed and render the error description directly under the tool title |
| `permission_requested` | append `Permission requested for <tool>` |
| `permission_denied` | append `Permission denied for <tool>` |
| `compact_boundary` | append compact summary stats |
| `turn_complete` | final result still comes from `TurnResult.response` |
| `turn_error` | final error path still renders the thrown error |

### TUI viewport and status placement

TUI layout should keep execution status close to the active prompt:

1. Header and separator stay at the top.
2. Conversation transcript owns the remaining scrollable viewport.
3. Input or approval prompt renders above the session panel.
4. A session panel below the input stays visible with mode, model, thought level, traceId, token usage, and todo state.
5. Status renders as the final footer line below the session panel.

The status line is a live execution indicator only. It must not consume transcript
height above the conversation because model streaming should not push visible
assistant content out of view from the top of the screen.

The transcript is an in-memory projection of the current TUI session. Rendering
must support a bounded viewport over the full rendered transcript instead of
always discarding older lines. `scrollOffset` is measured in rendered lines above
the latest transcript line:

- `0` means follow the newest content.
- PageUp increases the offset up to the oldest available rendered line.
- PageDown decreases the offset back toward the latest content.
- Normal prompt Up/Down are reserved for input-history/editor behavior and must
  not mutate transcript scrollback. Selection, approval, and clarification
  prompts may keep their own Up/Down navigation contracts.
- New model/tool events keep following latest content only when the offset is
  already `0`; otherwise the user remains in scrollback.
- Starting a new prompt resets the offset to `0`.

Streaming assistant text must remain available in the transcript projection while
the turn is running. The renderer may clip the viewport, but should not truncate
the active assistant message solely to fit the current terminal height.

When a turn completes, the TUI must not replace a populated live transcript entry
with the final assistant response. If no live model/tool line was rendered, the
initial placeholder may be replaced by the final response. If live lines were
rendered, operational lines such as model request status and tool status remain
as the process transcript and the final response is appended as a separate
assistant message so scrollback can still inspect the tool/model path after
completion.

Token usage is session metadata, not conversation text. `model_complete.usage`
must update the panel below the input box and the live status area, but must not
append a `Usage:` line to the transcript. Keeping usage out of transcript avoids
a transient line that appears under the assistant text and disappears when the
viewport or final answer projection changes.

Live model text is response material, not an independent process step. When the
live model text is the same as the final assistant response, the TUI removes that
live model text before appending the final response. Otherwise the same answer is
shown twice: once under the live model transcript and once under the completed
agent message. `model_complete.content` follows the same rule; usage/status may
be rendered as progress, but the content must not create a second visible copy of
the final answer.

An empty final assistant response must not create a visible placeholder transcript
row. Empty final text means there is no additional assistant content to append;
errors use the explicit error path instead of masquerading as a normal agent
message.

### TUI flicker-safe rendering

Streaming deltas may arrive faster than a terminal can comfortably repaint. The
TUI renderer must therefore treat live model text as frame-paced UI input rather
than a command to repaint immediately for every token:

- Initial TUI entry and terminal resize may clear the whole screen.
- Routine rerenders, including model streaming, must not emit full-screen clear
  sequences. They should reposition the cursor and update only the affected
  rows, clearing individual rows before writing replacement content.
- The first visible streaming delta should render immediately so the user sees
  progress, while subsequent deltas should be coalesced to a bounded frame
  cadence. The initial cadence is 16ms, matching the mature CLI pattern of
  frame-paced rendering without introducing a full virtual-screen engine yet.
- Final turn completion, permission prompts, input editing and explicit scroll
  actions may render immediately because they are user-visible state changes
  rather than high-frequency model deltas.
- Any pending scheduled streaming repaint must be cancelled before shutdown or
  a forced immediate render so stale frames cannot draw after the UI exits.

Design rationale: a terminal renderer should throttle render commits around a
shared frame interval and use screen diff/damage tracking instead of full clears
for steady-state frames, and model stream chunking should be validated against a
commit cadence. ZCode keeps the first implementation smaller by diffing rendered
terminal rows, but the same contract applies: bounded streaming commits and no
steady-state full-screen erase.

### ZCode app-server projection, future phase

| ZCode event | ZCode app-server behavior |
| --- | --- |
| `turn_started` | optional progress `session/update` |
| `model_complete` | `session/update` with `agent_message_chunk` |
| `tool_call_scheduled` | `session/update` with `tool_call`, status `pending` |
| `tool_call_started` | `session/update` with `tool_call_update`, status `in_progress` |
| `tool_call_result` | `session/update` with `tool_call_update`, status `completed` |
| `tool_call_error` | `session/update` with `tool_call_update`, status `failed` |
| `permission_requested` | `session/request_permission` |
| `turn_complete` | `session/prompt` response with `end_turn` |
| cancellation | `session/prompt` response with `cancelled` |

## Delivery Shape

`AgentRuntime` owns a small set of event sinks. `bootstrap` can register a per-turn sink when `submitPrompt()` receives `onEvent`, and unregister it when the turn completes or fails.

This keeps the runtime reusable:

- `zcode --prompt` does not pass `onEvent`.
- TUI passes `onEvent` and updates the screen.
- ZCode app-server passes `onEvent` and maps events to JSON-RPC notifications.

## Ordering

Within a single runtime instance, events should be delivered to sinks in the same order that `appendEvent()` sees them. The first implementation awaits each sink call before returning from `appendEvent()` to keep tests and simple clients deterministic.

Long-running sink work should be avoided. Heavy consumers should enqueue lightweight updates and process them outside the runtime critical path.

## Current Limitation

The first implementation still uses `generateText()`, so model text appears when `model_complete` is emitted rather than token by token. Token-level UI streaming requires a later `streamText()` runtime path that emits `model_streaming` deltas before `model_complete`.

## Minimal File Diff Display

`Write` and `Edit` results may attach a UI-only display payload to `tool_call_result`:

```ts
type ToolResultDisplay =
  | {
      kind: "file_diff";
      filePath: string;
      additions: number;
      deletions: number;
      structuredPatch: DiffHunk[];
      truncated?: boolean;
    };
```

This payload is a projection for interactive clients. It is not the model-visible tool result and should remain bounded before rendering. The TUI renders a small red/green diff preview with a line-number gutter, `+`/`-` markers, full-line red/green backgrounds when color is available, and a plain-text fallback when color is disabled. It does not provide syntax highlighting, word-level diffing, permission-dialog editing, or a full review UI.

The same bounded display payload must be persisted on the completed tool part as
`part.state.metadata.display` with `metadata.schemaVersion = 1`. Live clients read it from
`tool_call_result.payload.result.display`; resumed clients read it from the stored `message + part`
projection. The two paths must share the same runtime schema and bounded projection helper so a
session reload does not lose the diff preview. Legacy parts without this metadata remain valid and
fall back to the stored model-visible `completed.output` text.

## Test Requirements

- core test: event sink receives live events in append order.
- core test: sink failure does not prevent the turn or event store append.
- bootstrap test: `submitPrompt({ onEvent })` registers a per-turn sink and unregisters it after completion.
- TUI test: live events render model/tool progress before final response.
- TUI test: `tool_call_result` with `result.display.kind=file_diff` renders the file path and bounded hunk lines.
- runtime/bootstrap/TUI tests: completed file mutation tool parts persist `metadata.display`, resume
  restores it, and legacy completed tool parts without display metadata still render `output`.
- TUI test: streaming status is rendered below the input footer.
- TUI test: long assistant output can be scrolled with PageUp/PageDown without
  losing the latest transcript view.
- TUI test: normal prompt Up recalls input history instead of scrolling even
  when transcript overflow exists.
- TUI test: streaming delta rerenders do not emit a full-screen clear sequence.
