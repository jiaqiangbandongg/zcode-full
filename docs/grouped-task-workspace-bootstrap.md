# Grouped task workspace bootstrap

Grouped task view bootstraps existing visible tasks by workspace.

## Behavior

- On the first grouped-view query that runs workspace bootstrap, visible tasks in the current scopes are moved into generated workspace groups.
- Completed tasks older than seven days in the current scopes are archived before workspace bootstrap reads visible tasks.
- The generated group title uses the workspace path leaf, such as `z-code`.
- The generated group id is deterministic from `workspaceIdentity || workspacePath`, so remote workspace identity remains isolated from local path display.
- The generated group color is deterministically distributed across the non-gray palette from the same workspace key.
- The generated group receives top-level grouped ordering.
- Tasks inside the generated group receive group-member ordering by recent activity.
- Generated workspace groups are only shown when their workspace is part of the current grouped-view scope.
- Workspace scopes with `workspacePurpose=conversation` participate in grouped task queries but are excluded from workspace-group bootstrap. Their tasks start as top-level ungrouped tasks and may be moved into ordinary user groups.

## Boundaries

- Bootstrap ignores existing group membership and rebuilds current visible task membership by workspace.
- Auto-archive during bootstrap is independent of settings and uses a fixed seven-day retention window.
- Workspace bootstrap writes a global marker after initialization, so deleting or ungrouping generated groups does not cause them to be recreated on the next refresh.
- New workspaces that appear after this one-time bootstrap do not receive generated workspace groups automatically.
- The managed conversation backing directory must never create a generated group named from its internal `default` path leaf.
- In grouped mode, clicking the global sidebar New task creates a UI-only draft row at the top level.
- In grouped mode, clicking a group-level New task entry creates the UI-only draft row at the top of that group.
- Repeated clicks on the same New task entry reuse the current draft row. Clicking a different New task entry repositions that same draft row to the latest requested placement.
- The grouped draft row is not persisted, cannot be renamed, cannot be dragged, and disappears when the user leaves it.
- When the first prompt creates a real task, the real task inherits the draft row placement before grouped order is persisted.
