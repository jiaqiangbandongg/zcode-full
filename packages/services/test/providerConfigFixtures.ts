import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderApiType,
  type ProviderLogoRef,
  type ZhipuAccountMode,
} from "@zcode/provider";

interface CommonProviderFixtureInput {
  readonly label?: string | null;
  readonly logo?: ProviderLogoRef | null;
  readonly apiFormat?: ProviderApiType | null;
  readonly baseURL?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly models?: readonly ModelId[] | null;
  readonly enabled?: boolean | null;
}

export function createApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    apiKey?: string | null;
    apiKeyManagementUrl?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    logo: input.logo,
    access: new ApiKeyAccessConfig({
      apiKey: input.apiKey,
      apiKeyManagementUrl: input.apiKeyManagementUrl,
    }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    enabled: input.enabled,
  });
}

export function createAccountProviderConfig(
  input: CommonProviderFixtureInput & {
    accountType?: "zai" | "bigmodel";
    mode?: ZhipuAccountMode;
    entitled?: boolean | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    logo: input.logo,
    access: new ZhipuAccountAccessConfig({
      accountType: input.accountType ?? "zai",
      mode: input.mode ?? "individual-coding-plan",
      entitled: input.entitled,
    }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    enabled: input.enabled,
  });
}

export function createCompleteApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    apiKey?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    logo: input.logo,
    access: new ApiKeyAccessConfig({ apiKey: input.apiKey }),
    api: new ProviderApiConfig({
      type: input.apiFormat ?? "anthropic-messages",
      baseUrl: input.baseURL ?? "https://api.example.com",
      headers: input.headers,
    }),
    builtinModelIds: input.models,
    enabled: input.enabled,
  });
}

function createProviderApi(input: CommonProviderFixtureInput): ProviderApiConfig | undefined {
  return input.apiFormat !== undefined || input.baseURL !== undefined || input.headers !== undefined
    ? new ProviderApiConfig({
        type: input.apiFormat,
        baseUrl: input.baseURL,
        headers: input.headers,
      })
    : undefined;
}
