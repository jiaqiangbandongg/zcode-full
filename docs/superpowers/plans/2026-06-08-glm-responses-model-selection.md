# GLM Responses Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Responses-only model providers in GLM chat model selection and Bot `/model` selection.

**Architecture:** Keep shared format semantics unchanged: `responses` maps to provider kind `openai`, while OpenAI-compatible Chat Completions stays `openai-compatible`. Update only the two selection filters that currently define GLM as `anthropic/openai` so they also accept `responses`.

**Tech Stack:** TypeScript, React UI model selection helpers, services Bot model selection helpers, Vitest, existing markdown docs.

---

### Task 1: Add Failing UI Selection Tests

**Files:**
- Modify: `packages/ui/test/chatInputToolbarModelGroups.test.ts`

- [ ] **Step 1: Add the failing regression test**

Add this test inside `describe("shouldIncludeModelProviderInSelection", ...)`, after the existing "ZCode Agent 下 custom provider 只配置 openai endpoint 时也展示" case:

```ts
  it("ZCode Agent 下 custom provider 只配置 responses endpoint 时也展示", () => {
    const provider = createModelProviderConfig({
      id: "provider-glm-custom-responses",
      endpoints: {
        baseURL: "https://example.com",
        paths: { openai: "/responses" },
      },
      apiFormat: "openai-responses",
      defaultKind: "openai",
      apiKey: "sk-glm-custom",
      models: ["glm-5"],
      modelSupportedFormats: {
        "glm-5": ["responses"],
      },
    });

    expect(getProviderModelsForSelection("glm", provider)).toEqual(["glm-5"]);
    expect(shouldIncludeModelProviderInSelection("glm", provider)).toBe(true);
  });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts -t "responses endpoint"
```

Expected: FAIL because GLM required formats and endpoint checks do not include `responses`.

### Task 2: Add Failing Bot Selection Tests

**Files:**
- Modify: `packages/services/test/botsModelSelectionHelpers.test.ts`

- [ ] **Step 1: Add the failing regression test**

Add this test after "GLM /model 入口允许只配置 openai endpoint 的供应商":

```ts
  it("GLM /model 入口允许只配置 responses endpoint 的供应商", () => {
    const provider = createModelProviderConfig({
      endpoints: {
        baseURL: "https://example.com",
        paths: { openai: "/responses" },
      },
      apiFormat: "openai-responses",
      defaultKind: "openai",
      apiKey: "sk-glm",
      models: ["glm-5"],
      modelSupportedFormats: {
        "glm-5": ["responses"],
      },
    });

    expect(getProviderModelsForSelection("glm", provider)).toEqual(["glm-5"]);
    expect(isModelProviderSelectableForZCodeProvider("glm", provider)).toBe(true);
  });
```

- [ ] **Step 2: Verify RED**

Run:

```bash
pnpm vitest run packages/services/test/botsModelSelectionHelpers.test.ts -t "responses endpoint"
```

Expected: FAIL because Bot GLM selection does not include `responses`.

### Task 3: Update GLM Selection Filters

**Files:**
- Modify: `packages/ui/src/chat-input-toolbar/modelSelection.ts`
- Modify: `packages/services/src/bots/modelSelectionHelpers.ts`

- [ ] **Step 1: Update chat model selection**

In `packages/ui/src/chat-input-toolbar/modelSelection.ts`, change the GLM required format return to:

```ts
    // Bugfix: GLM runtime supports Anthropic-compatible, OpenAI-compatible, and OpenAI Responses upstreams.
    // The chat model menu must expose Responses-only providers now that GLM Agent can send that protocol.
    return ["anthropic", "responses", "openai"];
```

Also change the GLM provider inclusion endpoint check to:

```ts
    return hasEndpointForSupportedFormats(provider, ["anthropic", "responses", "openai"]);
```

- [ ] **Step 2: Update Bot model selection**

In `packages/services/src/bots/modelSelectionHelpers.ts`, change the GLM required format return to:

```ts
    // Bugfix: GLM runtime supports Anthropic-compatible, OpenAI-compatible, and OpenAI Responses upstreams.
    // Bot /model selection must stay aligned with the chat model menu.
    return ["anthropic", "responses", "openai"];
```

Also change the GLM provider inclusion endpoint check to:

```ts
    return hasEndpointForFormat(provider, "anthropic") ||
      hasEndpointForFormat(provider, "responses") ||
      hasEndpointForFormat(provider, "openai");
```

- [ ] **Step 3: Verify GREEN**

Run:

```bash
pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts packages/services/test/botsModelSelectionHelpers.test.ts
```

Expected: PASS.

### Task 4: Document GLM Responses Selection

**Files:**
- Modify: `docs/ui/chat-model-select-menu.md`

- [ ] **Step 1: Add compatibility note**

Add this bullet under "兼容边界":

```md
- GLM/ZCode Agent 的自定义 provider 模型菜单按 Agent 当前可发送协议过滤，当前支持 Anthropic-compatible、OpenAI-compatible Chat Completions 和 OpenAI Responses；Bot `/model` 入口使用同一能力边界。
```

- [ ] **Step 2: Run required verification**

Run:

```bash
pnpm vitest run packages/ui/test/chatInputToolbarModelGroups.test.ts packages/services/test/botsModelSelectionHelpers.test.ts
pnpm typecheck
pnpm lint
```

Expected: all commands exit 0.

- [ ] **Step 3: Commit**

Run:

```bash
git status --short
git add docs/superpowers/specs/2026-06-08-glm-responses-model-selection-design.md docs/superpowers/plans/2026-06-08-glm-responses-model-selection.md docs/ui/chat-model-select-menu.md packages/ui/src/chat-input-toolbar/modelSelection.ts packages/ui/test/chatInputToolbarModelGroups.test.ts packages/services/src/bots/modelSelectionHelpers.ts packages/services/test/botsModelSelectionHelpers.test.ts
git commit -m "feat(model-provider): support glm responses selection"
```

Expected: commit succeeds.
