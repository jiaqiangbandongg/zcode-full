# Hide Runtime Model Unavailable Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide the chat error banner for `ZCODE_RUNTIME_MODEL_UNAVAILABLE` while preserving internal guard state and diagnostics.

**Architecture:** Keep service and restore behavior unchanged. Add a presentation-layer guard in `ChatErrorBanner` so this specific error code renders no banner, while other error codes continue through the existing localized error banner path.

**Tech Stack:** React, TypeScript, Vitest, server-side React rendering tests.

---

### Task 1: Chat Error Banner Visibility

**Files:**
- Modify: `packages/ui/test/chatErrorBanner.test.ts`
- Modify: `packages/ui/src/ChatErrorBanner.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that renders `ChatErrorBanner` with:

```ts
{
  code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
  message: "历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。",
}
```

Assert that the rendered HTML does not contain the historical-model message.

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
pnpm test -- packages/ui/test/chatErrorBanner.test.ts
```

Expected before implementation: the new assertion fails because `ChatErrorBanner` still renders the localized unavailable-model message.

- [ ] **Step 3: Implement the minimal presentation-layer guard**

In `packages/ui/src/ChatErrorBanner.tsx`, return `null` when `error.code === "ZCODE_RUNTIME_MODEL_UNAVAILABLE"`. Leave localization, feedback, copy, and detail behavior unchanged for all other errors.

- [ ] **Step 4: Run targeted tests and verify they pass**

Run:

```bash
pnpm test -- packages/ui/test/chatErrorBanner.test.ts
```

Expected after implementation: the new unavailable-model visibility test passes and existing chat error banner tests still pass.

- [ ] **Step 5: Run required project checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

Stage the spec, plan, tests, and implementation, then commit with Conventional Commits:

```bash
git add docs/superpowers/specs/2026-06-10-hide-runtime-model-unavailable-banner-design.md docs/superpowers/plans/2026-06-10-hide-runtime-model-unavailable-banner.md packages/ui/test/chatErrorBanner.test.ts packages/ui/src/ChatErrorBanner.tsx
git commit -m "fix(ui): hide unavailable historical model banner"
```
