# TUI Selection Copy

The OpenTUI renderer owns mouse input when `useMouse` is enabled, so terminal
native drag selection cannot reliably copy transcript text. The TUI should use
OpenTUI selection state directly and write selected text to the clipboard when a
selection ends.

## Behavior

- Dragging across selectable TUI text and releasing the mouse copies the selected
  text to the clipboard.
- `Ctrl+C` copies the current OpenTUI selection when one exists; otherwise it
  starts the TUI exit confirmation. The user must press `Ctrl+C` again in the
  confirmation window to exit.
- `Ctrl+Y` copies the current OpenTUI selection without exiting.
- Empty selections are ignored and cleared.
- Clipboard failures surface as TUI status text instead of crashing the session.

## Boundaries

The TUI package must not call platform clipboard commands directly. It exposes a
`TuiWriteClipboardText` option and only reports selection copy intent. The CLI
composition layer provides the Node clipboard adapter.

The Node clipboard adapter writes OSC 52 to the TUI stdout when available, then
attempts a native platform fallback:

- macOS: `pbcopy`
- Linux: `wl-copy`, `xclip`, then `xsel`
- Windows: PowerShell `Set-Clipboard`

OSC 52 keeps remote and terminal-integrated clipboard flows working, while the
native fallback covers terminals that do not accept OSC 52.

## Testing

- TUI unit tests cover exact selected text preservation, empty selection
  handling, unavailable writer behavior, and selection clearing.
- CLI unit tests cover OSC 52 output and native command invocation without
  touching the real system clipboard.
