import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type ZCodeProviderAccountAccess } from "@zcode/shared";
import {
  AccountRequestCredentialUnavailableError,
  createAccountProviderRequestAuthService,
} from "../src/model-provider/accountProviderRequestAuthService.js";

function createService(overrides: Record<string, unknown> = {}) {
  return createAccountProviderRequestAuthService({
    resolveCurrentAccountAccess: vi.fn(async (access: ZCodeProviderAccountAccess) => ({
      type: "zhipu-account" as const,
      family: access.accountType,
      planKind: access.mode === "off-peak" ? ("individual-coding-plan" as const) : access.mode,
    })),
    loadOAuthTokenSet: vi.fn(async () => ({ accessToken: "oauth", zcodeJwtToken: "jwt" })),
    loadIndividualPlanMaterial: vi.fn(async () => null),
    resolveTeamPlanMaterial: vi.fn(async () => null),
    ...overrides,
  } as never);
}

function individualAccess(): ZCodeProviderAccountAccess {
  return {
    type: "zhipu-account",
    accountType: "zai",
    mode: "individual-coding-plan",
  };
}

describe("AccountProviderRequestAuthService", () => {
  it("reads the provider-specific zcode jwt for start plan requests", async () => {
    const loadOAuthTokenSet = vi.fn(async () => ({ zcodeJwtToken: "zai-zcode-jwt" }));
    const service = createService({ loadOAuthTokenSet });
    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "start-plan",
        },
        reason: "model-request",
      }),
    ).resolves.toEqual({ apiKey: "zai-zcode-jwt" });
    expect(loadOAuthTokenSet).toHaveBeenCalledWith("zai");
  });

  it("reads the latest individual coding plan key for every request", async () => {
    const loadIndividualPlanMaterial = vi
      .fn()
      .mockResolvedValueOnce({ token: "key-v1", apiKeyId: "id-key-v1" })
      .mockResolvedValueOnce({ token: "key-v2", apiKeyId: "id-key-v2" });
    const service = createService({ loadIndividualPlanMaterial });
    const input = {
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      accountAccess: individualAccess(),
      reason: "model-request" as const,
    };
    await expect(service.resolveCurrent(input)).resolves.toMatchObject({
      apiKey: "key-v1",
      apiKeyId: "id-key-v1",
      accountScope: expect.any(String),
    });
    await expect(service.resolveCurrent(input)).resolves.toMatchObject({
      apiKey: "key-v2",
      apiKeyId: "id-key-v2",
      accountScope: expect.any(String),
    });
    expect(loadIndividualPlanMaterial).toHaveBeenCalledWith(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      "zai",
      undefined,
    );
  });

  it("passes the complete team access to the team key resolver", async () => {
    const providerAccess = {
      type: "zhipu-account" as const,
      accountType: "bigmodel" as const,
      mode: "team-coding-plan" as const,
    };
    const currentAccess = {
      type: "zhipu-account" as const,
      family: "bigmodel" as const,
      planKind: "team-coding-plan" as const,
      productId: "product-a",
      organizationId: "organization-a",
      projectId: "project-a",
    };
    const resolveTeamPlanMaterial = vi.fn(async () => ({
      token: "team-project-key",
      apiKeyId: "id-team-project-key",
    }));
    const service = createService({
      resolveCurrentAccountAccess: vi.fn(async () => currentAccess),
      resolveTeamPlanMaterial,
    });
    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccess: providerAccess,
        reason: "model-request",
      }),
    ).resolves.toMatchObject({
      apiKey: "team-project-key",
      apiKeyId: "id-team-project-key",
      accountScope: expect.any(String),
    });
    expect(resolveTeamPlanMaterial).toHaveBeenCalledWith(currentAccess, undefined);
  });

  it("当前连接与 Active Model 的静态 access 不兼容时 fail-closed", async () => {
    const resolveCurrentAccountAccess = vi.fn(async () => null);
    const service = createService({ resolveCurrentAccountAccess });
    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        accountAccess: individualAccess(),
        reason: "model-request",
      }),
    ).rejects.toBeInstanceOf(AccountRequestCredentialUnavailableError);
    expect(resolveCurrentAccountAccess).toHaveBeenCalledWith(individualAccess());
  });

  it("uses a typed error when the selected access has no request credential", async () => {
    const service = createService();
    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountAccess: individualAccess(),
        reason: "off-peak",
      }),
    ).rejects.toBeInstanceOf(AccountRequestCredentialUnavailableError);
  });

  it("does not read credentials when no compatible current account exists", async () => {
    const loadIndividualPlanMaterial = vi.fn(async () => ({
      token: "new-account-key",
      apiKeyId: "id-new-account-key",
    }));
    const service = createService({
      resolveCurrentAccountAccess: vi.fn(async () => null),
      loadIndividualPlanMaterial,
    });
    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountAccess: individualAccess(),
        reason: "model-request",
      }),
    ).rejects.toBeInstanceOf(AccountRequestCredentialUnavailableError);
    expect(loadIndividualPlanMaterial).not.toHaveBeenCalled();
  });

  it("非 Model 当前态请求同样解析当前兼容连接", async () => {
    const resolveCurrentAccountAccess = vi.fn(async () => ({
      type: "zhipu-account" as const,
      family: "zai" as const,
      planKind: "individual-coding-plan" as const,
    }));
    const loadIndividualPlanMaterial = vi.fn(async () => ({
      token: "current-key",
      apiKeyId: "id-current-key",
    }));
    const service = createService({ resolveCurrentAccountAccess, loadIndividualPlanMaterial });

    await expect(
      service.resolveCurrent({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountAccess: individualAccess(),
        reason: "usage",
      }),
    ).resolves.toEqual({ apiKey: "current-key", apiKeyId: "id-current-key" });
    expect(resolveCurrentAccountAccess).toHaveBeenCalledOnce();
  });
});
