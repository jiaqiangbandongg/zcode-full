# Expert Workflow TODO

## Purpose

This document is the handoff TODO for taking `/expert` from the current v0 workflow shell to a GSAP-class scheduler.

Current state:

- `/expert` command exists and defaults to yolo.
- Workflow runs are persisted under `~/.zcode/cli/workflows`.
- ZCode app-server exposes `start/list/get/cancel` plus workflow event notifications.
- z-code-2 has a Workflows side pane that shows runs, phases, activities, events, and graph/frontier state.
- The runtime executes non-exec expert phases serially, and routes `exec` through the generic workflow DAG scheduler.

Target state:

- `exec` becomes a real DAG scheduler.
- The graph grows and changes during execution.
- Child agent sessions are first-class node activities.
- ZCode app-server streams fine-grained scheduler state so z-code-2 can debug what is running, ready, blocked, retried, reopened, or done.

## P0: Real DAG Executor

Goal: make `exec` use graph/frontier scheduling instead of one serial phase activity.

Status: initial generic scheduler landed. It derives ready/active/blocked nodes, dispatches ready executable nodes with `maxConcurrentLoops`, records child agent activities per node, emits node/frontier/executor events, retries failed nodes, pauses on `maxConsecutiveErrors`, and exposes the derived scheduler state through the workflow contract plus ZCode app-server detail responses. The durable contract now exposes generic `WorkflowRunSnapshot` / `WorkflowStrategy` names while keeping expert aliases for compatibility. Resume/cancel now have generic snapshot repair helpers: stale active work is closed before resume, cancellation marks non-terminal workflow state as cancelled, and same-process background workflows receive abort signals. Remaining P0 work is mostly feeding richer task graphs from planner output.

Tasks:

- [x] Add a workflow executor module under `packages/core/src/workflow/`.
- [x] Load `snapshot.graph` and derive ready nodes from dependencies.
- [x] Track node states: `pending`, `active`, `completed`, `failed`, `skipped`, `cancelled`.
- [x] Dispatch ready nodes as child agent session activities.
- [x] Respect strategy fields:
  - `executor.maxConcurrentLoops`
  - `executor.maxConsecutiveErrors`
  - `reactLoop.maxRounds` is included in node prompts; per-node loop enforcement still belongs in child AgentRuntime/react-loop policy.
- [x] Persist state after every node transition.
- [x] Emit events:
  - `node_started`
  - `node_completed`
  - `node_failed`
  - `frontier_changed`
  - `executor_paused`
  - `executor_completed`
- [x] Keep all external I/O behind existing workflow store and agent runner ports.

Acceptance criteria:

- Two independent graph nodes can run concurrently.
- A node with unfinished dependencies remains blocked.
- A failed node is retried or reset according to the configured error policy.
- `zcode.dev/workflow/get` returns a graph where z-code-2 can show active, ready, and blocked nodes correctly.

Tests:

- Unit test ready-node derivation.
- Unit test dependency blocking.
- Unit test concurrency cap.
- Unit test failed-node retry/error threshold.
- Runtime test with a fake agent runner that records child session activities per node.

## P0.5: GSAP-like Node Executor

Goal: make built-in expert task nodes execute closer to `zcode-cli-bak/src/gsap`: subplan the node, run actor/critic loops, and expose every sub-activity through ZCode app-server.

Status: planned. The generic DAG scheduler should remain the owner of ready/blocked/frontier state. The expert workflow should provide a GSAP-like node executor for task nodes, while phase nodes can keep the direct activity path for compatibility.

Tasks:

- [ ] Extend workflow activity kinds for subplanner, actor, and critic child sessions.
- [ ] Add scheduler callbacks that let a node executor record nested activities and artifacts without owning scheduler state.
- [ ] Implement expert task node execution:
  - subplanner JSON parser with legacy GSAP aliases.
  - actor JSON parser with tolerant fallback for Markdown summaries.
  - critic JSON parser with pass/fail verdict and blockers.
  - retry actor rounds with critic feedback up to `reactLoop.maxRounds`.
- [ ] Keep ZCode app-server aligned:
  - include nested activities in `snapshot.activities` and `snapshot.sessionLinks`.
  - emit `workflow_session_linked` with `nodeId`, `activityId`, `activityKind`, `loopId`, `sessionId`, and `model`.
  - keep `zcode.dev/workflow/get.scheduler.activeActivities` derivable from the snapshot.
- [ ] Leave worktree isolation and merge locking as the next slice after the activity/ZCode app-server contract is stable.

Acceptance criteria:

- A seeded expert exec node creates subplanner, actor, and critic activities in addition to the parent node activity.
- ZCode app-server workflow get can show child session links for each nested attempt.
- A critic failure causes another actor round with the prior feedback.
- A blocked or exhausted loop fails the node through the existing workflow pause/retry policy.

Tests:

- Scheduler test for nested activity recording and session link derivation.
- Runtime test for subplanner -> actor -> critic pass on a seeded node.
- Runtime test for critic fail then pass on the second actor round.
- ZCode app-server test that `workflow/get` returns nested session links and activity kinds.

## P1: Exploration Planner

Goal: support GSAP-style graph expansion while `exec` is running.

Status: generic collection/frontier state, graph expansion validation, planner activity recording, and scheduler planner hooks are in place at the workflow layer. The runtime now also accepts a generic `WorkflowGraphSeed` from planning artifacts and uses it to seed `exec` task nodes and collections after expert `arch_decompose`. The parser accepts the legacy GSAP architecture graph shape (`name`, `references`, `source`/`target`, `node_names`/`nodeNames`) from `~/workspace/zcode-cli-bak`, then persists the result through normal workflow graph records. `meta_prompt` can now return a generic `WorkflowNodePromptUpdateSet`, which updates existing target-phase nodes before scheduler dispatch.

Tasks:

- [x] Extend workflow graph model with optional collections:
  - `collectionId`
  - `nodeIds`
  - `explorable`
  - `frontierTarget`
  - `plannerRuns`
  - `exhausted`
- [x] Add an exploration planner activity type.
- [x] When a collection frontier falls below target, run an injected planner port.
- [x] Let the planner append nodes and edges to the graph through generic validation.
- [x] Record planner watermarks so completed nodes are not repeatedly re-analyzed.
- [x] Emit events:
  - `planner_started`
  - `planner_completed`
  - `planner_failed`
  - `graph_expanded`
  - `collection_exhausted`
- [x] Add the planner artifact parser that turns `arch_decompose` output into exec task nodes, edges, and collections.
- [x] Add deeper `meta_prompt` integration for node-level prompts when a future prompt artifact provides richer per-node instructions.

Acceptance criteria:

- A graph can grow during `exec`.
- The scheduler sees newly added ready nodes without restarting the workflow.
- Planner run count and exhausted state survive resume.
- z-code-2 can show collection/frontier status if returned by ZCode app-server.

Tests:

- [x] Planner triggers when frontier is below target.
- [x] Planner does not trigger before seeded frontier has had a chance to run.
- [x] Planner stops after `maxPlannerRuns`.
- [x] Planner failure increments collection error count and does not corrupt graph state.
- [x] Add runtime coverage for architecture graph seeding into scheduled exec nodes.
- Add runtime coverage for richer `meta_prompt` prompt enrichment once wired.

## P2: Final Critic Reopen Loop

Goal: make `final_critic` able to reopen graph nodes and send them back through the executor.

Status: implemented as a generic workflow critic result schema plus reusable reopen-node snapshot operation. Expert `final_critic` now parses critic JSON, emits critic lifecycle events, reopens eligible completed/failed/skipped nodes with a cap, and re-enters the generic scheduler for reopened work. Empty fail-without-reopen exits safely.

Tasks:

- [x] Define critic output schema for:
  - pass/fail verdict
  - reopened node ids
  - reason per reopened node
  - optional new acceptance gaps
- [x] Add `reopen_node` graph operation.
- [x] When critic fails with reopen proposals, set those nodes back to `pending`.
- [x] Re-enter executor loop for reopened nodes.
- [x] Cap reopen attempts per node.
- [x] Emit events:
  - `critic_started`
  - `critic_passed`
  - `critic_failed`
  - `node_reopened`
  - `critic_iteration_limit_reached`

Acceptance criteria:

- A critic can reopen one completed node.
- Reopened nodes rerun with dependency rules intact.
- Critic stops when it passes or reaches `finalCritic.maxIterations`.
- Empty fail-without-reopen does not loop forever.

Tests:

- [x] Critic pass completes workflow.
- [x] Critic fail with one reopen reruns that node.
- [x] Critic fail with no reopen exits safely.
- [x] Reopen attempt cap is enforced.

## P3: Resume, Cancel, and Recovery Semantics

Goal: make long-running workflows safe to stop, resume, and inspect after process failure.

Tasks:

- [x] Reset `active` nodes to `pending` on resume unless their child session is known to still be running.
- Persist enough activity state to reconnect child sessions.
- [x] Make cancellation cooperative:
  - run-level cancel
  - node-level stop
  - planner-level stop
- [x] Add graph/state reconciliation before resume.
- Detect corrupt or incompatible workflow artifacts and surface structured errors.
- Add a workflow lock so two processes cannot mutate one run at the same time.

Current note: resume/cancel repair is implemented at the generic workflow snapshot boundary. The current runtime does not yet reconnect to still-running child sessions, so resumed active work is conservatively retried. Node-level/planner-level stop is represented by graph/activity cancellation state, while planner activities themselves remain future P1/P3 work.

Acceptance criteria:

- Killing the process during `exec` allows safe resume.
- Cancelling a run stops new dispatch and marks active work cancelled or pending with a reason.
- Corrupt graph/state produces a user-actionable error, not silent data loss.

Tests:

- Resume after active node reset.
- Cancel active run.
- Refuse or repair malformed state according to documented policy.
- Concurrent mutation lock.

## P4: ZCode app-server State Surface

Goal: expose enough state for z-code-2 to act as a useful workflow debugger.

Tasks:

- Extend ZCode app-server workflow detail response with:
  - graph nodes and edges
  - active node ids
  - ready node ids
  - blocked node ids with blocking dependency ids
  - collection/frontier state
  - [x] active child session ids
  - recent scheduler events
- Add fine-grained workflow events to `zcode.dev/workflow/event`.
- Keep events small. Large artifacts should return paths/references, not full content.
- Document method payloads and error shapes in `expert-workflow.md`.

Acceptance criteria:

- z-code-2 can update the Workflows panel without polling every field from disk.
- A user can see what will run next and why blocked nodes are blocked.
- A user can jump from a workflow node/activity to the child session when z-code-2 supports that link.

Tests:

- [x] ZCode Protocol workflow start returns initial graph.
- [x] ZCode Protocol workflow get returns derived scheduler state.
- [x] ZCode Protocol workflow notification fires for node start/complete/fail and frontier changes.
- [x] Malformed workflow request returns structured invalid request errors.
- App follow-up: the current z-code app no longer has the ZCode Protocol handler. `packages/shared/src/zcode-task-types.ts` already models `ZCodeWorkflowEventRecord.nodeId` and `payload`, but `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` still leaves workflow methods as empty/unsupported. Reconnect workflow transport through `IZCodeTaskService` before productizing the debugger.
  - Required app change: route workflow list/get/start/cancel/retry to the ZCode agent server and publish `workspace_workflow_event` through dynamic workspace events.
  - Keep `ZCodeWorkflowKind` as a non-empty string so custom definition-backed workflows are observable.

## P5: z-code-2 Debugger Polish

Goal: make the current debug UI good enough for real workflow debugging.

Tasks in `/Users/dev/workspace/z-code-2`:

- Add graph filters: all, active, ready, blocked, failed.
- Link activity/session rows to the corresponding task/session view.
- Show node-level event timeline.
- Show artifact links per phase/node.
- Show collection/frontier state once ZCode Protocol exposes it.
- Add explicit refresh/error states per selected run.
- Add a compact layout for narrow side panes.

Acceptance criteria:

- During a real run, the user can answer:
  - what is running now?
  - what is next?
  - what is blocked and by what?
  - which child session produced this artifact?
  - why did a node retry or reopen?

Tests:

- Pure tests for graph derived state.
- UI rendering tests for active/ready/blocked rows.
- Service tests for workflow ZCode app-server method calls.
- Protocol test for workflow notification to workspace event mapping.

## P6: Configurable Workflow Definitions

Goal: make workflows configurable without hardcoding every step.

Status: built-in expert runs from a runtime-validated definition object. This slice also defines durable definition provenance, adapter-level JSON loading from `~/.zcode/cli/workflows/definitions`, and a generic bootstrap/ZCode app-server control path. `/expert` remains pinned to the built-in definition, while `zcode.dev/workflow/*` may select a definition-backed workflow with `kind` and `definitionId`.

Tasks:

- [x] Add runtime-validated `WorkflowDefinition` and `WorkflowPhaseDefinition` contracts.
- [x] Move built-in expert phase order, behavior, artifact paths, graph seed source, and default strategy into a reusable definition object.
- [x] Add workflow definition loading from `~/.zcode/cli/workflows/definitions`.
- Keep built-in `expert` as the default definition.
- Define schema for:
  - [x] phases
  - [x] graph seed
  - [x] strategy defaults
  - [x] agent prompt updates from phase artifacts
  - agent prompt templates
  - allowed activity kinds
- [x] Validate definitions with runtime schema.
- Add `/expert --definition <name>` or a future generic `/workflow <name>` slash command only after the schema is stable.

Acceptance criteria:

- [x] Built-in `expert` works without user config.
- [x] Invalid custom definitions fail before creating a run.
- [x] Definition name/version is recorded in the run snapshot.
- [x] ZCode app-server can start/list/get/cancel definition-backed workflow kinds without treating them as expert-only requests.

Tests:

- [x] Load built-in definition.
- [x] Load valid user definition.
- [x] Reject invalid definition with structured error.
- [x] Snapshot records definition id and version.

## Suggested Implementation Order

1. P0 real DAG executor.
2. P4 ZCode app-server scheduler state for active/ready/blocked.
3. P5 z-code-2 links and filters.
4. P2 final critic reopen loop.
5. P1 exploration planner.
6. P3 harden resume/cancel/recovery.
7. P6 configurable definitions.

The first useful milestone is P0 + part of P4: after that, z-code-2 can show a real moving frontier instead of only a static phase graph.

## Reference Files

Current implementation:

- `docs/design/v2/expert-workflow.md`
- `packages/core/src/workflow/expert.ts`
- `packages/core/src/workflow/lifecycle.ts`
- `packages/contracts/src/workflow/index.ts`
- `packages/adapters/src/workflow/index.ts`
- `packages/bootstrap/src/zcode-protocol-entrypoint.ts`

GSAP reference:

- `/Users/dev/workspace/zcode-cli-bak/src/gsap/pipeline/orchestrator.ts`
- `/Users/dev/workspace/zcode-cli-bak/src/gsap/pipeline/executor.ts`
- `/Users/dev/workspace/zcode-cli-bak/src/gsap/graph/engine.ts`
- `/Users/dev/workspace/zcode-cli-bak/src/gsap/graph/ops.ts`

z-code-2 debugger:

- `/Users/dev/workspace/z-code-2/docs/workflow-debugger.md`
- `/Users/dev/workspace/z-code-2/packages/ui/src/WorkflowDebugPane.tsx`
- `/Users/dev/workspace/z-code-2/packages/ui/src/WorkflowGraphView.tsx`
- `/Users/dev/workspace/z-code/packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`
