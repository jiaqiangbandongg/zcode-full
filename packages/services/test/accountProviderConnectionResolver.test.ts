import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  createAccountProviderConfigResolver,
} from "@zcode/provider";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  migrateLegacyModelProviderId,
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountProviderConnectionResolver,
  createCodingPlanFamilyAvailabilityResolver,
  resolveCurrentAccountAccess,
  type AccountProviderFamilyAvailabilityResolver,
} from "../src/model-provider/accountProviderConnectionResolver.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

function configuredProviders(options: { bigmodelTeam?: boolean } = {}): ProviderConfigMap {
  return new ProviderConfigMap([
    [
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      createAccountProviderConfig({
        accountType: "zai",
        mode: "individual-coding-plan",
        models: ["zai-coding"],
      }),
    ],
    [
      BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      createAccountProviderConfig({
        accountType: "zai",
        mode: "start-plan",
        models: ["zai-start"],
      }),
    ],
    [
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      createAccountProviderConfig({
        accountType: "bigmodel",
        mode: "individual-coding-plan",
        models: ["bigmodel-coding"],
      }),
    ],
    ...(options.bigmodelTeam
      ? ([
          [
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            createAccountProviderConfig({
              accountType: "bigmodel",
              mode: "team-coding-plan",
              models: ["bigmodel-team"],
            }),
          ],
        ] as const)
      : []),
    [
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      createAccountProviderConfig({
        accountType: "bigmodel",
        mode: "start-plan",
        models: ["bigmodel-start"],
      }),
    ],
  ]);
}

describe("createAccountProviderConnectionResolver", () => {
  it("Start 与付费连接并存，切团队不改变 Start 身份，退出登录则失效", async () => {
    let identity: string | null = "account-a";
    let selections: import("@zcode/shared").ProviderFamilyConnectionSelectionSettings = {
      bigmodel: { kind: "individual-coding-plan" },
    };
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({ providerFamilyDomain: "bigmodel", selections }),
      loadAccountIdentity: async (family) => (family === "bigmodel" ? identity : null),
      loadCodingPlanApiKey: async () => null,
      resolveFamilyAvailability: async () => ({
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: { kind: "available", models: [] },
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: { kind: "available" },
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: { kind: "available" },
      }),
    });
    const input = {
      configRevision: "config",
      configuredProviders: configuredProviders({ bigmodelTeam: true }),
    };
    const first = await resolve(input);
    expect(first.filter((p) => p.current).map((p) => p.providerId)).toEqual([
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    ]);
    selections = {
      bigmodel: {
        kind: "team-coding-plan",
        organizationId: "org",
        projectId: "project",
        productId: "product",
      },
    };
    const second = await resolve(input);
    const start = (values: typeof first) =>
      values.find((p) => p.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan)!;
    expect(start(second).current).toBe(true);
    expect(start(second).connectionKey).toBe(start(first).connectionKey);
    expect(start(second).resetPrevious).toBeUndefined();
    selections = {};
    expect(start(await resolve(input)).current).toBe(true);
    identity = null;
    expect(start(await resolve(input))).toMatchObject({
      current: false,
      status: "unavailable",
      resetPrevious: true,
    });
  });

  it.each([
    undefined,
    { kind: "individual-coding-plan" as const },
    { kind: "start-plan" as const },
  ])("Start 请求不依赖套餐选择 %j，仍要求当前品牌与登录身份", async (selection) => {
    const input = {
      access: {
        type: "zhipu-account" as const,
        accountType: "bigmodel" as const,
        mode: "start-plan" as const,
      },
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel" as const,
        selections: selection ? { bigmodel: selection } : {},
      }),
      loadAccountIdentity: async () => "account-a",
    };
    await expect(resolveCurrentAccountAccess(input)).resolves.toEqual({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "start-plan",
    });
    await expect(
      resolveCurrentAccountAccess({ ...input, loadAccountIdentity: async () => null }),
    ).resolves.toBeNull();
    await expect(
      resolveCurrentAccountAccess({
        ...input,
        readSettings: async () => ({ providerFamilyDomain: "zai", selections: {} }),
      }),
    ).resolves.toBeNull();
  });

  it("真实账号缺 Key 保持权益未知，且不阻断另一个可用套餐", async () => {
    const configured = configuredProviders();
    const resolve = createAccountProviderConfigResolver(
      createAccountProviderConnectionResolver({
        readSettings: async () => ({
          providerFamilyDomain: "bigmodel",
          selections: { bigmodel: { kind: "individual-coding-plan" } },
        }),
        loadAccountIdentity: async () => "account",
        loadCodingPlanApiKey: async () => null,
        resolveFamilyAvailability: createCodingPlanFamilyAvailabilityResolver({
          credentialService: { load: async () => "local-login-info" },
          apiClient: {
            request: async () =>
              new Response(
                JSON.stringify({
                  code: 0,
                  success: true,
                  data: {
                    plans: [{ plan_id: "zcode-v3-start-plan", status: "active" }],
                    balances: [],
                  },
                }),
                { status: 200 },
              ),
          },
        }),
      }),
    );
    const result = await resolve({
      configRevision: "builtin-1",
      configuredProviders: configured,
      previousProviders: new ProviderConfigMap(),
    });
    const parsed = zcodeProviderUpdateAccountConfigParamsSchema.parse({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "builtin-1",
      providers: {},
      states: result.states,
    });
    for (const id of [
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    ]) {
      expect(parsed.states[id]).toMatchObject({
        availability: "unknown",
      });
    }
    expect(parsed.states[BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]).toMatchObject({
      availability: "available",
      entitled: true,
    });
  });
  it.each(["connection", "identity"] as const)(
    "查询期间变更 %s 时丢弃过期结果，不污染上次成功的 scope",
    async (change) => {
      let identity = "account-a";
      let settings: import("../src/model-provider/accountProviderConnectionResolver.js").AccountProviderConnectionSettings =
        {
          providerFamilyDomain: "bigmodel",
          selections: { bigmodel: { kind: "individual-coding-plan" } },
        };
      let release!: () => void;
      let entered!: () => void;
      const enteredGate = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let wait = false;
      const resolve = createAccountProviderConnectionResolver({
        readSettings: async () => settings,
        loadAccountIdentity: async (family) => (family === "bigmodel" ? identity : null),
        loadCodingPlanApiKey: async () => null,
        resolveFamilyAvailability: async () => {
          if (wait) {
            entered();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return {};
        },
      });
      const input = {
        configRevision: "config",
        configuredProviders: configuredProviders({ bigmodelTeam: true }),
      };
      await resolve(input);
      // 未发布的 B 查询不能把成功作用域 A 推进成 B。
      identity = "account-b";
      wait = true;
      const pending = resolve(input);
      await enteredGate;
      if (change === "identity") identity = "account-c";
      else
        settings = {
          ...settings,
          selections: {
            bigmodel: {
              kind: "team-coding-plan",
              organizationId: "org",
              productId: "product",
              projectId: "project",
            },
          },
        };
      release();
      await expect(pending).rejects.toThrow("账号查询期间");
      wait = false;
      identity = "account-b";
      const next = await resolve(input);
      expect(
        next.find(
          (entry) => entry.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        )?.resetPrevious,
      ).toBe(true);
    },
  );
  it("旧团队待补全只限制付费访问，Start 与其他 Family 继续查询", async () => {
    const availability = vi.fn<AccountProviderFamilyAvailabilityResolver>(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: { kind: "available", models: ["glm-5"] },
    }));
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {},
        unresolvedFamilies: ["bigmodel"],
      }),
      loadAccountIdentity: async () => "account",
      loadCodingPlanApiKey: async () => "key",
      resolveFamilyAvailability: availability,
    });
    const results = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders({ bigmodelTeam: true }),
    });
    expect(availability).toHaveBeenCalledTimes(2);
    expect(availability.mock.calls[1]?.[0].providers.map((p) => p.providerId)).toEqual([
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
    ]);
    expect(availability.mock.calls[0]?.[0]).toMatchObject({ family: "zai" });
    for (const result of results.filter((entry) =>
      entry.providerId.startsWith("account:bigmodel-"),
    )) {
      expect(result).toMatchObject({
        status:
          result.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
            ? "available"
            : "unknown",
        current: result.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      });
    }
  });
  it("切换账号后只清理该账号的旧权益，不把网络 unknown 当旧账号可用", async () => {
    let identity = "account-a";
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {},
      }),
      loadAccountIdentity: async (family) => (family === "bigmodel" ? identity : null),
      loadCodingPlanApiKey: async () => null,
      resolveFamilyAvailability: async () => ({}),
    });
    const input = {
      configRevision: "config",
      configuredProviders: configuredProviders(),
    };
    await resolve(input);
    identity = "account-b";
    expect(await resolve(input)).toContainEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      status: "unknown",
      connectionKey: expect.any(String),
      current: true,
      resetPrevious: true,
    });
    expect((await resolve(input)).some((entry) => entry.resetPrevious)).toBe(false);
  });
  it("把不可用原因随连接结果发布，供 UI 区分未开通与未连接", async () => {
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {},
      }),
      loadAccountIdentity: async (family) => (family === "bigmodel" ? "account" : null),
      loadCodingPlanApiKey: async () => null,
      resolveFamilyAvailability: async () => ({
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: {
          kind: "unavailable" as const,
          reason: "coding_plan_not_entitled" as const,
        },
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: {
          kind: "unavailable" as const,
          reason: "coding_plan_auth_failed" as const,
        },
      }),
    });

    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
    });

    // 修复原因：个人套餐"服务端明确无订阅"的原因曾在此丢失，UI 只能统一显示"未连接"。
    expect(result).toContainEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      status: "unavailable",
      unavailableReason: "not-entitled",
      connectionKey: expect.any(String),
      current: false,
    });
    expect(result).toContainEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      status: "unavailable",
      unavailableReason: "credential-failed",
      connectionKey: expect.any(String),
      current: true,
    });
  });
  it("可用结果不携带不可用原因", async () => {
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {},
      }),
      loadAccountIdentity: async (family) => (family === "bigmodel" ? "account" : null),
      loadCodingPlanApiKey: async () => null,
      resolveFamilyAvailability: async () => ({
        [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: {
          kind: "available" as const,
          models: [],
        },
      }),
    });

    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
    });

    const individual = result.find(
      (entry) => entry.providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(individual?.status).toBe("available");
    expect(individual).not.toHaveProperty("unavailableReason");
  });
  it("没有保存连接选择也查询已登录 Family 的 Start 权益；未选中不改写 availability", async () => {
    const resolveFamilyAvailability = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: {
        kind: "available" as const,
        models: [],
      },
    }));
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {},
      }),
      loadAccountIdentity: async (family) => (family === "bigmodel" ? "account" : null),
      loadCodingPlanApiKey: async () => null,
      resolveFamilyAvailability,
    });
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
    });
    expect(resolveFamilyAvailability).toHaveBeenCalledOnce();
    expect(result).toContainEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      status: "available",
      models: [],
      connectionKey: expect.any(String),
      current: true,
    });
  });
  it.each(["bigmodel", "zai"] as const)(
    "%s 登录连接仍单独解析，但不决定旧 Selection 迁移落点",
    async (family) => {
      const settings = {
        providerFamilyDomain: family,
        selections: {
          [family]: {
            kind: "team-coding-plan" as const,
            productId: "product",
            organizationId: "org",
            projectId: "project",
          },
        },
      };
      const input = {
        access: {
          type: "zhipu-account" as const,
          accountType: family,
          mode: "team-coding-plan" as const,
        },
        readSettings: async () => settings,
      };
      const connected = await resolveCurrentAccountAccess({
        ...input,
        loadAccountIdentity: async () => "account",
      });
      expect(connected?.planKind).toBe("team-coding-plan");
      expect(migrateLegacyModelProviderId(`builtin:${family}-coding-plan`)).toBe(
        `account:${family}-individual-coding-plan`,
      );
      const loggedOut = await resolveCurrentAccountAccess({
        ...input,
        loadAccountIdentity: async () => null,
      });
      expect(loggedOut).toBeNull();
      expect(migrateLegacyModelProviderId(`builtin:${family}-coding-plan`)).toBe(
        `account:${family}-individual-coding-plan`,
      );
    },
  );

  it("请求期从当前 Team 连接解析动态 scope", async () => {
    await expect(
      resolveCurrentAccountAccess({
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: "team-coding-plan",
        },
        readSettings: async () => ({
          providerFamilyDomain: "bigmodel",
          selections: {
            bigmodel: {
              kind: "team-coding-plan",
              productId: "product",
              organizationId: "org",
              projectId: "project",
            },
          },
        }),
        loadAccountIdentity: async () => "account-a",
      }),
    ).resolves.toEqual({
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "team-coding-plan",
      productId: "product",
      organizationId: "org",
      projectId: "project",
    });
  });

  it("当前 Family 或 Plan 不兼容时不返回请求凭据范围", async () => {
    await expect(
      resolveCurrentAccountAccess({
        access: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
        },
        readSettings: async () => ({
          providerFamilyDomain: "bigmodel",
          selections: { zai: { kind: "individual-coding-plan" } },
        }),
        loadAccountIdentity: async () => "account-a",
      }),
    ).resolves.toBeNull();
  });

  it("只启用当前 Family 已连接 Coding Plan 对应的 Off-Peak Provider", async () => {
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: {
          zai: { kind: "individual-coding-plan" },
          bigmodel: { kind: "individual-coding-plan" },
        },
      }),
      loadCodingPlanApiKey: async () => "personal-key",
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability: async ({ family }) =>
        family === "zai"
          ? {
              [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
                kind: "available",
              },
            }
          : {
              [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: {
                kind: "available",
              },
            },
    });
    const providers = configuredProviders()
      .set(
        "account:zai-offpeak-idle-plan",
        new ProviderConfig({
          group: "zai-family",
          access: new ZhipuAccountAccessConfig({
            accountType: "zai",
            mode: "off-peak",
          }),
        }),
      )
      .set(
        "account:bigmodel-offpeak-idle-plan",
        new ProviderConfig({
          group: "bigmodel-family",
          access: new ZhipuAccountAccessConfig({
            accountType: "bigmodel",
            mode: "off-peak",
          }),
        }),
      );

    await expect(
      resolve({ configRevision: "config-1", configuredProviders: providers }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { providerId: "account:zai-offpeak-idle-plan", status: "available" },
        {
          providerId: "account:bigmodel-offpeak-idle-plan",
          status: "unavailable",
        },
      ]),
    );
  });

  it("把当前 Family 的 Start/Coding 权益映射为可用状态", async () => {
    const resolveFamilyAvailability = vi.fn<AccountProviderFamilyAvailabilityResolver>(
      async ({ family }) =>
        family === "zai"
          ? {
              [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
                kind: "available",
              },
              [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
                kind: "unavailable",
                reason: "coding_plan_not_entitled",
              },
            }
          : {},
    );
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey: async () => "personal-key",
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability,
    });

    await expect(
      resolve({
        configRevision: "config-1",
        configuredProviders: configuredProviders(),
      }),
    ).resolves.toEqual([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        status: "available",
        connectionKey: expect.any(String),
        current: true,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        status: "unavailable",
        unavailableReason: "not-entitled",
        connectionKey: expect.any(String),
        current: true,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        status: "unknown",
        connectionKey: expect.any(String),
        current: false,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        status: "unknown",
        connectionKey: expect.any(String),
        current: false,
      },
    ]);
    expect(resolveFamilyAvailability).toHaveBeenCalledTimes(2);
  });

  it("Coding Plan 选中 Team 连接时只投影可用状态", async () => {
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "bigmodel",
        selections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "product",
            organizationId: "org",
            projectId: "project",
          },
        },
      }),
      loadCodingPlanApiKey: async () => null,
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability: async ({ family }) =>
        family === "bigmodel"
          ? {
              [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: {
                kind: "available",
              },
            }
          : {},
    });

    const result = await resolve({
      configRevision: "config-1",
      configuredProviders: configuredProviders({ bigmodelTeam: true }),
    });

    expect(result).toContainEqual({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
      status: "available",
      connectionKey: expect.any(String),
      current: true,
    });
  });

  it("禁用 Account Provider 仍解析连接，供设置与 Usage 保留账号事实", async () => {
    const resolveFamilyAvailability = vi.fn<AccountProviderFamilyAvailabilityResolver>(
      async () => ({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
          kind: "available",
        },
      }),
    );
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey: async () => "personal-key",
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability,
    });

    await expect(
      resolve({
        configRevision: "config-1",
        configuredProviders: new ProviderConfigMap([
          [
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            createAccountProviderConfig({
              enabled: false,
              models: ["zai-coding"],
            }),
          ],
        ]),
      }),
    ).resolves.toEqual([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        status: "available",
        connectionKey: expect.any(String),
        current: true,
      },
    ]);
    expect(resolveFamilyAvailability).toHaveBeenCalledOnce();
  });

  it("保留单个 Provider 的 unknown，并按 Config 顺序返回", async () => {
    const requestedFamilies: ProviderFamilyDomain[] = [];
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: null,
        selections: {
          zai: { kind: "start-plan" },
          bigmodel: { kind: "individual-coding-plan" },
        },
      }),
      loadCodingPlanApiKey: async () => null,
      loadAccountIdentity: async () => "account-a",
      resolveFamilyAvailability: async ({ family }) => {
        requestedFamilies.push(family);
        return family === "zai"
          ? {
              [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
                kind: "available",
                models: ["remote-start-model"],
              },
            }
          : {};
      },
    });

    const result = await resolve({
      configRevision: "config-1",
      configuredProviders: configuredProviders(),
    });

    expect(requestedFamilies).toEqual(["zai", "bigmodel"]);
    expect(result).toEqual([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        status: "unknown",
        connectionKey: expect.any(String),
        current: false,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        status: "available",
        models: ["remote-start-model"],
        connectionKey: expect.any(String),
        current: false,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        status: "unknown",
        connectionKey: expect.any(String),
        current: false,
      },
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
        status: "unknown",
        connectionKey: expect.any(String),
        current: false,
      },
    ]);
  });

  it("连接身份稳定且随账号改变，不暴露明文账号或凭据", async () => {
    let accountIdentity = "account-a";
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey: async () => "rotating-key",
      loadAccountIdentity: async () => accountIdentity,
      resolveFamilyAvailability: async () => ({
        [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
          kind: "available",
        },
      }),
    });
    const input = {
      configRevision: "config-1",
      configuredProviders: new ProviderConfigMap([
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          createAccountProviderConfig({ models: ["zai-coding"] }),
        ],
      ]),
    };

    const first = await resolve(input);
    expect((await resolve(input))[0]?.connectionKey).toBe(first[0]?.connectionKey);
    expect(JSON.stringify(first)).not.toContain("account-a");
    expect(JSON.stringify(first)).not.toContain("rotating-key");
    accountIdentity = "account-b";
    expect((await resolve(input))[0]?.connectionKey).not.toBe(first[0]?.connectionKey);

    await expect(resolve(input)).resolves.toEqual([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        status: "available",
        connectionKey: expect.any(String),
        current: true,
      },
    ]);
  });

  it("缺少账号身份时不查询权益并关闭 Account Provider", async () => {
    const resolveFamilyAvailability = vi.fn(async () => ({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        kind: "available" as const,
      },
    }));
    const resolve = createAccountProviderConnectionResolver({
      readSettings: async () => ({
        providerFamilyDomain: "zai",
        selections: { zai: { kind: "individual-coding-plan" } },
      }),
      loadCodingPlanApiKey: async () => "personal-key",
      loadAccountIdentity: async () => null,
      resolveFamilyAvailability,
    });

    await expect(
      resolve({
        configRevision: "config-1",
        configuredProviders: new ProviderConfigMap([
          [
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            createAccountProviderConfig({ models: ["zai-coding"] }),
          ],
        ]),
      }),
    ).resolves.toEqual([
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        status: "unavailable",
        unavailableReason: "not-connected",
        connectionKey: expect.any(String),
        current: true,
      },
    ]);
    expect(resolveFamilyAvailability).not.toHaveBeenCalled();
  });
});
