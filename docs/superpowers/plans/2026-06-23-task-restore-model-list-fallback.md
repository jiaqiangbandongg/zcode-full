# Task Restore Model List Fallback Implementation Plan

> 状态（2026-07-15）：旧 UI 方案已实施后随 V4 迁移被替换，本文保留为历史实施记录。
> 当前不可用模型自动定位由 `packages/ui/src/v4/composer/modelAutoPosition.ts` 负责，并复用
> `packages/ui/src/chat-input-toolbar/modelSelection.ts` 的存活纯函数；下文旧 hook/toolbar 路径不再是当前链路。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore unavailable historical task models by auto-selecting the first model from the visible model list.

**Architecture:** Keep task-local model resolution in `zcodeTaskResumeModel.ts`; keep visible model fallback in toolbar model-selection helpers. Remove provider snapshot first-model fallback from restore so the only automatic switch uses the same model list users can select from.

**Tech Stack:** React, Zustand, TypeScript, Vitest, pnpm.

## Global Constraints

- Do not change manual model switching behavior.
- Keep fallback scoped to confirmed unavailable historical task models and unavailable toolbar custom selections.
- Preserve desktop continuous and web remote replayable restore boundaries.
- Add or update tests before production code changes.

---

### Task 1: Lock Visible Model List Fallback Behavior

**Files:**
- Modify: `packages/ui/test/chatInputToolbarModelGroups.test.ts`
- Modify: `packages/ui/src/chat-input-toolbar/modelSelection.ts`
- Modify: `packages/ui/src/ChatInputToolbar.tsx`

**Interfaces:**
- Consumes: `resolveUnavailableModelListFallback(params)`
- Produces: active task fallback may return `modelSelectGroups[0].items[0].value`

- [x] **Step 1: Write the failing test**

Add tests asserting that active task current unavailable model falls back to the first visible model list item.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts`
Expected: FAIL because current code returns `null` when `taskId` is present.

- [x] **Step 3: Write minimal implementation**

Replace the custom-only fallback helper with visible model list fallback and stop passing `taskId` from `ChatInputToolbar`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts`
Expected: PASS.

### Task 2: Stop Provider Snapshot First-Model Restore Fallback

**Files:**
- Modify: `packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`
- Modify: `packages/ui/src/lib/zcodeTaskResumeModel.ts`
- Modify: `packages/ui/src/hooks/useTaskRestore.ts`

**Interfaces:**
- Consumes: `resolveAvailableResumeModelForExistingTask(params)`
- Produces: unavailable task model resolution without provider snapshot fallback

- [x] **Step 1: Write the failing test**

Update the restore test so an available provider snapshot still returns the original unavailable model with `fallbackApplied: false`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`
Expected: FAIL because current code returns provider snapshot fallback.

- [x] **Step 3: Write minimal implementation**

Remove the provider snapshot fallback helper and keep only availability detection plus `unavailableModel`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts`
Expected: PASS.

### Task 3: Final Verification

**Files:**
- Verify all files changed by Tasks 1-2.

- [x] **Step 1: Run targeted tests**

Run: `pnpm vitest run packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts packages/ui/test/chatInputToolbarModelGroups.test.ts packages/ui/test/useTaskRestoreRuntimeSnapshot.test.ts`
Expected: PASS.

- [x] **Step 2: Run required checks**

Run: `pnpm typecheck`
Expected: exit 0.

Run: `pnpm lint`
Expected: exit 0; existing warnings may remain.

- [ ] **Step 3: Commit**

Run:
```bash
git add docs/superpowers/specs/2026-06-23-task-restore-model-list-fallback-design.md docs/superpowers/plans/2026-06-23-task-restore-model-list-fallback.md packages/ui/src/ChatInputToolbar.tsx packages/ui/src/chat-input-toolbar/modelSelection.ts packages/ui/src/hooks/useTaskRestore.ts packages/ui/src/lib/zcodeTaskResumeModel.ts packages/ui/test/chatInputToolbarModelGroups.test.ts packages/ui/test/useZCodeChatSendPromptQueuePolicy.test.ts
git commit -m "fix: use visible model list for task restore fallback"
```
