# Collapsible Remote connection Dialog

## Goal

Remote connection setup can take a long time while SSH/Docker sessions are created and remote assets are prepared. The remote connection wizard supports minimizing the dialog from any wizard step without cancelling the active connection flow or discarding an idle draft/error state.

## State Boundary

### Connection type shortcuts

The current three-screen wizard starts with the unified device list. New SSH,
Docker, Windows-only WSL, and development-only Server entries open their matching
configuration form on a single click. The form belongs to the first screen; there
is no separate type-selection screen or Next action. Visibility rules are unchanged.
This follows [RDUX-10](architecture/remote-device-connection-ux-spec.md#三屏向导与统一选择2026-09-28rdux-10).

The form hook owns the selected type, and the single dialog flow owner switches
between the list and the form:

```text
single click / double click -> new connection(type) -> reset draft / feedback -> matching form
Back to list -> unified device list -> another explicit entry chooses its own type
form submit -> validate -> connection screen
```

A double-click must reach the same form as a single click without submitting it.
After visiting another type and returning to the list, both gestures still open
the chosen type. The list entries are actions rather than a retained radio
selection; returning does not require a selected-card style. Only explicit form
submission begins a connection. Keyboard activation uses the same entry action.
Mobile Web currently does not mount this dialog; desktop continuous and mobile
replayable connection recovery are unchanged.

Acceptance: for each visible type, verify single-click, double-click after visiting
another type, and another double-click after returning to the list. All paths must
show the matching form, produce no form submission, and remain outside connection
or directory selection (catalog CWP20).

### Active flow

The active remote connection wizard is mounted once from `RootInner`. This keeps the wizard state alive while the user moves between workspace views and settings.

The active-flow state is still defined as either:

- a connection request is still loading, or
- a remote session is connected and waiting for directory selection.

When the flow is active, opening the dialog resumes the current wizard step. An explicit minimize also resumes the preserved step when the flow is idle, including the device list, connection settings, and failed connection context. A fresh open starts from the unified device list; a new connection form remains part of this first screen.

## Minimize vs Close

Minimize only hides the dialog. It does not cancel the pending request, clear form/error/log state, reset the current step, or release a connected session. The minimize action is available throughout the three-screen flow, including the first-screen configuration form.

Close keeps the previous destructive behavior. If a connection is pending, the user must confirm cancellation. If a session is connected but no directory has been selected, closing releases that session.

## Entry Indicators

When a minimized flow is active, the workspace sidebar `Open Workspace` button shows a connecting indicator.

Clicking the entry opens the same global wizard instance and returns to the current step.

## Reconnect Logs

Remote workspace reconnects expose the same runtime log stream from hover tooltips in the workspace sidebar. The tooltip stays compact in the row and scrolls to the latest log line when opened.

Log ownership is keyed by the reconnect request id when it is available. This prevents concurrent reconnects to the same SSH host, WSL distro, or Docker container from showing each other's upload or setup logs. Legacy log events without a request id only fall back to target-label matching when the target uniquely identifies one reconnecting workspace.
