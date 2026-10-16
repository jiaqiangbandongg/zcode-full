# zcode-cli 默认思考强度族补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zcode-cli 在 dynamic provider model 缺少 reasoning metadata 时，为 Qwen、Kimi、MiMo 补默认思考强度能力。

**Architecture:** 只修改 zcode-cli bootstrap 的 workspace model catalog overlay。默认 reasoning 仍由 agent catalog override 承载，App/UI 不参与本次推断。

**Tech Stack:** TypeScript, Vitest, zcode protocol dynamic provider catalog overlay.

## Global Constraints

- 新增功能必须先留 spec 到 `docs`。
- 不修改 `packages/ui`。
- import 路径保持现有绝对包路径风格。
- 修改完成后执行 `pnpm typecheck` 和 `pnpm lint`。
- 完成后提交 Conventional Commit。

---

### Task 1: Add failing dynamic provider default reasoning tests

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Interfaces:**
- Consumes: `workspaceUpsertModelProvider` protocol method.
- Produces: test expectations for `overlay.catalogOverrides[provider/model].reasoning`.

- [ ] **Step 1: Write the failing tests**

Add three tests near existing dynamic reasoning tests:

```ts
it("synthesizes Qwen enable_thinking defaults for dynamic providers without reasoning metadata", async () => {
  // Upsert qwen-alibaba-model-studio-cn/qwen3.5-plus without reasoning.
  // Expect enabled/disabled levels and providerOptionsByLevel using enable_thinking.
});

it("synthesizes Kimi thinking toggle defaults for dynamic providers without reasoning metadata", async () => {
  // Upsert moonshot-kimi/kimi-k2.6 without reasoning.
  // Expect enabled/disabled levels and openaiCompatible.extra_body.thinking.type.
});

it("synthesizes Anthropic MiMo thinking toggle defaults for dynamic providers without reasoning metadata", async () => {
  // Upsert xiaomi-mimo/mimo-v2.5-pro without reasoning using anthropic kind.
  // Expect enabled/disabled levels and anthropic.thinking.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zcode/bootstrap test -- tests/zcode-protocol.test.ts
```

Expected: new tests fail because catalog overrides do not contain reasoning for Qwen/Kimi/MiMo without metadata.

### Task 2: Implement zcode-cli default reasoning families

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`

**Interfaces:**
- Consumes: `ZCodeModelProviderConfig`, `ZCodeModelProviderModel`.
- Produces: `createDynamicProviderDefaultReasoning(provider, model)`.

- [ ] **Step 1: Update helper signature**

Change:

```ts
createDynamicProviderDefaultReasoning(provider.kind, model.modelId)
```

to:

```ts
createDynamicProviderDefaultReasoning(provider, model)
```

- [ ] **Step 2: Add Qwen default reasoning helper**

Add a helper that returns:

```ts
{
  defaultLevel: "enabled",
  enabled: true,
  levels: ["enabled", "disabled"],
  providerOptionsByLevel: {
    enabled: { openaiCompatible: { extra_body: { enable_thinking: true } } },
    disabled: { openaiCompatible: { extra_body: { enable_thinking: false } } },
  },
}
```

- [ ] **Step 3: Expand default inference**

For Anthropic providers, return Anthropic thinking toggle for `isCatalogThinkingToggleProtocolModel(provider, model)`.

For OpenAI-compatible providers, return Qwen `enable_thinking` defaults before the generic catalog thinking toggle branch. Return generic OpenAI-compatible thinking toggle for Kimi/MiMo/GLM/DeepSeek non-V4.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @zcode/bootstrap test -- tests/zcode-protocol.test.ts
```

Expected: all `zcode-protocol.test.ts` tests pass.

### Task 3: Verify repository constraints and commit

**Files:**
- Existing changed files only.

**Interfaces:**
- Produces: committed working tree.

- [ ] **Step 1: Run required checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands pass.

- [ ] **Step 2: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-06-29-zcode-cli-default-reasoning-families-design.md docs/superpowers/plans/2026-06-29-zcode-cli-default-reasoning-families.md apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts
git commit -m "feat: infer dynamic provider reasoning defaults"
```
