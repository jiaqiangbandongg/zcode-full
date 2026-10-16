# CUA PiP Session Consumer Integration

## Ownership

ZCode publishes product facts only. `@zcode/zcode-cua` owns PiP panels, grouping,
dismissal, terminal badges, capture admission, native stacking and retry policy.

```text
Renderer activeTaskId --value change--> Desktop Main focus router
                                             |
                                             | FocusChanged(revision, windowId, sessionId)
                                             v
window-scoped Local Host ------------> producer pip-session client

computer-use/operation-event --------> TurnStarted / TurnEnded / SessionClosed
                                             |
                                             v
                                  producer PipSessionCoordinator
```

Desktop Main keeps only ephemeral `{windowId -> activeSessionId}`, the focused
ZCode window and a process-lifetime `focusRevision`. A background renderer may
update its map, but only the frontmost ZCode window publishes global focus. When
focus moves between ZCode windows, Main sends `sessionId=null` to the old host
before sending the new host's session. When no ZCode window is focused, the last
host receives `sessionId=null`.

The existing `computer-use/operation-event` sideband remains outside conversation
snapshot, queue and replayable delivery. Desktop continuous and web-remote
replayable semantics are unchanged. Remote workspaces and mobile clients never
create another Helper or presentation client.

## Strict compatibility

The Local Host imports `@zcode/zcode-cua/pip-session` for pure event types and
`@zcode/zcode-cua/pip-session/node` for the control client. It does not parse
NDJSON or name broker methods. The client must complete the exact runtime/version
handshake before sending events. A mismatch disables Auto-PiP for that Helper
transport and produces one diagnostic; there is no `pip_stop`, clear, freeze or
legacy group fallback.

## Lifecycle mapping

| Sideband fact | Producer event |
| --- | --- |
| `turn-started` | `TurnStarted` with the original sequence and event id |
| `turn-completed` | `TurnEnded(outcome=completed)` |
| `turn-failed` | `TurnEnded(outcome=failed)` |
| `session-closed` | `SessionClosed` |

Tool scheduled/started events continue to drive the Windows operation indicator,
but do not define PiP lifecycle. ZCode never manufactures a green badge from
connection loss or controller state.

## Verification catalog

| ID | Scenario | Expected |
| --- | --- | --- |
| PIP-C01 | renderer repeats the same active task | one IPC fact only |
| PIP-C02 | background window changes task | Main map changes; producer focus does not |
| PIP-C03 | foreground switches A -> B | old host gets null, new host gets B, revisions increase |
| PIP-C04 | completed / failed / closed sideband | exact typed producer event and original ordering fields |
| PIP-C05 | protocol/runtime mismatch | Auto-PiP disabled, one diagnostic, no raw fallback |
| PIP-C06 | web remote or remote authority | no presentation client/helper creation |
| PIP-C07 | source audit | no PiP NDJSON parser, raw group method names, or session env key |

This catalog is intentionally separate from the conversation formal matrix: the
facts are desktop-local presentation sideband and never enter conversation state.
