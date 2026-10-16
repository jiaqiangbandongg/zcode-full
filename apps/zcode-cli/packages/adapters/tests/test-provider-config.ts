import type { Model, ModelOptions, ModelProperties, ModelSelection } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
  type ZhipuAccountMode,
} from "@zcode/provider";
import {
  AiSdkModelAdapter as ProductionAiSdkModelAdapter,
  type AiSdkModelAdapterOptions,
  type CreateAiSdkModelOptions,
} from "../src/model/runner.js";
import {
  AiSdkModelExecution,
  type AiSdkModelExecutionConfig,
  type AiSdkModelExecutionOptions,
  type AiSdkResolvedModel,
} from "../src/model/model-execution.js";
import { createTestModelProperties } from "./test-model-format.js";

interface LegacyTestProviderConfig {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly createLanguageModel?: (modelId: string) => unknown;
  readonly accountMode?: ZhipuAccountMode;
  readonly headers?: Readonly<Record<string, string>>;
  readonly kind: "anthropic" | "custom" | "openai" | "openai-compatible";
  readonly name?: string;
  readonly providerOptions?: Readonly<Record<string, unknown>>;
}

interface LegacyTestRegistryConfig extends AiSdkModelExecutionConfig {
  readonly defaultProvider?: string;
  readonly providers: Readonly<Record<string, LegacyTestProviderConfig>>;
}

interface TestCreateModelOptions {
  readonly accountMode?: ZhipuAccountMode;
  readonly displayName?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly optionSpecs?: RegistryModelConfig["optionSpecs"];
  readonly options?: ModelOptions;
  readonly properties?: ModelProperties;
  readonly requestDependencies?: CreateAiSdkModelOptions["requestDependencies"];
}

/**
 * 仅供旧 Adapter 行为测试组织多组输入数据。
 *
 * 它不是执行 Registry：每次创建 Model 时都会先解析出一份完整的单 Provider Config，
 * 再直接传给生产 Adapter。这样保留网络与请求回归覆盖，同时不会把已删除的查询层带回产品代码。
 */
export class TestProviderConfigFixture {
  private config: LegacyTestRegistryConfig;
  private execution: AiSdkModelExecution;
  private readonly executionOptions: AiSdkModelExecutionOptions;

  constructor(config: LegacyTestRegistryConfig, options: AiSdkModelExecutionOptions = {}) {
    this.config = config;
    this.executionOptions = options;
    this.execution = new AiSdkModelExecution(this.executionConfig(), this.executionOptions);
  }

  replaceConfig(config: LegacyTestRegistryConfig): void {
    this.config = config;
    this.execution = new AiSdkModelExecution(this.executionConfig(), this.executionOptions);
  }

  resolveConfig(selection: ModelSelection | string, accountMode?: ZhipuAccountMode) {
    const resolvedSelection = parseTestSelection(selection, this.config.defaultProvider);
    const source = this.config.providers[resolvedSelection.providerId];
    if (!source) throw new Error(`Unknown test provider: ${resolvedSelection.providerId}`);
    return {
      modelId: resolvedSelection.modelId,
      providerConfig: toRegistryProviderConfig(resolvedSelection.providerId, source, accountMode),
      providerId: resolvedSelection.providerId,
    };
  }

  resolve(
    selection: ModelSelection | string,
    options: ModelOptions = { maxOutputTokens: 32_000, reasoningLevel: "disabled" },
  ): AiSdkResolvedModel {
    const resolvedSelection = parseTestSelection(selection, this.config.defaultProvider);
    const resolved = this.resolveConfig(resolvedSelection);
    const source = this.config.providers[resolvedSelection.providerId];
    if (!source) throw new Error(`Unknown test provider: ${resolvedSelection.providerId}`);
    const bound = this.execution.bindModel({
      ...resolved,
      supportsJsonSchemaOutput: false,
      optionSpecs: defaultOptionSpecs(resolved.providerConfig.api.type),
    });
    return bound.resolveRequest({
      options: { reasoningLevel: "disabled", ...options },
      ...(source.accountMode && source.apiKey ? { requestAuth: { apiKey: source.apiKey } } : {}),
    });
  }

  executionConfig(): AiSdkModelExecutionConfig {
    const { providers: _providers, defaultProvider: _defaultProvider, ...execution } = this.config;
    return execution;
  }
}

export class TestAiSdkModelAdapter extends ProductionAiSdkModelAdapter {
  readonly testProviderConfigs?: TestProviderConfigFixture;

  constructor(
    options: AiSdkModelAdapterOptions & { readonly registry?: TestProviderConfigFixture },
  ) {
    const { registry, ...productionOptions } = options;
    super({ ...productionOptions, ...registry?.executionConfig() });
    this.testProviderConfigs = registry;
  }

  createModel(options: CreateAiSdkModelOptions | TestCreateModelOptions): Model {
    if ("providerConfig" in options) return super.createModel(options);
    const fixture = this.testProviderConfigs;
    if (!fixture) throw new Error("Test Provider Config fixture is required");
    const resolved = fixture.resolveConfig(
      { providerId: options.providerId, modelId: options.modelId },
      options.accountMode ?? (options.requestDependencies?.requestAuth ? "off-peak" : undefined),
    );
    const requestDependencies =
      options.requestDependencies ??
      (options.accountMode === "off-peak"
        ? {
            requestAuth: {
              source: { resolve: async () => ({ apiKey: "test-off-peak-key" }) },
            },
          }
        : undefined);
    const modelConfig = createRegistryModelConfig(options, resolved.providerConfig.api.type);
    const reasoningValues = modelConfig.optionSpecs.reasoningLevel.values;
    return super.createModel({
      ...resolved,
      providerConfig: resolved.providerConfig,
      modelConfig,
      ...(options.displayName ? { displayName: options.displayName } : {}),
      options: {
        maxOutputTokens: Math.min(32_000, modelConfig.optionSpecs.maxOutputTokens.max),
        reasoningLevel: reasoningValues.at(-1) ?? "disabled",
        ...options.options,
      },
      ...(requestDependencies ? { requestDependencies } : {}),
    });
  }
}

export function createTestAiSdkModelAdapter(
  options: AiSdkModelAdapterOptions & { readonly registry?: TestProviderConfigFixture },
): TestAiSdkModelAdapter {
  return new TestAiSdkModelAdapter(options);
}

function createRegistryModelConfig(
  options: TestCreateModelOptions,
  apiType: RegistryProviderConfig["api"]["type"],
): RegistryModelConfig {
  const properties = options.properties ?? createTestModelProperties();
  const input = properties.inputFormat;
  const output = properties.outputFormat;
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      ...properties,
      inputFormat: new ModelInputFormatConfig(input),
      outputFormat: new ModelOutputFormatConfig(output),
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      maxOutputTokens: {
        ...(options.optionSpecs?.maxOutputTokens ?? {
          max: 1_000_000,
        }),
        map: options.optionSpecs?.maxOutputTokens.map ?? maxOutputTokensMap(apiType),
      },
      reasoningLevel: options.optionSpecs?.reasoningLevel
        ? {
            ...options.optionSpecs.reasoningLevel,
            map:
              options.optionSpecs.reasoningLevel.map ??
              enumOptionMap(
                Object.fromEntries(
                  options.optionSpecs.reasoningLevel.values.map((value) => [value, {}]),
                ),
              ),
          }
        : {
            values: ["disabled"],
            map: "{}",
          },
    }),
  }) as RegistryModelConfig;
}

function maxOutputTokensMap(apiType: RegistryProviderConfig["api"]["type"]): string {
  switch (apiType) {
    case "anthropic-messages":
      return '{"max_tokens": maxOutputTokens}';
    case "openai-chat-completions":
      return '{"max_completion_tokens": maxOutputTokens}';
    case "openai-responses":
      return '{"max_output_tokens": maxOutputTokens}';
  }
}

function defaultOptionSpecs(apiType: RegistryProviderConfig["api"]["type"]) {
  return {
    reasoningLevel: {
      values: ["disabled"],
      map: "{}",
    },
    maxOutputTokens: {
      map: maxOutputTokensMap(apiType),
    },
  };
}

function enumOptionMap(mapping: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(mapping);
  return entries.reduceRight(
    (fallback, [value, parameters]) =>
      `reasoningLevel == ${JSON.stringify(value)} ? ${JSON.stringify(parameters)} : ${fallback}`,
    "{}",
  );
}

function toRegistryProviderConfig(
  providerId: string,
  source: LegacyTestProviderConfig,
  accountMode?: ZhipuAccountMode,
): RegistryProviderConfig {
  const effectiveAccountMode = accountMode ?? source.accountMode;
  const apiType =
    source.kind === "anthropic"
      ? "anthropic-messages"
      : source.kind === "openai"
        ? "openai-responses"
        : "openai-chat-completions";
  return new ProviderConfig({
    access: effectiveAccountMode
      ? new ZhipuAccountAccessConfig({
          accountType: "zai",
          mode: effectiveAccountMode,
        })
      : source.apiKey
        ? new ApiKeyAccessConfig({ apiKey: source.apiKey })
        : new ApiKeyAccessConfig({ apiKey: "test-api-key" }),
    api: new ProviderApiConfig({
      baseUrl: source.baseURL ?? "https://adapter.test/v1",
      headers: source.headers,
      type: apiType,
    }),
    builtinModelIds: [],
    enabled: true,
    id: providerId,
    personalModelIds: [],
    name: source.name ?? providerId,
    visibility: "visible",
  }) as RegistryProviderConfig;
}

function parseTestSelection(selection: ModelSelection | string, defaultProvider?: string) {
  if (typeof selection !== "string") {
    return { modelId: selection.modelId, providerId: selection.providerId };
  }
  const value = selection;
  const separator = value.indexOf("/");
  if (separator < 0) {
    if (!defaultProvider) throw new Error(`Test model requires provider id: ${value}`);
    return { modelId: value, providerId: defaultProvider };
  }
  return { modelId: value.slice(separator + 1), providerId: value.slice(0, separator) };
}
