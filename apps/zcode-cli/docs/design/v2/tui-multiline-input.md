# TUI Multiline Input

## Goal

The TUI prompt input should remain readable while the user drafts long prompts.
Long text wraps inside the input box instead of horizontally scrolling away, and
users can insert intentional line breaks with `Shift+Enter`.

## Behavior

- `Enter` submits the current prompt when the normal input box is focused.
- `Shift+Enter` inserts a newline into the draft without submitting.
- `Ctrl+C` clears the whole prompt draft when the input box has content. With an
  empty prompt draft it falls through to the protected double-press TUI exit
  flow defined in `turn-cancellation.md`.
- Long draft text wraps by word inside the input area.
- The input area defaults to two visible editor rows and grows up to six
  visible editor rows, then scrolls internally so the transcript and sidebar
  remain usable.
  Explicit newlines and word-wrapped visual lines both contribute to the
  visible row count.
- Programmatic draft replacement, including slash completion, input history
  recall, paste attachment placeholders, and post-submit clearing, keeps the
  editor buffer in sync with the session draft state and moves the cursor to the
  end of the inserted draft.
- `Up` and `Down` continue to navigate input history when the draft is empty or
  already in history-navigation mode, including while model output is streaming
  and a submitted prompt would be queued. While the user is editing non-history
  draft text, `Up` and `Down` are left to the multiline editor for cursor
  movement across wrapped or explicit lines.

## Rendering Contract

The prompt surface uses the OpenTUI textarea renderable rather than the
single-line input renderable. The textarea owns cursor movement, word wrapping,
scrolling, paste handling, and newline insertion. The TUI component owns only the
controlled draft synchronization and submit intent.

The renderer must not move draft ownership into component-local state. The
canonical draft remains the React/TUI session state used by slash suggestions,
attachments, history recall, sidebar metadata, and submission.

The composer computes the current visible editor row count from the draft text
and available content width, clamps it to `2..6`, and applies the same height
contract to the textarea. The bordered container also reserves the single
composer status line defined by `tui-input-session-panel.md` inside its lower
content row, with any spare vertical space placed between the textarea and that
status line. The textarea still owns its internal viewport and scroll offset
once the draft exceeds six visible rows.

## Tests

- TUI unit tests assert the prompt renders a textarea with word wrapping,
  bounded `2..6` visible rows, and key bindings for `Enter` submit plus
  `Shift+Enter` newline.
- TUI unit tests assert external draft replacement synchronizes the textarea
  buffer and moves the cursor to the end.
- Keyboard tests assert input history navigation is captured when the draft is
  empty or history navigation is already active, including during busy model
  output, leaving multiline editing keys to the textarea otherwise.
- Keyboard tests assert `Ctrl+C` clears a non-empty draft without exiting, and
  keeps empty-input `Ctrl+C` on the double-press exit guard.
