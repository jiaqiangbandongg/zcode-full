# TUI Responsive Sidebar

## Goal

The TUI sidebar should stay visible when the terminal is wide enough for a
stable two-pane layout, and it should automatically leave the main transcript
and composer room in narrower terminals.

## Layout Contract

- The sidebar width is `42` terminal columns.
- A terminal is treated as wide when its measured width is greater than `120`
  columns.
- In `auto` mode, wide terminals render the sidebar as a normal right-side pane
  that reserves `42` columns.
- Docked sidebars are flush with the terminal top, right, and bottom edges; the
  main transcript/composer keeps its own padding instead of relying on global
  shell padding.
- In `auto` mode, terminals at `120` columns or below hide the sidebar.
- If the user manually opens the sidebar in a narrow terminal, it renders as a
  right-aligned overlay over the app instead of shrinking the transcript and
  composer.
- Overlay sidebars also fill the top, right, and bottom edges of the overlay.
- Overlay sidebars reserve no composer or slash suggestion width.
- Manual hide wins over future resizes until the user toggles the sidebar back
  to `auto`.
- Sidebar section containers and text rows do not shrink below one terminal row.
  When vertical space is insufficient, content may be clipped at the bottom, but
  section titles and following rows must not draw on the same terminal cells.
- Sidebar row labels are padded and truncated by display-cell width, not UTF-16
  string length, so localized CJK labels keep stable alignment.

## Keyboard Contract

- `Ctrl+X` arms the sidebar leader key for a short confirmation window.
- Pressing `B` while the leader is armed toggles the sidebar.
- Toggling while visible hides the sidebar.
- Toggling while hidden returns the sidebar to `auto`; if the terminal is
  narrow, the sidebar opens as an overlay immediately.
- Any non-sidebar key clears the armed leader state and continues through the
  normal keyboard path.

## State And Boundaries

- The state is local TUI presentation state only. It does not affect session,
  runtime, tool, permission, ZCode app-server, storage, or provider contracts.
- Terminal width is read through the existing OpenTUI terminal-dimensions hook.
- No environment variables or platform-specific terminal commands are added.

## Tests

- Pure layout tests cover the `>120` breakpoint, fixed width, reserved width,
  overlay behavior, and manual hide behavior.
- Pure shortcut tests cover `Ctrl+X B`, timeout behavior, and unrelated keys
  clearing the leader.
- Component tests assert the shell renders no sidebar when hidden and wraps the
  sidebar in an absolute overlay when requested.
- Renderer tests cover localized CJK sidebar rows and assert that compressed
  sidebars do not leak title tail glyphs into the following row.
