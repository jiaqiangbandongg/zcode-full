# GLM-5.2 Reasoning Depth Implementation Plan

> **历史计划，禁止执行**：该计划依赖的 `reasoning-policy.ts`、`default-policy.ts`、按
> modelId 匹配和 `providerOptionsByLevel` Runtime 投影已在 Provider Refactor Todo 02 中删除。
> 当前行为必须由 Built-in Model Config Rules 显式配置，详见
> [Todo 02](../../../../../../docs/working-memory/provider-refactor/steps/todo-02-ai-sdk-execution-registry-retirement.md)。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give GLM-5.2 three selectable reasoning depths (`max` / `high` / `nothink`, default `max`) that map to GLM chat-template kwargs on the OpenAI-compatible transport and to native Anthropic thinking controls on the Anthropic-compatible transport.

**Architecture:** Two reasoning factories in `reasoning-policy.ts` (one per transport), wired into the two existing capability-resolution seams — `default-policy.ts` (model-id match, OpenAI-compatible) and `config/schema.ts` (transport-kind aware, Anthropic). This mirrors the existing DeepSeek-V4 dual-wiring precedent. No app/UI changes; the agent already renders levels in the 思考深度 selector and applies the selected level's provider options to the request body.

**Tech Stack:** TypeScript, Vitest, Vercel AI SDK (`@ai-sdk/openai-compatible`, `@ai-sdk/anthropic`).

**Spec:** `apps/zcode-cli/docs/design/v2/model/glm-5.2-reasoning-depth.md`

---

## File Structure

- **Modify** `apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts` — add GLM-5.2 level constants and two factory pairs (`createGlm52Reasoning` + options, `createGlm52AnthropicReasoning` + options).
- **Modify** `apps/zcode-cli/packages/adapters/src/model/default-policy.ts` — import `createGlm52Reasoning`, add `isGlm52ModelId` helper, insert a policy entry after `glm-thinking-toggle`.
- **Modify** `apps/zcode-cli/packages/adapters/src/config/schema.ts` — import `createGlm52AnthropicReasoning`, add `isGlm52ConfiguredModelId` helper, add an Anthropic-branch case before the generic thinking-toggle case.
- **Modify** `apps/zcode-cli/packages/adapters/tests/model-default-policy.test.ts` — OpenAI-compatible default tests.
- **Modify** `apps/zcode-cli/packages/adapters/tests/config.test.ts` — Anthropic configured-model test.

All commands assume CWD `apps/zcode-cli/packages/adapters` unless noted. Note: `default-policy.ts` re-exports everything from `reasoning-policy.ts` via `export * from "./reasoning-policy.js"`, so `config/schema.ts` imports the new Anthropic factory from `../model/default-policy.js` (its existing import source).

---

## Task 1: GLM-5.2 reasoning factories (OpenAI-compatible + Anthropic)

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-default-policy.test.ts`

- [ ] **Step 1: Write the failing test** for the OpenAI-compatible factory.

Add to `tests/model-default-policy.test.ts` (top-level, after the existing `const` reasoning fixtures near the file head):

```ts
import {
  ONE_MILLION_CONTEXT_WINDOW,
  applyModelCapabilityDefaults,
  createGlm52Reasoning,
  createGlm52AnthropicReasoning,
} from "../src/model/default-policy.js";

const glm52OpenAiReasoning = {
  defaultLevel: "max",
  enabled: true,
  levels: ["max", "high", "nothink"],
  providerOptionsByLevel: {
    max: { openaiCompatible: { extra_body: { chat_template_kwargs: { reasoning_effort: "max" } } } },
    high: { openaiCompatible: { extra_body: { chat_template_kwargs: { reasoning_effort: "high" } } } },
    nothink: { openaiCompatible: { extra_body: { chat_template_kwargs: { enable_thinking: false } } } },
  },
};

const glm52AnthropicReasoning = {
  defaultLevel: "max",
  enabled: true,
  levels: ["max", "high", "nothink"],
  providerOptionsByLevel: {
    max: { anthropic: { effort: "max", thinking: { budgetTokens: 32_000, type: "enabled" } } },
    high: { anthropic: { effort: "high", thinking: { budgetTokens: 16_000, type: "enabled" } } },
    nothink: { anthropic: { thinking: { type: "disabled" } } },
  },
};
```

Then add this test inside `describe("model default policy", ...)`:

```ts
it("builds GLM-5.2 reasoning factories for both transports", () => {
  expect(createGlm52Reasoning()).toEqual(glm52OpenAiReasoning);
  expect(createGlm52AnthropicReasoning()).toEqual(glm52AnthropicReasoning);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/model-default-policy.test.ts -t "GLM-5.2 reasoning factories"`
Expected: FAIL — `createGlm52Reasoning is not a function` (export missing).

- [ ] **Step 3: Implement the factories** in `reasoning-policy.ts`.

Append after the existing DeepSeek factories (anywhere among the `export function create*` block; place near the other GLM/thinking factories):

```ts
export const GLM_5_2_MAX_LEVEL = "max";
export const GLM_5_2_HIGH_LEVEL = "high";
export const GLM_5_2_NOTHINK_LEVEL = "nothink";
export const GLM_5_2_REASONING_LEVELS = [
  GLM_5_2_MAX_LEVEL,
  GLM_5_2_HIGH_LEVEL,
  GLM_5_2_NOTHINK_LEVEL,
];
export const GLM_5_2_REASONING_DEFAULT_LEVEL = GLM_5_2_MAX_LEVEL;

const GLM_5_2_ANTHROPIC_BUDGET_TOKENS_BY_LEVEL: Record<string, number> = {
  [GLM_5_2_MAX_LEVEL]: 32_000,
  [GLM_5_2_HIGH_LEVEL]: 16_000,
};

export function createGlm52Reasoning(): NonNullable<ModelCapability["reasoning"]> {
  return {
    defaultLevel: GLM_5_2_REASONING_DEFAULT_LEVEL,
    enabled: true,
    levels: [...GLM_5_2_REASONING_LEVELS],
    providerOptionsByLevel: createGlm52ReasoningProviderOptions(),
  };
}

export function createGlm52AnthropicReasoning(): NonNullable<ModelCapability["reasoning"]> {
  return {
    defaultLevel: GLM_5_2_REASONING_DEFAULT_LEVEL,
    enabled: true,
    levels: [...GLM_5_2_REASONING_LEVELS],
    providerOptionsByLevel: createGlm52AnthropicReasoningProviderOptions(),
  };
}

export function createGlm52ReasoningProviderOptions(): Record<string, Record<string, unknown>> {
  return {
    [GLM_5_2_MAX_LEVEL]: {
      openaiCompatible: { extra_body: { chat_template_kwargs: { reasoning_effort: "max" } } },
    },
    [GLM_5_2_HIGH_LEVEL]: {
      openaiCompatible: { extra_body: { chat_template_kwargs: { reasoning_effort: "high" } } },
    },
    [GLM_5_2_NOTHINK_LEVEL]: {
      openaiCompatible: { extra_body: { chat_template_kwargs: { enable_thinking: false } } },
    },
  };
}

export function createGlm52AnthropicReasoningProviderOptions(): Record<
  string,
  Record<string, unknown>
> {
  return {
    [GLM_5_2_MAX_LEVEL]: {
      anthropic: {
        effort: GLM_5_2_MAX_LEVEL,
        thinking: {
          budgetTokens: GLM_5_2_ANTHROPIC_BUDGET_TOKENS_BY_LEVEL[GLM_5_2_MAX_LEVEL],
          type: "enabled",
        },
      },
    },
    [GLM_5_2_HIGH_LEVEL]: {
      anthropic: {
        effort: GLM_5_2_HIGH_LEVEL,
        thinking: {
          budgetTokens: GLM_5_2_ANTHROPIC_BUDGET_TOKENS_BY_LEVEL[GLM_5_2_HIGH_LEVEL],
          type: "enabled",
        },
      },
    },
    [GLM_5_2_NOTHINK_LEVEL]: {
      anthropic: {
        thinking: { type: "disabled" },
      },
    },
  };
}
```

`ModelCapability` is already imported at the top of `reasoning-policy.ts` (`import type { ModelCapability } from "@zcode/contracts";`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/model-default-policy.test.ts -t "GLM-5.2 reasoning factories"`
Expected: PASS.

- [ ] **Step 5: Commit** (shared worktree — commit only these files by pathspec, `-m` before `--`)

```bash
git commit -m "feat(model): add GLM-5.2 reasoning depth factories" -- \
  apps/zcode-cli/packages/adapters/src/model/reasoning-policy.ts \
  apps/zcode-cli/packages/adapters/tests/model-default-policy.test.ts
```

---

## Task 2: Wire OpenAI-compatible default policy for GLM-5.2

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/model/default-policy.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/model-default-policy.test.ts`

- [ ] **Step 1: Write the failing tests** — GLM-5.2 synthesizes the three levels via the catalog, prefix variants match, and other GLM models keep the toggle.

Add inside `describe("model default policy", ...)`:

```ts
const glmThinkingToggleReasoning = {
  defaultLevel: "enabled",
  enabled: true,
  levels: ["enabled", "disabled"],
  providerOptionsByLevel: {
    enabled: { openaiCompatible: { extra_body: { thinking: { type: "enabled" } } } },
    disabled: { openaiCompatible: { extra_body: { thinking: { type: "disabled" } } } },
  },
};

it("synthesizes three reasoning depths for GLM-5.2 model ids", () => {
  const service = new ModelCatalogService({ overrides: {} });
  service.initialize();
  expect(service.getCapability("zai", "glm-5.2")?.reasoning).toEqual(glm52OpenAiReasoning);
  expect(service.getCapability("zai", "glm-5.2-pro")?.reasoning).toEqual(glm52OpenAiReasoning);
  expect(service.getCapability("zai", "GLM-5.2")?.reasoning).toEqual(glm52OpenAiReasoning);
  expect(service.getCapability("default-zai", "zai/glm-5.2")?.reasoning).toEqual(
    glm52OpenAiReasoning,
  );
});

it("keeps non-5.2 GLM models on the thinking toggle policy", () => {
  const service = new ModelCatalogService({ overrides: {} });
  service.initialize();
  expect(service.getCapability("zai", "glm-4.6")?.reasoning).toEqual(glmThinkingToggleReasoning);
  expect(service.getCapability("zai", "glm-5.1")?.reasoning).toEqual(glmThinkingToggleReasoning);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/model-default-policy.test.ts -t "GLM-5.2 model ids"`
Expected: FAIL — GLM-5.2 currently resolves to `glmThinkingToggleReasoning`, not the three-level set.

- [ ] **Step 3: Implement the policy wiring** in `default-policy.ts`.

3a. Add `createGlm52Reasoning` to the import block from `"./reasoning-policy.js"` (keep alphabetical grouping with the other `create*` imports):

```ts
  createDeepSeekV4Reasoning,
  createGlm52Reasoning,
  createOpenAiCompatibleReasoningDepthReasoning,
```

3b. Insert a new policy entry into `modelDefaultPolicies` **immediately after** the `glm-thinking-toggle` entry (so the ordered `Object.assign` lets GLM-5.2 override the toggle for matching ids):

```ts
  {
    defaults: {
      replaceReasoning: true,
      reasoning: createGlm52Reasoning(),
      supportsReasoning: true,
    },
    id: "glm-5.2-reasoning-depth",
    matches: ({ modelId }) => isGlm52ModelId(modelId),
  },
```

3c. Add the helper near the other `is*ModelId` helpers at the bottom of the file (reuses the existing `modelIdCandidates`, which lowercases and also yields the last `/`-separated segment):

```ts
function isGlm52ModelId(modelId: string): boolean {
  return modelIdCandidates(modelId).some((candidate) => candidate.startsWith("glm-5.2"));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/model-default-policy.test.ts -t "GLM-5.2 model ids|thinking toggle policy"`
Expected: PASS (both new tests).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(model): route GLM-5.2 to reasoning-depth default policy" -- \
  apps/zcode-cli/packages/adapters/src/model/default-policy.ts \
  apps/zcode-cli/packages/adapters/tests/model-default-policy.test.ts
```

---

## Task 3: Wire Anthropic-transport reasoning for configured GLM-5.2

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/config/schema.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/config.test.ts`

- [ ] **Step 1: Write the failing test** — a configured Anthropic-kind GLM-5.2 model with no explicit reasoning resolves to the Anthropic option set; `nothink` is native thinking-disabled.

Add this test inside the top-level `describe` in `tests/config.test.ts` (it uses the same `loadFileConfig` + temp-dir pattern as the existing provider config loading tests):

```ts
it("defaults configured Anthropic GLM-5.2 to reasoning depth with native thinking", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-"));
  const path = join(dir, "config.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        $schema: "https://zcode.ai/schema/config-v2.json",
        provider: {
          "provider-auth-zai": {
            kind: "anthropic",
            name: "Z.AI",
            options: {
              baseURL: "https://open.bigmodel.cn/api/anthropic",
              apiKey: "secret",
            },
            models: {
              "glm-5.2": { name: "GLM-5.2" },
            },
          },
        },
        model: { main: "provider-auth-zai/glm-5.2" },
      }),
    );

    const result = loadFileConfig(path);

    expect(result.loaded).toBe(true);
    expect(
      result.config.modelCatalog?.overrides?.["provider-auth-zai/glm-5.2"]?.reasoning,
    ).toEqual({
      defaultLevel: "max",
      enabled: true,
      levels: ["max", "high", "nothink"],
      providerOptionsByLevel: {
        max: { anthropic: { effort: "max", thinking: { budgetTokens: 32_000, type: "enabled" } } },
        high: { anthropic: { effort: "high", thinking: { budgetTokens: 16_000, type: "enabled" } } },
        nothink: { anthropic: { thinking: { type: "disabled" } } },
      },
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
```

(`mkdtemp`, `writeFile`, `rm`, `join`, `tmpdir`, `loadFileConfig` are already imported in this test file — confirm at the top and reuse; do not re-import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "Anthropic GLM-5.2"`
Expected: FAIL — without the new branch, the Anthropic GLM-5.2 falls through to `createAnthropicThinkingToggleReasoning()` (enabled/disabled), not the three-level set.

- [ ] **Step 3: Implement the Anthropic-branch wiring** in `config/schema.ts`.

3a. Add `createGlm52AnthropicReasoning` to the existing import block from `"../model/default-policy.js"`:

```ts
import {
  DEEPSEEK_V4_MODEL_PREFIX,
  createDeepSeekV4AnthropicReasoning,
  createAnthropicThinkingToggleReasoning,
  createGlm52AnthropicReasoning,
  createOpenAiCompatibleThinkingToggleReasoning,
  resolveModelCapabilityDefaults,
} from "../model/default-policy.js";
```

3b. In `createConfiguredModelDefaultReasoning`, inside the `if (kind === "anthropic")` block, add the GLM-5.2 case **after** the DeepSeek-V4 case and **before** the thinking-toggle case:

```ts
  if (kind === "anthropic") {
    if (isDeepSeekV4ConfiguredModelId(modelId)) return createDeepSeekV4AnthropicReasoning();
    if (isGlm52ConfiguredModelId(modelId)) return createGlm52AnthropicReasoning();
    if (isThinkingToggleConfiguredModelId(modelId)) return createAnthropicThinkingToggleReasoning();
    // Bugfix: model-id defaults can be transport-specific. Reusing an
    // openaiCompatible default for an Anthropic-compatible configured model
    // makes the UI show thinking enabled while the final request has no
    // Anthropic thinking field.
    if (usesAnthropicProviderOptions(defaults.reasoning)) return defaults.reasoning;
    return createAnthropicThinkingToggleReasoning();
  }
```

3c. Add the helper next to `isDeepSeekV4ConfiguredModelId` / `isThinkingToggleConfiguredModelId`:

```ts
function isGlm52ConfiguredModelId(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("glm-5.2");
}
```

> Note: the OpenAI-compatible configured path needs no change — its branch returns `defaults.reasoning`, which for GLM-5.2 is already `createGlm52Reasoning()` from Task 2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts -t "Anthropic GLM-5.2"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(model): map configured Anthropic GLM-5.2 to reasoning depth" -- \
  apps/zcode-cli/packages/adapters/src/config/schema.ts \
  apps/zcode-cli/packages/adapters/tests/config.test.ts
```

---

## Task 4: Full verification + spec trail

**Files:**
- Already created: `apps/zcode-cli/docs/design/v2/model/glm-5.2-reasoning-depth.md`

- [ ] **Step 1: Run the adapters package test suite**

Run (from `apps/zcode-cli/packages/adapters`): `npx vitest run`
Expected: PASS, including the three new tests, with no regressions in `model-default-policy.test.ts` / `config.test.ts`.

- [ ] **Step 2: Run lint + the full test command** per the project CLAUDE.md

Run (from `apps/zcode-cli`): `npm run lint && npm test`
Expected: PASS.

- [ ] **Step 3 (optional but recommended): Confirm the real request body** for both transports.

Mirror an existing runner/model-IO debug test (`packages/adapters/tests/runner.test.ts`) or run the agent against a GLM-5.2 target with the model-IO debug path enabled (`createGenerateTextOptions`/`createStreamTextOptions` pass `experimental_include.requestBody` when `includeModelIO` is true). Verify:
- OpenAI-compatible `max` → request body contains `chat_template_kwargs: { reasoning_effort: "max" }`.
- OpenAI-compatible `nothink` → `chat_template_kwargs: { enable_thinking: false }`.
- Anthropic `nothink` → `thinking: { type: "disabled" }` and no `chat_template_kwargs`.

If the GLM Anthropic endpoint ignores `effort` for `max` vs `high`, adjust only `GLM_5_2_ANTHROPIC_BUDGET_TOKENS_BY_LEVEL` and/or drop `effort` in `createGlm52AnthropicReasoningProviderOptions` — the level/value contract and tests stay the same.

- [ ] **Step 4: Commit the spec** (if not already committed)

```bash
git commit -m "docs(model): add GLM-5.2 reasoning depth spec" -- \
  apps/zcode-cli/docs/design/v2/model/glm-5.2-reasoning-depth.md \
  apps/zcode-cli/docs/design/v2/model/glm-5.2-reasoning-depth-plan.md
```

---

## Notes for the implementer

- **Level labels:** No i18n work. `session-mapper.ts` maps each level string to `{ value, label }` verbatim, so the selector shows `max` / `high` / `nothink`, consistent with existing levels.
- **Round-trip:** `resolveRuntimeThoughtLevel` reverse-maps active provider options to a level by deep equality. The three option objects are mutually distinct per transport, so selection round-trips.
- **Ordering matters twice:** GLM-5.2 must come *after* `glm-thinking-toggle` in `default-policy.ts` (Object.assign override), and *before* `isThinkingToggleConfiguredModelId` in `config/schema.ts` (first-match-wins return).
