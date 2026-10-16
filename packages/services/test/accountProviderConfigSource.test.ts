import {
  ModelConfigRules,
  ProviderConfigMap,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { createAccountProviderConfigSource } from "../src/model-provider/accountProviderConnectionResolver.js";
import { createAccountProviderCredentialService } from "../src/model-provider/accountProviderCredentialService.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

class StaticConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  async read(): Promise<ProviderConfigSnapshot> {
    return {
      revision: "config-1",
      zcodeBuiltinRevision: "builtin-1",
      personalRevision: "personal-1",
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          createAccountProviderConfig({
            accountType: "zai",
            mode: "individual-coding-plan",
            models: ["GLM-5.2"],
          }),
        ],
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
          createAccountProviderConfig({
            accountType: "zai",
            mode: "start-plan",
            models: ["GLM-5-Turbo"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: ModelConfigRules.empty(),
    };
  }

  onDidChange(): () => void {
    return () => {};
  }
}

describe("createAccountProviderConfigSource", () => {
  it.each([
    ["oauth-login-entitlement", true],
    ["settings:oauth-login-entitlement", true],
    ["settings:oauth-callback", true],
    ["settings:settings-manual", false],
    ["settings:oauth-restore-entitlement", false],
    ["settings:not-oauth-login-entitlement", false],
  ] as const)("刷新 %s 时无旧 Key Store 也能恢复账号 Token", async (reason, _shouldRefresh) => {
    const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
    const resolveProviderMaterial = vi.fn(async () => ({
      token: "fresh-key",
      apiKeyId: "id-fresh-key",
      organizationId: "org",
      projectId: "proj",
    }));
    const credentials = createAccountProviderCredentialService({
      loadOAuthAccessToken: async () => "new-login-token",
      resolveProviderMaterial,
    });
    const source = createAccountProviderConfigSource({
      configSource: new StaticConfigSource(),
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadAccountIdentity: async () => "same-account",
      loadCodingPlanApiKey: (id, family, accountIdentity, forceRefresh) =>
        id === providerId
          ? credentials.loadCodingPlanApiKey({
              providerId: id,
              family,
              accountIdentity,
              forceRefresh,
            })
          : Promise.resolve(null),
      resolveFamilyAvailability: async ({ providers }) => ({
        [providerId]:
          providers.find((p) => p.providerId === providerId)?.apiKey === "fresh-key"
            ? { kind: "available" as const }
            : {
                kind: "unavailable" as const,
                reason: "coding_plan_auth_failed" as const,
              },
      }),
    });
    try {
      expect((await source.read()).states[providerId]).toMatchObject({
        availability: "available",
      });
      await source.refresh(reason);
      expect(resolveProviderMaterial).toHaveBeenCalledTimes(2);
      expect(resolveProviderMaterial).toHaveBeenCalledWith(
        "zai",
        "new-login-token",
        "same-account",
        undefined,
      );
      expect((await source.read()).states[providerId]).toMatchObject({
        availability: "available",
        entitled: true,
      });
    } finally {
      source.dispose();
    }
  });

  it("直接从 Config 与账号连接结果产生第三层 Account Config", async () => {
    const resolveFamilyAvailability = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        kind: "available" as const,
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        kind: "available" as const,
        models: ["remote-start-model"],
      },
    }));
    const loadCodingPlanApiKey = vi.fn(
      async (providerId: string, _family: string, accountIdentity: string) =>
        providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
          ? `personal-key:${accountIdentity}`
          : null,
    );
    const source = createAccountProviderConfigSource({
      configSource: new StaticConfigSource(),
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey,
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability,
    });

    await expect(source.read()).resolves.toMatchObject({
      providers: expect.any(ProviderConfigMap),
    });
    expect(
      Object.fromEntries(
        (await source.read()).providers.entries().map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        access: { type: "zhipu-account", entitled: true },
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        // 未选中不等于没有权益；current 由状态层隔离，不能反写为未授权。
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["remote-start-model"],
      },
    });
    expect((await source.read()).states).toMatchObject({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        availability: "available",
        entitled: true,
        current: true,
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        availability: "available",
        entitled: true,
        current: true,
      },
    });
    expect(resolveFamilyAvailability).toHaveBeenCalledTimes(1);
    expect(resolveFamilyAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            apiKey: "personal-key:account-a",
          }),
        ]),
      }),
    );

    await source.refresh("oauth-login-entitlement");
    expect(loadCodingPlanApiKey).toHaveBeenCalledWith(
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      "zai",
      "account-a",
      true,
    );

    source.dispose();
  });
});
