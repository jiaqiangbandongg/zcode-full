import { DatabaseSync } from "node:sqlite";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  BUILTIN_PROVIDER_TEMPLATE_IDS,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_V4_MODEL_CONFIG,
  ZCODE_AGENT_PROVIDER,
  encodeCustomModelValue,
  type ProviderFamilyConnectionSelection,
} from "@zcode/shared";
import { getE2EAppDataPaths } from "./desktop-app.js";
import { getUpstreamApiKey } from "./upstream-provider.js";
import { waitForSqliteTable } from "./e2e-sqlite-readiness.js";
import { resolveSeededReplayBaseUrl } from "./custom-openai-provider-store.js";
import {
  restartIntoWorkspacePreservingProfile as restartIntoWorkspacePreservingProfileFixture,
  restartIntoWorkspaceRestoringPreferences,
  type ModelProviderRestartOptions,
} from "./model-provider-restart-runtime.js";
import {
  seedPersonalProviderConfig,
  type PersonalProviderConfigSeed,
  type SeedReplayProviderModel,
} from "./model-provider-restart-config.js";
import { getV4DraftThoughtState } from "./v4-conversation.js";

const paths = getE2EAppDataPaths();
const SETTINGS_FILE = join(paths.appDataDir, "setting.json");
const CREDENTIALS_FILE = paths.credentialsFile;
const MODEL_SELECTION_RECENT_KEY_PREFIX = "zcode-model-selection-recent-v1";

export { seedTurboAgentStartupModel } from "./model-provider-restart-runtime.js";

export const E2E_BIGMODEL_PLAN_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan;
export const E2E_BIGMODEL_START_PROVIDER_ID = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
export const E2E_BIGMODEL_API_PROVIDER_ID = BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel;
export const E2E_PLAN_FIRST_MODEL = "GLM-5.3";
export const E2E_PLAN_DEFAULT_MODEL = "GLM-5.2";
export const E2E_PLAN_NON_DEFAULT_MODEL = "GLM-5.3-Flash";
export const E2E_PLAN_TURBO_MODEL = "GLM-5-Turbo";

export async function seedBigModelConnectionSelection(
  selection: ProviderFamilyConnectionSelection,
) {
  await writeJsonPatch(SETTINGS_FILE, {
    providerFamilyConnectionSelections: {
      bigmodel: selection,
    },
    providerFamilyDomain: "bigmodel",
    providerFamilyDomainMigrated: true,
  });
}

export async function readBigModelConnectionSelection(): Promise<
  ProviderFamilyConnectionSelection | undefined
> {
  const settings = await readJson(SETTINGS_FILE);
  const selections = settings.providerFamilyConnectionSelections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return undefined;
  }
  return (selections as { bigmodel?: ProviderFamilyConnectionSelection }).bigmodel;
}

export async function seedBigModelOAuthCredential() {
  await writeJsonPatch(CREDENTIALS_FILE, {
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: "bigmodel-e2e-user",
      username: "bigmodel-e2e-user",
    }),
  });
}

/**
 * 为需要实际进入 BigModel Start Plan 的 E2E 补齐 zcode JWT。
 *
 * Start Plan 与个人 Coding Plan 共用 OAuth 用户身份，但请求授权读取的是
 * `zcodejwttoken`；只 seed business access token 会让菜单把 Start Plan 判成未认证。
 */
export async function seedBigModelStartPlanCredential() {
  await writeJsonPatch(CREDENTIALS_FILE, {
    "oauth:active_provider": "bigmodel",
    "oauth:bigmodel:access_token": "e2e-bigmodel-oauth-token",
    "oauth:bigmodel:user_info": JSON.stringify({
      displayName: "BigModel E2E",
      id: "bigmodel-e2e-user",
      username: "bigmodel-e2e-user",
    }),
    zcodejwttoken: "e2e-bigmodel-start-plan-jwt",
  });
}

export async function seedReplayProvider(params: {
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
  id: string;
  models: readonly SeedReplayProviderModel[];
  name: string;
}) {
  const baseURL = params.baseURL ?? (await resolveSeededReplayBaseUrl());
  if (!baseURL) {
    throw new Error("没有可用 replay Base URL，无法 seed model provider restart case");
  }
  const provider: PersonalProviderConfigSeed = {
    id: params.id,
    label: params.name,
    // 内建 account provider 的模型规则按 anthropic-messages 匹配；若用 OpenAI Chat Completions
    // 格式覆盖连接配置，GLM builtin model rules 不会命中，模型在 Registry 中
    // 会因缺少完整 option/properties 被过滤，UI 菜单就看不到该计划模型。
    apiFormat: params.id.startsWith("account:") ? "anthropic-messages" : "openai-chat-completions",
    apiKey: params.apiKey ?? getUpstreamApiKey(),
    baseURL,
    enabled: params.enabled ?? true,
    models: params.models.map((input) =>
      typeof input === "string"
        ? { id: input }
        : {
            contextWindow: input.contextWindow,
            id: input.id,
            maxOutputTokens: input.maxOutputTokens ?? input.limit?.output,
          },
    ),
  };
  await seedPersonalProviderConfig(paths.configFile, provider);
}

export async function seedPersistedModelSelection(params: {
  modelId: string;
  providerId: string;
  reasoningLevel: string;
}) {
  await browser.execute(
    (workspacePath, keyPrefix, selection, appProvider) => {
      window.localStorage.setItem(
        `${keyPrefix}:${workspacePath}`,
        JSON.stringify({
          providerId: selection.providerId,
          modelId: selection.modelId,
          options: { reasoningLevel: selection.reasoningLevel },
        }),
      );
      window.localStorage.setItem("zcode-last-agent-provider", appProvider);
    },
    paths.workspace,
    MODEL_SELECTION_RECENT_KEY_PREFIX,
    params,
    ZCODE_AGENT_PROVIDER,
  );
}

export async function readLastSelectedAgentConfig() {
  return await browser.execute(
    (workspacePath, keyPrefix) => {
      const raw = window.localStorage.getItem(`${keyPrefix}:${workspacePath}`);
      if (!raw) return null;
      const recent: unknown = JSON.parse(raw);
      // Recent 扩展为模型与权限并列保存；重启断言同时兼容旧的纯模型种子。
      const record = recent && typeof recent === "object" && !Array.isArray(recent) ? recent : null;
      const selection =
        record && "modelSelection" in record ? record.modelSelection : (record ?? recent);
      const candidate =
        selection && typeof selection === "object" && !Array.isArray(selection)
          ? (selection as {
              providerId?: unknown;
              modelId?: unknown;
              options?: { reasoningLevel?: unknown };
            })
          : null;
      if (
        !candidate ||
        typeof candidate.providerId !== "string" ||
        typeof candidate.modelId !== "string" ||
        candidate.providerId.length === 0 ||
        candidate.modelId.length === 0
      ) {
        return null;
      }
      return {
        schemaVersion: 1,
        model: `${candidate.providerId}/${candidate.modelId}`,
        thoughtLevel: candidate.options?.reasoningLevel ?? null,
      };
    },
    paths.workspace,
    MODEL_SELECTION_RECENT_KEY_PREFIX,
  );
}

export async function waitForLastSelectedAgentConfig(params: {
  model: string;
  thoughtLevel: string;
}) {
  let latest: Awaited<ReturnType<typeof readLastSelectedAgentConfig>> = null;
  try {
    await browser.waitUntil(
      async () => {
        latest = await readLastSelectedAgentConfig();
        return Boolean(
          latest?.model.includes(params.model) && latest.thoughtLevel === params.thoughtLevel,
        );
      },
      {
        timeout: 30000,
        timeoutMsg: `last-selected 配置没有收敛到 ${params.model}/${params.thoughtLevel}`,
      },
    );
  } catch {
    const storedAgentPreferences = await browser.execute(() =>
      Object.fromEntries(
        Object.entries(window.localStorage).filter(([key]) => key.startsWith("zcode-last-agent-")),
      ),
    );
    throw new Error(
      `last-selected 配置没有收敛到 ${params.model}/${params.thoughtLevel}，实际值：${JSON.stringify(latest)}，全部偏好：${JSON.stringify(storedAgentPreferences)}`,
    );
  }
  return latest;
}

export async function seedGlobalAgentReasoningLevel(thoughtLevel: string) {
  const databasePath = join(paths.storageRoot, "cli", "db", "db.sqlite");
  // Bug 根因：workspace UI ready 不代表 Agent DB migration ready；直接打开 writable DB
  // 会在父目录尚未创建时报 unable to open，甚至可能抢先生成缺少 schema 的空库。
  await waitForSqliteTable(databasePath, "local_setting");
  const db = new DatabaseSync(databasePath);
  const now = Date.now();
  try {
    db.exec("pragma busy_timeout = 5000");
    // Bug 根因：同一 spec 内 Agent SQLite 会跨 case 保留上一条显式 thought，
    // 只 seed renderer localStorage 不能隔离跨模型默认值。这里固定 Agent 侧前置状态，
    // 避免 I39 的 GLM high 泄漏到 I42，让用例真正验证 Turbo enabled → GLM 默认值。
    db.prepare(`
      insert into local_setting (
        scope, scope_id, namespace, key, value, schema_version, time_created, time_updated
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(scope, scope_id, namespace, key) do update set
        value = excluded.value,
        schema_version = excluded.schema_version,
        time_updated = excluded.time_updated
    `).run(
      "user",
      "default",
      "model",
      "reasoningLevel",
      JSON.stringify({ level: thoughtLevel }),
      1,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

export async function waitForDraftThoughtLevelState(params: {
  current: string;
  values: readonly string[];
  timeoutMsg?: string;
}) {
  let latest: Awaited<ReturnType<typeof getV4DraftThoughtState>> | null = null;
  await browser.waitUntil(
    async () => {
      // Bugfix：legacy workspace 目录可能仍属于上一模型；当前值与能力集优先读 V4
      // 当前模型投影，避免把 Turbo 二态误判成旧模型的 off/high/max。
      latest = await getV4DraftThoughtState(paths.workspace);
      const actualValues = [...latest.values].sort();
      const expectedValues = [...params.values].sort();
      return (
        latest.current === params.current &&
        JSON.stringify(actualValues) === JSON.stringify(expectedValues)
      );
    },
    {
      timeout: 30000,
      timeoutMsg: params.timeoutMsg ?? `draft thought 没有收敛到 ${params.current}`,
    },
  );
  return latest;
}

export async function waitForV4DraftModelConfig(params: { model: string; thought: string }) {
  let latest: { model: string | null; thought: string | null } | null = null;
  await browser.waitUntil(
    async () => {
      latest = await browser.execute((configTestId) => {
        const config = document.querySelector<HTMLElement>(`[data-testid="${configTestId}"]`);
        return {
          model: config?.dataset.model?.trim() || null,
          thought: config?.dataset.thought?.trim() || null,
        };
      }, TID_V4_MODEL_CONFIG);
      const modelMatches =
        latest.model === params.model || latest.model?.endsWith(`/${params.model}`) === true;
      return modelMatches && latest.thought === params.thought;
    },
    {
      timeout: 30000,
      timeoutMsg: `V4 draft 配置没有收敛到 ${params.model}/${params.thought}`,
    },
  );
  return latest;
}

export async function waitForPlanModelIoRequest(expectedText: string) {
  const debugDir = join(paths.homeDir, ".zcode", "cli", "debug");
  let matched: { model?: string; thinking?: { type?: string } } | null = null;
  await browser.waitUntil(
    async () => {
      const files = await readdir(debugDir).catch(() => []);
      for (const file of files.filter(
        (item) => item.startsWith("model-io-") && item.endsWith(".jsonl"),
      )) {
        const content = await readFile(join(debugDir, file), "utf-8").catch(() => "");
        for (const line of content.split("\n")) {
          if (!line.includes(expectedText)) continue;
          try {
            const record = JSON.parse(line) as {
              querySource?: string;
              request?: { body?: { model?: string; thinking?: { type?: string } } };
            };
            if (record.querySource === "main_turn" && record.request?.body) {
              matched = record.request.body;
              return true;
            }
          } catch {
            // model IO 正在追加时可能读到半行，下一轮重试即可。
          }
        }
      }
      return false;
    },
    { timeout: 30000, timeoutMsg: `没有找到 Plan model IO 请求: ${expectedText}` },
  );
  return matched as { model?: string; thinking?: { type?: string } } | null;
}

export async function restartIntoWorkspace(options: ModelProviderRestartOptions = {}) {
  await restartIntoWorkspaceRestoringPreferences(paths.workspace, options);
}

export async function restartIntoWorkspacePreservingProfile() {
  await restartIntoWorkspacePreservingProfileFixture(paths.workspace);
}

export async function waitForSelectedModel(providerId: string, modelId: string) {
  const expected = encodeCustomModelValue(providerId, modelId);
  let actual: string | null = null;
  let storedConfig: string | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const snapshot = await browser.execute(
          (value, triggerTestId, workspacePath, keyPrefix) => {
            const trigger = document.querySelector<HTMLElement>(`[data-testid="${triggerTestId}"]`);
            return {
              actual: trigger?.dataset.modelCurrentValue ?? null,
              matched: trigger?.dataset.modelCurrentValue === value,
              storedConfig: window.localStorage.getItem(`${keyPrefix}:${workspacePath}`),
            };
          },
          expected,
          TID_CHAT_MODEL_SELECT_TRIGGER,
          paths.workspace,
          MODEL_SELECTION_RECENT_KEY_PREFIX,
        );
        actual = snapshot.actual;
        storedConfig = snapshot.storedConfig;
        return snapshot.matched;
      },
      {
        timeout: 30000,
        timeoutMsg: `toolbar 没有选择 ${expected}`,
      },
    );
  } catch (error) {
    throw new Error(
      `toolbar 没有选择 ${expected}，actual=${actual}，storedConfig=${storedConfig}`,
      { cause: error },
    );
  }
}

async function writeJsonPatch(file: string, patch: Record<string, unknown>) {
  const current = await readJson(file);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...current, ...patch }, null, 2), "utf-8");
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
