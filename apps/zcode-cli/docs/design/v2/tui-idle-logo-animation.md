# TUI Empty Transcript Logo

## Goal

When a new TUI session has no user or agent messages yet, the message viewport
should not look like a large blank area. It should render a lightweight ZCODE
terminal character logo placeholder with a subtle terminal-text shimmer.

## Scope

- Show the placeholder only while the transcript is empty.
- Keep the prompt, status line, session panel, approvals, and selection UI in
  their existing layout positions.
- Keep the placeholder in the TUI presentation layer. It must not mutate session,
  runtime, model, tool, permission, or persistence state.
- Use plain terminal text plus the existing TUI palette. Do not introduce image assets,
  external commands, terminal-specific escape protocols, or new dependencies.
- Keep motion helpers presentation-only and reusable by other TUI surfaces.

## Non-Goals

- Do not add a new `ZCODE_` environment variable or configuration setting.
- Do not change the session event contract.
- Do not make startup rendering depend on model/provider availability.
- Do not render the placeholder after the first message appears in the transcript.

## Rendering Contract

The empty transcript renderer returns a small ZCODE block-and-box-drawing logo
for OpenTUI React to place inside the existing message viewport.

When the transcript content is shorter than the available message viewport, the
placeholder container must stretch with the scrollbox content and vertically
center the logo rows. If the viewport is shorter than the logo, the container
keeps a bounded minimum height equal to the logo row count so normal scrollbox
overflow behavior still applies.

The logo may render each row as styled character spans so a highlight band can
sweep across the terminal text. The shimmer must preserve the exact text content of
each logo row. It must not use ANSI escape sequences
inside text strings; color is expressed through normal OpenTUI style props.

The logo rows must be intentionally shorter than the TUI main pane minimum
content width so they do not wrap in normal layouts. If the app later exposes a
smaller transcript content width to this component, the renderer may fall back
to a compact logo variant, but the first implementation keeps the full logo
within the current main pane budget.

## Lifecycle

The component owns only local presentation state for the shimmer frame. It
appears when `messages.length === 0` and disappears on the same render pass that
introduces the first transcript message.

The shimmer timer is local to the logo component and is stopped when the logo
unmounts. Updating the animation frame must not mutate session, runtime, model,
tool, permission, or persistence state.

## Cross-Platform Behavior

The implementation uses React, OpenTUI React, and string-width-aware helpers
only. It does not call shell commands, inspect platform-specific terminal names,
or hardcode operating-system paths. No-color rendering still gets a bounded
static logo.

## Failure Behavior

Placeholder rendering is best-effort presentation. It must not catch or mask
runtime errors, and it must not affect prompt submission, cancellation,
permission handling, or terminal cleanup.

## Tests

- The TUI renders the visible ZCODE logo rows before the first message.
- The transcript renders the placeholder when its message list is empty.
- The empty transcript logo is vertically centered in the available message viewport.
- The transcript removes the placeholder as soon as a real message is present.
- The shimmer projection preserves the original logo text while producing a
  highlighted span near the sweep position.
