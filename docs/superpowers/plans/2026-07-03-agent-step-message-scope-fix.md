# Agent Step Message Scope Fix Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史修复计划。当前 telemetry 契约以
> `docs/monitoring/business-monitoring.md`、`docs/monitoring/performance-telemetry-catalog.md`
> 和 `packages/ui/src/lib/messageTelemetry.ts` 为准；下文旧 `useZCodeChat` 调用路径仅供追溯。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `message_completion` step and tool counts describe only its active prompt instead of the full task history.

**Architecture:** Accumulate finalized step metrics in `PromptTelemetryState`, using the same `finalizeAgentStep()` path that emits `agent_step`. Keep `loop_index` in the existing prompt-reset `AgentStepTelemetryState`, and remove `taskMessages` from completion finalization and its callers.

**Tech Stack:** TypeScript, Vitest, WebdriverIO/Electron E2E.

---

### Task 1: Lock the message-scoped contract in unit tests

**Files:**
- Modify: `packages/ui/test/messageTelemetry.test.ts`

- [x] **Step 1:** Add a two-prompt test on one task. Finalize one generation step in each prompt while passing historical assistant messages to the old API, then assert the second completion reports `agent_step_cnt="1"` and its emitted step has `loop_index="1"`.
- [x] **Step 2:** Add a current-prompt tool test that finalizes one successful and one failed tool step, then asserts `tool_call_total="2"`, `tool_call_failed="1"`, and the first tool error fallback.
- [x] **Step 3:** Run `pnpm vitest run packages/ui/test/messageTelemetry.test.ts` and confirm the new message-scope assertion fails against the historical scan.

### Task 2: Accumulate completion metrics in the prompt lifecycle

**Files:**
- Modify: `packages/ui/src/lib/messageTelemetry.ts`

- [x] **Step 1:** Add prompt-level finalized step count, tool count, failed tool count, and first tool error state initialized by `queuePromptTelemetry()`.
- [x] **Step 2:** Update `finalizeAgentStep()` to increment those fields exactly once for every emitted step.
- [x] **Step 3:** Make `finalizePromptTelemetry()` read the prompt counters and remove `countAgentSteps()`, `collectToolCallCompletionMetrics()`, `TaskChatMessage`, and `FinalizePromptTelemetryInput.taskMessages`.
- [x] **Step 4:** Run the focused Vitest file and confirm GREEN.

### Task 3: Simplify completion callers and update the monitoring contract

**Files:**
- Modify: `packages/ui/src/hooks/useZCodeChat.ts`
- Modify: `packages/ui/src/lib/zcodeTaskRuntimeMonitor.ts`
- Modify: `docs/monitoring/business-monitoring.md`
- Modify: `docs/monitoring/performance-telemetry-catalog.md`

- [x] **Step 1:** Remove message-store reads and `taskMessages` arguments used only by completion telemetry.
- [x] **Step 2:** Document prompt-lifecycle step/tool accumulation and the equality between `agent_step_cnt` and same-message emitted steps.
- [x] **Step 3:** Run focused unit tests and desktop E2E typecheck.

### Task 4: Verify the production fix

**Files:**
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-02-agent-step-message-scope-e2e-design.md`

- [x] **Step 1:** Run the formal message-scope E2E with its case-local replay fixture and confirm the former RED assertion passes.
- [x] **Step 2:** Change R01 from `failing` to `covered` and record the GREEN evidence.
- [x] **Step 3:** Run `pnpm typecheck`, `pnpm lint`, focused unit tests, `git diff --check`, and inspect the final diff.
- [x] **Step 4:** Commit with a Conventional Commit message.
