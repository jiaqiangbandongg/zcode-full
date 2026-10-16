import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type AppSettings,
  type ZCodeAccountAccess,
} from "@zcode/shared";
import {
  OffPeakCodingPlanUnavailableError,
  OffPeakCredentialsUnavailableError,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  buildOffPeakRequestAuth,
  resolveOffPeakCodingPlanSupport,
  resolveOffPeakCredentials,
} from "../src/session/offPeakRuntimeModel.js";

describe("buildOffPeakRequestAuth", () => {
  it("只生成逐请求鉴权材料，不携带 Provider 或 Model 静态事实", () => {
    const requestAuth = buildOffPeakRequestAuth({
      credentials: {
        jwt: "zcode-jwt",
        codingPlanApiKey: "coding-plan-key",
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      },
      ticketId: "ticket-1",
    });

    expect(requestAuth).toEqual({
      apiKey: "zcode-jwt",
      headers: {
        Authorization: "Bearer zcode-jwt",
        "X-Coding-Plan-Api-Key": "coding-plan-key",
        "X-Off-Peak-Ticket-ID": "ticket-1",
      },
    });
    expect(requestAuth).not.toHaveProperty("baseURL");
    expect(requestAuth).not.toHaveProperty("model");
    expect(requestAuth).not.toHaveProperty("reasoning");
    expect(requestAuth).not.toHaveProperty("properties");
  });
});

describe("OffPeak permanent dispatch errors", () => {
  it("只用类型表达确定性模型/凭证配置错误", () => {
    expect(new OffPeakModelUnavailableError("workspaceUser")).toBeInstanceOf(
      OffPeakPermanentDispatchError,
    );
    expect(new OffPeakCredentialsUnavailableError("jwt")).toBeInstanceOf(
      OffPeakPermanentDispatchError,
    );
    expect(new Error("network unavailable")).not.toBeInstanceOf(OffPeakPermanentDispatchError);
  });
});

type CredentialSettings = Pick<
  AppSettings,
  "providerFamilyConnectionSelections" | "providerFamilyDomain"
>;

function accountProvider(
  providerId: string,
  access: ZCodeAccountAccess,
  apiKey: string,
  baseURL = "https://coding.example.test",
): AccountProviderFixture {
  return {
    providerId,
    access,
    apiKey,
    baseURL,
  };
}

interface AccountProviderFixture {
  readonly providerId: string;
  readonly access: ZCodeAccountAccess;
  readonly apiKey: string;
  readonly baseURL?: string;
}

function individualAccess(family: "zai" | "bigmodel"): ZCodeAccountAccess {
  return {
    type: "zhipu-account",
    family,
    planKind: "individual-coding-plan",
  };
}

function credentialDeps(params: {
  settings: CredentialSettings | CredentialSettings[];
  accountProviders: AccountProviderFixture | null | Array<AccountProviderFixture | null>;
  activeProvider?: string | null;
  jwt?: string | null;
  accountScope?: string;
}) {
  const providerSequence = Array.isArray(params.accountProviders)
    ? [...params.accountProviders]
    : null;
  const fallbackProvider = Array.isArray(params.accountProviders)
    ? (params.accountProviders.at(-1) ?? null)
    : params.accountProviders;
  let currentProvider = fallbackProvider;
  return {
    credentialService: {
      load: async (key: string) =>
        key === "oauth:active_provider"
          ? params.activeProvider === undefined
            ? (currentProvider?.access.family ?? null)
            : params.activeProvider
          : params.jwt === undefined
            ? "zcode-jwt"
            : params.jwt,
    },
    resolveAccountProvider: async () => {
      currentProvider = providerSequence?.shift() ?? fallbackProvider;
      return currentProvider
        ? {
            providerId: currentProvider.providerId,
            access: currentProvider.access,
            ...(currentProvider.baseURL ? { baseURL: currentProvider.baseURL } : {}),
          }
        : null;
    },
    accountRequestAuthService: {
      resolveCurrent: async () =>
        currentProvider
          ? { apiKey: currentProvider.apiKey, accountScope: params.accountScope }
          : {},
    },
    env: {} as NodeJS.ProcessEnv,
  };
}

describe("resolveOffPeakCredentials selected Coding Plan matrix", () => {
  it("派发时将 owner 的账号作用域传到私有 requestAuth，供后续请求刷新校验", async () => {
    const accountScope = "a".repeat(64);
    const credentials = await resolveOffPeakCredentials(
      credentialDeps({
        settings: {},
        accountScope,
        accountProviders: accountProvider(
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          individualAccess("bigmodel"),
          "initial-pat",
        ),
      }),
    );
    const auth = buildOffPeakRequestAuth({ credentials, ticketId: "ticket-1" });
    expect(auth.accountScope).toBe(accountScope);
    expect(auth.headers["X-Off-Peak-Ticket-ID"]).toBe("ticket-1");
    expect(auth.headers).not.toHaveProperty("accountScope");
  });

  it.each([
    {
      name: "ZAI personal",
      family: "zai" as const,
      selection: { kind: "individual-coding-plan" } as const,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      apiKey: "zai-coding-key",
      kind: "zai-personal" as const,
    },
    {
      // 修复原因：zai/bigmodel Team Plan 对称化。原 offPeakRuntimeModel 对 zai team key
      // 直接 throw connection_unavailable，zai 团队用户无法走后台任务。锁定 zai-team 正常解析。
      name: "ZAI Team",
      family: "zai" as const,
      selection: {
        kind: "team-coding-plan",
        productId: "team-pro",
        organizationId: "org-zai",
        projectId: "project-zai",
      } as const,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
      apiKey: "zai-team-api-key.zai-team-secret",
      kind: "zai-team" as const,
    },
    {
      name: "BigModel personal",
      family: "bigmodel" as const,
      selection: { kind: "individual-coding-plan" } as const,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      apiKey: "bigmodel-personal-key",
      kind: "bigmodel-personal" as const,
    },
    {
      name: "BigModel Team",
      family: "bigmodel" as const,
      selection: {
        kind: "team-coding-plan",
        productId: "team-pro",
        organizationId: "org-1",
        projectId: "project-1",
      } as const,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      apiKey: "team-api-key.team-secret-key",
      kind: "bigmodel-team" as const,
    },
  ])("$name resolves the exact selected runtime credential", async (scenario) => {
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: scenario.family,
        providerFamilyConnectionSelections: {
          [scenario.family]: scenario.selection,
        },
      },
      accountProviders: accountProvider(
        scenario.providerId,
        {
          type: "zhipu-account",
          family: scenario.family,
          planKind: scenario.selection.kind,
          ...(scenario.selection.kind === "team-coding-plan"
            ? {
                productId: scenario.selection.productId,
                organizationId: scenario.selection.organizationId,
                projectId: scenario.selection.projectId,
              }
            : {}),
        } as ZCodeAccountAccess,
        scenario.apiKey,
      ),
    });

    const credentials = await resolveOffPeakCredentials(deps);
    expect(credentials).toMatchObject({
      jwt: "zcode-jwt",
      codingPlanApiKey: scenario.apiKey,
      kind: scenario.kind,
      providerFamily: scenario.family,
      providerId: scenario.providerId,
    });
    await expect(resolveOffPeakCodingPlanSupport(deps)).resolves.toEqual({
      supported: true,
      kind: scenario.kind,
      providerFamily: scenario.family,
      providerId: scenario.providerId,
    });

    const requestAuth = buildOffPeakRequestAuth({
      credentials,
      ticketId: "ticket-1",
    });
    expect(requestAuth.headers).toMatchObject({
      Authorization: "Bearer zcode-jwt",
      "X-Coding-Plan-Api-Key": scenario.apiKey,
      "X-Off-Peak-Ticket-ID": "ticket-1",
    });
  });

  it("BigModel Team 从结构化连接快照向 messages 注入 organization/project", async () => {
    const selection = {
      kind: "team-coding-plan",
      productId: "team-pro",
      organizationId: "org-1",
      projectId: "project-1",
    } as const;
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: { bigmodel: selection },
      },
      accountProviders: accountProvider(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: selection.productId,
          organizationId: selection.organizationId,
          projectId: selection.projectId,
        },
        "team-api-key.team-secret-key",
      ),
    });

    const credentials = await resolveOffPeakCredentials(deps);
    expect(credentials).toMatchObject({
      kind: "bigmodel-team",
      organizationId: "org-1",
      projectId: "project-1",
    });
    const requestAuth = buildOffPeakRequestAuth({
      credentials,
      ticketId: "ticket-1",
    });
    expect(requestAuth.headers).toMatchObject({
      "bigmodel-organization": "org-1",
      "bigmodel-project": "project-1",
    });
  });

  it("rejects Start Plan even when another cached Coding Plan key exists", async () => {
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: "zai",
        providerFamilyConnectionSelections: { zai: { kind: "start-plan" } },
      },
      accountProviders: accountProvider(
        BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        {
          type: "zhipu-account",
          family: "zai",
          planKind: "start-plan",
        },
        "unselected-coding-key",
      ),
    });

    const error = await resolveOffPeakCredentials(deps).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OffPeakCodingPlanUnavailableError);
    expect((error as OffPeakCodingPlanUnavailableError).reason).toBe("start_plan_not_supported");
  });

  it("rejects when Effective Config has no current Coding Plan Account Access", async () => {
    const deps = credentialDeps({
      settings: {},
      accountProviders: null,
    });
    await expect(resolveOffPeakCodingPlanSupport(deps)).resolves.toEqual({
      supported: false,
      reason: "connection_unavailable",
    });
  });

  it("rejects a missing JWT before exposing a supported snapshot", async () => {
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      },
      accountProviders: accountProvider(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        individualAccess("bigmodel"),
        "coding-key",
      ),
      jwt: null,
    });
    await expect(resolveOffPeakCodingPlanSupport(deps)).resolves.toEqual({
      supported: false,
      reason: "jwt_missing",
    });
  });

  it("reports the selected connection unavailable when its request credential is missing", async () => {
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      },
      accountProviders: accountProvider(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        individualAccess("bigmodel"),
        "",
      ),
    });

    await expect(resolveOffPeakCodingPlanSupport(deps)).resolves.toEqual({
      supported: false,
      reason: "connection_unavailable",
    });
  });

  it.each([
    { name: "missing", activeProvider: null },
    { name: "different", activeProvider: "zai" },
  ])("rejects a $name active JWT provider identity", async ({ activeProvider }) => {
    const deps = credentialDeps({
      settings: {
        providerFamilyDomain: "bigmodel",
        providerFamilyConnectionSelections: {
          bigmodel: { kind: "individual-coding-plan" },
        },
      },
      activeProvider,
      accountProviders: accountProvider(
        BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        individualAccess("bigmodel"),
        "bigmodel-coding-key",
      ),
    });
    await expect(resolveOffPeakCodingPlanSupport(deps)).resolves.toEqual({
      supported: false,
      reason: "provider_identity_mismatch",
    });
  });

  it("retries when selection changes during resolution and never mixes two selections", async () => {
    const zaiSettings: CredentialSettings = {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
    };
    const bigmodelSettings: CredentialSettings = {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {
        bigmodel: { kind: "individual-coding-plan" },
      },
    };
    const deps = credentialDeps({
      settings: [zaiSettings, bigmodelSettings, bigmodelSettings, bigmodelSettings],
      accountProviders: [
        accountProvider(
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          individualAccess("zai"),
          "zai-key",
        ),
        accountProvider(
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          individualAccess("bigmodel"),
          "bigmodel-key",
        ),
      ],
    });

    await expect(resolveOffPeakCredentials(deps)).resolves.toMatchObject({
      providerFamily: "bigmodel",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      codingPlanApiKey: "bigmodel-key",
    });
  });
});
