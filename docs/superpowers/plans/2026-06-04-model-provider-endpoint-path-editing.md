# Model Provider Endpoint Path Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit provider-level endpoint paths for every selected API format, and make all API format UI display the configured path.

**Architecture:** Keep endpoint paths owned by provider config, not models. Add draft path state in add/edit provider forms, route it through `ProviderDraftSave`, and use one display helper so API format labels resolve paths from current provider or draft data.

**Tech Stack:** React, TypeScript, Vitest, existing shadcn-style `Input`/`Select` components, `@zcode/shared` model provider helpers.

---

### Task 1: Provider Draft Save Path Tests

**Files:**

- Modify: `packages/ui/test/modelProviderDraftSave.test.ts`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts`

- [ ] **Step 1: Write failing tests**

Add tests showing custom paths are saved and used for Base URL normalization:

```ts
it("新建自定义供应商可覆盖所选 API 格式的 endpoint path", () => {
  const provider = createProvider();

  expect(
    buildEndpointsForApiFormats(
      provider,
      ["openai-chat-completions"],
      "https://proxy.example.com/api",
      {
        "openai-compatible": "/proxy/chat",
      },
    ),
  ).toEqual({
    baseURL: "https://proxy.example.com/api",
    paths: { "openai-compatible": "/proxy/chat" },
  });
});

it("编辑供应商 path 时保留其它格式 path", () => {
  const provider = createProvider({
    apiFormat: "openai-chat-completions",
    defaultKind: "openai-compatible",
    endpoints: {
      baseURL: "https://api.deepseek.com",
      paths: {
        anthropic: "/anthropic/v1/messages",
        "openai-compatible": "/v1/chat/completions",
      },
    },
  });

  const result = resolvePendingProviderDraftSave({
    provider,
    draft: {
      nameValue: provider.name,
      apiFormat: "openai-chat-completions",
      baseUrlValue: "https://api.deepseek.com",
      endpointPathsValue: {
        anthropic: "/anthropic/v1/messages",
        "openai-compatible": "/custom/chat",
      },
      apiKeyValue: provider.apiKey,
    },
    now: () => 2000,
  });

  expect(result?.endpoints).toEqual({
    baseURL: "https://api.deepseek.com",
    paths: {
      anthropic: "/anthropic/v1/messages",
      "openai-compatible": "/custom/chat",
    },
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderDraftSave.test.ts
```

Expected: fail because `buildEndpointsForApiFormats` does not accept path overrides and `ProviderDraftValues` has no `endpointPathsValue`.

- [ ] **Step 3: Implement minimal save helpers**

In `ProviderDraftSave.ts`:

```ts
export type ProviderEndpointPathDraft = Partial<Record<ModelProviderKind, string>>;

export interface ProviderDraftValues {
  endpointPathsValue?: ProviderEndpointPathDraft;
}
```

Update `buildEndpointsForApiFormats` to accept `endpointPaths?: ProviderEndpointPathDraft`, normalize selected paths, and use them when computing `baseURL`.

Update `buildCanonicalEndpointsForDraft` to prefer `draft.endpointPathsValue`, then existing provider paths, then defaults.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderDraftSave.test.ts
```

Expected: all tests in that file pass.

### Task 2: Add Provider Path Draft UI

**Files:**

- Modify: `packages/ui/test/modelProviderCodingPlan.test.ts`
- Modify: `packages/ui/src/settings/model-provider-section/AddProviderCard.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Write failing tests**

Update the add-provider tests:

```ts
expect(html).toContain("settings.modelProvider.endpointPath");
expect(html).toContain('value="/anthropic/v1/messages"');
expect(html).toContain('value="/v1/chat/completions"');
```

Add a `customProviderToConfig` test with `endpointPaths`:

```ts
const provider = customProviderToConfig({
  apiFormats: ["openai-chat-completions"],
  apiKey: "sk-custom",
  baseURL: "https://custom.example.com/v1",
  endpointPaths: { "openai-compatible": "/proxy/chat" },
  name: "Custom Provider",
});

expect(provider.endpoints).toMatchObject({
  baseURL: "https://custom.example.com/v1",
  paths: { "openai-compatible": "/proxy/chat" },
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderCodingPlan.test.ts
```

Expected: fail because custom endpoint path inputs and `endpointPaths` are not wired.

- [ ] **Step 3: Implement add-provider UI**

Extend `AddProviderDraft`:

```ts
customEndpointPaths: Partial<Record<ModelProviderKind, string>>;
```

Render one path input per selected kind below `ProviderModelApiFormatMultiSelect`, using existing `Input`:

```tsx
<Input
  type="text"
  size="lg"
  className="font-mono"
  value={draft.customEndpointPaths[kind] ?? getDefaultModelProviderEndpointPathForKind(kind)}
  onChange={(event) => updateCustomEndpointPath(kind, event.target.value)}
/>
```

When API formats change, retain paths for selected kinds and add defaults for new kinds.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderCodingPlan.test.ts
```

Expected: updated tests pass.

### Task 3: Edit Provider Path UI And Dynamic Labels

**Files:**

- Modify: `packages/ui/test/modelProviderCodingPlan.test.ts`
- Modify: `packages/ui/test/providerModelMetadataDialog.test.ts`
- Modify: `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderModelApiFormatTags.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`

- [ ] **Step 1: Write failing tests**

Add rendering assertions that configured paths appear:

```ts
const html = renderDetail({
  type: "custom-provider",
  provider: createProvider({
    endpoints: {
      baseURL: "https://api.example.com",
      paths: { "openai-compatible": "/custom/chat" },
    },
    models: [
      createModelProviderModelConfig({
        id: "glm-5",
        kinds: ["openai-compatible"],
        defaultKind: "openai-compatible",
      }),
    ],
  }),
});

expect(html).toContain("/custom/chat");
expect(html).not.toContain("/chat/completions");
```

Update metadata dialog tests so `ProviderModelApiFormatMultiSelect` receives endpoint paths and renders `/custom/chat`.

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderCodingPlan.test.ts packages/ui/test/providerModelMetadataDialog.test.ts
```

Expected: fail because API format display still uses hardcoded endpoint strings.

- [ ] **Step 3: Implement dynamic display helper**

In `ProviderModelApiFormatTags.tsx`, keep format metadata but resolve endpoint path dynamically:

```ts
export type ApiFormatEndpointPaths = Partial<Record<ModelProviderKind, string>>;

export function resolveApiFormatEndpointPath(
  kind: ModelProviderKind,
  endpointPaths?: ApiFormatEndpointPaths,
) {
  const configured = endpointPaths?.[kind]?.trim();
  return configured || getDefaultModelProviderEndpointPathForKind(kind);
}
```

Pass `endpointPaths` through `ProviderConnectionSection`, `ProviderModelsSection`, `ModelRowInput`, and `ProviderModelMetadataDialog`.

Use `titleLabelId + resolved path` instead of the old hardcoded long-label i18n string anywhere a path is shown.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderCodingPlan.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/test/modelProviderDraftSave.test.ts
```

Expected: all targeted tests pass.

### Task 4: Final Verification And Commit

**Files:**

- All changed files from Tasks 1-3

- [ ] **Step 1: Format changed files**

Run:

```bash
pnpm exec oxfmt packages/ui/src/settings/model-provider-section/AddProviderCard.tsx packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx packages/ui/src/settings/model-provider-section/ProviderModelApiFormatTags.tsx packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx packages/ui/test/modelProviderCodingPlan.test.ts packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
```

Expected: formatter exits 0.

- [ ] **Step 2: Run required checks**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/modelProviderCodingPlan.test.ts packages/ui/test/providerModelMetadataDialog.test.ts
pnpm typecheck
pnpm lint
```

Expected: tests pass, typecheck exits 0, lint exits 0.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-06-04-model-provider-endpoint-path-editing.md packages/ui/src/settings/model-provider-section/AddProviderCard.tsx packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx packages/ui/src/settings/model-provider-section/ProviderModelApiFormatTags.tsx packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx packages/ui/test/modelProviderCodingPlan.test.ts packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
git commit -m "feat(model-provider): edit endpoint paths per api format"
```

Expected: commit succeeds.
