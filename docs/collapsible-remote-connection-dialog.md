# Collapsible Remote connection Dialog

## Goal

Remote connection setup can take a long time while SSH/Docker sessions are created and remote assets are prepared. The remote connection wizard now supports minimizing the dialog without cancelling the active connection flow.

## State Boundary

### Connection type shortcuts

All visible connection type cards support double-clicking to select that type and
advance to its configuration step. Single-clicking still only selects the type;
the existing Next button remains available. SSH, Docker, Windows-only WSL, and
development-only Server share this behavior without changing their visibility rules.

The form hook continues to own the selected type, and the dialog owns the wizard
step. Double-clicking reuses the existing Next callback, including feedback reset:

```text
single click -> form.setKind(type) -> stay on kind step
double click -> form.setKind(type) -> dialog Next -> reset feedback -> settings
```

Entering settings does not start a connection. Switching from another selected
card must open the double-clicked type's settings; returning to the type step
retains that selection. Keyboard selection and Next retain their existing behavior.
Mobile Web currently does not mount this dialog; desktop continuous and mobile
replayable connection recovery are unchanged.

Acceptance: for each visible type, verify single-click plus Next, double-click from
another selection, and double-click after returning from settings. All paths must
show the matching form without submitting a connection (catalog CWP13).

### Active flow

The active remote connection wizard is mounted once from `RootInner`. This keeps the wizard state alive while the user moves between workspace views and settings.

The active-flow state is defined as either:

- a connection request is still loading, or
- a remote session is connected and waiting for directory selection.

When the flow is active, opening the dialog resumes the current wizard step. When the flow is idle, opening the dialog starts from the first step. Failed connections reopen on the connecting step so users can immediately see the failure context and retry.

## Minimize vs Close

Minimize only hides the dialog. It does not cancel the pending request, clear logs, reset the current step, or release a connected session.

Close keeps the previous destructive behavior. If a connection is pending, the user must confirm cancellation. If a session is connected but no directory has been selected, closing releases that session.

## Entry Indicators

When a minimized flow is active, the workspace sidebar `Open Workspace` button shows a connecting indicator.

Clicking the entry opens the same global wizard instance and returns to the current step.

## Reconnect Logs

Remote workspace reconnects expose the same runtime log stream from hover tooltips in the workspace sidebar. The tooltip stays compact in the row and scrolls to the latest log line when opened.

Log ownership is keyed by the reconnect request id when it is available. This prevents concurrent reconnects to the same SSH host, WSL distro, or Docker container from showing each other's upload or setup logs. Legacy log events without a request id only fall back to target-label matching when the target uniquely identifies one reconnecting workspace.
