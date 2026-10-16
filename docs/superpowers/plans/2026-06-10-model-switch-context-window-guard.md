# Model Switch Context Window Guard Implementation Plan

> 状态（2026-07-15）：历史方案，已被 V4 composer 迁移裁决取代，当前尚未恢复“切换模型前自动压缩”守卫。
> 待实施的 V4 产品语义以
> `docs/superpowers/specs/2026-06-10-model-switch-context-window-guard-design.md` 为准；迁移事实见
> `docs/v4-refactor/m5-composer-parity.md` 与 `docs/v4-refactor/m6-model-selection-parity.md`。
> 下文旧 `ChatView` / `ChatInputToolbar` 路径仅供追溯。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent active-task model switches when the target model context window is smaller than the current session context, offering compression first and switching only if compression brings usage under the target window.

**Architecture:** Add a pure context-window guard helper under the chat input toolbar domain, test it first, then wire it into `useToolbarModelChange` before the existing native/custom/local selection branches. Reuse the existing `/compact` send path so desktop continuous and mobile replayable semantics stay unchanged.

**Tech Stack:** React 19, Zustand, Vitest, TypeScript, existing ZCode UI components, existing model provider metadata helpers.

---

### File Structure

- Create: `packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts`
  - Pure helpers for resolving target model context windows and executing the compress-before-switch decision.
- Create: `packages/ui/test/modelSwitchContextWindowGuard.test.ts`
  - Unit tests for resolver and guard decision flow.
- Modify: `packages/ui/src/chat-input-toolbar/useToolbarModelChange.ts`
  - Invoke the guard before dispatching to existing model switch branches.
- Modify: `packages/ui/src/chat-input-toolbar/modelChangeActions.ts`
  - Extend `ToolbarModelChangeDependencies` with an optional compression callback.
- Modify: `packages/ui/src/ChatInputToolbar.tsx`
  - Accept and pass the model-switch compression callback.
- Modify: `packages/ui/src/ChatView/ChatViewComposer.tsx`
  - Accept and pass the model-switch compression callback into `ChatInputToolbar`.
- Modify: `packages/ui/src/hooks/useChatComposer.ts`
  - Expose a Promise-returning `/compact` callback that reuses `sendPrompt("/compact", [])`.
- Modify: `packages/ui/src/ChatView.tsx`
  - Pull the new callback from the composer bridge and pass it to `ChatViewComposer`.
- Modify: `packages/ui/src/ConfirmDialog.tsx`
  - Render `warning` confirm dialogs with a warning-styled action.
- Modify: `packages/ui/src/components/ui/button.tsx`
  - Add a `warning` button variant using semantic warning tokens.
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
  - Add Chinese context-window guard messages.
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
  - Add English context-window guard messages.

---

### Task 1: Add Context Window Resolver

**Files:**
- Create: `packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts`
- Test: `packages/ui/test/modelSwitchContextWindowGuard.test.ts`

- [ ] **Step 1: Write the failing resolver tests**

Create `packages/ui/test/modelSwitchContextWindowGuard.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import {
  encodeCustomModelValue,
  type ModelProviderConfig,
  type ZCodeConfigOption,
} from "@zcode/shared";
import { resolveTargetModelContextWindow } from "@/chat-input-toolbar/modelSwitchContextWindowGuard.js";

function createModelOption(
  value: string,
  providerId = "builtin:zai",
): ZCodeConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "builtin:zai/glm-4.7",
    options: [
      {
        value,
        name: value,
        modelProviderId: providerId,
        modelProviderName: providerId,
      },
    ],
  };
}

function createProvider(): ModelProviderConfig {
  return {
    id: "builtin:zai",
    name: "Z.AI",
    type: "builtin",
    enabled: true,
    apiKey: "",
    endpoints: {
      baseURL: "https://api.z.ai/api/anthropic",
      paths: { anthropic: "/v1/messages" },
    },
    models: [
      {
        id: "glm-4.7",
        name: "GLM 4.7",
        kinds: ["anthropic"],
        modalities: { input: ["text"], output: ["text"] },
        contextWindow: 128_000,
      },
      {
        id: "glm-5",
        name: "GLM 5",
        kinds: ["anthropic"],
        modelIdByKind: { anthropic: "glm-5-runtime" },
        modalities: { input: ["text"], output: ["text"] },
        contextWindow: 200_000,
      },
      "legacy-model",
      "wide-model[1m]",
    ],
  };
}

describe("resolveTargetModelContextWindow", () => {
  it("resolves native model metadata context window", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [createProvider()],
      option: createModelOption("builtin:zai/glm-4.7"),
      selectedProvider: "glm",
      value: "builtin:zai/glm-4.7",
    });

    expect(result).toEqual({
      contextWindow: 128_000,
      modelId: "glm-4.7",
      providerId: "builtin:zai",
    });
  });

  it("resolves custom model metadata context window", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [createProvider()],
      option: createModelOption(encodeCustomModelValue("builtin:zai", "glm-4.7")),
      selectedProvider: "glm",
      value: encodeCustomModelValue("builtin:zai", "glm-4.7"),
    });

    expect(result?.contextWindow).toBe(128_000);
    expect(result?.providerId).toBe("builtin:zai");
    expect(result?.modelId).toBe("glm-4.7");
  });

  it("matches runtime modelIdByKind values back to source metadata", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [createProvider()],
      option: createModelOption("builtin:zai/glm-5-runtime"),
      selectedProvider: "glm",
      value: "builtin:zai/glm-5-runtime",
    });

    expect(result?.contextWindow).toBe(200_000);
    expect(result?.modelId).toBe("glm-5");
  });

  it("uses legacy fallback for string model entries that exist in provider metadata", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [createProvider()],
      option: createModelOption("builtin:zai/legacy-model"),
      selectedProvider: "glm",
      value: "builtin:zai/legacy-model",
    });

    expect(result?.contextWindow).toBe(200_000);
    expect(result?.modelId).toBe("legacy-model");
  });

  it("uses one million context for [1m] string model entries", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [createProvider()],
      option: createModelOption("builtin:zai/wide-model[1m]"),
      selectedProvider: "glm",
      value: "builtin:zai/wide-model[1m]",
    });

    expect(result?.contextWindow).toBe(1_000_000);
  });

  it("returns null when no provider metadata can identify the model", () => {
    const result = resolveTargetModelContextWindow({
      modelProviders: [],
      option: createModelOption("unknown/unknown-model", "unknown"),
      selectedProvider: "glm",
      value: "unknown/unknown-model",
    });

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run resolver tests to verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: FAIL because `@/chat-input-toolbar/modelSwitchContextWindowGuard.js` does not exist.

- [ ] **Step 3: Implement resolver helper**

Create `packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts`:

```ts
import {
  isModelProviderModelConfig,
  resolveModelProviderContextWindow,
  type ModelProviderConfig,
  type ModelProviderModelEntry,
  type ZCodeConfigOption,
  type ZCodeProvider,
} from "@zcode/shared";
import { decodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";

export interface TargetModelContextWindow {
  contextWindow: number;
  modelId: string;
  providerId: string;
}

export interface ResolveTargetModelContextWindowParams {
  modelProviders: readonly ModelProviderConfig[];
  option: ZCodeConfigOption;
  selectedProvider: ZCodeProvider;
  value: string;
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function stripVariant(value: string): string {
  const trimmed = value.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  return colonIndex > 0 ? trimmed.slice(0, colonIndex) : trimmed;
}

function modelIdCandidates(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  const candidates = new Set<string>([trimmed, stripVariant(trimmed)]);
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    const afterSlash = trimmed.slice(slashIndex + 1);
    candidates.add(afterSlash);
    candidates.add(stripVariant(afterSlash));
  }

  return [...candidates].filter(Boolean);
}

function resolveOptionProviderId(option: ZCodeConfigOption, value: string): string | null {
  if (option.type !== "select") {
    return null;
  }
  const selected = option.options?.find((entry) => entry.value === value);
  return selected?.modelProviderId?.trim() || null;
}

function findProvider(
  modelProviders: readonly ModelProviderConfig[],
  providerId: string | null,
  selectedProvider: ZCodeProvider,
): ModelProviderConfig | null {
  if (providerId) {
    const exact = modelProviders.find((provider) => provider.id === providerId);
    if (exact) {
      return exact;
    }
  }

  return modelProviders.find((provider) => provider.id === selectedProvider) ?? null;
}

function modelEntryMatches(entry: ModelProviderModelEntry, candidate: string): boolean {
  const normalizedCandidate = normalizeModelId(candidate);
  if (typeof entry === "string") {
    return normalizeModelId(entry) === normalizedCandidate;
  }

  if (normalizeModelId(entry.id) === normalizedCandidate) {
    return true;
  }

  return Object.values(entry.modelIdByKind ?? {}).some(
    (runtimeModelId) => normalizeModelId(runtimeModelId ?? "") === normalizedCandidate,
  );
}

function resolveModelEntryContextWindow(
  provider: ModelProviderConfig,
  candidates: readonly string[],
): TargetModelContextWindow | null {
  for (const candidate of candidates) {
    const entry = provider.models.find((model) => modelEntryMatches(model, candidate));
    if (!entry) {
      continue;
    }

    if (isModelProviderModelConfig(entry)) {
      return {
        contextWindow: resolveModelProviderContextWindow(entry.id, entry.contextWindow),
        modelId: entry.id.trim(),
        providerId: provider.id,
      };
    }

    const modelId = entry.trim();
    return {
      contextWindow: resolveModelProviderContextWindow(modelId, undefined),
      modelId,
      providerId: provider.id,
    };
  }

  return null;
}

export function resolveTargetModelContextWindow(
  params: ResolveTargetModelContextWindowParams,
): TargetModelContextWindow | null {
  if (params.option.category !== "model" || params.option.type !== "select") {
    return null;
  }

  const customSelection = decodeCustomModelValue(params.value);
  if (customSelection) {
    const provider = findProvider(
      params.modelProviders,
      customSelection.providerId,
      params.selectedProvider,
    );
    if (!provider) {
      return null;
    }
    return resolveModelEntryContextWindow(
      provider,
      customSelection.modelName ? [customSelection.modelName] : [],
    );
  }

  const provider = findProvider(
    params.modelProviders,
    resolveOptionProviderId(params.option, params.value),
    params.selectedProvider,
  );
  if (!provider) {
    return null;
  }

  return resolveModelEntryContextWindow(provider, modelIdCandidates(params.value));
}
```

- [ ] **Step 4: Run resolver tests to verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: PASS for all resolver tests.

- [ ] **Step 5: Commit resolver helper**

```bash
git add packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts packages/ui/test/modelSwitchContextWindowGuard.test.ts
git commit -m "test: add model switch context window resolver"
```

---

### Task 2: Add Guard Decision Runner

**Files:**
- Modify: `packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts`
- Test: `packages/ui/test/modelSwitchContextWindowGuard.test.ts`

- [ ] **Step 1: Add failing guard decision tests**

Append to `packages/ui/test/modelSwitchContextWindowGuard.test.ts`:

```ts
import { runModelSwitchContextWindowGuard } from "@/chat-input-toolbar/modelSwitchContextWindowGuard.js";

describe("runModelSwitchContextWindowGuard", () => {
  it("proceeds immediately when current usage fits the target window", async () => {
    const confirmCompression = vi.fn().mockResolvedValue(true);
    const runCompression = vi.fn().mockResolvedValue(true);

    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression,
        currentUsed: 64_000,
        isTaskBusy: false,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(),
        runCompression,
        targetContextWindow: 128_000,
      }),
    ).resolves.toBe("proceed");

    expect(confirmCompression).not.toHaveBeenCalled();
    expect(runCompression).not.toHaveBeenCalled();
  });

  it("cancels and reports running task when compression is required but task is busy", async () => {
    const notifyRunningBlocked = vi.fn();

    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 200_001,
        isTaskBusy: true,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked,
        readContextUsedAfterCompression: vi.fn(),
        runCompression: vi.fn().mockResolvedValue(true),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");

    expect(notifyRunningBlocked).toHaveBeenCalledTimes(1);
  });

  it("cancels when user rejects compression", async () => {
    const runCompression = vi.fn().mockResolvedValue(true);

    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(false),
        currentUsed: 200_001,
        isTaskBusy: false,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(),
        runCompression,
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");

    expect(runCompression).not.toHaveBeenCalled();
  });

  it("proceeds after confirmed compression brings usage under target window", async () => {
    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 200_001,
        isTaskBusy: false,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(() => 128_000),
        runCompression: vi.fn().mockResolvedValue(true),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("proceed");
  });

  it("cancels after compression when usage is still above target window", async () => {
    const notifyCompressionStillTooLarge = vi.fn();

    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 250_000,
        isTaskBusy: false,
        notifyCompressionStillTooLarge,
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(() => 210_000),
        runCompression: vi.fn().mockResolvedValue(true),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");

    expect(notifyCompressionStillTooLarge).toHaveBeenCalledTimes(1);
  });

  it("cancels when compression fails or does not confirm latest usage", async () => {
    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 250_000,
        isTaskBusy: false,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(() => 128_000),
        runCompression: vi.fn().mockResolvedValue(false),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");

    const notifyCompressionStillTooLarge = vi.fn();
    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 250_000,
        isTaskBusy: false,
        notifyCompressionStillTooLarge,
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(() => null),
        runCompression: vi.fn().mockResolvedValue(true),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");

    expect(notifyCompressionStillTooLarge).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run guard tests to verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: FAIL because `runModelSwitchContextWindowGuard` is not exported.

- [ ] **Step 3: Implement guard runner**

Append to `packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts`:

```ts
export type ModelSwitchContextWindowGuardResult = "proceed" | "cancel";

export interface RunModelSwitchContextWindowGuardParams {
  confirmCompression: () => Promise<boolean>;
  currentUsed: number;
  isTaskBusy: boolean;
  notifyCompressionStillTooLarge: () => void;
  notifyRunningBlocked: () => void;
  readContextUsedAfterCompression: () => number | null;
  runCompression: () => Promise<boolean>;
  targetContextWindow: number;
}

export async function runModelSwitchContextWindowGuard(
  params: RunModelSwitchContextWindowGuardParams,
): Promise<ModelSwitchContextWindowGuardResult> {
  if (params.currentUsed <= params.targetContextWindow) {
    return "proceed";
  }

  if (params.isTaskBusy) {
    params.notifyRunningBlocked();
    return "cancel";
  }

  const confirmed = await params.confirmCompression();
  if (!confirmed) {
    return "cancel";
  }

  const compressed = await params.runCompression();
  if (!compressed) {
    return "cancel";
  }

  const nextUsed = params.readContextUsedAfterCompression();
  if (typeof nextUsed === "number" && Number.isFinite(nextUsed) && nextUsed > 0) {
    if (nextUsed <= params.targetContextWindow) {
      return "proceed";
    }
  }

  params.notifyCompressionStillTooLarge();
  return "cancel";
}
```

- [ ] **Step 4: Run guard tests to verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: PASS for resolver and guard runner tests.

- [ ] **Step 5: Commit guard runner**

```bash
git add packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts packages/ui/test/modelSwitchContextWindowGuard.test.ts
git commit -m "test: add model switch context guard runner"
```

---

### Task 3: Expose a Promise-Based Compact Callback

**Files:**
- Modify: `packages/ui/src/hooks/useChatComposer.ts`
- Modify: `packages/ui/src/ChatView.tsx`
- Modify: `packages/ui/src/ChatView/ChatViewComposer.tsx`
- Modify: `packages/ui/src/ChatInputToolbar.tsx`
- Modify: `packages/ui/src/chat-input-toolbar/modelChangeActions.ts`

- [ ] **Step 1: Write the failing type-oriented callback test**

Append this compile-time usage test to `packages/ui/test/modelSwitchContextWindowGuard.test.ts`:

```ts
import type { ToolbarModelChangeDependencies } from "@/chat-input-toolbar/modelChangeActions.js";

describe("ToolbarModelChangeDependencies compression callback", () => {
  it("accepts a promise-returning compression callback for model switch guard", async () => {
    const deps = {
      onRequestContextCompressionForModelSwitch: async () => true,
    } satisfies Partial<ToolbarModelChangeDependencies>;

    await expect(deps.onRequestContextCompressionForModelSwitch?.()).resolves.toBe(true);
  });
});
```

- [ ] **Step 2: Run callback type test to verify RED**

Run:

```bash
pnpm typecheck
```

Expected: FAIL because `onRequestContextCompressionForModelSwitch` is not part of `ToolbarModelChangeDependencies`.

- [ ] **Step 3: Extend model change dependencies**

Modify `packages/ui/src/chat-input-toolbar/modelChangeActions.ts` inside `ToolbarModelChangeDependencies`:

```ts
  onRequestContextCompressionForModelSwitch?: () => Promise<boolean>;
```

- [ ] **Step 4: Expose callback from composer hook**

In `packages/ui/src/hooks/useChatComposer.ts`, add beside `handleSendContextCompressionCommand`:

```ts
  const handleRequestContextCompressionForModelSwitch = useCallback(async () => {
    // 修复原因：模型切换 guard 的压缩必须复用现有 `/compact` 控制命令路径，
    // 才能保留 timeline 横条、desktop continuous 与手机 replayable 路由语义。
    return sendPrompt("/compact", []);
  }, [sendPrompt]);
```

Return it from the hook result near `handleSendContextCompressionCommand`:

```ts
    handleRequestContextCompressionForModelSwitch,
```

- [ ] **Step 5: Thread callback through ChatView and composer**

In `packages/ui/src/ChatView.tsx`, destructure the new callback from `useChatViewComposerBridge`:

```ts
    handleRequestContextCompressionForModelSwitch,
```

Pass it into `ChatViewComposer`:

```tsx
            handleRequestContextCompressionForModelSwitch={
              handleRequestContextCompressionForModelSwitch
            }
```

In `packages/ui/src/ChatView/ChatViewComposer.tsx`, add the prop to destructuring and type:

```ts
  handleRequestContextCompressionForModelSwitch,
```

```ts
  handleRequestContextCompressionForModelSwitch: () => Promise<boolean>;
```

Pass it to `ChatInputToolbar`:

```tsx
          onRequestContextCompressionForModelSwitch={
            handleRequestContextCompressionForModelSwitch
          }
```

In `packages/ui/src/ChatInputToolbar.tsx`, add the prop type:

```ts
  onRequestContextCompressionForModelSwitch?: () => Promise<boolean>;
```

Destructure it and pass it into `useToolbarModelChange`:

```ts
    onRequestContextCompressionForModelSwitch,
```

- [ ] **Step 6: Run callback test to verify GREEN**

Run:

```bash
pnpm typecheck
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: both commands PASS.

- [ ] **Step 7: Commit callback plumbing**

```bash
git add packages/ui/src/hooks/useChatComposer.ts packages/ui/src/ChatView.tsx packages/ui/src/ChatView/ChatViewComposer.tsx packages/ui/src/ChatInputToolbar.tsx packages/ui/src/chat-input-toolbar/modelChangeActions.ts packages/ui/test/modelSwitchContextWindowGuard.test.ts
git commit -m "feat: expose compact callback for guarded model switch"
```

---

### Task 4: Add UI Messages and Warning Dialog Styling

**Files:**
- Modify: `packages/ui/src/components/ui/button.tsx`
- Modify: `packages/ui/src/ConfirmDialog.tsx`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`

- [ ] **Step 1: Add failing i18n key test**

Append to `packages/ui/test/modelSwitchContextWindowGuard.test.ts`:

```ts
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

describe("model switch context window guard i18n", () => {
  it("defines localized dialog and toast messages", () => {
    for (const messages of [zhCN, enUS]) {
      expect(messages["chat.modelSwitch.contextWindowGuard.title"]).toBeTruthy();
      expect(messages["chat.modelSwitch.contextWindowGuard.description"]).toContain("{used}");
      expect(messages["chat.modelSwitch.contextWindowGuard.compress"]).toBeTruthy();
      expect(messages["chat.modelSwitch.contextWindowGuard.runningBlocked"]).toBeTruthy();
      expect(messages["chat.modelSwitch.contextWindowGuard.stillTooLarge"]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run i18n test to verify RED**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: FAIL because the new i18n keys are missing.

- [ ] **Step 3: Add warning button variant**

In `packages/ui/src/components/ui/button.tsx`, add this `variant` entry:

```ts
        warning:
          "bg-warning text-warning-foreground hover:bg-warning/90 focus-visible:border-warning/40 focus-visible:ring-warning/20 aria-expanded:bg-warning aria-expanded:text-warning-foreground",
```

- [ ] **Step 4: Use warning variant in ConfirmDialogHost**

In `packages/ui/src/ConfirmDialog.tsx`, add:

```ts
  const confirmVariant =
    variant === "danger" ? "destructive" : variant === "warning" ? "warning" : "default";
```

Replace the confirm button variant:

```tsx
            variant={confirmVariant}
```

Replace the keyboard hint color branch with:

```tsx
                variant === "danger" || variant === "warning"
                  ? "text-foreground-subtle"
                  : "text-primary-foreground/60",
```

- [ ] **Step 5: Add localized messages**

In `packages/ui/src/i18n/locales/zh-CN.ts`, add near the existing `chat.toolbar.modelSwitch.*` keys:

```ts
  "chat.modelSwitch.contextWindowGuard.title": "需要压缩上下文后再切换模型",
  "chat.modelSwitch.contextWindowGuard.description":
    "当前会话已使用 {used} tokens，上下文窗口已超过目标模型 {modelName} 的 {target} tokens。\n请先使用当前模型压缩上下文。压缩完成且上下文用量小于目标模型窗口后，会继续切换模型。",
  "chat.modelSwitch.contextWindowGuard.compress": "压缩",
  "chat.modelSwitch.contextWindowGuard.runningBlocked":
    "目标模型的上下文窗口小于当前会话已使用的上下文，需要先压缩当前会话后才能切换。但当前任务正在运行，无法执行上下文压缩。请等待任务结束后再切换模型。",
  "chat.modelSwitch.contextWindowGuard.stillTooLarge":
    "压缩完成后，当前会话已使用的上下文仍大于目标模型的上下文窗口，模型切换已取消。",
```

In `packages/ui/src/i18n/locales/en-US.ts`, add:

```ts
  "chat.modelSwitch.contextWindowGuard.title": "Compress context before switching models",
  "chat.modelSwitch.contextWindowGuard.description":
    "This conversation has used {used} tokens, which exceeds {modelName}'s context window of {target} tokens.\nCompress the current conversation with the current model first. If the compressed context fits, ZCode will continue switching models.",
  "chat.modelSwitch.contextWindowGuard.compress": "Compress",
  "chat.modelSwitch.contextWindowGuard.runningBlocked":
    "The target model's context window is smaller than the context already used by this conversation. The conversation must be compressed before switching models, but the current task is still running and context compression cannot run now. Wait for the task to finish, then switch models again.",
  "chat.modelSwitch.contextWindowGuard.stillTooLarge":
    "After compression, the context used by this conversation is still larger than the target model's context window. Model switching was canceled.",
```

- [ ] **Step 6: Run i18n test to verify GREEN**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit UI message support**

```bash
git add packages/ui/src/components/ui/button.tsx packages/ui/src/ConfirmDialog.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/test/modelSwitchContextWindowGuard.test.ts
git commit -m "feat(ui): add model switch context guard messages"
```

---

### Task 5: Wire Guard into Model Selection

**Files:**
- Modify: `packages/ui/src/chat-input-toolbar/useToolbarModelChange.ts`

- [ ] **Step 1: Add failing integration-oriented guard test**

Append to `packages/ui/test/modelSwitchContextWindowGuard.test.ts`:

```ts
import { runModelSwitchContextWindowGuard } from "@/chat-input-toolbar/modelSwitchContextWindowGuard.js";

describe("model switch guard integration contract", () => {
  it("requires a compression callback before a guarded switch can proceed", async () => {
    await expect(
      runModelSwitchContextWindowGuard({
        confirmCompression: vi.fn().mockResolvedValue(true),
        currentUsed: 250_000,
        isTaskBusy: false,
        notifyCompressionStillTooLarge: vi.fn(),
        notifyRunningBlocked: vi.fn(),
        readContextUsedAfterCompression: vi.fn(() => 100_000),
        runCompression: vi.fn().mockResolvedValue(false),
        targetContextWindow: 200_000,
      }),
    ).resolves.toBe("cancel");
  });
});
```

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts
```

Expected: PASS already, because Task 2 implemented this contract. This is an intentional characterization test before wiring.

- [ ] **Step 2: Extract the existing branch dispatch into a local helper**

In `packages/ui/src/chat-input-toolbar/useToolbarModelChange.ts`, inside the returned callback create this local function before any guard awaits:

```ts
      const runExistingModelSelection = () => {
        if (
          shouldSwitchNativeModelFromCustomSelection(
            selectedProvider,
            option,
            value,
            selectedSupplierKey,
          )
        ) {
          handleNativeModelSelection(
            params,
            option,
            value,
            nextModelLabel,
            modelChangeNotice,
          );
          return;
        }
        if (decodeCustomModelValue(value)) {
          handleCustomProviderSelection(
            params,
            option,
            value,
            nextModelLabel,
            modelChangeNotice,
          );
          return;
        }
        handleLocalOrTaskSelection(
          params,
          option,
          value,
          nextModelLabel,
          modelChangeNotice,
        );
      };
```

Replace the existing duplicated branch calls at the end of the callback with:

```ts
      runExistingModelSelection();
```

- [ ] **Step 3: Import guard dependencies**

At the top of `useToolbarModelChange.ts`, add:

```ts
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isTaskRuntimeBusy } from "@/lib/zcodeTaskRuntimeMonitorTypes.js";
import { getTaskRuntimeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  resolveTargetModelContextWindow,
  runModelSwitchContextWindowGuard,
} from "./modelSwitchContextWindowGuard.js";
```

Remove the existing duplicate `useZCodeSessionStore` import line if needed so the file imports it only once.

- [ ] **Step 4: Initialize dialog and formatter hooks**

Inside `useToolbarModelChange`, before the returned `useCallback`, add:

```ts
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const numberFormatter = new Intl.NumberFormat(locale);
```

- [ ] **Step 5: Run the guard before existing selection dispatch**

Inside the returned callback, after `modelChangeNotice` and `runExistingModelSelection` are available, add:

```ts
      const targetContext = resolveTargetModelContextWindow({
        modelProviders,
        option,
        selectedProvider,
        value,
      });

      if (params.taskId && targetContext) {
        const workspaceState = useZCodeSessionStore
          .getState()
          .getWorkspaceState(params.workspacePath, params.workspaceIdentity);
        const taskRuntime = getTaskRuntimeState(workspaceState, params.taskId);
        const currentUsed = taskRuntime.usage?.used;
        if (
          typeof currentUsed === "number" &&
          Number.isFinite(currentUsed) &&
          currentUsed > 0 &&
          currentUsed > targetContext.contextWindow
        ) {
          void (async () => {
            const decision = await runModelSwitchContextWindowGuard({
              confirmCompression: () =>
                confirmDialog({
                  title: intl.formatMessage({
                    id: "chat.modelSwitch.contextWindowGuard.title",
                  }),
                  description: intl.formatMessage(
                    { id: "chat.modelSwitch.contextWindowGuard.description" },
                    {
                      modelName: nextModelLabel?.trim() || targetContext.modelId,
                      target: numberFormatter.format(targetContext.contextWindow),
                      used: numberFormatter.format(currentUsed),
                    },
                  ),
                  confirmLabel: intl.formatMessage({
                    id: "chat.modelSwitch.contextWindowGuard.compress",
                  }),
                  cancelLabel: intl.formatMessage({ id: "common.cancel" }),
                  variant: "warning",
                }),
              currentUsed,
              isTaskBusy: isTaskRuntimeBusy(taskRuntime.status),
              notifyCompressionStillTooLarge: () => {
                toast(
                  intl.formatMessage({
                    id: "chat.modelSwitch.contextWindowGuard.stillTooLarge",
                  }),
                );
              },
              notifyRunningBlocked: () => {
                toast(
                  intl.formatMessage({
                    id: "chat.modelSwitch.contextWindowGuard.runningBlocked",
                  }),
                );
              },
              readContextUsedAfterCompression: () => {
                const latestWorkspaceState = useZCodeSessionStore
                  .getState()
                  .getWorkspaceState(params.workspacePath, params.workspaceIdentity);
                const latestUsage = getTaskRuntimeState(
                  latestWorkspaceState,
                  params.taskId!,
                ).usage;
                return typeof latestUsage?.used === "number" &&
                  Number.isFinite(latestUsage.used) &&
                  latestUsage.used > 0
                  ? latestUsage.used
                  : null;
              },
              runCompression: async () =>
                params.onRequestContextCompressionForModelSwitch?.() ?? false,
              targetContextWindow: targetContext.contextWindow,
            });
            if (decision === "proceed") {
              runExistingModelSelection();
            }
          })();
          return;
        }
      }
```

Keep the existing final `runExistingModelSelection();` for non-guarded cases.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts packages/ui/test/modelChangeActions.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit guard wiring**

```bash
git add packages/ui/src/chat-input-toolbar/useToolbarModelChange.ts packages/ui/test/modelSwitchContextWindowGuard.test.ts
git commit -m "feat(ui): guard model switch by context window"
```

---

### Task 6: Full Verification

**Files:**
- No production files expected unless verification exposes a bug.

- [ ] **Step 1: Run focused UI tests**

Run:

```bash
pnpm exec vitest run packages/ui/test/modelSwitchContextWindowGuard.test.ts packages/ui/test/modelChangeActions.test.ts packages/ui/test/chatInputToolbarModelGroups.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run required typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run required lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- packages/ui/src/chat-input-toolbar/modelSwitchContextWindowGuard.ts packages/ui/src/chat-input-toolbar/useToolbarModelChange.ts packages/ui/src/hooks/useChatComposer.ts packages/ui/src/ChatInputToolbar.tsx packages/ui/src/ChatView.tsx packages/ui/src/ChatView/ChatViewComposer.tsx
```

Expected: Diff is limited to the context-window guard, callback plumbing, dialog style, i18n, and tests.

- [ ] **Step 5: Commit verification fixes if any**

If verification required fixes, commit them:

```bash
git add <fixed-files>
git commit -m "fix(ui): stabilize model switch context guard"
```

If no fixes were required, do not create an empty commit.
