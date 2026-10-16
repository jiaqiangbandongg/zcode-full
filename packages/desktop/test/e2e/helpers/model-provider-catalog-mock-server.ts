export const SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION =
  "e2e-subagent-login-catalog-pre-login-v1";
export const SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION = "e2e-subagent-login-catalog-v1";

export const MODEL_PROVIDER_CATALOG_PAYLOAD = {
  code: 0,
  data: {
    builtinModels: [
      {
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        modelId: "GLM-5.2",
        name: "GLM-5.2",
        reasoning: {
          defaultLevel: "max",
          levels: {
            max: {
              anthropic: {
                set: [
                  { path: ["effort"], value: "max" },
                  {
                    path: ["thinking"],
                    value: { budgetTokens: 32_000, type: "enabled" },
                  },
                ],
              },
            },
            high: {
              anthropic: {
                set: [
                  { path: ["effort"], value: "high" },
                  {
                    path: ["thinking"],
                    value: { budgetTokens: 16_000, type: "enabled" },
                  },
                ],
              },
            },
            nothink: {
              anthropic: {
                set: [{ path: ["thinking"], value: { type: "disabled" } }],
                unset: [{ path: ["effort"] }],
              },
            },
          },
        },
      },
      {
        contextWindow: 1_048_576,
        maxCompletionTokens: 131_072,
        modelId: "glm-5.2-highspeed-e2e",
        name: "GLM-5.2 Highspeed E2E",
      },
      {
        contextWindow: 2_000_000,
        maxCompletionTokens: 131_072,
        modelId: "GLM-5-Turbo",
        name: "GLM-5-Turbo",
        reasoning: {
          defaultLevel: "enabled",
          levels: {
            enabled: {
              anthropic: {
                set: [
                  {
                    path: ["thinking"],
                    value: { budgetTokens: 1_024, type: "enabled" },
                  },
                ],
              },
            },
            off: {
              anthropic: {
                set: [{ path: ["thinking"], value: { type: "disabled" } }],
              },
            },
          },
        },
      },
    ],
    builtinProviders: [
      {
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        defaultModel: "GLM-5.2",
        id: "account:bigmodel-individual-coding-plan",
        models: ["GLM-5.2", "glm-5.2-highspeed-e2e", "GLM-5-Turbo"],
        name: "BigModel Coding Plan E2E",
        schema: "anthropic",
      },
      {
        baseUrl: "https://open.bigmodel.cn/api/anthropic",
        defaultModel: "GLM-5.2",
        id: "bigmodel-api",
        models: ["GLM-5.2", "GLM-5-Turbo"],
        name: "BigModel E2E",
        schema: "anthropic",
      },
    ],
    configs: {},
  },
  msg: "",
} as const;

export function resolveSubagentLoginCatalogConfigVersion(oauthTokenIssued: boolean): string {
  return oauthTokenIssued
    ? SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION
    : SUBAGENT_LOGIN_CATALOG_PRE_LOGIN_CONFIG_VERSION;
}

export function resolveSubagentLoginCatalogPayload(params: {
  configVersion: string | null;
  oauthTokenIssued: boolean;
}) {
  const configVersion = params.configVersion?.trim() ?? "";
  const includesCodingPlan = configVersion
    ? configVersion === SUBAGENT_LOGIN_CATALOG_POST_LOGIN_CONFIG_VERSION
    : params.oauthTokenIssued;
  if (includesCodingPlan) {
    return MODEL_PROVIDER_CATALOG_PAYLOAD;
  }
  return {
    ...MODEL_PROVIDER_CATALOG_PAYLOAD,
    data: {
      ...MODEL_PROVIDER_CATALOG_PAYLOAD.data,
      builtinProviders: MODEL_PROVIDER_CATALOG_PAYLOAD.data.builtinProviders.filter(
        (provider) => provider.id !== "account:bigmodel-individual-coding-plan",
      ),
    },
  };
}
