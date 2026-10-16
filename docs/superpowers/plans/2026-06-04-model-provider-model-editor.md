# Model Provider Model Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Current note (2026-06-05): this is a historical implementation plan. The current model add/edit dialog no longer exposes reasoning JSON; do not copy `reasoningJsonValue` or reasoning JSON UI snippets from the old steps below.

**Goal:** Make “Add model” open a model editor dialog, and make both add/edit dialogs expose Model ID, API formats, context window, and reasoning JSON.

**Architecture:** Keep model draft parsing in `ProviderModelMetadata.ts`, keep dialog rendering in `ProviderModelMetadataDialog.tsx`, and wire add/edit behavior from `ProviderModelsSection` / `ModelRowInput`. Add one small multi-select dropdown inside the dialog using existing `DropdownMenuCheckboxItem`.

**Tech Stack:** React, TypeScript, Radix-backed local UI components, Vitest server-side render tests, existing `@zcode/shared` model provider types.

---

### Task 1: Extend Model Draft Data Rules

**Files:**
- Modify: `packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts`
- Modify: `packages/ui/test/modelProviderDraftSave.test.ts`

- [ ] **Step 1: Write failing draft tests**

Append these cases under `describe("provider model metadata draft", ...)` in `packages/ui/test/modelProviderDraftSave.test.ts`:

```ts
  it("会保存模型 API 格式并按当前设置页格式选择 defaultKind", async () => {
    const module = await import(
      "@/settings/model-provider-section/ProviderModelMetadata.js"
    );
    const resolveProviderModelDraftCommit = (
      module as unknown as {
        resolveProviderModelDraftCommit: (input: {
          currentModel: ReturnType<typeof createModelProviderModelConfig>;
          draft: {
            idValue: string;
            nameValue: string;
            kindsValue: Array<"anthropic" | "openai-compatible" | "openai">;
            contextWindowValue: string;
            maxOutputTokensValue: string;
            reasoningJsonValue: string;
          };
          preferredDefaultKind?: "anthropic" | "openai-compatible" | "openai" | null;
        }) => unknown;
      }
    ).resolveProviderModelDraftCommit;

    const result = resolveProviderModelDraftCommit({
      currentModel: createModelProviderModelConfig({
        id: "qwen-old",
        kinds: ["anthropic"],
      }),
      preferredDefaultKind: "openai-compatible",
      draft: {
        idValue: "qwen-new",
        nameValue: "",
        kindsValue: ["openai", "anthropic", "openai-compatible"],
        contextWindowValue: "64000",
        maxOutputTokensValue: "",
        reasoningJsonValue: "",
      },
    });

    expect(result).toEqual({
      status: "commit",
      model: expect.objectContaining({
        id: "qwen-new",
        kinds: ["anthropic", "openai-compatible", "openai"],
        defaultKind: "openai-compatible",
        contextWindow: 64000,
      }),
    });
  });

  it("模型 ID 或 API 格式为空时不会提交模型变更", async () => {
    const module = await import(
      "@/settings/model-provider-section/ProviderModelMetadata.js"
    );
    const resolveProviderModelDraftCommit = (
      module as unknown as {
        resolveProviderModelDraftCommit: (input: {
          currentModel: ReturnType<typeof createModelProviderModelConfig>;
          draft: {
            idValue: string;
            nameValue: string;
            kindsValue: Array<"anthropic" | "openai-compatible" | "openai">;
            contextWindowValue: string;
            maxOutputTokensValue: string;
            reasoningJsonValue: string;
          };
        }) => unknown;
      }
    ).resolveProviderModelDraftCommit;

    const currentModel = createModelProviderModelConfig({
      id: "qwen-old",
      kinds: ["openai-compatible"],
    });

    expect(
      resolveProviderModelDraftCommit({
        currentModel,
        draft: {
          idValue: " ",
          nameValue: "",
          kindsValue: ["openai-compatible"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
          reasoningJsonValue: "",
        },
      }),
    ).toEqual({ status: "invalid", field: "id" });

    expect(
      resolveProviderModelDraftCommit({
        currentModel,
        draft: {
          idValue: "qwen-old",
          nameValue: "",
          kindsValue: [],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
          reasoningJsonValue: "",
        },
      }),
    ).toEqual({ status: "invalid", field: "kinds" });
  });
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/modelProviderDraftSave.test.ts
```

Expected: FAIL because `ProviderModelDraftValues` does not include `kindsValue`, and `resolveProviderModelDraftCommit` still deletes empty IDs instead of returning invalid.

- [ ] **Step 3: Implement draft rules**

In `packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts`:

```ts
import {
  modelProviderReasoningSpecSchema,
  type ModelProviderKind,
  type ModelProviderModelConfig,
} from "@zcode/shared";

const MODEL_PROVIDER_KIND_ORDER: ModelProviderKind[] = [
  "anthropic",
  "openai-compatible",
  "openai",
];

export interface ProviderModelDraftValues {
  idValue: string;
  nameValue: string;
  kindsValue: ModelProviderKind[];
  contextWindowValue: string;
  maxOutputTokensValue: string;
  reasoningJsonValue: string;
}

export type ProviderModelDraftCommitResult =
  | { status: "commit"; model: ModelProviderModelConfig }
  | { status: "invalid"; field: "id" | "kinds" | "contextWindow" | "maxOutputTokens" | "reasoning" };

export function createProviderModelDraftValues(
  model: ModelProviderModelConfig,
): ProviderModelDraftValues {
  return {
    idValue: model.id,
    nameValue: model.name ?? "",
    kindsValue: normalizeProviderModelDraftKinds(model.kinds),
    contextWindowValue: String(model.contextWindow),
    maxOutputTokensValue:
      model.maxOutputTokens === undefined ? "" : String(model.maxOutputTokens),
    reasoningJsonValue: model.reasoning
      ? JSON.stringify(model.reasoning, null, 2)
      : "",
  };
}

export function normalizeProviderModelDraftKinds(
  kinds: readonly ModelProviderKind[],
): ModelProviderKind[] {
  const selected = new Set(kinds);
  return MODEL_PROVIDER_KIND_ORDER.filter((kind) => selected.has(kind));
}
```

Update `resolveProviderModelDraftCommit` signature and beginning:

```ts
export function resolveProviderModelDraftCommit({
  currentModel,
  draft,
  preferredDefaultKind,
}: {
  currentModel: ModelProviderModelConfig;
  draft: ProviderModelDraftValues;
  preferredDefaultKind?: ModelProviderKind | null;
}): ProviderModelDraftCommitResult {
  const id = draft.idValue.trim();
  if (!id) {
    return { status: "invalid", field: "id" };
  }

  const kinds = normalizeProviderModelDraftKinds(draft.kindsValue);
  if (kinds.length === 0) {
    return { status: "invalid", field: "kinds" };
  }

  const defaultKind =
    preferredDefaultKind && kinds.includes(preferredDefaultKind)
      ? preferredDefaultKind
      : kinds[0];
```

Include `kinds` and `defaultKind` in the committed model:

```ts
    model: {
      ...currentModel,
      id,
      name: draft.nameValue.trim() || undefined,
      kinds,
      defaultKind,
      contextWindow,
      maxOutputTokens,
      reasoning,
    },
```

- [ ] **Step 4: Run tests to verify pass**

Run:

```bash
pnpm vitest run packages/ui/test/modelProviderDraftSave.test.ts
```

Expected: PASS.

### Task 2: Expand The Model Editor Dialog

**Files:**
- Modify: `packages/ui/src/settings/model-provider-section/ProviderModelMetadataDialog.tsx`
- Modify: `packages/ui/test/providerModelMetadataDialog.test.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`

- [ ] **Step 1: Write failing dialog render test**

Update the mocked messages in `packages/ui/test/providerModelMetadataDialog.test.ts` to include:

```ts
          "common.cancel": "取消",
          "settings.modelProvider.addModel": "添加模型",
          "settings.modelProvider.apiFormat": "API 格式",
          "settings.modelProvider.apiFormat.anthropicMessages": "Anthropic Messages (/v1/messages)",
          "settings.modelProvider.apiFormat.chatCompletions": "Chat Completions (/chat/completions)",
          "settings.modelProvider.apiFormat.responses": "Responses (/responses)",
          "settings.modelProvider.modelMetadata.invalid.id": "模型 ID 不能为空",
          "settings.modelProvider.modelMetadata.invalid.kinds": "至少选择一种 API 格式",
```

Add this mock so dropdown content renders in static markup:

```ts
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuCheckboxItem: ({
    children,
    checked,
  }: {
    children: ReactNode;
    checked?: boolean;
  }) => createElement("div", { "data-checked": checked ? "true" : "false" }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));
```

Add a test:

```ts
  it("添加模型弹窗展示模型 ID、API 格式、上下文窗口和推理强度", () => {
    const html = renderToStaticMarkup(
      createElement(ProviderModelMetadataDialog, {
        mode: "add",
        open: true,
        draft: {
          idValue: "",
          nameValue: "",
          kindsValue: ["anthropic"],
          contextWindowValue: "128000",
          maxOutputTokensValue: "",
          reasoningJsonValue: "",
        },
        draftErrorMessage: null,
        onOpenChange: vi.fn(),
        onDraftChange: vi.fn(),
        onCommit: vi.fn(() => true),
      }),
    );

    expect(html).toContain("添加模型");
    expect(html).toContain("模型 ID");
    expect(html).toContain("API 格式");
    expect(html).toContain("Anthropic Messages (/v1/messages)");
    expect(html).toContain("Chat Completions (/chat/completions)");
    expect(html).toContain("Responses (/responses)");
    expect(html).toContain("上下文窗口");
    expect(html).toContain("推理强度 JSON");
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/providerModelMetadataDialog.test.ts
```

Expected: FAIL because the dialog does not render model ID or API format controls.

- [ ] **Step 3: Implement four-field dialog**

In `ProviderModelMetadataDialog.tsx`, add imports:

```ts
import { ChevronDown, Pencil } from "lucide-react";
import type { ModelProviderApiFormat, ModelProviderKind } from "@zcode/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
```

Add local API format metadata:

```ts
const MODEL_API_FORMAT_OPTIONS: Array<{
  format: ModelProviderApiFormat;
  kind: ModelProviderKind;
  labelId: string;
}> = [
  {
    format: "anthropic-messages",
    kind: "anthropic",
    labelId: "settings.modelProvider.apiFormat.anthropicMessages",
  },
  {
    format: "openai-chat-completions",
    kind: "openai-compatible",
    labelId: "settings.modelProvider.apiFormat.chatCompletions",
  },
  {
    format: "openai-responses",
    kind: "openai",
    labelId: "settings.modelProvider.apiFormat.responses",
  },
];
```

Add a helper component in the same file:

```tsx
function ProviderModelApiFormatMultiSelect({
  kinds,
  onChange,
}: {
  kinds: ModelProviderKind[];
  onChange: (kinds: ModelProviderKind[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const labels = MODEL_API_FORMAT_OPTIONS.filter((option) =>
    kinds.includes(option.kind),
  ).map((option) => intl.formatMessage({ id: option.labelId }));
  const triggerText =
    labels.length > 0
      ? labels.join(", ")
      : intl.formatMessage({ id: "settings.modelProvider.apiFormat" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="w-full justify-between"
        >
          <span className="min-w-0 truncate text-left">{triggerText}</span>
          <ChevronDown className="size-3.5 text-foreground-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {MODEL_API_FORMAT_OPTIONS.map((option) => {
          const checked = kinds.includes(option.kind);
          return (
            <DropdownMenuCheckboxItem
              key={option.kind}
              checked={checked}
              onCheckedChange={(nextChecked) => {
                const selected = new Set(kinds);
                if (nextChecked) {
                  selected.add(option.kind);
                } else {
                  selected.delete(option.kind);
                }
                onChange(
                  MODEL_API_FORMAT_OPTIONS.map((item) => item.kind).filter((kind) =>
                    selected.has(kind),
                  ),
                );
              }}
              onSelect={(event) => event.preventDefault()}
            >
              {intl.formatMessage({ id: option.labelId })}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

Extend `ProviderModelMetadataDialog` props:

```ts
mode?: "add" | "edit";
```

Render these controls before context window:

```tsx
          <div>
            <label className="mb-1 block text-xs text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.modelId" })}
            </label>
            <Input
              type="text"
              size="lg"
              className="font-mono"
              value={draft.idValue}
              placeholder={intl.formatMessage({ id: "settings.modelProvider.modelId" })}
              onChange={(event) => onDraftChange({ idValue: event.target.value })}
              onBlur={mode === "edit" ? onCommit : undefined}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}
            </label>
            <ProviderModelApiFormatMultiSelect
              kinds={draft.kindsValue}
              onChange={(kindsValue) => onDraftChange({ kindsValue })}
            />
          </div>
```

Set the title to:

```tsx
<DialogTitle className="truncate">
  {intl.formatMessage({
    id: mode === "add" ? "settings.modelProvider.addModel" : "settings.modelProvider.editModel",
  })}
</DialogTitle>
```

For add mode, render footer:

```tsx
{mode === "add" ? (
  <DialogFooter>
    <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
      {intl.formatMessage({ id: "common.cancel" })}
    </Button>
    <Button type="button" onClick={onCommit}>
      {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
    </Button>
  </DialogFooter>
) : null}
```

- [ ] **Step 4: Add i18n messages**

Add to both locale files near existing model metadata messages:

```ts
"settings.modelProvider.modelMetadata.invalid.id": "Model ID is required",
"settings.modelProvider.modelMetadata.invalid.kinds": "Select at least one API format",
```

Chinese:

```ts
"settings.modelProvider.modelMetadata.invalid.id": "模型 ID 不能为空",
"settings.modelProvider.modelMetadata.invalid.kinds": "至少选择一种 API 格式",
```

- [ ] **Step 5: Run dialog test**

Run:

```bash
pnpm vitest run packages/ui/test/providerModelMetadataDialog.test.ts
```

Expected: PASS.

### Task 3: Wire Add Model To The Dialog

**Files:**
- Modify: `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx`
- Modify: `packages/ui/src/settings/model-provider-section/InlineEditableProviderCard.tsx`
- Modify: `packages/ui/test/modelProviderModelRowEditor.test.ts`

- [ ] **Step 1: Write failing add default draft test**

In `packages/ui/test/modelProviderModelRowEditor.test.ts`, add a test for the pure helper that will create the add-model draft from the current settings page API format:

```ts
import { createProviderModelAddDraft } from "@/settings/model-provider-section/ProviderCardSections.js";

  it("新增模型 draft 默认选中当前设置页 API 格式", () => {
    expect(
      createProviderModelAddDraft("openai-chat-completions").kindsValue,
    ).toEqual(["openai-compatible"]);
    expect(createProviderModelAddDraft("openai-responses").kindsValue).toEqual([
      "openai",
    ]);
    expect(createProviderModelAddDraft("anthropic-messages").kindsValue).toEqual([
      "anthropic",
    ]);
  });
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
pnpm vitest run packages/ui/test/modelProviderModelRowEditor.test.ts
```

Expected: FAIL because `createProviderModelAddDraft` is not exported yet.

- [ ] **Step 3: Update `ModelRowInput` for new commit rules**

In `ProviderFormControls.tsx`:

```ts
const [draftErrorField, setDraftErrorField] = useState<
  "id" | "kinds" | "contextWindow" | "maxOutputTokens" | "reasoning" | null
>(null);
```

Pass the preferred kind into commit:

```ts
const result = resolveProviderModelDraftCommit({
  currentModel: model,
  draft,
  preferredDefaultKind: currentKind,
});
```

Pass `mode="edit"` into the dialog:

```tsx
<ProviderModelMetadataDialog
  mode="edit"
  open={metadataDialogOpen}
  draft={draft}
  draftErrorMessage={draftErrorMessage}
  onOpenChange={handleMetadataDialogOpenChange}
  onDraftChange={updateDraft}
  onCommit={commitDraft}
/>
```

- [ ] **Step 4: Add ProviderModelsSection add dialog state**

In `ProviderCardSections.tsx`, change the React import and add `createModelProviderModelConfig` to the existing `@zcode/shared` import:

```ts
import { useCallback, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
```

Import dialog helpers:

```ts
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
  type ProviderModelDraftValues,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";
import { ProviderModelMetadataDialog } from "@/settings/model-provider-section/ProviderModelMetadataDialog.js";
```

Create and export this helper near `ProviderModelsSection`:

```ts
export function createProviderModelAddDraft(
  currentApiFormat?: ModelProviderApiFormat,
): ProviderModelDraftValues {
  const defaultKind = currentApiFormat
    ? mapModelProviderApiFormatToKind(currentApiFormat)
    : "openai-compatible";
  return createProviderModelDraftValues(
    createModelProviderModelConfig({
      id: "",
      kinds: [defaultKind],
      defaultKind,
    }),
  );
}
```

Change the prop type:

```ts
onAddModel: (model: ModelProviderModelConfig) => void;
```

Inside `ProviderModelsSection`, add state:

```ts
const [addDialogOpen, setAddDialogOpen] = useState(false);
const addDefaultKind = currentKind ?? "openai-compatible";
const createAddDraft = useCallback(
  () => createProviderModelAddDraft(currentApiFormat),
  [currentApiFormat],
);
const [addDraft, setAddDraft] = useState<ProviderModelDraftValues>(() =>
  createAddDraft(),
);
const [addDraftErrorField, setAddDraftErrorField] = useState<
  "id" | "kinds" | "contextWindow" | "maxOutputTokens" | "reasoning" | null
>(null);
```

Add handlers:

```ts
const openAddDialog = useCallback(() => {
  setAddDraft(createAddDraft());
  setAddDraftErrorField(null);
  setAddDialogOpen(true);
}, [createAddDraft]);

const updateAddDraft = useCallback((patch: Partial<ProviderModelDraftValues>) => {
  setAddDraft((previous) => ({ ...previous, ...patch }));
  setAddDraftErrorField(null);
}, []);

const commitAddDraft = useCallback((): boolean => {
  const result = resolveProviderModelDraftCommit({
    currentModel: createModelProviderModelConfig({
      id: addDraft.idValue,
      kinds: addDraft.kindsValue,
      defaultKind: addDefaultKind,
    }),
    draft: addDraft,
    preferredDefaultKind: addDefaultKind,
  });
  if (result.status === "invalid") {
    setAddDraftErrorField(result.field);
    return false;
  }
  onAddModel(result.model);
  setAddDialogOpen(false);
  setAddDraft(createAddDraft());
  return true;
}, [addDefaultKind, addDraft, createAddDraft, onAddModel]);
```

Render the add dialog next to the button:

```tsx
<ProviderModelMetadataDialog
  mode="add"
  open={addDialogOpen}
  draft={addDraft}
  draftErrorMessage={
    addDraftErrorField
      ? intl.formatMessage({
          id: `settings.modelProvider.modelMetadata.invalid.${addDraftErrorField}`,
        })
      : null
  }
  onOpenChange={setAddDialogOpen}
  onDraftChange={updateAddDraft}
  onCommit={commitAddDraft}
/>
<Button
  type="button"
  variant="secondary"
  size="lg"
  data-testid={TID_MODEL_PROVIDER_ADD_MODEL_BUTTON}
  className="mt-1"
  onClick={openAddDialog}
>
  <Plus className="mr-1 size-3.5" />
  {intl.formatMessage({ id: "settings.modelProvider.addModel" })}
</Button>
```

- [ ] **Step 5: Save newly added model from parent**

In `InlineEditableProviderCard.tsx`, change `handleAddModel`:

```ts
const handleAddModel = useCallback(
  (model: ModelProviderModelConfig) => {
    saveModels([...models, model]);
  },
  [models, saveModels],
);
```

Remove the unused `resolveModelProviderDefaultKind` import if no longer used.

- [ ] **Step 6: Run model row test**

Run:

```bash
pnpm vitest run packages/ui/test/modelProviderModelRowEditor.test.ts
```

Expected: PASS.

### Task 4: Verification And Commit

**Files:**
- Inspect all modified files from Tasks 1-3.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/test/modelProviderModelRowEditor.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run required project checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: `pnpm typecheck` exits 0. `pnpm lint` exits 0; existing warnings may remain, but there should be no errors.

- [ ] **Step 3: Review diff**

Run:

```bash
git diff --stat
git diff -- packages/ui/src/settings/model-provider-section packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/test/modelProviderModelRowEditor.test.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
```

Expected: diff only contains model editor dialog, draft helpers, tests, and locale changes.

- [ ] **Step 4: Commit implementation**

Run:

```bash
git add packages/ui/src/settings/model-provider-section packages/ui/test/modelProviderDraftSave.test.ts packages/ui/test/providerModelMetadataDialog.test.ts packages/ui/test/modelProviderModelRowEditor.test.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/src/i18n/locales/zh-CN.ts
git commit -m "feat(model-provider): edit model details in dialog"
```

Expected: commit succeeds.
