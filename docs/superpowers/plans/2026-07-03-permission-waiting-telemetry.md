# Permission Waiting Telemetry Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前字段契约以
> `packages/ui/src/lib/messageTelemetry.ts`、`docs/monitoring/business-monitoring.md` 和
> `docs/monitoring/performance-telemetry-catalog.md` 为准；下文旧 task-stream hook 路径仅供追溯。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore permission waiting aggregation for `message_completion` and expose the same per-tool waiting time on existing `agent_step` events without adding a new step type.

**Architecture:** Keep permission interval state inside `messageTelemetry.ts`, keyed by `requestId` and associated with `toolCallId`. Settle each interval exactly once on permission response, tool termination, or task termination, updating both the prompt aggregate and the matching active tool step.

**Tech Stack:** TypeScript, React hooks, Vitest, pnpm.

---

### Task 1: Add failing telemetry state-machine tests

**Files:**
- Modify: `packages/ui/test/messageTelemetry.test.ts`

- [x] Add tests that start a tool step, open/close permission intervals, and assert:

```ts
expect(toolStep.eventExtraDetail).toMatchObject({
  duration_ms: "300",
  waiting_ms: "150",
});
expect(completion.eventExtraDetail).toMatchObject({
  duration_ms: "600",
  waiting_ms: "150",
});
```

- [x] Cover multiple tool calls, repeated request/response, unmatched tools, and terminal settlement.
- [x] Run `pnpm vitest run packages/ui/test/messageTelemetry.test.ts`.
- [x] Confirm RED failures are caused by the missing request-scoped waiting API and missing `agent_step.waiting_ms`.

### Task 2: Implement request-scoped waiting aggregation

**Files:**
- Modify: `packages/ui/src/lib/messageTelemetry.ts`

- [x] Replace the single `permissionRequestedAt` field with a `Map` keyed by `requestId`.
- [x] Add `waitingMs` to `ActiveAgentStep`.
- [x] Make permission request registration idempotent and resolve `toolCallId` from the event payload.
- [x] Settle intervals on response, tool terminal events, and task terminal events.
- [x] Add `waiting_ms` to every finalized `agent_step`; non-tool steps remain `"0"`.
- [x] Keep both existing `duration_ms` formulas unchanged.
- [x] Run the focused test and confirm GREEN.

### Task 3: Wire desktop and remote response paths

**Files:**
- Modify: `packages/ui/src/hooks/taskStreamEventHandlers.ts`
- Modify: `packages/ui/src/hooks/useChatTaskControlActions.ts`
- Modify: `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`
- Test: relevant UI handler/runtime monitor tests when needed

- [x] Register permission requests with their full stream event.
- [x] Settle successful local responses after the service call returns.
- [x] Settle stream `permission_response` events so another client can complete the interval.
- [x] Apply the same idempotent calls in the background runtime monitor.
- [x] Run focused UI tests.

### Task 4: Update telemetry documentation

**Files:**
- Modify: `docs/monitoring/business-monitoring.md`
- Modify: `docs/monitoring/performance-telemetry-catalog.md`

- [x] Document that `duration_ms` is wall-clock time and includes permission waiting.
- [x] Document `agent_step.waiting_ms` and message-level summation.

### Task 5: Verify and commit

- [x] Run `pnpm vitest run packages/ui/test/messageTelemetry.test.ts`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Run `git diff --check`.
- [x] Review the diff against all cases in the design spec.
- [ ] Commit with a Conventional Commit message.
