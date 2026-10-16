# Workflow Session Linking

Workflow is the durable task state machine. Session is one execution attempt inside that workflow.
The runtime must preserve the relationship explicitly so clients can inspect, resume, and debug long
tasks without guessing from logs.

## Goals

- Every workflow phase, graph node, and planner attempt can point to the child session that executed it.
- One workflow node may have multiple attempts, and each attempt may have a distinct child session.
- Session history can link back to the owning workflow run, phase, node, and activity.
- Old snapshots that only contain `activities[]` remain readable.

## Contract

`WorkflowRunSnapshot.sessionLinks[]` is the canonical workflow-to-session index. When it is missing
or empty, clients may derive equivalent links from `activities[]`.

```ts
interface WorkflowSessionLink {
  activityId: string;
  attempt: number;
  kind:
    | "agent_session"
    | "planner_agent"
    | "subplanner_agent"
    | "actor_agent"
    | "critic_agent";
  model?: string;
  nodeId?: string;
  parentSessionId?: string;
  phase: string;
  runId: string;
  sessionId?: string;
  startedAt: string;
  completedAt?: string;
  status:
    | "starting"
    | "running"
    | "retrying_model"
    | "waiting_permission"
    | "completed"
    | "failed"
    | "cancelled";
  traceId?: string;
  turnId?: string;
}
```

`activityId` is stable for a single execution attempt. `attempt` is scoped by `(phase, nodeId,
kind)`, so retrying the same node creates a new activity and increments the visible attempt count.

## Runtime Rules

- Create a link as soon as the workflow activity starts, even before the child session id is known.
- Update the same link when the child session starts and when the activity completes or fails.
- Preserve failed links instead of overwriting them. A retry must create a new activity and link.
- Include `model` when the child runtime is created so model changes during a workflow are auditable.
- Session metadata should eventually carry the reverse reference:

```ts
interface SessionWorkflowReference {
  activityId: string;
  nodeId?: string;
  phase: string;
  runId: string;
}
```

## UI Expectations

- Workflow graph nodes show the active or latest linked child session.
- Node detail shows all attempts with session id, model, status, trace id, and turn id.
- A session transcript can navigate back to its workflow run and node.

## Tests

- Snapshot schema accepts `sessionLinks[]`.
- Missing `sessionLinks[]` can be derived from `activities[]`.
- A failed retry creates a new link without removing the failed link.
- A model switch before a new attempt is reflected in that attempt link.
