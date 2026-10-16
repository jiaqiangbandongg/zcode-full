# TUI Todo Display

## Goal

The TUI should expose the session todo state as a live projection so long-running
tasks are visible without requiring the user to scroll through transcript text.
The current TUI renders the todo projection in the session panel directly below
the input box so task state stays visible while the transcript scrolls.

## Boundary

- TUI does not read `SessionStorePort` or call todo tools directly.
- Runtime remains the source of truth. TUI only consumes `SessionEvent` updates.
- Todo state is updated from successful `tool_call_result` events for
  `TodoRead` and `TodoWrite` when the serialized result contains a valid
  `{ todos: TodoItem[] }` payload.
- Invalid, truncated, or unrelated tool outputs are ignored and do not clear the
  last known todo projection.

## Layout

Normal layout:

1. Header.
2. Transcript viewport.
3. Input box.
4. Session panel todo section.
5. Status line.

The todo section is height bounded so the transcript always keeps at least one
visible row on small terminals. During approval prompts, the approval panel keeps
focus while the session panel below it keeps showing the last known todo
projection.

## Rendering

- The title shows completed and total counts, for example `todo 1/3`.
- Each item is one line, preserving session todo order.
- Status markers are ASCII for cross-platform terminal safety:
  - `[ ]` pending
  - `[>]` in progress
  - `[x]` completed
- In-progress rows may be colored cyan and completed rows may be dimmed when
  color is enabled.
- Long todo text is truncated to the panel width; large lists show a final
  `... N more` row when space is exhausted.

## Tests

- TUI unit test sends a `TodoWrite` result and asserts the todo panel appears in
  the session panel below the input area.
- The test covers pending, in-progress, and completed markers.
