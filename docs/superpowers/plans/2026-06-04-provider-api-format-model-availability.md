# Provider API Format Model Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make provider settings show only supplier-supported API formats while keeping the full model list visible with aligned API format tags.

**Architecture:** Reuse existing shared provider kind/API format helpers instead of adding a new domain model. The settings connection section derives selectable API formats from provider endpoint paths and model `kinds`; the model list stays complete and passes the current format kind into each row for fixed-column tag highlighting and test-button gating.

**Tech Stack:** TypeScript, React, Vitest, existing ZCode UI components and i18n message ids.

---

### Task 1: UI Tests For Format Options And Model Tags

**Files:**
- Modify: `packages/ui/test/modelProviderModelRowEditor.test.ts`

- [x] **Step 1: Add failing render tests**

Add tests for `resolveProviderApiFormatOptions` with `anthropic` and `openai-compatible` paths and assert that Responses is absent, then render `ProviderModelsSection` with one Anthropic-only and one OpenAI-compatible-only model while current format is Anthropic and assert both models render with fixed-column API format tags.

- [x] **Step 2: Run focused test and verify RED**

Run: `pnpm vitest run packages/ui/test/modelProviderModelRowEditor.test.ts`

Expected: FAIL because `ProviderConnectionSection` still maps the hard-coded `API_FORMATS` list and `ProviderModelsSection` has no aligned API format tag state.

### Task 2: Implement Provider Format Filtering And Row Tags

**Files:**
- Create: `packages/ui/src/settings/model-provider-section/ProviderModelApiFormatTags.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`

- [x] **Step 1: Filter API format options**

In `ProviderCardSections.tsx`, derive supported API formats from `getModelProviderEndpointKinds(provider.endpoints)` and `model.kinds`, map each kind through `resolveModelProviderKindApiFormat`, and keep unsupported formats out of the dropdown.

- [x] **Step 2: Keep full model list and show aligned tags**

Pass `currentApiFormat={apiFormat}` from `InlineEditableProviderCard` into `ProviderModelsSection`. In `ProviderModelsSection`, compute `mapModelProviderApiFormatToKind(currentApiFormat)` and pass the current kind into `ModelRowInput`.

- [x] **Step 3: Gate only runtime testing**

In `ModelRowInput`, keep editing/deleting/metadata controls active, render fixed columns for Anthropic, OpenAI Compatible, and OpenAI Responses tags, highlight the current format when supported, and keep the test button visible but disabled for unavailable rows.

- [x] **Step 4: Add i18n labels**

Add tooltip labels for each model API format tag in English and Chinese locale files.

- [x] **Step 5: Run focused test and verify GREEN**

Run: `pnpm vitest run packages/ui/test/modelProviderModelRowEditor.test.ts`

Expected: PASS.

### Task 3: Documentation And Full Verification

**Files:**
- Modify: `docs/model-provider-catalog-metadata.md`

- [x] **Step 1: Document settings behavior**

Record that API format choices are supplier-supported, settings keep the full model list visible, unavailable rows are marked for the current API format, and runtime projection still filters unavailable model/format combinations.

- [x] **Step 2: Run required verification**

Run:
- `pnpm vitest run packages/ui/test/modelProviderModelRowEditor.test.ts`
- `pnpm typecheck`
- `pnpm lint`

Expected: all commands exit 0.

- [ ] **Step 3: Commit**

Run:
- `git status --short`
- `git add packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts packages/ui/test/modelProviderModelRowEditor.test.ts docs/model-provider-catalog-metadata.md docs/superpowers/plans/2026-06-04-provider-api-format-model-availability.md`
- `git commit -m "feat(model-provider): mark model availability by api format"`

Expected: commit succeeds.
