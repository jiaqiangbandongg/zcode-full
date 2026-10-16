# Bot State/Cache V2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Bot runtime state and model cache to `bot-state.v2.json` and `bots-model-cache.v2.json`, migrating old files read-only and using `config.json` provider data as the model cache authority.

**Architecture:** Keep file-name/version fallback in the repo layer, keep provider/model matching in pure migration helpers, and let `createBotsService` run one lazy storage migration before state/cache reads are trusted. Old files are never written by the new code path.

**Tech Stack:** TypeScript, Zod schemas, Vitest, existing `@zcode/shared` bot/model-provider types, service logger via `createServiceLogger`.

---

### Task 1: Add V2 File Names And Repo Metadata

**Files:**
- Modify: `packages/services/src/bots/config.ts`
- Modify: `packages/services/src/bots/repo.ts`
- Modify: `packages/services/src/bots/modelCacheRepo.ts`
- Test: `packages/services/test/botsRepo.test.ts`
- Test: `packages/services/test/botsModelCacheRepo.test.ts`

- [ ] **Step 1: Write failing repo tests**

Add `packages/services/test/botsRepo.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotsRepo } from "../src/bots/repo.js";
import { setDataBaseDir } from "../src/paths.js";

describe("BotsRepo", () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-bots-repo-"));
    setDataBaseDir(tempDir);
  });

  afterEach(() => {
    setDataBaseDir(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads legacy bot-state.json but writes bot-state.v2.json", async () => {
    const dataDir = join(tempDir!, ".zcode", "v2");
    writeFileSync(
      join(dataDir, "bot-state.json"),
      `${JSON.stringify({
        version: 2,
        bots: {
          "feishu-1": {
            botId: "feishu-1",
            workspacePath: "/tmp/workspace",
            mode: "draft",
            activeTaskId: null,
            draftOptions: {
              provider: "glm",
              model: "custom:old-provider:deepseek-v4-flash",
            },
            updatedAt: 1,
          },
        },
      })}\n`,
    );

    const repo = new BotsRepo();
    await expect(repo.readState()).resolves.toMatchObject({
      bots: {
        "feishu-1": {
          draftOptions: {
            model: "custom:old-provider:deepseek-v4-flash",
          },
        },
      },
    });

    await repo.writeState({ version: 2, bots: {} });

    expect(existsSync(join(dataDir, "bot-state.json"))).toBe(true);
    expect(existsSync(join(dataDir, "bot-state.v2.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "bot-state.json"), "utf-8"))).toMatchObject({
      bots: {
        "feishu-1": {
          draftOptions: {
            model: "custom:old-provider:deepseek-v4-flash",
          },
        },
      },
    });
  });
});
```

Extend `packages/services/test/botsModelCacheRepo.test.ts` with a failing test:

```ts
  it("reads legacy bots-model-cache.json but writes bots-model-cache.v2.json", async () => {
    const dataDir = join(tempDir!, ".zcode", "v2");
    writeFileSync(
      join(dataDir, "bots-model-cache.json"),
      `${JSON.stringify({
        version: 1,
        modelProviders: {
          updatedAt: 1,
          providers: [],
        },
        workspaceConfigOptions: {},
      })}\n`,
    );

    const repo = new BotsModelCacheRepo();
    await expect(repo.read()).resolves.toMatchObject({
      version: 2,
      source: {
        cacheUpdatedAt: 1,
      },
    });

    await repo.write({
      version: 2,
      updatedAt: 2,
      providers: [],
      workspaceConfigOptions: {},
    });

    expect(existsSync(join(dataDir, "bots-model-cache.json"))).toBe(true);
    expect(existsSync(join(dataDir, "bots-model-cache.v2.json"))).toBe(true);
  });
```

- [ ] **Step 2: Run tests to confirm failure**

Run:

```bash
pnpm vitest run packages/services/test/botsRepo.test.ts packages/services/test/botsModelCacheRepo.test.ts
```

Expected: tests fail because the repos still write old filenames and model cache version is still `1`.

- [ ] **Step 3: Implement v2 file constants and repo read/write**

Update `packages/services/src/bots/config.ts`:

```ts
export const BOTS_CONFIG_FILE = "bot-config.json";
export const BOTS_LEGACY_STATE_FILE = "bot-state.json";
export const BOTS_STATE_FILE = "bot-state.v2.json";
export const BOTS_LEGACY_MODEL_CACHE_FILE = "bots-model-cache.json";
export const BOTS_MODEL_CACHE_FILE = "bots-model-cache.v2.json";
```

Update `packages/services/src/bots/repo.ts` so `statePath()` points to `BOTS_STATE_FILE`, add `legacyStatePath()`, and make `readState()` parse v2 first, then legacy:

```ts
  private statePath(): string {
    return join(getAppConfigDir(), BOTS_STATE_FILE);
  }

  private legacyStatePath(): string {
    return join(getAppConfigDir(), BOTS_LEGACY_STATE_FILE);
  }

  async readState(): Promise<BotsStateFile> {
    const fallback: BotsStateFile = { version: 2, bots: {} };
    const raw = await readJsonFile<unknown>(this.statePath(), null);
    const parsed = botsStateFileSchema.safeParse(raw);
    if (parsed.success) {
      return parsed.data;
    }
    const legacyRaw = await readJsonFile<unknown>(this.legacyStatePath(), null);
    const legacyParsed = botsStateFileSchema.safeParse(legacyRaw);
    return legacyParsed.success ? legacyParsed.data : fallback;
  }
```

Update `packages/services/src/bots/modelCacheRepo.ts` with a v2 schema:

```ts
const BOTS_MODEL_CACHE_VERSION = 2;

const botsModelCacheFileSchema = z
  .object({
    version: z.literal(BOTS_MODEL_CACHE_VERSION),
    updatedAt: z.number(),
    migratedAt: z.number().optional(),
    source: z
      .object({
        cacheUpdatedAt: z.number().optional(),
      })
      .strict()
      .optional(),
    providers: modelProviderListSchema,
    workspaceConfigOptions: z
      .record(z.string(), botsModelCacheWorkspaceConfigOptionsSchema)
      .default({}),
    modelIdRemaps: z.record(z.string(), z.string()).optional(),
  })
  .strict();
```

Add a legacy schema that matches the current `version: 1` shape, normalize it to v2 in `read()`, and keep `write()` pointed only at `BOTS_MODEL_CACHE_FILE`.

- [ ] **Step 4: Run repo tests**

Run:

```bash
pnpm vitest run packages/services/test/botsRepo.test.ts packages/services/test/botsModelCacheRepo.test.ts
```

Expected: PASS.

### Task 2: Add Pure Provider/Model Migration Helpers

**Files:**
- Create: `packages/services/src/bots/storageMigration.ts`
- Test: `packages/services/test/botsStorageMigration.test.ts`

- [ ] **Step 1: Write failing migration tests**

Create `packages/services/test/botsStorageMigration.test.ts` with cases for direct match, provider-name remap, ambiguous match, and secret stripping:

```ts
import { describe, expect, it } from "vitest";
import { createModelProviderModelConfig, encodeCustomModelValue, type BotsStateFile, type ModelProviderConfig } from "@zcode/shared";
import { createDefaultBotsModelCache } from "../src/bots/modelCacheRepo.js";
import { migrateBotsModelCacheToV2, migrateBotsStateToV2 } from "../src/bots/storageMigration.js";

function provider(params: { id: string; name: string; models: string[]; apiKey?: string }): ModelProviderConfig {
  return {
    id: params.id,
    name: params.name,
    enabled: true,
    apiKey: params.apiKey ?? "",
    endpoints: {
      anthropic: "https://example.com/anthropic",
      openai: "",
      gemini: "",
    },
    models: params.models.map((id) => createModelProviderModelConfig({ id, kinds: ["anthropic"] })),
    createdAt: 1,
    updatedAt: 1,
  };
}

function stateWithModel(model: string): BotsStateFile {
  return {
    version: 2,
    bots: {
      "feishu-1": {
        botId: "feishu-1",
        workspacePath: "/tmp/workspace",
        mode: "draft",
        activeTaskId: null,
        draftOptions: {
          provider: "glm",
          model,
          mode: "yolo",
          thoughtLevel: "max",
        },
        updatedAt: 1,
      },
    },
  };
}

describe("bot storage migration", () => {
  it("keeps draft model when provider id and model still exist", () => {
    const providers = [provider({ id: "new-provider", name: "DeepSeek", models: ["deepseek-v4-flash"] })];

    expect(
      migrateBotsStateToV2({
        state: stateWithModel(encodeCustomModelValue("new-provider", "deepseek-v4-flash")),
        legacyCache: createDefaultBotsModelCache(),
        providers,
        nowMs: 2,
      }).bots["feishu-1"]?.draftOptions?.model,
    ).toBe(encodeCustomModelValue("new-provider", "deepseek-v4-flash"));
  });

  it("remaps draft model by legacy provider name and model id when unique", () => {
    const legacyCache = {
      ...createDefaultBotsModelCache(),
      providers: [provider({ id: "old-provider", name: "DeepSeek", models: ["deepseek-v4-flash"] })],
    };
    const providers = [provider({ id: "new-provider", name: "DeepSeek", models: ["deepseek-v4-flash"] })];

    expect(
      migrateBotsStateToV2({
        state: stateWithModel(encodeCustomModelValue("old-provider", "deepseek-v4-flash")),
        legacyCache,
        providers,
        nowMs: 2,
      }).bots["feishu-1"]?.draftOptions?.model,
    ).toBe(encodeCustomModelValue("new-provider", "deepseek-v4-flash"));
  });

  it("clears draft model when matching is ambiguous", () => {
    const providers = [
      provider({ id: "provider-a", name: "DeepSeek A", models: ["deepseek-v4-flash"] }),
      provider({ id: "provider-b", name: "DeepSeek B", models: ["deepseek-v4-flash"] }),
    ];

    expect(
      migrateBotsStateToV2({
        state: stateWithModel(encodeCustomModelValue("missing-provider", "deepseek-v4-flash")),
        legacyCache: createDefaultBotsModelCache(),
        providers,
        nowMs: 2,
      }).bots["feishu-1"]?.draftOptions?.model,
    ).toBeUndefined();
  });

  it("writes v2 model cache from authoritative providers without real api keys", () => {
    const result = migrateBotsModelCacheToV2({
      legacyCache: createDefaultBotsModelCache(),
      providers: [provider({ id: "new-provider", name: "DeepSeek", models: ["deepseek-v4-flash"], apiKey: "secret" })],
      nowMs: 2,
    });

    expect(result).toMatchObject({
      version: 2,
      updatedAt: 2,
      providers: [
        {
          id: "new-provider",
          apiKey: "__zcode_cached_api_key_present__",
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run tests to confirm failure**

Run:

```bash
pnpm vitest run packages/services/test/botsStorageMigration.test.ts
```

Expected: FAIL because `storageMigration.ts` does not exist.

- [ ] **Step 3: Implement migration helpers**

Create `packages/services/src/bots/storageMigration.ts` with:

```ts
import {
  decodeCustomModelValue,
  encodeCustomModelValue,
  normalizeAgentProviderToZCodeAgent,
  type BotsStateFile,
  type BotDraftOptions,
  type ModelProviderConfig,
} from "@zcode/shared";
import {
  type BotsModelCacheFile,
} from "./modelCacheRepo.js";

const BOT_MODEL_CACHE_API_KEY_PLACEHOLDER = "__zcode_cached_api_key_present__";

export function migrateBotsModelCacheToV2(params: {
  legacyCache: BotsModelCacheFile;
  providers: readonly ModelProviderConfig[];
  nowMs: number;
}): BotsModelCacheFile {
  return {
    version: 2,
    updatedAt: params.nowMs,
    migratedAt: params.nowMs,
    source: {
      cacheUpdatedAt: params.legacyCache.updatedAt,
    },
    providers: params.providers.map(sanitizeModelProviderForCache),
    workspaceConfigOptions: params.legacyCache.workspaceConfigOptions,
    modelIdRemaps: buildModelIdRemaps(params.legacyCache, params.providers),
  };
}
```

Implement `migrateBotsStateToV2()` to preserve all bot state fields, normalize `draftOptions.provider`, and use a helper `migrateDraftModel()` with this order:

```ts
function migrateDraftModel(params: {
  value: string | undefined;
  legacyCache: BotsModelCacheFile;
  providers: readonly ModelProviderConfig[];
}): string | undefined {
  if (!params.value) {
    return undefined;
  }
  const custom = decodeCustomModelValue(params.value);
  if (!custom?.providerId || !custom.modelName) {
    return findUniqueProviderByModel(params.providers, params.value)
      ? params.value
      : undefined;
  }
  const directProvider = params.providers.find((provider) => provider.id === custom.providerId);
  if (directProvider && providerHasModel(directProvider, custom.modelName)) {
    return encodeCustomModelValue(custom.providerId, custom.modelName);
  }
  const legacyProviderName = params.legacyCache.providers.find((provider) => provider.id === custom.providerId)?.name;
  const remappedProvider = legacyProviderName
    ? findUniqueProviderByNameAndModel(params.providers, legacyProviderName, custom.modelName)
    : findUniqueProviderByModel(params.providers, custom.modelName);
  return remappedProvider ? encodeCustomModelValue(remappedProvider.id, custom.modelName) : undefined;
}
```

Include a Chinese comment near the ambiguous-match branch:

```ts
// Bugfix: 旧 bot-state 里的 providerId 可能来自被迁移前的 provider 快照。
// 多个新 provider 同时命中时不能猜测，否则会把 Bot 后续请求发到错误供应商。
```

- [ ] **Step 4: Run migration tests**

Run:

```bash
pnpm vitest run packages/services/test/botsStorageMigration.test.ts
```

Expected: PASS.

### Task 3: Wire Migration Into Bot Service Hydration

**Files:**
- Modify: `packages/services/src/bots/botsService.ts`
- Modify: `packages/services/test/botsService.fixtures.ts`
- Test: `packages/services/test/botsService.config.test.ts`

- [ ] **Step 1: Write failing service-level test**

Add a test to `packages/services/test/botsService.config.test.ts` that creates a memory repo with legacy state, a memory cache with legacy provider snapshot, and a model provider service with the new provider id. The test should call `/model` and assert the provider list contains the new provider and the saved state model was remapped.

```ts
it("migrates bot draft model to current config provider before /model", async () => {
  const repo = createMemoryRepo(baseConfig, {
    version: 2,
    bots: {
      "webhook-1": {
        botId: "webhook-1",
        workspacePath: "/tmp/workspace",
        workspaceIdentity: "ssh://host/tmp/workspace",
        mode: "draft",
        activeTaskId: null,
        draftOptions: {
          provider: "glm",
          model: encodeCustomModelValue("old-provider", "deepseek-v4-flash"),
        },
        updatedAt: 1,
      },
    },
  });
  const legacyProvider = createTestProvider({ id: "old-provider", name: "DeepSeek", models: ["deepseek-v4-flash"] });
  const currentProvider = createTestProvider({ id: "new-provider", name: "DeepSeek", models: ["deepseek-v4-flash"] });
  const modelCacheRepo = createMemoryModelCacheRepo({
    version: 2,
    updatedAt: 1,
    providers: [legacyProvider],
    workspaceConfigOptions: {},
  });
  const service = createBotsService({
    repo,
    modelCacheRepo,
    modelProviderService: createModelProviderService([currentProvider]),
    credentialService: createCredentialService(),
  });

  const replies = await service.handleInboundMessage({
    provider: "webhook",
    botId: "webhook-1",
    actor: {
      provider: "webhook",
      botId: "webhook-1",
      providerUserId: "user-1",
      chatType: "private",
    },
    text: "/model",
    receivedAt: 2,
  });

  expect(replies[0]?.selection?.options.some((option) => option.id === "new-provider")).toBe(true);
  await expect(repo.readState()).resolves.toMatchObject({
    bots: {
      "webhook-1": {
        draftOptions: {
          model: encodeCustomModelValue("new-provider", "deepseek-v4-flash"),
        },
      },
    },
  });
});
```

- [ ] **Step 2: Run focused test to confirm failure**

Run:

```bash
pnpm vitest run packages/services/test/botsService.config.test.ts -t "migrates bot draft model"
```

Expected: FAIL because service hydration does not run storage migration yet.

- [ ] **Step 3: Add lazy migration gate in `createBotsService`**

In `packages/services/src/bots/botsService.ts`, import migration helpers and add:

```ts
let botStorageMigrationPromise: Promise<void> | null = null;

async function ensureBotStorageMigrated(): Promise<void> {
  if (!botStorageMigrationPromise) {
    botStorageMigrationPromise = (async () => {
      const providers = await refreshModelProviderConfigs("migration");
      const state = await repo.readState();
      const migratedState = migrateBotsStateToV2({
        state,
        legacyCache: modelCacheFile,
        providers,
        nowMs: Date.now(),
      });
      if (JSON.stringify(migratedState) !== JSON.stringify(state)) {
        await repo.writeState(migratedState);
      }
    })().catch((error: unknown) => {
      botsLogger.warn(
        undefined,
        `migrate bot state/cache v2 failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  await botStorageMigrationPromise;
}
```

Call `await ensureBotStorageMigrated()` at the start of `readContext()`, `writeContext()` does not need it because it only writes the already-normalized v2 state.

Add a guard to prevent recursion if `refreshModelProviderConfigs()` already calls `ensureModelCacheHydrated()`.

- [ ] **Step 4: Make model cache hydration use current providers on first migration**

In `ensureModelCacheHydrated()`, after reading cache, if the cache came from legacy/default or has no providers, call `deps.modelProviderService?.getAll()` once and persist `migrateBotsModelCacheToV2({ legacyCache, providers, nowMs })`. Keep failure behavior conservative: if provider service is unavailable or fails, seed existing cache and log `warn`.

Include a Chinese comment:

```ts
// Bugfix: v2 cache 的 provider 快照必须来自 config.json 迁移后的 ModelProviderService。
// 旧 bots-model-cache.json 只能辅助迁移，不能继续作为 /model 供应商事实源。
```

- [ ] **Step 5: Run service-level test**

Run:

```bash
pnpm vitest run packages/services/test/botsService.config.test.ts -t "migrates bot draft model"
```

Expected: PASS.

### Task 4: Update Existing Tests And Docs

**Files:**
- Modify: `packages/services/test/botsService.fixtures.ts`
- Modify: `packages/services/test/botsModelCacheRepo.test.ts`
- Modify: `docs/bots.md`

- [ ] **Step 1: Update fixtures to v2 cache defaults**

Make `createMemoryModelCacheRepo()` use `createDefaultBotsModelCache()` with `version: 2`, `updatedAt`, `providers`, and `workspaceConfigOptions`. Keep the helper API unchanged for existing tests.

- [ ] **Step 2: Update existing cache repo test expectations**

Change the existing `persists model providers with apiFormat metadata` test to write the v2 shape:

```ts
await repo.write({
  version: 2,
  updatedAt: 1,
  providers: [
    {
      id: "custom-openai",
      name: "Custom OpenAI",
      endpoints: {
        anthropic: "",
        openai: "https://example.com/v1",
        gemini: "",
      },
      apiFormat: "openai-responses",
      apiKey: "__zcode_cached_api_key_present__",
      models: [
        createModelProviderModelConfig({
          id: "gpt-example",
          kinds: ["openai"],
        }),
      ],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  workspaceConfigOptions: {},
});
```

- [ ] **Step 3: Update `docs/bots.md` file list**

Replace the state/cache bullet points with:

```md
- `bot-state.v2.json`: current runtime state keyed by bot id. It stores active workspace, draft/task mode, active task, pending permissions, Telegram offset, and update time.
- `bots-model-cache.v2.json`: current model selection cache. Provider snapshots are derived from `config.json` through `modelProviderService.getAll()` and never store real API keys.
- `bot-state.json` / `bots-model-cache.json`: legacy files. New versions read them only as migration input and never modify them.
```

- [ ] **Step 4: Run all focused bot tests touched by the change**

Run:

```bash
pnpm vitest run packages/services/test/botsRepo.test.ts packages/services/test/botsModelCacheRepo.test.ts packages/services/test/botsStorageMigration.test.ts packages/services/test/botsService.config.test.ts packages/services/test/botsModelSelectionHelpers.test.ts
```

Expected: PASS.

### Task 5: Full Verification And Commit

**Files:**
- Verify all modified files

- [ ] **Step 1: Inspect git diff**

Run:

```bash
git diff -- packages/services/src/bots packages/services/test docs/bots.md docs/superpowers/plans/2026-06-10-bot-state-cache-v2-migration.md
```

Expected: diff only includes v2 migration, tests, and docs.

- [ ] **Step 2: Run required project checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both PASS.

- [ ] **Step 3: Commit implementation**

Run:

```bash
git status --short
git add packages/services/src/bots/config.ts packages/services/src/bots/repo.ts packages/services/src/bots/modelCacheRepo.ts packages/services/src/bots/storageMigration.ts packages/services/test/botsRepo.test.ts packages/services/test/botsModelCacheRepo.test.ts packages/services/test/botsStorageMigration.test.ts packages/services/test/botsService.config.test.ts packages/services/test/botsService.fixtures.ts docs/bots.md docs/superpowers/plans/2026-06-10-bot-state-cache-v2-migration.md
git commit -m "fix: migrate bot state and model cache to v2 files"
```

Expected: Conventional Commit created; `.turbo/` remains untracked and unstaged.
