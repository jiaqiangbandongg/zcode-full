# Web Replayable Task Model Readonly Restore Implementation Plan

> 状态（2026-07-15）：已实施的 legacy replayable 兼容记录。`resumeModelPolicy` 仍由 task compatibility
> adapter 保留，但当前 conversation 的恢复权威是 V4 projection/snapshot；下文 `useTaskRestore`、
> `useTaskStreamEvents` 等旧 UI 接入路径已经删除，不能作为新功能入口。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mobile `web-remote-replayable` open historical tasks whose exact model is unavailable without breaking desktop `desktop-continuous`.

**Architecture:** Add an explicit snapshot resume model policy that only the mobile replayable restore path uses. The UI requests a snapshot without task-index model backfill when the historical model is known unavailable, while the provider snapshot has not hydrated yet, or when the current task meta has not reached UI state yet, then skips the follow-up `resumeTask` for that read-only open.

**Tech Stack:** TypeScript, React hooks, Vitest, ZCode task service adapter.

---

### Task 1: Add Red Tests

**Files:**
- Modify: `packages/ui/test/useTaskRestoreRuntimeSnapshot.test.ts`
- Modify: `packages/ui/test/useTaskStreamEventsSnapshotReader.test.ts`
- Modify: `packages/ui/test/taskStreamEventSnapshotSync.test.ts`
- Modify: `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

- [x] Add a UI test asserting `buildReplayableTaskRestoreSnapshotParams` can emit `resumeModelPolicy: "ui-resolved-only"`.
- [x] Add a UI test asserting mobile replayable restore uses read-only mode while provider snapshot is not hydrated even without a local historical model hint, and desktop restore does not.
- [x] Add a UI test asserting mobile replayable restore uses read-only mode when task meta has not reached UI state yet, and desktop restore does not.
- [x] Add a UI test asserting the web replayable stream snapshot reader requests `resumeModelPolicy: "ui-resolved-only"`.
- [x] Add a UI test asserting generic web replayable snapshot sync requests `resumeModelPolicy: "ui-resolved-only"`.
- [x] Add a service adapter test asserting replayable snapshot with `resumeModelPolicy: "ui-resolved-only"` calls `agent.resumeSession` without a model even when task index meta has a model.
- [x] Add a service adapter test asserting default replayable snapshot still passes the task index model to `agent.resumeSession`.
- [x] Run the focused tests and verify they fail before implementation.

### Task 2: Implement Mobile-Only Policy

**Files:**
- Modify: `packages/services/src/session/zcodeTaskService.ts`
- Modify: `packages/ui/src/hooks/useZCodeTaskService.ts`
- Modify: `packages/ui/src/hooks/useTaskRestore.ts`
- Modify: `packages/ui/src/hooks/useTaskStreamEvents.ts`
- Modify: `packages/ui/src/hooks/taskStreamEventSnapshotSync.ts`
- Modify: `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`

- [x] Add `resumeModelPolicy?: "task-index" | "ui-resolved-only"` to snapshot params.
- [x] Include the policy in the UI snapshot dedupe/cache key.
- [x] In `zcodeTaskServiceAdapter.getTaskSnapshot`, skip task-index resume hints only when `clientMode` is `web-remote-replayable` and policy is `ui-resolved-only`.
- [x] In `useTaskRestore`, set the policy only when the mobile replayable path detects an unavailable historical model with no resolved fallback model, when the provider snapshot has not hydrated yet, or when task meta has not reached UI state yet.
- [x] In that same branch, skip `resumeTask` and use `snapshot.meta` as read-only restored meta.
- [x] In post-open web replayable snapshot sync, pass `resumeModelPolicy: "ui-resolved-only"` so event/gap/terminal snapshot alignment cannot reintroduce the unavailable task-index model after model switching.

### Task 3: Verify

**Files:**
- Test: `packages/ui/test/useTaskRestoreRuntimeSnapshot.test.ts`
- Test: `packages/services/test/zcodeLegacyTaskCompatTaskIndex.test.ts`

- [x] Run focused tests until green.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Commit with a Conventional Commits message.
