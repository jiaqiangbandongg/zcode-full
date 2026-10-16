# Workflow Debugger

Workflow Debugger is a lightweight side-pane tool for inspecting ZCode Agent workflow runs.

## Scope

The default workflow kind is `expert`, while the ZCode task service/types accept arbitrary non-empty workflow kinds and optional `definitionId` values from newer ZCode agents. The panel is intentionally debugging-oriented and shows:

- workflow run list for the active workspace
- selected run snapshot
- phase status
- workflow graph state, including frontier, active, ready, blocked, completed, and failed nodes
- activity to child session mapping
- recent workflow events

## ZCode Integration

The renderer never reads `~/.zcode/cli/workflows` directly. It calls `IZCodeTaskService`, which currently exposes the shared `IWorkflowService` shape.

Current branch status: the UI and shared `ZCodeWorkflow*` types are still present, but the ZCode task service adapter only returns empty workflow data and marks mutating workflow operations unsupported. The intended agent extension methods remain:

- `zcode.dev/workflow/start`
- `zcode.dev/workflow/list`
- `zcode.dev/workflow/get`
- `zcode.dev/workflow/cancel`

Live updates are delivered through the extension notification:

- `zcode.dev/workflow/event`

When workflow transport is reconnected, the adapter must map that notification into a workspace event with type `workspace_workflow_event`, preserving `kind`, `nodeId`, and small structured `payload` fields. Preserving these fields is required for incremental scheduler/frontier updates from `zcode-cli`; older clients that dropped them had to reload the full snapshot to understand node movement.

The graph view uses the `snapshot.graph` payload returned by `zcode.dev/workflow/get`.
When the response also includes `scheduler`, the graph view prefers that derived server state and falls back to local graph derivation for older agents.
It derives:

- `active`: nodes currently executing
- `ready`: pending nodes whose dependencies are terminal
- `blocked`: pending nodes still waiting on dependencies
- `frontier`: active + ready nodes, matching the debugger's useful scheduling surface

This keeps the UI close to GSAP's DAG/frontier mental model without requiring direct access to workflow artifacts.

## UI Placement

The debugger is a right side-pane tab named `Workflows`. The tab renderer is still kept for restored or already-open debug tabs, but the side-pane add-menu entry is hidden while workflow state is not productized.
