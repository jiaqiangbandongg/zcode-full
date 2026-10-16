# UI Perf Telemetry Attribution Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前事件字段和归因口径以
> `docs/monitoring/performance-telemetry-catalog.md`、`docs/monitoring/business-monitoring.md`
> 与 `packages/ui/src/lib/uiPerfArmsTelemetry.ts` 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen UI-side Agent/RUM telemetry so 3.1.5 performance issues can be attributed to turn completion, stream stalls, and model network status without adding high-frequency runtime overhead.

**Architecture:** Reuse the existing `uiPerfArmsTelemetry.ts` and `planUsageArmsTelemetry.ts` wrappers. Add one low-frequency turn breakdown event emitted once per prompt completion, enrich stream stall with chunk type, and mirror existing model network statuses into `plan_request` with sanitized properties.

**Tech Stack:** TypeScript, Vitest, existing `IPlatformService.reportArmsCustomEvent`, ARMS custom event payloads.

---

### Task 1: Document Scope and Performance Guardrails

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-ui-perf-arms-telemetry-design.md`
- Create: `docs/superpowers/plans/2026-06-25-ui-perf-telemetry-attribution.md`

- [x] **Step 1: Update the existing spec**

Document the attribution gap, low-overhead rules, new event names, and runtime-only future fields.

- [x] **Step 2: Save this implementation plan**

Save this file under `docs/superpowers/plans/`.

### Task 2: Add Failing Tests for UI Perf Payloads

**Files:**
- Modify: `packages/ui/test/uiPerfArmsTelemetry.test.ts`

- [x] **Step 1: Add tests before production code**

Add tests for:

```ts
reportUiTurnBreakdown({
  durationMs: 9000,
  result: "success",
  model: "glm-4",
  talkId: "task-1",
  messageId: "message-1",
  ttftMs: 1200,
  waitingMs: 300,
  toolCallTotal: 2,
  toolCallFailed: 1,
  agentStepCount: 4,
  retryCount: 1,
  fileChangeCount: 3,
  generatedCodeLines: 20,
});
```

Expected payload: `name=perf_ui_turn_breakdown`, `group=ui_perf`, `value=9000`, with numeric properties rounded and string ids preserved.

Add a stream stall test with `chunkType: "thought"` and expect `properties.chunk_type = "thought"`.

- [x] **Step 2: Run the targeted test and verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts
```

Expected: fail because `reportUiTurnBreakdown` and `chunkType` support do not exist yet.

### Task 3: Implement UI Perf Payload Enhancements

**Files:**
- Modify: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`
- Modify: `packages/ui/src/hooks/taskStreamEventHandlers.ts`
- Modify: `packages/ui/src/hooks/useZCodeChat.ts`

- [x] **Step 1: Add `UI_PERF_EVENT_TURN_BREAKDOWN` and `reportUiTurnBreakdown`**

Implementation must:
- Emit one event per prompt completion.
- Reuse the existing async `emit()` helper.
- Round numeric values.
- Keep absent optional values undefined.

- [x] **Step 2: Add `chunkType` to stream stall**

Extend `recordStreamChunkArrival()` options with `chunkType?: "message" | "thought" | "unknown"` and add `chunk_type` to properties.

- [x] **Step 3: Pass chunk type at call sites**

Pass `chunkType: "message"` for `agent_message_chunk` and `chunkType: "thought"` for `agent_thought_chunk`.

- [x] **Step 4: Emit turn breakdown from prompt completion**

Parse existing `completionTelemetry.eventExtraDetail` values in `useZCodeChat.ts` and call `reportUiTurnBreakdown()` once alongside `reportUiMessageComplete()`.

### Task 4: Add Failing Tests for Plan Network Status Mirroring

**Files:**
- Modify: `packages/ui/test/planUsageArmsTelemetry.test.ts` or create if missing.
- Modify: `packages/ui/src/lib/planUsageArmsTelemetry.ts`

- [x] **Step 1: Add tests before production code**

Test that `model_request_completed`, `model_request_failed`, `model_retry_scheduled`, and `model_stream_stalled` are mirrored to `plan_request` with sanitized duration/status/retry fields.

- [x] **Step 2: Run the targeted test and verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/planUsageArmsTelemetry.test.ts
```

Expected: fail because only `model_request_started` is currently mirrored.

### Task 5: Implement Plan Network Status Mirroring

**Files:**
- Modify: `packages/ui/src/lib/planUsageArmsTelemetry.ts`

- [x] **Step 1: Rename the helper internally or extend it in place**

Keep the existing exported `reportPlanUsageModelRequestStartedToArms()` name for call-site compatibility, but allow all `task_network_debug_status` model status types through.

- [x] **Step 2: Include sanitized properties**

Include `duration_ms`, `status_code`, `delay_ms`, `idle_ms`, `timeout_ms`, `retryable`, `reason`, `transport`, `provider_kind`, `next_attempt` when present. Do not include headers or raw messages.

### Task 6: Verification and Commit

**Files:**
- All modified files.

- [x] **Step 1: Run targeted tests**

```bash
pnpm vitest run packages/ui/test/uiPerfArmsTelemetry.test.ts packages/ui/test/planUsageArmsTelemetry.test.ts
```

- [x] **Step 2: Run required checks**

```bash
pnpm typecheck
pnpm lint
```

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-ui-perf-arms-telemetry-design.md docs/superpowers/plans/2026-06-25-ui-perf-telemetry-attribution.md packages/ui/src/lib/uiPerfArmsTelemetry.ts packages/ui/src/lib/planUsageArmsTelemetry.ts packages/ui/src/hooks/taskStreamEventHandlers.ts packages/ui/src/hooks/useZCodeChat.ts packages/ui/test/uiPerfArmsTelemetry.test.ts packages/ui/test/planUsageArmsTelemetry.test.ts
git commit -m "feat: enrich ui perf telemetry attribution"
```
