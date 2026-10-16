import { readFile } from "node:fs/promises";
import { BUILTIN_PROVIDER_TEMPLATE_IDS } from "@zcode/shared";
import { getDefaultConfigPath } from "@zcode/adapters/config";
import {
  parseLegacyCliModelConfig,
  type LegacyCliModelConfigProjection,
} from "./legacy-cli-model-config.js";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderApiType,
  type ProviderConfigLayerUpdate,
  type ModelSelection,
} from "@zcode/provider";

interface LegacyCliPersonalProviderConfigImportInput {
  readonly input: unknown;
}

const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

class UnsupportedLegacyCliProviderConfigError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`旧 CLI Provider ${providerId} 含有正式 Config 尚不能表达的执行字段`);
    this.name = "UnsupportedLegacyCliProviderConfigError";
    this.providerId = providerId;
  }
}

function resolveLegacyProviderApiType(
  kind: "anthropic" | "openai" | "openai-compatible" | undefined,
): ProviderApiType {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    case "openai-compatible":
    case undefined:
      return "openai-chat-completions";
  }
  return "openai-chat-completions";
}

/** 把旧 CLI 用户文件中的显式 Provider 定义迁移到新的 Personal Overlay。 */
export function importLegacyCliPersonalProviderConfig(
  input: LegacyCliPersonalProviderConfigImportInput,
): ProviderConfigLayerUpdate {
  const runtimePatch = parseLegacyCliModelConfig(input.input);
  // 通用 ZCodeConfigFileSchema 刻意把旧 provider 留在 passthrough unknown，
  // 迁移器却从该结果取类型，导致 Bootstrap build 无法证明 model/provider 结构。
  // 这里只消费专用旧格式 parser 的已校验投影，保持兼容逻辑封闭在读取边界。
  let providers = ProviderConfigMap.empty();
  let models = ModelConfigRules.empty();

  for (const [rawProviderId, provider] of Object.entries(runtimePatch.provider ?? {})) {
    const providerId = rawProviderId.trim();
    if (!providerId) continue;
    // Standalone 也会读取旧 Desktop 写出的 builtin:* / source=custom。
    // 与 Desktop 导入一致：旧内置静态配置和账号凭据不迁，按量 API 只留下 Key。
    const templateId =
      providerId === "builtin:bigmodel"
        ? BUILTIN_PROVIDER_TEMPLATE_IDS.bigmodel
        : providerId === "builtin:zai"
          ? BUILTIN_PROVIDER_TEMPLATE_IDS.zai
          : undefined;
    if (templateId) {
      const apiKey = provider.options?.apiKey?.trim();
      if (apiKey)
        providers = providers.setRule({
          providerId: templateId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey }),
          }),
        });
      continue;
    }
    if (providerId.startsWith("builtin:") || providerId.startsWith("account:")) continue;
    if (provider.source !== undefined && provider.source !== "custom") continue;
    if (requiresUnsupportedNoAuthentication(provider)) {
      throw new UnsupportedLegacyCliProviderConfigError(providerId);
    }
    const members = collectLegacyCliModelMembers(provider);
    const modelIds = members.map((member) => member.modelId);
    const providerName = provider.name?.trim();
    providers = providers.setRule({
      providerId,
      providerName: providerName && providerName !== providerId ? providerName : undefined,
      config: new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({
          apiKey: provider.options?.apiKey,
        }),
        api: new ProviderApiConfig({
          type: resolveLegacyProviderApiType(provider.kind),
          baseUrl: provider.options?.baseURL,
          headers: mergeHeaders(provider.headers, provider.options?.headers),
        }),
        ...(modelIds.length > 0 ? { personalModelIds: modelIds, modelOrder: modelIds } : {}),
      }),
    });
    for (const member of members) {
      if (member.contextWindow === undefined) continue;
      models = models.setExact(
        providerId,
        member.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({ contextWindow: member.contextWindow }),
        }),
      );
    }
  }

  // 默认选择与 Provider 由同一次旧文件读取生成，只在 Personal 文件首次创建时导入。
  // 后续清空默认不能再次读取旧 main，也不能先创建半份配置阻止剩余字段迁移。
  const defaultModelSelection = importLegacyCliConfiguredDefault(input.input) ?? undefined;
  return Object.freeze({ providers, models, defaultModelSelection });
}

export async function readLegacyCliPersonalProviderConfig(input: {
  readonly filePath?: string;
}): Promise<ProviderConfigLayerUpdate | null> {
  const filePath = input.filePath ?? getDefaultConfigPath();
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return importLegacyCliPersonalProviderConfig({ input: raw });
  } catch (error) {
    if (isFileNotFound(error)) return null;
    // 迁移必须是全有或全无。正式 Config 尚不能表达旧执行字段时保留旧链路，
    // 不写一个部分 Personal 文件阻止未来版本重新迁移。
    if (error instanceof UnsupportedLegacyCliProviderConfigError) return null;
    throw error;
  }
}

/** 旧 CLI 用户文件中的 main model 只迁移为 Environment 默认选择。 */
export function importLegacyCliConfiguredDefault(input: unknown): ModelSelection | null {
  const main = parseLegacyCliModelConfig(input).model?.main;
  if (!main || main.provider === RETIRED_ZAPI_PROVIDER_ID) return null;
  return Object.freeze({
    providerId: main.provider,
    modelId: main.model,
  });
}

type LegacyCliProvider = NonNullable<LegacyCliModelConfigProjection["provider"]>[string];

interface LegacyCliModelMember {
  readonly modelId: string;
  readonly contextWindow?: number;
}

function collectLegacyCliModelMembers(
  provider: LegacyCliProvider,
): readonly LegacyCliModelMember[] {
  const seen = new Set<string>();
  const members: LegacyCliModelMember[] = [];
  for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
    if (model.deleted === true) continue;
    const modelId = (model.id ?? modelKey).trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const contextWindow = model.contextWindow ?? model.limit?.context;
    members.push({
      modelId,
      ...(isPositiveInteger(contextWindow) ? { contextWindow } : {}),
    });
  }
  return members;
}

function mergeHeaders(
  ...values: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const result = Object.assign({}, ...values.filter(Boolean));
  return Object.keys(result).length > 0 ? result : undefined;
}

function requiresUnsupportedNoAuthentication(provider: LegacyCliProvider): boolean {
  return provider.options?.apiKeyRequired === false;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}
