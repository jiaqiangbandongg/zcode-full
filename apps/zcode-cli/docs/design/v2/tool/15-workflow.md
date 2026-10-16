# Workflow Tool

## Capability

`Workflow` is a client-side built-in tool that starts a script workflow from the main model loop.
It is now the **only** entry point for script workflows — the `/workflow run` and `/workflows`
commands were removed on 2026-08-22 (`docs/dynamic-workflow/launch.md`). The tool accepts a
self-contained workflow script, a named workflow, a script path, or a prior run id to resume.

The model-visible description is derived from `workflow.md`. It must make explicit that the model
may only call `Workflow` after the user opted into multi-agent orchestration.

## Input

The Zod runtime schema is the source of truth and projects to provider-neutral JSON Schema:

- `script?: string` up to `524288` bytes. A self-contained script beginning with
  `export const meta = { name, description, phases }`.
- `name?: string`. A saved workflow name resolved from the allowlisted built-in registry, project
  `.zcode/workflows`, then user `~/.zcode/workflows`.
- `args?: unknown`. Exposed to the script as global `args`.
- `scriptPath?: string`. Path to an editable workflow script. This takes precedence over `script`
  and `name`.
- `resumeFromRunId?: string` matching `wf_[a-z0-9-]{6,}`. Resumes an earlier run in the same
  session lineage.

At least one of `scriptPath`, `script`, `name`, or `resumeFromRunId` is required. Precedence is
`scriptPath > script > name`; `resumeFromRunId` may be combined with a script source to re-run the
same deterministic call prefix after edits.

## Output

The tool returns a small structured object:

- `status`: `backgrounded`, `completed`, or `failed`. V1 returns `backgrounded` after launch.
- `runId`: durable workflow run id.
- `scriptPath?`: editable script path used for this invocation.
- `name?`: resolved workflow name when available.
- `response`: human-readable summary carrying the run id. It must NOT point at `/workflows`
  (removed); runs are read back through the app capabilities / desktop workflow surface.
- `traceId`: propagated trace id.

The full workflow tree, child session links, events, stats and failures are stored in workflow
tables and read through the app's workflow capabilities (desktop surface / app-server queries);
they are not embedded in the tool result.

When a background workflow reaches a terminal state, the runtime task tracker enqueues a
`<task-notification>` for the parent runtime. The notification uses the same runtime command queue
as Bash and background subagents, so the main agent can stop after launch and be woken when the
workflow completes.

## Side Effects And Permission

`Workflow` is not read-only. Even though the tool handler only validates input, persists an editable
script copy, and launches a background workflow, child workflow agents run in yolo mode and may call
workspace-mutating tools. The tool therefore declares:

- `sideEffectScope: "workspace"`
- `riskLevel: "high"`
- `needsApproval: true`
- `concurrentSafe: false`
- `destructive: true`

Permission matching uses the tool name and input summary. Child agent tool calls still go through
their own runtime/tool contracts inside their child sessions.

## Execution Boundary

The core handler never reads files, writes files, starts processes, or touches SQLite directly. It
validates the input and delegates to `WorkflowPort`. Bootstrap implements the port by reusing the
script workflow runtime:

1. Resolve the script source.
2. Persist inline scripts under a session-scoped storage directory.
3. Validate meta and DSL constraints before reporting a launch.
4. Create or resume a `wf_...` run in the workflow tables.
5. Start the runner in the background and return a small launch result.

The script itself still runs in the dedicated Node child process described in
[`../workflow-script.md`](../workflow-script.md). This is process isolation, not a sandbox.

`WorkflowPort` exposes an optional `waitForTask` completion boundary. Bootstrap wires this to the
background workflow run promise so terminal workflow snapshots can be observed without relying on
poll timing; `getTask` remains available for live status updates and UI projection.

## Resume And Status

The workflow run id is durable. The app's workflow capabilities list runs and read status, phase,
activities, child sessions and accumulated stats (the `/workflows` command that used to render this
is gone; the run store is unchanged). Resume starts a new runner process and replays the
script from the beginning; completed `agent()` calls with the same deterministic call path and input
hash return cached results.

## Failure Paths

- Invalid tool input fails before any workflow launch.
- Unknown named workflows fail with a stable configuration error at the port boundary.
- Invalid or unreadable scripts fail before the tool returns `backgrounded`.
- Background runner failures update the workflow run status and events; callers read the structured
  failure back through the workflow capabilities.
- Cancellation of the tool call only cancels launch. Once launched, the workflow is tracked by run
  id and future stop/resume commands operate on that run.

## Tests

Required coverage:

- Contract schema accepts `script`, `name`, `scriptPath`, `resumeFromRunId`, and rejects empty input
  or unknown fields.
- Registry registers `Workflow` only when a `WorkflowPort` is configured.
- Handler delegates to `WorkflowPort` with `sessionId`, `turnId`, `toolCallId`, cwd and trace.
- Missing `WorkflowPort` fails closed.
- Bootstrap port persists inline scripts, resolves named workflows from `.zcode/workflows` and
  `~/.zcode/workflows`, and returns a `wf_...` launch result.
- Background workflow completion enters `RuntimeTaskRegistry` as `local_workflow` and queues a
  parent `<task-notification>` only after terminal completion is observed.
