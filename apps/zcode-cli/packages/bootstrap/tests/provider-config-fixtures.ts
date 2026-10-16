import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  type ModelId,
  type ProviderApiType,
  type ZhipuAccountMode,
} from "@zcode/provider";

interface CommonProviderFixtureInput {
  readonly label?: string | null;
  readonly apiFormat?: ProviderApiType | null;
  readonly baseURL?: string | null;
  readonly headers?: Readonly<Record<string, string>> | null;
  readonly models?: readonly ModelId[] | null;
  readonly enabled?: boolean | null;
}

export function createApiKeyProviderConfig(
  input: CommonProviderFixtureInput & {
    readonly apiKey?: string | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    access: new ApiKeyAccessConfig({ apiKey: input.apiKey }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    personalModelIds: [],
    enabled: input.enabled ?? true,
    visibility: "visible",
  });
}

export function createAccountProviderConfig(
  input: CommonProviderFixtureInput & {
    readonly family?: "zai" | "bigmodel" | null;
    readonly mode?: ZhipuAccountMode | null;
  } = {},
): ProviderConfig {
  return new ProviderConfig({
    label: input.label,
    access: new ZhipuAccountAccessConfig({
      family: input.family ?? "zai",
      mode: input.mode ?? "individual-coding-plan",
    }),
    api: createProviderApi(input),
    builtinModelIds: input.models,
    personalModelIds: [],
    enabled: input.enabled ?? true,
    visibility: "visible",
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
