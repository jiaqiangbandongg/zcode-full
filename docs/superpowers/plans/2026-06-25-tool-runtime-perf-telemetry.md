# Tool Runtime Perf Telemetry Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前结构化工具 perf 合同以
> `apps/zcode-cli/packages/contracts/src/tools/performance.ts` 和 core tool executor/handlers 为准，
> UI 事件定义以 `packages/ui/src/lib/uiPerfArmsTelemetry.ts` 为准；下文旧 task-stream 接入点仅供追溯。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bash, Write, and Edit runtime performance attribution fields and mirror them to UI RUM without changing model-visible tool results.

**Architecture:** Define a shared contracts-level `ToolPerformanceTelemetrySchema`, attach optional `perf` to Bash/Write/Edit structured outputs, merge executor-level permission wait into `tool_call_result.payload.result.perf`, and report one UI ARMS event per terminal tool update.

**Tech Stack:** TypeScript, Zod contracts, Vitest, existing ZCode session events, existing ARMS custom event wrapper.

---

### Task 1: Document Runtime Tool Perf Scope

**Files:**
- Modify: `docs/superpowers/specs/2026-06-16-ui-perf-arms-telemetry-design.md`
- Modify: `apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md`
- Create: `docs/superpowers/plans/2026-06-25-tool-runtime-perf-telemetry.md`

- [x] **Step 1: Update specs before code**

Document `perf` as structured metadata only, with low-cardinality and privacy constraints.

### Task 2: Write Failing Tests

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/write-tool-contract.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts`
- Modify: `packages/ui/test/uiPerfArmsTelemetry.test.ts`

- [x] **Step 1: Test handler output perf**

Expected fields:
- Bash: `commandRunMs`, `outputBytes`, `exitCode`, `timedOut`, `commandCategory`, `commandHash`.
- Write: `fsReadMs`, `fsWriteMs`, `fileCount`, `totalBytes`, `maxFileBytes`, `workspaceKind`.
- Edit: `fsReadMs`, `fsWriteMs`, `patchMatchMs`, `hunkCount`, `matchAttempts`, `totalBytes`.

- [x] **Step 2: Test executor result perf merge**

Expected `ToolCallResult.payload.result.perf.permissionWaitMs` is present when permission ask waits before execution.

- [x] **Step 3: Test UI ARMS event**

Expected `reportUiToolCallDetail` emits `perf_ui_tool_call_detail` with sanitized fields.

### Task 3: Implement Runtime Perf

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/tools/bash.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/write.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/tools/edit.ts`
- Create: `apps/zcode-cli/packages/contracts/src/tools/performance.ts`
- Create: `apps/zcode-cli/packages/core/src/tool/handlers/tool-perf.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/write.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/edit.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/events.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/events/session.events.ts`

- [x] **Step 1: Add schema and output fields**

Add optional `perf` to Bash/Write/Edit output schemas.

- [x] **Step 2: Measure handler stages**

Use `Date.now()` around adapter calls and patch matching. Do not add extra I/O.

- [x] **Step 3: Merge permission wait**

Measure only the ask/broker waiting span. Auto-allow remains `0`/undefined.

- [x] **Step 4: Add result perf to session event**

Set `payload.result.perf` from structured output plus permission wait.

### Task 4: Implement UI Reporting

**Files:**
- Modify: `packages/ui/src/lib/uiPerfArmsTelemetry.ts`
- Modify: `packages/ui/src/hooks/taskStreamEventHandlers.ts`
- Modify: `packages/ui/test/uiPerfArmsTelemetry.test.ts`

- [x] **Step 1: Add `perf_ui_tool_call_detail` reporter**

Emit only sanitized fields, once on terminal tool update.

- [x] **Step 2: Wire tool update event**

Read `event.raw.result.perf` for `completed/failed/denied` statuses and report.

### Task 5: Verification and Commit

- [x] **Step 1: Run targeted tests**

```bash
pnpm vitest run apps/zcode-cli/packages/core/tests/bash-handler.test.ts apps/zcode-cli/packages/core/tests/write-tool-contract.test.ts apps/zcode-cli/packages/core/tests/edit-tool-contract.test.ts apps/zcode-cli/packages/core/tests/tool-executor-trace.test.ts packages/ui/test/uiPerfArmsTelemetry.test.ts
```

- [x] **Step 2: Run required checks**

```bash
pnpm typecheck
pnpm lint
```

- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-ui-perf-arms-telemetry-design.md apps/zcode-cli/docs/design/v2/tool/00-tool-change-chain.md docs/superpowers/plans/2026-06-25-tool-runtime-perf-telemetry.md apps/zcode-cli/packages/contracts/src/tools apps/zcode-cli/packages/contracts/src/events/session.events.ts apps/zcode-cli/packages/core/src/tool packages/ui/src/lib/uiPerfArmsTelemetry.ts packages/ui/src/hooks/taskStreamEventHandlers.ts packages/ui/test/uiPerfArmsTelemetry.test.ts
git commit -m "feat: add tool runtime perf telemetry"
```
