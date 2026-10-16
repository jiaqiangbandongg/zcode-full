# Expert Workflow Runtime

## Goal

`/expert` provides a durable long-task workflow entry point for large NL->Code work. It is not a second agent loop and not a subagent. It is a workflow orchestrator that calls child agent sessions as activities.

The first supported workflow kind is `expert`, modeled after `~/workspace/zcode-cli-bak/src/gsap`: clarify the task, analyze it, decompose architecture, check environment needs, prepare meta prompts, execute, run a final critic, then produce a report.

The implementation must treat `expert` as the first built-in workflow definition, not as a one-off subsystem. Scheduling, graph state derivation, node transitions, activity recording, and ZCode app-server observation are generic workflow runtime capabilities. `expert` only supplies the default phase order, prompts, strategy defaults, and completion report.

Workflow contracts use generic `WorkflowRunSnapshot`, `WorkflowStrategy`, `kind`, and `phase` shapes so future workflow definitions can add their own phase names without changing the scheduler or ZCode app-server envelope. `ExpertWorkflowRunSnapshot` and `ExpertWorkflowStrategy` remain compatibility aliases for the built-in workflow, but the store and graph scheduler depend on the generic names. The slash command surface still only registers `/expert` for the built-in workflow; ZCode app-server and bootstrap expose a generic workflow control path where `kind` defaults to `expert` and `definitionId` can select a runtime-validated workflow definition.

Workflow definitions are also a generic contract. A `WorkflowDefinition` declares `definitionId`, `definitionVersion`, `kind`, `title`, `phaseOrder`, default `strategy`, and one `WorkflowPhaseDefinition` per phase. Phase definitions declare the phase id/title/description, optional artifact path, and behavior: `agent`, `scheduled_graph`, `critic`, or `complete`. An agent phase may also declare `seedGraphFromArtifact` with `targetPhase` and optional `gateAfterPhase`; the built-in expert definition uses that on `arch_decompose` to seed the `exec` graph and gate root task nodes after `meta_prompt`. An agent phase may also declare `nodePromptsFromArtifact` with a `targetPhase`; the runtime parses the phase artifact as a validated node-prompt update set and updates existing target-phase graph nodes before the scheduler dispatches them. The built-in expert definition uses this on `meta_prompt` so execution instructions become scheduler input instead of only another report artifact. The runtime reads expert's schedule from this definition object, so expert is the first built-in definition rather than the owner of the workflow scheduler.

Definition provenance is durable run state. New snapshots record `definitionId` and `definitionVersion`, and the initial graph meta record repeats both fields so event/graph readers can understand which definition shaped the run without loading mutable definition files later. Old snapshots may omit these fields and must remain readable.

Definition files live under the workflow definition directory:

```text
~/.zcode/cli/workflows/
  definitions/
    <definitionId>.json
```

The file body is the same `WorkflowDefinition` JSON object accepted by the runtime. Adapter-level loading validates the runtime schema before returning a definition, rejects path traversal in `definitionId`, and reports malformed JSON or schema failures before a run is created. The built-in `expert` definition is still available without any user file; a definition file named `expert.json` can override the built-in only after the command/API surface explicitly asks to load it. Until a generic `/workflow` command exists, `/expert` continues to use the built-in `expert` definition by default.

## Storage

Expert workflow state is user-level CLI state, not project state:

```text
~/.zcode/cli/workflows/
  definitions/
  runs/
    <runId>/
      run.json
      events.jsonl
      graph.jsonl
      artifacts/
      report.md
  index.json
```

Implementations must resolve the leading `~` through the same cross-platform storage-root logic used by CLI config. Do not hardcode Unix paths. The default root is derived from `storage.dir`; with the current default `storage.dir = ~/.zcode`, the workflow root is `~/.zcode/cli/workflows`.

## Architecture

The runtime boundary is:

```text
Command Center
  -> WorkflowRuntime
       -> WorkflowStorePort
       -> AgentRunnerPort
            -> child AgentRuntime session
```

`WorkflowRuntime` owns lifecycle, graph state, event history, artifacts, resume, and status formatting. It must not call model providers, tools, `fs`, `child_process`, or environment variables directly. External I/O is handled by `WorkflowStorePort` adapters and agent activity execution is handled by `AgentRunnerPort`. `WorkflowStorePort` persists generic workflow snapshots, so adding a future workflow kind must not require a new persistence adapter.

The generic scheduler boundary is:

```text
WorkflowRuntime
  -> WorkflowGraphScheduler
       -> WorkflowGraph snapshot
       -> AgentRunnerPort node activity
       -> callbacks for snapshot/event/graph-record persistence
```

`WorkflowGraphScheduler` is a pure orchestration layer around the durable graph. It accepts a generic `WorkflowRunSnapshot`, derives ready, active, blocked, failed, and collection frontier state from `WorkflowGraph`, respects `strategy.executor.maxConcurrentLoops`, starts child agent activities for ready nodes, marks node transitions, and emits small workflow events. It does not know about `fs`, config files, provider clients, tools, ZCode app-server transports, terminal UI, or the built-in expert phase list.

The scheduler also owns the generic graph-expansion contract used by GSAP-style exploration. A workflow graph may define optional `collections[]`; each collection contains `collectionId`, `nodeIds`, `explorable`, optional `frontierTarget`, planner counters, watermarks, and exhaustion state. When a collection is explorable and its pending+active frontier falls below the target after seeded work has had a chance to run, the scheduler may call an injected planner port. The planner returns nodes and edges; the scheduler validates duplicates, unknown edge endpoints, self-loops, and cycles before persisting the expansion. This makes graph growth a reusable workflow capability. `expert` supplies the first built-in collection/planner prompts later, but does not own the expansion mechanism.

Workflow graph seeding is the generic bridge from planning artifacts into scheduler state. A phase artifact may return a `WorkflowGraphSeed` JSON object, either as raw JSON or fenced JSON:

```json
{
  "nodes": [
    {
      "id": "implement_auth",
      "title": "Implement auth",
      "description": "Small executable unit",
      "dependsOn": ["setup_config"],
      "collectionId": "implementation",
      "prompt": "Optional node-specific instructions"
    }
  ],
  "edges": [{ "from": "setup_config", "to": "implement_auth" }],
  "collections": [
    {
      "collectionId": "implementation",
      "nodeIds": ["setup_config", "implement_auth"],
      "explorable": false,
      "goal": "Ship the feature",
      "metric": "Tests pass"
    }
  ],
  "reasoning": "Brief rationale"
}
```

The runtime validates seeded nodes and edges with the same duplicate, unknown endpoint, self-loop, and cycle checks used by planner expansion, then appends graph node/edge/collection records plus a `graph_seeded` graph op and `graph_expanded` event. The built-in expert workflow uses this after `arch_decompose` to seed `exec` task nodes. It also accepts the legacy GSAP architecture shape from `~/workspace/zcode-cli-bak` (`name`, `references`, `source`/`target`, `node_names`/`nodeNames`) so the copied scheduler prompts can be migrated without losing compatibility. Future workflow kinds can reuse the same seed schema from their own planning phases; `expert` is only the first producer.

Workflow node prompt enrichment is the generic bridge from meta-prompt artifacts into scheduler input. A phase artifact may return a `WorkflowNodePromptUpdateSet` JSON object, either raw or fenced:

```json
{
  "nodes": [
    {
      "id": "implement_auth",
      "prompt": "Implement only the auth boundary and keep migrations separate.",
      "description": "Optional refined objective.",
      "title": "Optional refined title"
    }
  ],
  "reasoning": "brief rationale"
}
```

The runtime accepts legacy-friendly aliases such as `nodeName`, `node_name`, `instructions`, `rules`, and keyed maps under `nodePrompts` / `node_prompts`. Updates are applied only to existing nodes in the configured target phase; unknown node ids, duplicate ids, empty updates, or attempts to mutate a node from another phase are structured workflow errors. The update writes a normal snapshot plus a `node_prompts_updated` graph op and a small `graph_updated` event with changed node ids. The scheduler remains generic: it only reads `node.prompt`, `node.description`, and `node.title` when building child activity prompts.

`AgentRuntime` remains the only unit that thinks, calls tools, edits files, and talks to providers. A workflow phase is one child session activity. The parent session starts and observes the workflow; child sessions do the actual phase work.

The run snapshot records the durable relationship:

```text
workflowRun
  parentSessionId
  activities[]
    activityId
    kind = agent_session
    phase
    nodeId
    parentSessionId
    sessionId
    turnId
    traceId
    status
    inputArtifactPaths[]
    outputArtifactPaths[]
```

This is intentionally different from a simple multi-turn implementation. Complex GSAP-style scheduling needs phase/node isolation, replayable activity state, and later concurrent execution. A future frontier executor can add multiple activities under the same phase or graph node without changing the command surface.

The runtime may still run non-exec phases serially. The `exec` phase must go through the generic DAG scheduler so later workflow definitions can reuse the same scheduler for different phase names and node prompts. If a run only contains the built-in phase graph, `exec` schedules the `phase:exec` node as a single activity. If a definition or planner adds task nodes, independent ready nodes can run concurrently without changing slash-command or ZCode app-server APIs.

## Default Mode

`/expert <task>` defaults to yolo mode. The command may switch the active session mode to `yolo` before starting the workflow. Workflow execution still uses the normal tool runtime and event stream; it does not create a separate permission system.

## Command Surface

- `/expert <task>` starts a new expert workflow run for the task.
- `/expert status [runId]` shows the latest or named run.
- `/expert resume [runId]` resumes the latest or named incomplete run.
- `/expert stop [runId]` marks the latest or named run cancelled.

Bare `/expert` is equivalent to `/expert status`.

The command center owns parsing and dispatch. The TUI only submits the slash command and renders returned text/events.

## ZCode App-Server Control Surface

Desktop and web clients must manage workflow state through ZCode app-server, not by reading the workflow store directly. The workflow store is the durable truth source; ZCode app-server is the control and observation surface.

ZCode Protocol extension methods:

- `zcode.dev/workflow/start`: start a workflow in the background and return the initial snapshot.
- `zcode.dev/workflow/list`: list workflow runs for the current workspace.
- `zcode.dev/workflow/get`: read one workflow snapshot and optional recent events.
- `zcode.dev/workflow/cancel`: mark a workflow run cancelled.

ZCode Protocol extension notifications:

- `zcode.dev/workflow/event`: emitted when workflow lifecycle events are appended.

All workflow extension requests are scoped through a ZCode app-server `sessionId`. The session identifies the workspace process and parent session; the workflow run then records child agent sessions through `activities[].sessionId`. Requests may include a non-empty `kind` string, which defaults to `expert`, and may include a non-empty `definitionId` string to load a definition from `~/.zcode/cli/workflows/definitions`. When both are supplied, the loaded definition's `kind` must match the requested `kind`. ZCode protocol clients should render workflow runs as scheduler objects and link out to child sessions instead of flattening a workflow into a normal chat session.

`zcode.dev/workflow/get` returns the durable snapshot and may include recent workflow events. Clients can derive active, ready, and blocked nodes from `snapshot.graph.nodes[].status`, `dependsOn`, and `snapshot.graph.edges`. The server also emits scheduler lifecycle events so clients can refresh without polling every field:

- `node_started`
- `node_completed`
- `node_failed`
- `frontier_changed`
- `executor_paused`
- `executor_completed`

The extension surface intentionally mirrors the slash command capabilities but returns structured data. UI clients must not start workflows by sending `/expert ...` as a prompt because that loses structured run/activity/session relationships.

`zcode.dev/workflow/start`, `zcode.dev/workflow/get`, and `zcode.dev/workflow/cancel` also return a derived `scheduler` object alongside `snapshot`. The server validates this view with `WorkflowSchedulerStateSchema` before crossing the ZCode app-server boundary:

- `readyNodeIds`
- `activeNodeIds`
- `activeActivities[]` with `activityId`, `phase`, optional `nodeId`, and optional child `sessionId`
- `activeChildSessionIds[]` for clients that want direct child-session links
- `blockedNodes[]` with `nodeId` and `blockedBy`
- `collectionStates[]` with frontier, planner, exhaustion, and ready-node state
- `counts` for total, pending, active, ready, blocked, completed, and failed
- `nodes[]` with each graph node plus incoming/outgoing dependency ids

The derived scheduler object is computed from the durable workflow snapshot. Graph state remains the source for ready/blocked/frontier derivation, and active activity state provides child session links once the child runtime has been created. It is a view, not a second source of truth. `zcode.dev/workflow/event` notifications must preserve `nodeId` and small structured `payload` values such as frontier changes so desktop clients can update debugger state without re-parsing event messages.

Malformed workflow ZCode app-server requests must fail with structured ZCode app-server `invalidParams` or `invalidRequest` errors. Examples: `sessionId`, `task`, `kind`, and `definitionId` must be non-empty strings when supplied, `runId` must be a non-empty string when supplied, `limit` and `eventLimit` must be positive integers, and `includeEvents` must be boolean when supplied.

## Scheduling Strategy

The default `expert` definition follows the GSAP-inspired schedule:

1. `clarify`: refine the task, assumptions, acceptance criteria, and open questions without blocking unless the agent needs to use `AskUserQuestion`.
2. `task_analysis`: map user intent to repo context, risks, constraints, and validation needs.
3. `arch_decompose`: decompose the work into a dependency graph of nodes and edges.
4. `env_setup`: detect environment setup or dependency work needed before execution.
5. `meta_prompt`: produce execution instructions for downstream node/phase runs.
6. `exec`: execute the plan through the normal agent runtime.
7. `final_critic`: review changes, compare against acceptance criteria, identify residual risk.
8. `complete`: write a final report and mark the run terminal.

The initial runtime may execute non-exec phases serially. The contract must keep graph records and strategy fields so later versions can add frontier scheduling, planner loops, and concurrent node workers without changing command/TUI APIs.

The scheduler copies the important GSAP executor properties from `~/workspace/zcode-cli-bak/src/gsap/pipeline/executor.ts`:

- Ready nodes are pending nodes whose declared dependencies are terminal.
- Dispatch consumes a concurrency slot before launching a child activity, preventing synchronous over-dispatch.
- Completion and failure always release the slot and persist graph/activity state.
- The scheduler waits for at least one active activity when no more nodes can be dispatched.
- Consecutive node errors pause the executor instead of spinning forever.
- Resume repairs stale `active` nodes left by a stopped process by resetting them to `pending` before dispatch, matching the bak executor's `resumeFromState` behavior.
- Explorable collections use the bak executor's frontier rule: do not expand before seeded nodes produce a completion, expand when frontier is below target or new completed nodes need analysis, cap planner runs, and mark collections exhausted on planner/error limits.
- Graph expansion follows the bak graph ops safety rules: reject duplicate nodes, self-loop edges, duplicate edges, unknown edge endpoints, and cycles before writing durable state.

Workflow lifecycle repair is generic runtime behavior, not expert-only behavior. When a workflow resumes without proof that child sessions are still running, stale active graph nodes are reset to `pending`, stale active activities are closed as `cancelled` with a resume-repair reason, and the repaired graph is persisted before new dispatch. When a workflow is cancelled, the run is marked `cancelled` and all non-terminal phases, graph nodes, and activities are marked `cancelled` so ZCode protocol clients do not continue to display phantom active or ready work. Same-process background runs must also receive an abort signal so cancellation stops new child activities instead of only editing the durable snapshot. Child session ids are recorded as soon as the activity runner creates the child runtime, so ZCode app-server debuggers can link active workflow activities before they complete.

The generic collection/planner contract and graph expansion validation are in place. The built-in expert workflow now seeds `exec` task nodes and collections from `arch_decompose` artifacts, including the legacy GSAP graph shape. Further planner specialization can still improve the quality of generated exploration prompts, but the graph bridge itself is generic workflow behavior.

The built-in expert workflow also feeds `meta_prompt` artifacts back into existing `exec` nodes through `nodePromptsFromArtifact`. This preserves the bak scheduler idea that planning/meta-prompt output must shape downstream node execution, while keeping the operation reusable for future workflow definitions.

### GSAP-like node execution

The scheduler must stay generic: it decides which DAG nodes are ready, active, blocked, retried, or complete. The built-in `expert` workflow supplies the first GSAP-like node executor for `scheduled_graph` task nodes.

For a task node in the built-in `expert` `exec` phase, execution is:

1. `subplanner_agent`: split the node into one or more concrete loops. The preferred JSON shape is `{ "loops": [{ "id": "...", "description": "...", "prompt": "...", "allowEmptyDiff": false, "needsWorktree": true, "graphNodeName": "node-id" }], "noMoreLoops": false }`. The runtime also accepts legacy GSAP aliases such as `loop_id`, `goal`, `rules`, `parallel_eligible`, `allow_empty_diff`, `needs_worktree`, and `graph_node_name`.
2. `actor_agent`: execute one loop. The preferred JSON shape is `{ "status": "done" | "in_progress" | "blocked", "summary": "...", "filesChanged": ["..."] }`.
3. `critic_agent`: review the actor result. The preferred JSON shape is `{ "verdict": "pass" | "fail", "reasoning": "...", "blockers": ["..."] }`.
4. Repeat actor/critic up to `strategy.reactLoop.maxRounds`. A failed critic feeds its reasoning and blockers into the next actor prompt. A blocked actor or exhausted loop fails the workflow node so normal retry/pause policy can take over.

If no task nodes were seeded and the only executable node is the built-in phase node, the scheduler may still use the direct single child activity path for compatibility. GSAP-like execution is for task nodes because they carry the scoped implementation objective.

Every subplanner, actor, and critic attempt is a normal workflow activity with an activity kind, artifact path, model, trace id, turn id, and optional child session id. `WorkflowRunSnapshot.sessionLinks[]` is derived from these activities so ZCode protocol clients can show all attempts for a node without scraping event text. `zcode.dev/workflow/event` must preserve `nodeId` and small payload fields such as `activityId`, `activityKind`, `loopId`, `attempt`, `sessionId`, `model`, and `artifactPath`.

Final critic is a generic workflow graph feedback loop, not an expert-only patch path. A critic activity returns a validated workflow critic result:

```json
{
  "verdict": "pass",
  "reasoning": "All acceptance criteria are met.",
  "reopenProposals": [
    {
      "nodeId": "node-id",
      "reason": "Concrete issue that requires rerunning this node.",
      "severity": "major"
    }
  ],
  "acceptanceGaps": ["Optional unresolved acceptance gap"]
}
```

`verdict=pass` completes the critic loop. `verdict=fail` with an empty `reopenProposals` list exits the loop without spending more model calls, because there is no graph mutation that could change the next verdict. For each accepted reopen proposal, the runtime applies a generic `reopen_node` graph operation: the target node must be in a terminal execution state (`completed`, `failed`, or `skipped`), its `reopenAttempts` counter must be below the configured cap, its status is reset to `pending`, and a `node_reopened` event plus graph op record are persisted. The executor is then re-entered over the same workflow graph, so dependency rules, concurrency limits, collection state, and child activity recording stay centralized in `WorkflowGraphScheduler`.

The built-in expert workflow uses this loop for `final_critic`, but future workflow definitions can reuse the same critic result schema and node reopen operation for other phase names. Critic loop events are:

- `critic_started`
- `critic_passed`
- `critic_failed`
- `node_reopened`
- `critic_iteration_limit_reached`

Default strategy values mirror the bak GSAP defaults where applicable:

- clarify: `maxRounds = 3`, `minRounds = 1`, `confidenceThreshold = 0.8`
- react loop: `maxRounds = 30`
- executor: `maxConcurrentLoops = 2`, `frontierTarget = 3`, `maxPlannerRuns = 10`, `maxConsecutiveErrors = 3`
- final critic: `maxIterations = 3`

Do not copy bak-only env vars such as `ZCODE_GSAP_*` unless a future spec defines their priority, errors, and tests.

## Tests

Required coverage:

- command parser recognizes `/expert`, `/expert status`, `/expert resume`, and `/expert stop`.
- command center starts expert in yolo mode and does not rewrite it into a normal model prompt.
- workflow store writes `run.json`, `events.jsonl`, `graph.jsonl`, artifacts, report, and `index.json`.
- workflow runtime runs phases in schedule order with a fake agent runner and records one child session activity per agent phase.
- workflow scheduler dispatches independent ready nodes concurrently, blocks dependent nodes, records node events, and pauses on the configured consecutive error threshold.
- ZCode app-server workflow extension methods list, get, cancel, and background-start workflow runs without parsing normal chat text.
- status/resume/stop work for missing, active, failed, cancelled, and completed runs.
- CLI/TUI wiring keeps `/expert` out of TUI-owned state.
