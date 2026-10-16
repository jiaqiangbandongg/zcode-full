# Chat Model Change Notice

## Scope

When a user changes the model inside an existing ZCode session, the UI immediately shows a toast warning that switching models during a conversation can reduce performance. The conversation timeline notice is held as pending and only appears before the next accepted prompt in that same task.

## State Boundary

- Notices are stored only in `packages/ui` Zustand memory state.
- Notices are keyed by workspace state (`workspaceIdentity?.trim() || workspacePath`) and task id.
- Notices are not written to localStorage, task history, ZCode protocol snapshots, replayable stream state, or service-layer persistence.
- A model change that is not followed by another prompt remains pending and does not alter the visible conversation timeline.
- Each task keeps only the most recent notices to avoid unbounded memory growth during one app lifecycle.

## Remote Compatibility

The feature does not change task realtime delivery. Desktop `desktop-continuous` and mobile `web-remote-replayable` streams keep their existing boundaries because the notice is a renderer UI event, not a replayable runtime event.

Remote workspace isolation follows the existing workspace identity rule, so two remote workspaces with the same `workspacePath` but different `workspaceIdentity` do not share notices.
