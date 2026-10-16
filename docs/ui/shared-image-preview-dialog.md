# Shared Conversation Image Gallery

## Scope

Conversation Markdown images and Browser Use / `node_repl` result images use one
shared thumbnail layout and full-screen preview dialog. Chat attachment previews
and the persistent Preview Pane remain separate because they own loading/error
metadata and pane lifecycle respectively.

## Shared thumbnail layout

- A single image keeps its intrinsic ratio, uses at most half of the message
  width, and is capped at `max-h-90`.
- A multi-image group uses one column on the narrowest screens, two columns from
  the small breakpoint, and fixed `h-44` thumbnails on desktop.
- Desktop groups flow horizontally and wrap onto additional rows. They never
  create a horizontal scrollbar.
- Every thumbnail uses `rounded-xl`, a semantic border/background, and
  `object-cover`.
- Markdown and Browser Use retain separate image loading and group ownership;
  only their presentation contract is shared.

## Shared behavior

- The active image starts centered at 100% zoom.
- A compact bottom pill contains only circular zoom-out and zoom-in buttons with
  the current percentage between them.
- Zoomed images support bounded mouse drag, single-touch drag, and two-touch
  pinch zoom. Images that fit inside the viewport remain centered.
- Multi-image groups expose fixed `ArrowLeft` and `ArrowRight` controls centered
  vertically against the viewport. Keyboard arrows perform the same navigation.
- Changing images resets zoom and translation.
- Closing the dialog returns focus to the thumbnail that opened it.
- Circular download and close buttons stay in the top-right safe area. Windows
  positions the action row below the native `titleBarOverlay` caption area.
  Linux keeps the dialog content below its self-drawn titlebar and preserves a
  trailing inset for the action row. macOS, Web, and mobile keep the normal
  top-right inset because their window controls do not occupy this corner.
- Download saves the active image. Desktop sends HTTP(S) sources to Electron
  main for CORS-independent streaming. Main resolves each initial/redirect
  destination, rejects local/private/reserved addresses, and pins the accepted
  address set into the actual connection to prevent DNS rebinding. It applies a 30-second timeout and five-
  redirect limit, and enforces the 50 MiB bound before the native Save As
  destination is written; resolved `data:` images continue through the bounded
  byte payload path. Web uses a size-bounded response reader when JavaScript can
  read the source, and falls back to browser-native navigation for cross-origin
  HTTP(S) sources that reject CORS so renderer memory is not used as an
  unbounded download buffer.
- Base64 `data:image/...` sources never enter the network path; their content is
  bounded in renderer memory and saved through the byte-payload IPC variant.
- The dialog works in desktop continuous and Web remote replayable rendering
  without adding image bytes to conversation/session state.

## Source-specific behavior

- Markdown provides the adjacent Markdown image group and uses image alt text as
  the suggested filename.
- Browser Use / `node_repl` provides the retained images emitted by the same tool
  result as one group and suggests `result-image-{index}.{ext}` filenames. Core
  currently retains at most `MAX_NODE_REPL_DISPLAY_IMAGES = 2` display images
  per result.

## Accepted cases

| Case    | Setup                             | Action                    | Expected                                                    |
| ------- | --------------------------------- | ------------------------- | ----------------------------------------------------------- |
| SIG-001 | One Markdown or Browser Use image | Render message            | At most half message width and `max-h-90`                   |
| SIG-002 | Multiple images on narrow mobile  | Render message            | One column, wrapped without horizontal scrolling            |
| SIG-003 | Multiple images on small screen   | Render message            | Two columns, equal-height cropped thumbnails                |
| SIG-004 | Multiple images on desktop        | Render message            | Horizontal `h-44` thumbnails wrapping to new rows           |
| SIP-001 | One image                         | Open preview              | Centered image, no navigation arrows                        |
| SIP-002 | Multiple images                   | Open the second thumbnail | Second image active; arrows and keyboard navigate the group |
| SIP-003 | Zoomed image                      | Drag or pinch             | Translation/zoom stay within configured bounds              |
| SIP-004 | Any image                         | Download                  | Active image is saved through the current platform path     |
| SIP-005 | Navigated/zoomed image            | Change image              | Zoom and translation reset to 100%/center                   |
| SIP-006 | Windows or Linux desktop preview  | Open preview              | Download/close stay outside native or self-drawn controls   |
