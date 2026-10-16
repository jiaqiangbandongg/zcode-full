# Task Find Dialog

> **当前状态**：本文描述 V4 conversation find 与 Git file-change find 的当前边界。

`Cmd/Ctrl+F` opens the task find dialog. It is separate from `Cmd/Ctrl+P`, which continues to open the file quick picker.

## Scopes

- Conversation: searches visible text in the current task conversation. All matches are highlighted, the active match uses a stronger highlight, and opening or changing the query scrolls to the first match.
- File changes: opens the Git/file changes side pane if needed, searches the current change source diff contents, expands the file containing the active match, and highlights visible matches in that diff. This scope does not mutate the conversation highlight state.

## Navigation

Up and down buttons, `ArrowUp`, `ArrowDown`, and `Enter` cycle through the current scope's matches with wraparound. `Shift+Enter` moves backward.

## Streaming Messages

The current running/prewarming message is included in conversation search once its text is rendered.
Streaming deltas may extend the current message's matches, but do not reorder existing matches, reset the
active match, or scroll the timeline automatically. Explicit navigation (buttons, Arrow keys, Enter, or
Shift+Enter) may scroll the selected match into view. When the message reaches a terminal phase, the full
stable index is rebuilt and the active match is rebased by its row identity where possible.

## State Boundaries

The dialog owns query and scope. `App` owns conversation and file-change query/index/count state; V4 `useConversationTimelineFind` indexes projection render units and highlights the virtualized timeline, while `GitPane` handles file-change matches from loaded diff patches and preloads missing diffs. The dialog does not couple the two renderers.
