import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import {
  createE2EProviderModelSnapshot,
  getE2EAppDataPaths,
  type E2EModelProviderSnapshot,
  type E2EProviderModality,
} from "./desktop-app.js";
import { getUpstreamApiKey } from "./upstream-provider.js";

// 修复原因：WDIO worker 的 os.homedir() 可能不同于 desktop-app 使用的 E2E_HOME_DIR；
// direct seed 必须复用同一份 sandbox 路径，否则 Provider 会写到应用读不到的位置。
const E2E_APP_DATA_PATHS = getE2EAppDataPaths();
const PERSONAL_CONFIG_FILE = E2E_APP_DATA_PATHS.configFile;
const E2E_PROVIDER_RUNTIME_FILE = resolve(
  process.env.ZCODE_E2E_NETWORK_CAPTURE_DIR?.trim() ||
    resolve(E2E_APP_DATA_PATHS.homeDir, "..", ".e2e-network-capture"),
  "upstream-runtime.json",
);

const E2E_MODEL_CONTEXT_WINDOW = 200_000;
const E2E_MODEL_MAX_OUTPUT_TOKENS = 32_000;

interface SeedCustomOpenAIProviderOptions {
  inputModalities?: readonly E2EProviderModality[];
  modelId: string;
  providerId: string;
  providerName: string;
}

export async function seedCustomOpenAIChatCompletionsProvider({
  inputModalities,
  modelId,
  providerId,
  providerName,
}: SeedCustomOpenAIProviderOptions): Promise<E2EModelProviderSnapshot> {
  const baseURL = await resolveSeededReplayBaseUrl();
  if (!baseURL) {
    throw new Error(
      "没有找到已 seed 的 replay provider Base URL，无法写入 OpenAI-compatible provider",
    );
  }

  const providerConfig = new ProviderConfig({
    // 新格式要求个人 Provider 明确分组，否则只有配置记录而无可执行模型。
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ apiKey: getUpstreamApiKey() }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl: baseURL }),
    personalModelIds: [modelId],
  });
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({
      ...current,
      providers: current.providers.setRule({ providerId, providerName, config: providerConfig }),
      models: current.models.setExact(providerId, modelId, createE2EModelConfig(inputModalities)),
    }));
  } finally {
    repository.dispose();
  }

  // 返回值只是 E2E 对 Personal Config 的观察投影，不参与任何运行时装配。
  return createSeededOpenAIProvider({
    baseURL,
    inputModalities,
    modelId,
    providerId,
    providerName,
  });
}

export async function resolveSeededReplayBaseUrl() {
  const envBaseURL = process.env.E2E_PROVIDER_RUNTIME_BASE_URL?.trim();
  if (envBaseURL) return normalizeReplayRootBaseUrl(envBaseURL);

  const runtimeBaseURL = await readReplayRootBaseUrlFromRuntimeFile();
  if (runtimeBaseURL) return runtimeBaseURL;

  const personal = await readPersonalProviderConfig();
  for (const [, provider] of personal.providers.entries()) {
    if (
      provider.access?.type === "api-key" &&
      provider.access.apiKey?.trim() === getUpstreamApiKey()
    ) {
      return normalizeReplayRootBaseUrl(provider.api?.baseUrl ?? "");
    }
  }
  return "";
}

function createE2EModelConfig(
  inputModalities: readonly E2EProviderModality[] | undefined,
): ModelConfig {
  const inputs = new Set(inputModalities ?? ["text"]);
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: E2E_MODEL_CONTEXT_WINDOW,
      inputFormat: {
        supportsText: inputs.has("text"),
        supportsImage: inputs.has("image"),
        supportsVideo: inputs.has("video"),
        supportsAudio: inputs.has("audio"),
        supportsPdf: inputs.has("pdf"),
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: {
        max: E2E_MODEL_MAX_OUTPUT_TOKENS,
      },
    }),
  });
}

function createSeededOpenAIProvider({
  baseURL,
  inputModalities,
  modelId,
  providerId,
  providerName,
}: SeedCustomOpenAIProviderOptions & { baseURL: string }): E2EModelProviderSnapshot {
  const now = Date.now();
  const model = createE2EProviderModelSnapshot({
    id: modelId,
    kinds: ["openai-compatible"],
    defaultKind: "openai-compatible",
    contextWindow: E2E_MODEL_CONTEXT_WINDOW,
    maxOutputTokens: E2E_MODEL_MAX_OUTPUT_TOKENS,
    supportsTools: true,
    supportsJsonSchemaOutput: false,
    ...(inputModalities ? { modalities: { input: inputModalities, output: ["text"] } } : {}),
  });
  return {
    id: providerId,
    name: providerName,
    apiFormat: "openai-chat-completions",
    apiKey: getUpstreamApiKey(),
    apiKeyRequired: true,
    defaultKind: "openai-compatible",
    endpoints: { baseURL, paths: { "openai-compatible": "" } },
    models: [model],
    source: "custom",
    createdAt: now,
    updatedAt: now,
  };
}

async function readPersonalProviderConfig(): Promise<ProviderConfigLayerSnapshot> {
  const repository = new NodePersonalProviderConfigRepository({
    filePath: PERSONAL_CONFIG_FILE,
    pollingIntervalMs: false,
  });
  try {
    return await repository.read();
  } finally {
    repository.dispose();
  }
}

async function readReplayRootBaseUrlFromRuntimeFile() {
  try {
    const json = JSON.parse(await readFile(E2E_PROVIDER_RUNTIME_FILE, "utf-8")) as {
      baseUrl?: string;
    };
    return normalizeReplayRootBaseUrl(json.baseUrl ?? "");
  } catch {
    return "";
  }
}

function normalizeReplayRootBaseUrl(baseURL: string) {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/anthropic") ? trimmed.slice(0, -"/anthropic".length) : trimmed;
}
