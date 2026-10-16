# TUI Turn Elapsed Indicator

## Goal

The interactive TUI should show how long the current top-level turn has been
running. The indicator appears on the right side of the live status line while a
turn is active and updates live so long-running work has an immediate time
signal.

## Scope

- Track the active turn start timestamp in the `TuiScreen` projection that the
  controller owns.
- Render a right-aligned elapsed indicator on the first status line only while a
  turn is active.
- Clear the indicator when the active turn completes, fails, is paused, or hands
  off to another local UI state such as a selection list.
- Keep the feature local to the TUI presentation surface; do not add a
  `ZCODE_` environment variable or alter provider/runtime contracts.

## Rendering Contract

The controller is the source of truth for whether a turn is active. It sets
`activeTurnStartedAtMs` when a prompt is accepted and clears it in the same
cleanup path that clears `busy`, `abortController`, and `activeTurnId`.

The Ink renderer may use component-local timer state to refresh the displayed
duration. That timer is presentation-only: it must not own session state, call
providers, read storage, or perform external I/O. The timer must be cleaned up
when the indicator unmounts and should be unref'd when the runtime supports it.

The status line should keep the live status text on the left, such as
`Streaming model response...`, and right-align the elapsed indicator in the same
row. The elapsed label must truncate to terminal width and must not overlap the
prompt, network panel, session panel, or status details.

Elapsed formatting must use larger units for longer turns: milliseconds below a
second, seconds below a minute, `Xm YYs` after a minute, and `Xh YYm ZZs` after
an hour.

## Cross-Platform Behavior

Elapsed time is computed with Node's standard timers and wall-clock
milliseconds. The implementation must not depend on shell commands, POSIX
signals, terminal escape parsing outside the existing Ink renderer, or
platform-specific time formatting.

## Failure Behavior

If the turn aborts or the TUI closes, the controller clears the active timestamp
and the renderer timer is disposed with the component. If the clock moves
backward, the display clamps elapsed time to zero rather than showing a negative
duration.

## Tests

The TUI test suite should cover:

- The elapsed label appears on the right side of the status line while a
  submitted turn is running.
- The row updates over time without requiring runtime events.
- The row disappears after the turn settles.
- Duration formatting converts minute- and hour-long turns into larger units.
