import { BUILTIN_MODEL_PROVIDER_IDS, type AppSettings, type OAuthProviderId } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { ensureProviderFamilyDomainMigration } from "@/lib/providerFamilyDomainMigration.js";
import { resolveLogoutProviderFamilyDomain } from "@/lib/providerFamilyDomainSettings.js";

function createSelectableProvider(providerId: string, kind: "api" | "account" = "api") {
  return {
    providerId,
    config: {
      access:
        kind === "api"
          ? { type: "api-key" as const, apiKey: "test-key" }
          : {
              type: "zhipu-account" as const,
              family: "bigmodel" as const,
              planKind: "individual-coding-plan" as const,
            },
    },
    models: [],
  };
}

function createServices(params: {
  settings?: Partial<AppSettings>;
  activeProvider?: OAuthProviderId | null;
  selectableProviderIds?: string[];
}) {
  const update = vi.fn(async (_patch: Partial<AppSettings>) => {});
  return {
    settingService: {
      get: vi.fn(async () => ({
        recentProjects: [],
        locale: "zh-CN" as const,
        modelProviderFamilyModes: {},
        providerFamilyDomainMigrated: false,
        ...params.settings,
      })),
      update,
    },
    oauthService: {
      getActiveProvider: vi.fn(async () => params.activeProvider ?? null),
    },
    modelSelectionService: {
      getView: vi.fn(async () => ({
        revision: 1,
        providers: (params.selectableProviderIds ?? []).map((providerId) => ({
          providerId,
          config: {
            access: { type: "api-key" as const, apiKey: "test-key" },
          },
          models: [],
        })),
      })),
    },
    update,
  };
}

describe("ensureProviderFamilyDomainMigration", () => {
  it("从旧 active OAuth provider 迁移 providerFamilyDomain", async () => {
    const services = createServices({ activeProvider: "zai" });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomain: "zai",
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("没有 active OAuth 时从唯一可用 Account Provider 推断", async () => {
    const services = createServices({
      selectableProviderIds: [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomain: "zai",
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("两边都有可用凭据时只标记已迁移，不猜测 domain", async () => {
    const services = createServices({
      selectableProviderIds: [
        BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      ],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        providerFamilyDomain: expect.any(String),
      }),
    );
    expect(services.update).toHaveBeenCalledWith(
      expect.objectContaining({
        providerFamilyDomainMigrated: true,
      }),
    );
  });

  it("active provider 和 provider 缓存都未恢复时暂不标记已迁移", async () => {
    const services = createServices({
      activeProvider: null,
      selectableProviderIds: [],
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).not.toHaveBeenCalled();
  });

  it("已有 providerFamilyDomain 时不重复迁移", async () => {
    const services = createServices({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyDomainMigrated: true,
      },
      activeProvider: "zai",
    });

    await ensureProviderFamilyDomainMigration(services);

    expect(services.update).not.toHaveBeenCalled();
  });
});

describe("resolveLogoutProviderFamilyDomain", () => {
  it("登出时当前 domain 只有 Account Provider 则清理 domain", () => {
    expect(
      resolveLogoutProviderFamilyDomain({
        currentDomain: "bigmodel",
        selectableProviders: [
          createSelectableProvider(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            "account",
          ),
        ],
      }),
    ).toBeNull();
  });
});
