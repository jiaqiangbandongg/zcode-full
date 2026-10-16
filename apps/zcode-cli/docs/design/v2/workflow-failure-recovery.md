# Workflow Failure Recovery

Long-running workflows should not collapse to a terminal failure just because a child session hit a
transient provider, network, or local execution problem. The workflow runtime should pause with
actionable recovery metadata and let the user decide how to continue.

## Goals

- Provider retries remain automatic inside the model adapter.
- When a child session still fails, workflow state becomes inspectable and recoverable.
- Retrying creates a new activity/session attempt and preserves the failed attempt for audit.
- Clients can present recovery actions without scraping error text.

## Failure Layers

1. Model adapter retry: retryable provider/network failures emit model retry status events and are
   retried before the workflow sees a failure.
2. Child session failure: if the child runtime throws, the owning activity records the structured
   failure and closes.
3. Workflow pause: the workflow run moves to `paused` with `failure`, `pauseReason`, and
   `recoveryActions`.

## Contract

`WorkflowRunStatus` includes `paused`. A paused workflow is non-terminal and may be resumed or
retried.

```ts
interface WorkflowFailure {
  code?: string;
  kind:
    | "network"
    | "rate_limit"
    | "timeout"
    | "auth"
    | "provider"
    | "model_context"
    | "configuration"
    | "permission"
    | "tool"
    | "cancelled"
    | "unknown";
  message: string;
  retryable: boolean;
  recoverable: boolean;
  activityId?: string;
  nodeId?: string;
  phase?: string;
  sessionId?: string;
  traceId?: string;
  turnId?: string;
}

interface WorkflowRecoveryAction {
  action: "retry" | "retry_with_current_model" | "skip_node" | "cancel";
  activityId?: string;
  destructive?: boolean;
  label: string;
  nodeId?: string;
  phase?: string;
}
```

## Runtime Rules

- Cancellation remains terminal `cancelled`.
- Completed workflows remain terminal `completed`.
- Non-cancel child failures pause the workflow instead of marking the run terminal `failed`.
- The failed phase or node keeps its local failure state and error message.
- `retry` resets the selected failed graph node, or the failed nodes in the current phase, to
  `pending`, clears run-level pause metadata, and re-enters the workflow executor.
- `retry_with_current_model` has the same runtime operation as `retry`; the distinction is for UI
  copy after the user changes model.
- `skip_node` is not required for the first implementation unless the workflow definition marks a
  node as optional.
- `failed` should be reserved for unrecoverable workflow-level corruption or explicit user choice.

## ZCode App-Server Surface

ZCode protocol clients use extension methods:

- `zcode.dev/workflow/get`: returns `snapshot.failure`, `snapshot.recoveryActions`, and
  `snapshot.sessionLinks`.
- `zcode.dev/workflow/retry`: retries a paused workflow, optionally scoped by `nodeId`,
  `activityId`, or `phase`.
- `zcode.dev/workflow/cancel`: remains the terminal stop operation.

## Tests

- A non-cancel child session error pauses the workflow and includes a retry action.
- A paused graph node retry creates a new activity and preserves the failed session link.
- Retrying after a model switch uses the current session model for the new attempt.
- ZCode app-server `workflow/retry` forwards kind, definition id, run id, and node selector.
