# TUI Borderless Layout

## Goal

The TUI should feel less boxed-in while keeping the same information hierarchy:
the transcript and sidebar render as open surfaces, the sidebar is separated by
background color, and the prompt input keeps a complete focused frame.

## Scope

- The transcript viewport has no border and no frame title.
- The sidebar has no border and no frame title.
- The sidebar uses a distinct background color from the transcript and main app
  background so it remains visually scannable without a frame.
- The prompt input keeps its complete border, including left and right vertical
  sides, because it is the active editor surface and should read as a coherent
  control.
- Existing input focus, submission, history recall, transcript scrollback,
  approval prompts, selection prompts, and slash suggestions keep their current
  behavior.

## Rendering Contract

- Main app background remains the transcript background.
- Sidebar background uses `theme.backgroundElement` from the TUI theme contract.
- Sidebar row truncation is based on the actual no-border content width:
  `sidebar width - horizontal padding`.
- Input height follows the multiline input spec; this layout does not add extra
  chrome rows beyond the complete prompt frame.
- No runtime, provider, session, tool, permission, event, ZCode app-server, or storage schema
  changes are required.

## Tests

- TUI unit tests assert the transcript and sidebar components render without a
  border.
- TUI unit tests assert the sidebar uses the alternate panel background and row
  truncation matches the no-border content width.
- TUI input tests assert the prompt input renders with a complete border.
