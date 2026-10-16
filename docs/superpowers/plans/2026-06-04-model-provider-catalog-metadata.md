# Model Provider Catalog Metadata Implementation Plan

> 状态（2026-07-15）：已实施，本文保留为历史实施计划。当前事实以
> `packages/shared/src/model-provider-types.ts`、`packages/services/src/model-provider/` 和
> `packages/ui/src/settings/model-provider-section/` 为准；下文复选框不代表当前完成度。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the model provider catalog metadata design from `docs/superpowers/specs/2026-06-03-model-provider-catalog-metadata-design.md`.

**Architecture:** Add shared catalog/provider v2 schemas and migration helpers first, then make the host service read/write v2 provider data, catalog sources, and display order. UI consumes object models and independent display order, while ZCode Agent registry projection remains the only runtime metadata path.

**Tech Stack:** TypeScript, Zod, Vitest, React, @dnd-kit, Electron desktop dev server.

---

### Task 1: Shared Schema And Projection

**Files:**
- Modify: `packages/shared/src/model-provider-types.ts`
- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Test: `packages/shared/test/zcodeProtocol.test.ts`

- [ ] **Step 1: Write failing schema and projection tests**

Add tests for parsing a `zcode.model-providers.v1` catalog file, parsing a v2 provider store file, migrating a legacy bare provider array to v2, and projecting context window, image modality, max output tokens, kind-aware model id, and reasoning provider options.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run packages/shared/test/zcodeProtocol.test.ts`
Expected: FAIL because catalog/provider v2 schemas and new projection helpers do not exist yet.

- [ ] **Step 3: Implement shared types, schemas, migration helpers, and projection**

Add `ModelProviderKind`, `ModelProviderCatalogFile`, `ModelProviderModelConfig`, `ModelProviderStoreFile`, display order state types, model helper functions, legacy migration, endpoint/kind resolution, reasoning patch application, and v2-aware `convertModelProviderConfigToZCodeProviderInput`.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run packages/shared/test/zcodeProtocol.test.ts`
Expected: PASS.

### Task 2: Service Storage, Catalog Sources, And Display Order

**Files:**
- Modify: `packages/services/src/model-provider/modelProvider.ts`
- Modify: `packages/services/src/model-provider/modelProviderService.ts`
- Modify: `packages/services/src/model-provider/modelProviderServiceStorage.ts`
- Create: `packages/services/src/model-provider/modelProviderCatalogSources.ts`
- Test: `packages/services/test/modelProviderService.test.ts`

- [ ] **Step 1: Write failing service tests**

Add tests for local China catalog loading, models.dev conversion to unified catalog model, legacy provider file backup/writeback to v2, API key/mapping/display names/format migration, and display order save without provider registry changed event.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run packages/services/test/modelProviderService.test.ts`
Expected: FAIL because service APIs and storage migration are missing.

- [ ] **Step 3: Implement storage and source APIs**

Make `readProviders` accept v2 store files and legacy bare arrays, write v2 store files, preserve a v1 backup on migration, expose `getCatalogProviders`, `getDisplayOrder`, and `saveDisplayOrder`, and ensure display-order writes do not invalidate provider registry snapshots.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run packages/services/test/modelProviderService.test.ts`
Expected: PASS.

### Task 3: UI Model Editing And Provider Ordering

**Files:**
- Modify: `packages/ui/src/lib/modelProviderOrdering.ts`
- Modify: `packages/ui/src/hooks/useModelProviders.ts`
- Modify: `packages/ui/src/settings/model-provider-section/AddProviderCard.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/Navigation.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts`
- Modify: `packages/ui/src/settings/ModelProviderSection.tsx`
- Modify: `packages/ui/src/chat-input-toolbar/modelSelection.ts`
- Modify: `packages/ui/src/ChatInputToolbar.tsx`
- Test: `packages/ui/test/modelProviderCodingPlan.test.ts`
- Test: `packages/ui/test/chatInputToolbarModelGroups.test.ts`

- [ ] **Step 1: Write failing UI pure tests**

Add tests for display order sorting, settings navigation order persistence input, chat group order by display order, catalog import writing object models, and model object labels/kinds/modalities used by filtering and display.

- [ ] **Step 2: Run focused UI tests and verify failure**

Run: `pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts packages/ui/test/modelProviderCodingPlan.test.ts`
Expected: FAIL because UI still uses string model lists and no display order.

- [ ] **Step 3: Implement UI changes**

Add display order hook state to model provider hooks, use `@dnd-kit` sortable handles for provider nav items, save order optimistically with rollback logging, switch model rows to object metadata editing, add catalog source selection, and pass display order into chat model grouping.

- [ ] **Step 4: Run focused UI tests and verify pass**

Run: `pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts packages/ui/test/modelProviderCodingPlan.test.ts`
Expected: PASS.

### Task 4: Documentation And Required Verification

**Files:**
- Create or update: `docs/model-provider-catalog-metadata.md`

- [ ] **Step 1: Document implementation boundary**

Record local China catalog source, future CDN migration point, v2 store migration behavior, display order file, and manual desktop verification scope.

- [ ] **Step 2: Run code verification**

Run:
- `pnpm vitest run packages/shared/test/zcodeProtocol.test.ts packages/services/test/modelProviderService.test.ts packages/ui/test/chatInputToolbarModelGroups.test.ts packages/ui/test/modelProviderCodingPlan.test.ts`
- `pnpm typecheck`
- `pnpm lint`

Expected: all commands exit 0.

### Task 5: Desktop Manual Verification

**Files:**
- Runtime only; no source edits unless bugs are found.

- [ ] **Step 1: Start desktop app**

Run: `pnpm dev:desktop`.
Use `computer-use` to interact with the desktop UI.

- [ ] **Step 2: Settings page provider CRUD**

Verify:
- China catalog provider import.
- models.dev provider import still works.
- custom provider create/edit/delete.
- provider name/API key/base URL/default kind save.
- model id/display name/kinds/default kind/modalities/context/output/reasoning level toggles save.
- provider drag reorder persists after restart.
- display order affects settings nav and chat model group order.

- [ ] **Step 3: Chat runtime verification**

Verify:
- Chat model selector reads latest provider metadata.
- Switching provider/model updates the next sent message.
- Switching thought/reasoning level updates the next sent message.
- Logs show selected provider, model, and reasoning/provider options are effective for each sent message.

- [ ] **Step 4: Loop on failures**

For any failure, use systematic debugging: collect logs/CDP evidence, identify root cause, add or update an automated regression test where practical, fix, restart, and repeat manual verification.

### Task 6: Commit

**Files:**
- All changed implementation, tests, docs, catalog files.

- [ ] **Step 1: Inspect diff and status**

Run: `git status --short` and `git diff --stat`.

- [ ] **Step 2: Commit with Conventional Commit**

Run: `git add ... && git commit -m "feat: add provider catalog metadata"`.
Expected: commit succeeds.
