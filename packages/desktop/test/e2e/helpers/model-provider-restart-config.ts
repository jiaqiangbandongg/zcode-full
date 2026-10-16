import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ProviderApiType,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import type { ModelSelection } from "@zcode/shared/model-selection";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export async function seedPersonalDefaultModelSelection(file: string, selection: ModelSelection) {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: file,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({ ...current, defaultModelSelection: selection }));
  } finally {
    repository.dispose();
  }
}

export type SeedReplayProviderModel =
  | string
  | {
      readonly contextWindow?: number;
      readonly id: string;
      readonly limit?: { readonly output?: number };
      readonly maxOutputTokens?: number;
    };

export interface PersonalModelConfigSeed {
  readonly contextWindow?: number;
  readonly id: string;
  readonly inputModalities?: readonly ("text" | "image" | "pdf" | "video")[];
  readonly maxOutputTokens?: number;
  readonly supportsJsonSchemaOutput?: boolean;
  readonly supportsToolCall?: boolean;
}

export interface PersonalProviderConfigSeed {
  readonly apiFormat: ProviderApiType;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly enabled?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly label: string;
  readonly models: readonly PersonalModelConfigSeed[];
  readonly visibility?: "visible" | "hidden";
}

/**
 * 为 restart E2E 写入正式 Personal Config。
 *
 * Seed 直接表达正式 ProviderConfig 与 ModelConfig 字段，不经过旧 Store DTO。
 */
export async function seedPersonalProviderConfig(
  file: string,
  provider: PersonalProviderConfigSeed,
) {
  // 固定 account:* Provider 的 Access 由 ZCode Built-in Config 所有；测试只需把
  // endpoint/model 事实切到 replay，不得在 Personal Config 再写 ApiKey Access，
  // 否则正式 schema 会拒绝“个人层覆盖计划 Access”的非法组合。
  const access = provider.id.startsWith("account:")
    ? undefined
    : new ApiKeyAccessConfig({
        apiKey: provider.apiKey,
      });
  const providerConfig = new ProviderConfig({
    group: "standard-personal",
    access,
    api: new ProviderApiConfig({
      type: provider.apiFormat,
      baseUrl: provider.baseURL,
      headers: provider.headers,
    }),
    personalModelIds: provider.models.map((model) => model.id),
    visibility: provider.visibility,
  });
  const repository = new NodePersonalProviderConfigRepository({
    filePath: file,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({
        providerId: provider.id,
        providerName: provider.label,
        config: providerConfig,
      }),
      models: provider.models.reduce(
        (rules, model) =>
          rules.setExact(provider.id, model.id, modelConfigFromSeed(model, provider.apiFormat)),
        current.models.deleteExactForProvider(provider.id),
      ),
    }));
  } finally {
    repository.dispose();
  }
}

function modelConfigFromSeed(
  model: PersonalModelConfigSeed,
  apiFormat: ProviderApiType,
): ModelConfig {
  const inputs = new Set(model.inputModalities ?? ["text"]);
  const maxOutputTokens = model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      inputFormat: {
        supportsText: inputs.has("text"),
        supportsImage: inputs.has("image"),
        supportsVideo: inputs.has("video"),
        supportsAudio: inputs.has("audio"),
        supportsPdf: inputs.has("pdf"),
      },
      outputFormat: { supportsText: true },
      supportsToolCall: model.supportsToolCall ?? true,
      supportsJsonSchemaOutput: model.supportsJsonSchemaOutput ?? false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: {
        max: maxOutputTokens,
        map: maxOutputTokensMap(apiFormat),
      },
    }),
  });
}

function maxOutputTokensMap(apiFormat: ProviderApiType): string {
  switch (apiFormat) {
    case "anthropic-messages":
      return '{"max_tokens":maxOutputTokens}';
    case "openai-chat-completions":
      return '{"max_completion_tokens":maxOutputTokens}';
    case "openai-responses":
      return '{"max_output_tokens":maxOutputTokens}';
  }
}
