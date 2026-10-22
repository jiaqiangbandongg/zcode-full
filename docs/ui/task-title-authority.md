# Task Title Authority

Task title can come from several places during a session lifecycle. Renderer code must treat them as ordered candidates instead of letting the newest snapshot string always win.

## Title priority

1. User-renamed title with `titleOverridden=true`.
2. Agent-generated title from the session/title update pipeline.
3. First user query title used as the initial optimistic title.
4. The agent default placeholder `New session`.

## Renderer restore rule

- CLI owns persisted titles and title source; `tasks-index.sqlite` contains their read-only Host projection.
- The active header reads the existing workspace-scoped `ZCodeTaskService.getTaskMeta` and refreshes on Host metadata events. It does not depend on a sidebar/query-cache row or call `readSession` to obtain a title. Historical and archived sessions can have metadata before their CLI runtime is active.
- `readSession` / `resumeSession` returns a raw agent snapshot. Its projected task meta is only a runtime candidate and can be missing app-side `titleOverridden`.
- Restore and remaining task cache sync paths must merge raw snapshot meta with indexed/query-cache meta before writing renderer caches. The active header uses Host metadata directly; existing optimistic metadata is used only before the indexed record arrives.
- A raw snapshot title must not overwrite a title whose existing meta has `titleOverridden=true`.
- `New session` must not overwrite a non-placeholder title, even when the snapshot has a newer `updatedAt`.
- Generated titles may replace the first query title when there is no user override.

## Compatibility

- Workspace-scoped title lookup uses `workspaceIdentity?.trim() || workspacePath`, matching remote workspace isolation. The active read also belongs to its scoped service/attachment and task ID; late responses cannot overwrite a newer target or request.
- The rule applies to desktop `desktop-continuous` restore and web remote `web-remote-replayable` restore. Replayable recovery can use snapshots to refill runtime fields, but it must not bypass the same title authority merge.
