# Task Notification Routing

## Boundary

Task notification facts come from v4 projections, not from a renderer-owned
background runtime monitor:

```text
CLI/runtime projection
  -> sessions-index / conversation snapshot
  -> renderer notification orchestrator
  -> IPlatformService.showTaskNotification
  -> desktop main / Web Notification API
```

`sessions-index` is the source for terminal task facts (`completedSuccess`,
`completedInterrupted`, `error`). `ConversationSnapshot.pendingInteractions` is
the source for permission and user-input blockers.

## Rules

- Renderer does not reply to host/server to decide task facts.
- Red error dots come from task status and never depend on notification display.
- Unread is the only persisted attention state written back by renderer because
  it depends on whether the task was seen in this window.
- System/browser notifications are presentation side effects. Renderer formats
  localized copy and sends a platform command; platform code applies focus,
  support, preference, and duplicate suppression.
- Cold snapshots only seed notification baselines. They do not replay historical
  completion, failure, permission, or elicitation notifications.

## Multi-client Shape

Multiple renderers may observe the same runtime fact. Each renderer decides
presentation for itself, while platform-layer focus suppression prevents focused
windows/pages from showing intrusive notifications. Host, relay, and desktop
main do not own task/session/queue/snapshot business state.
