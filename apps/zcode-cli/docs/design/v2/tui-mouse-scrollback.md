# TUI Transcript Scrollback

## Goal

The TUI transcript output area should stay scrollable when output is longer than
the viewport. Keyboard history recall must stay bound to the prompt input, the
prompt input remains the only normal focus target, and normal terminal text
selection must remain available across the whole TUI by default.

## Scope

- Keep prompt `Up`/`Down` bound to input history recall.
- Keep `PageUp`/`PageDown` bound to transcript scrollback.
- Keep ordinary focus on the prompt input. `Tab` must not toggle focus between
  transcript and input; outside slash-command completion it is a consumed no-op.
- Keep the transcript viewport on a renderer-level scroll implementation with a
  visible scrollbar when content overflows.
- Do not enable xterm mouse reporting by default, because it globally reroutes
  drag gestures into the application and prevents normal terminal text
  selection.
- If an external terminal mode still sends SGR mouse events, treat wheel and
  scrollbar drag events as transcript-only interactions.

## Non-Goals

- Do not add a new `ZCODE_` environment variable or user configuration surface.
- Do not change runtime session, provider, tool, permission, or event schemas.
- Do not make terminal emulator scrollback the source of truth. The TUI
  transcript projection remains the scrollable surface.
- Do not add mouse editing behavior to the prompt input.
- Do not add mouse interactions for approval, selection, or session panels.
- Do not enable xterm mouse reporting (`?1000h`, `?1002h`, or `?1006h`) by
  default.
- Do not enable xterm alternate scroll mode (`?1007h`).

## Terminal Contract

At startup, the TUI must leave xterm mouse reporting disabled so terminal-native
text selection remains the default interaction. It writes disable guards for:

- SGR extended mouse coordinates (`?1006l`)
- button-event drag tracking (`?1002l`)
- normal button tracking (`?1000l`)
- alternate scroll mode (`?1007l`)

The TUI must not enable alternate scroll mode (`?1007h`). `Up` and `Down`
remain prompt-history keys and must not be translated from wheel input by the
terminal.

On cleanup, the TUI repeats the same disable guards. This avoids inheriting a
stale mouse mode from a previous terminal application while preserving the
terminal's ability to select text anywhere in the TUI.

## Renderer Choice

The transcript viewport uses a published scroll-capable Ink fork
(`ink: npm:@jrichman/ink@6.6.9`) instead of a small scrollbar-only
component. This fork adds renderer-level support for `overflowY="scroll"`,
`scrollTop`, native scrollbar drawing, and scroll geometry helpers. That keeps
scroll clipping and scrollbar rendering inside the terminal renderer instead of
duplicating those responsibilities in ZCode's transcript component.

Maintaining a custom forked Ink DOM with a local `ScrollBox` would not give this
project a reusable package boundary. The published fork can be adopted directly
as a dependency while keeping ZCode's controller as the owner of
transcript-only scroll policy.

If SGR mouse input is externally supplied, wheel input remains routed through
the TUI controller so prompt history, approval panels, and other non-transcript
surfaces do not accidentally scroll. The wheel delta should start at one
rendered line for precise touchpad and notched-wheel control, then accelerate
during rapid consecutive wheel events so long scrollback remains practical.

## Layout Rules

The transcript viewport remains the only scrollable surface. When transcript
content overflows, the viewport reserves the rightmost column for a scrollbar.
Scrollbar presence may reduce transcript wrapping width by one column.

The scrollbar rules are:

- It is hidden when the transcript fits in the viewport.
- The thumb size reflects the visible fraction of transcript lines.
- Page key events move transcript scrollback by a viewport-sized delta.
- If SGR mouse input is externally supplied, wheel events over transcript
  content or the scrollbar move transcript scrollback by an accelerated line
  delta that starts at one rendered line and increases only during rapid
  consecutive wheel input.
- If SGR mouse input is externally supplied, clicking the thumb starts a drag
  interaction.
- If SGR mouse input is externally supplied, clicking the scrollbar track
  outside the thumb repositions toward that point and allows continued drag.

The same clamping rules as keyboard scrollback apply:

- `scrollOffset` never drops below `0`.
- `scrollOffset` never exceeds the currently rendered transcript overflow.
- New prompts reset `scrollOffset` to `0`.
- Live events keep following the newest output only when `scrollOffset` is
  already `0`; otherwise the user remains in scrollback.

## Input Contract

Externally supplied SGR mouse wheel input over the prompt area must be ignored.
It must not recall history, move the text cursor, or change transcript
scrollback.

Prompt `Up` still recalls older project input and prompt `Down` still restores
newer history or the local draft, even when transcript overflow exists.

Prompt focus is not a session or transcript state. The TUI should not expose a
second focus mode for the transcript because scrolling, copy selection, approval
prompts, and queued input are all represented by explicit interactions. This
keeps `Tab` free for slash-command completion and prevents accidental loss of
typing focus during long-running turns.

Mouse clicks outside the prompt input must not leave the normal composer
blurred. The renderer disables mouse-driven autofocus so focusable transcript
surfaces cannot steal keyboard input on mouse down, and the app shell refocuses
the prompt input after mouse up once selection-copy handling has had a chance to
read the current selection. This preserves terminal text selection while keeping
typing routed to the composer after any ordinary click.

## Tests

- TUI unit test: startup disables `?1006l`, `?1002l`, `?1000l`, and `?1007l`,
  and does not enable `?1000h`, `?1002h`, `?1006h`, or `?1007h`.
- TUI unit test: cleanup disables `?1006l`, `?1002l`, `?1000l`, and `?1007l`.
- TUI unit test: normal prompt `Up` recalls history after long output instead of
  scrolling transcript overflow.
- TUI unit test: ordinary `Tab` leaves prompt focus on the input instead of
  switching to transcript focus.
- TUI unit test: clicking transcript or shell space leaves the prompt input
  focused after mouse up.
- TUI unit test: an externally supplied SGR wheel event over transcript content
  scrolls the transcript.
- TUI unit test: an externally supplied SGR wheel event over the prompt area does
  not change transcript scrollback.
- TUI unit test: an externally supplied SGR scrollbar drag updates the visible
  transcript window.
