import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZCODE_VERSION,
  type ApiClient,
} from "@zcode/shared";
import { BigModelUsageQuotaProvider } from "../src/usage-stats/providers/bigmodelUsageQuotaProvider.js";

const TEST_BIGMODEL_PROVIDER_ID = "test-bigmodel-api-provider";

interface TestUsageProvider {
  id: string;
  apiKey: string;
  name?: string;
}

interface LegacyModelProviderReader {
  getAllCached(): Promise<TestUsageProvider[]>;
}

type LegacyQuotaProviderTestOptions = Omit<
  ConstructorParameters<typeof BigModelUsageQuotaProvider>[0],
  "accountRequestAuthService"
> & {
  modelProviderService?: LegacyModelProviderReader;
  accountRequestAuthService?: ConstructorParameters<
    typeof BigModelUsageQuotaProvider
  >[0]["accountRequestAuthService"];
};

/**
 * 这些测试原本直接把旧 ModelProviderService 注入 quota provider。
 * 迁移后凭据由 Account Request Auth 提供；这里仅保留测试数据装配，避免测试继续
 * 把旧 Provider Config 当成生产事实来源。
 */
function createProviderForTest(
  options: LegacyQuotaProviderTestOptions,
): BigModelUsageQuotaProvider {
  const provider = new BigModelUsageQuotaProvider({
    ...options,
    accountRequestAuthService: options.accountRequestAuthService ?? {
      resolveAccessCurrent: vi.fn(async () => null),
      resolveCurrent: vi.fn(async ({ providerId, accountAccess }) => {
        if (accountAccess.planKind === "team-coding-plan") {
          return {
            apiKey:
              providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                ? "team-ak-zai.team-secret-zai"
                : "team-ak.team-secret",
          };
        }
        if (providerId.includes("start-plan")) {
          const token = await options.credentialService?.load("zcodejwttoken");
          return { apiKey: token ?? undefined };
        }
        const providers = await options.modelProviderService?.getAllCached();
        return {
          apiKey: providers?.find((candidate) => candidate.id === providerId)?.apiKey,
        };
      }),
      assertCurrent: vi.fn(async () => undefined),
    },
  });
  const getSnapshotForRequest = provider.getSnapshotForRequest.bind(provider);
  provider.getSnapshotForRequest = (request = {}) =>
    getSnapshotForRequest(withTestAccountAccess(request));
  return provider;
}

function withTestAccountAccess(
  request: Parameters<BigModelUsageQuotaProvider["getSnapshotForRequest"]>[0] = {},
) {
  const providerId = request.preferredProviderId ?? "";
  const family = providerId.includes("zai") ? ("zai" as const) : ("bigmodel" as const);
  if (request.organizationId && request.projectId) {
    return {
      ...request,
      accountAccess: {
        type: "zhipu-account" as const,
        family,
        planKind: "team-coding-plan" as const,
        productId: "test-product",
        organizationId: request.organizationId,
        projectId: request.projectId,
      },
    };
  }
  return {
    ...request,
    accountAccess: {
      type: "zhipu-account" as const,
      family,
      planKind: providerId.includes("start-plan")
        ? ("start-plan" as const)
        : ("individual-coding-plan" as const),
    },
  };
}

function createBigModelCodingPlanProvider(): TestUsageProvider {
  return {
    id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    apiKey: "bigmodel-api-key",
  };
}

function createBigModelApiKeyProvider(): TestUsageProvider {
  return {
    ...createBigModelCodingPlanProvider(),
    id: TEST_BIGMODEL_PROVIDER_ID,
    apiKey: "ordinary-api-key",
  };
}

function createZaiCodingPlanProvider(): TestUsageProvider {
  return {
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    apiKey: "zai-api-key",
  };
}

function createZaiStartPlanProvider(): TestUsageProvider {
  return {
    ...createZaiCodingPlanProvider(),
    id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
    apiKey: "provider-zcode-jwt",
  };
}

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", Date: "Tue, 02 Jun 2026 00:00:00 GMT" },
  });
}

describe("BigModelUsageQuotaProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("旧 active 响应超过 HTTP Date 有效期后返回过期无权益快照", async () => {
    const provider = createProviderForTest({
      apiClient: {
        request: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: 0,
                data: {
                  server_time: 1788448680,
                  plans: [
                    { plan_id: "zcode-v3-start-plan", status: "active", ends_at: 1788796799 },
                  ],
                  balances: [{ plan_id: "zcode-v3-start-plan", remaining_units: 3000000 }],
                },
              }),
              { headers: { Date: "Thu, 17 Sep 2026 13:42:46 GMT" } },
            ),
        ),
      },
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: { load: vi.fn(async () => "credential-zcode-jwt") },
    });
    expect(
      await provider.getSnapshotForRequest({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        requirePreferredProvider: true,
      }),
    ).toMatchObject({
      unavailableReason: "no_plan",
      startPlanExpired: true,
      subscription: null,
      quota: null,
      remaining: null,
    });
  });

  it("Z.ai Start Plan 用 zcodejwttoken 读取当前套餐和到期时间", async () => {
    const balanceUrl = `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${ZCODE_VERSION}`;
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer credential-zcode-jwt",
        });
        expect(url).toBe(balanceUrl);
        return createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            server_time: 1_780_400_123,
            plans: [
              {
                plan_id: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                status: "active",
                starts_at: 1_780_291_200,
                ends_at: 1_781_500_800,
                entitlements: [
                  {
                    entitlement_id: "ent_zcode_v3_glm_52",
                    meter: "model_usage",
                    period: "daily",
                  },
                ],
              },
            ],
            balances: [
              {
                bucket_id: "bucket-glm-52",
                user_plan_id: "user-plan-52",
                period_start: 1_780_416_000,
                period_end: 1_780_502_399,
                meter: "model_usage",
                unit_type: "token",
                plan_id: "zcode-v3-start-plan",
                entitlement_id: "ent_zcode_v3_glm_52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                used_units: 500_000,
                remaining_units: 2_500_000,
                available_units: 2_500_000,
                expires_at: 1_780_502_400,
              },
            ],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key: string) =>
          key === "zcodejwttoken" ? "credential-zcode-jwt" : null,
        ),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(requestUrls).toEqual([balanceUrl]);
    expect(snapshot.serverTime).toBe(1_780_400_123_000);
    expect(snapshot.provider).toMatchObject({
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      name: "Z.ai - Coding Plan",
    });
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "zcode-v3-start-plan",
      productName: "ZCode V3 Start Plan",
      billingCycle: "daily",
      // Start Plan 卡片不再展示套餐级续期时间；桶刷新时间由各 limit 的 nextResetTime 表达。
      renewTime: null,
      expireTime: new Date(1_781_500_800 * 1000).toISOString(),
    });
    expect(snapshot.quota).toMatchObject({
      level: "Start",
      limits: [
        {
          type: "ent_zcode_v3_glm_52",
          bucketId: "bucket-glm-52",
          userPlanId: "user-plan-52",
          periodStart: 1_780_416_000_000,
          periodEnd: 1_780_502_399_000,
          period: "daily",
          meter: "model_usage",
          unitType: "token",
          number: 3_000_000,
          usage: 500_000,
          remaining: 2_500_000,
          usageDetails: [{ modelCode: "glm-5.2", displayName: "GLM-5.2", usage: 500_000 }],
        },
      ],
    });
    expect(snapshot.remaining).toMatchObject({
      count: 2_500_000,
      isShow: true,
      nextResetTime: 1_780_502_400 * 1000,
    });
  });

  it("Z.ai Start Plan 保留多个套餐顺序和额度桶 plan id", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "start-plan-welcome",
                name: "Welcome Plan",
                status: "active",
                ends_at: 1_781_500_800,
              },
              {
                plan_id: "start-plan-bonus",
                name: "Bonus Plan",
                status: "active",
                ends_at: 1_782_105_600,
              },
            ],
            balances: [
              {
                plan_id: "start-plan-welcome",
                entitlement_id: "welcome-glm-52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                remaining_units: 2_500_000,
                expires_at: 1_780_506_000,
              },
              {
                plan_id: "start-plan-bonus",
                entitlement_id: "bonus-glm-5-turbo",
                show_name: "GLM-5-Turbo",
                capabilities: ["model:glm-5-turbo"],
                total_units: 1_000_000,
                remaining_units: 750_000,
                expires_at: 1_781_110_800,
              },
            ],
          },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "credential-zcode-jwt"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.subscription?.details).toMatchObject([
      {
        productId: "start-plan-welcome",
        productName: "Welcome Plan",
        expireTime: new Date(1_781_500_800 * 1000).toISOString(),
      },
      {
        productId: "start-plan-bonus",
        productName: "Bonus Plan",
        expireTime: new Date(1_782_105_600 * 1000).toISOString(),
      },
    ]);
    expect(snapshot.quota?.limits).toMatchObject([
      {
        type: "welcome-glm-52",
        planId: "start-plan-welcome",
        nextResetTime: 1_780_506_000 * 1000,
      },
      {
        type: "bonus-glm-5-turbo",
        planId: "start-plan-bonus",
        nextResetTime: 1_781_110_800 * 1000,
      },
    ]);
  });

  it("Z.ai Start Plan 过期套餐不进入 subscription 且移除其额度桶", async () => {
    // 固化服务端契约被破坏时的行为：subscription 只含 active 套餐；
    // 无法归属的桶由 provider 原样透传（设置页归属层会丢弃，聊天气泡仍展示），
    // 同时 provider 会打 warn tripwire 日志（见 warnOnUnattributedStartPlanBuckets）。
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "start-plan-welcome",
                name: "ZCode V3 Start Plan",
                status: "active",
                ends_at: 1_781_500_800,
              },
              {
                plan_id: "start-plan-expired",
                name: "Expired Plan",
                status: "expired",
                ends_at: 1_780_000_000,
              },
            ],
            balances: [
              {
                plan_id: "start-plan-welcome",
                entitlement_id: "welcome-glm-52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                remaining_units: 2_500_000,
                expires_at: 1_780_506_000,
              },
              {
                plan_id: "start-plan-expired",
                entitlement_id: "expired-glm-52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 900_000,
                remaining_units: 800_000,
                expires_at: 1_780_506_000,
              },
            ],
          },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "credential-zcode-jwt"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.subscription?.details).toMatchObject([{ productId: "start-plan-welcome" }]);
    expect(snapshot.quota?.limits).toMatchObject([
      { type: "welcome-glm-52", planId: "start-plan-welcome" },
    ]);
  });

  it("Z.ai Start Plan 乱序穿插非active套餐时保持服务端相对顺序", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "start-plan-expired-a",
                name: "Expired A",
                status: "expired",
                ends_at: 1,
              },
              {
                plan_id: "start-plan-active-1",
                name: "Active One",
                status: "active",
                ends_at: 1_781_500_800,
              },
              {
                plan_id: "start-plan-expired-b",
                name: "Expired B",
                status: "cancelled",
                ends_at: 1,
              },
              {
                plan_id: "start-plan-active-2",
                name: "Active Two",
                status: "active",
                ends_at: 1_782_105_600,
              },
            ],
            balances: [
              {
                plan_id: "start-plan-active-1",
                entitlement_id: "active-1-glm-52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                remaining_units: 2_500_000,
                expires_at: 1_780_506_000,
              },
              {
                plan_id: "start-plan-active-2",
                entitlement_id: "active-2-glm-5-turbo",
                show_name: "GLM-5-Turbo",
                capabilities: ["model:glm-5-turbo"],
                total_units: 1_000_000,
                remaining_units: 750_000,
                expires_at: 1_781_110_800,
              },
            ],
          },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "credential-zcode-jwt"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.subscription?.details?.map((detail) => detail.productId)).toEqual([
      "start-plan-active-1",
      "start-plan-active-2",
    ]);
  });

  it("Z.ai Start Plan 桶缺失 expires_at 时 nextResetTime 为 undefined 且不抛错", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                status: "active",
                ends_at: 1_781_500_800,
              },
            ],
            balances: [
              {
                plan_id: "zcode-v3-start-plan",
                entitlement_id: "ent_zcode_v3_glm_52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                remaining_units: 2_500_000,
                // 服务端契约保证 expires_at 存在；缺失时桶刷新时间退化为 undefined，
                // 快照构建不能抛错。
              },
            ],
          },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "credential-zcode-jwt"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.quota?.limits).toMatchObject([
      {
        type: "ent_zcode_v3_glm_52",
        remaining: 2_500_000,
        nextResetTime: undefined,
      },
    ]);
    expect(snapshot.remaining).toMatchObject({ count: 2_500_000 });
  });

  it("Z.ai Start Plan 余额展示优先使用 remaining_units 而不是 available_units", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        expect(url).toContain("/billing/balance");
        return createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                status: "active",
              },
            ],
            balances: [
              {
                entitlement_id: "ent_zcode_v3_glm_52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 3_000_000,
                used_units: 266_000,
                reserved_units: 1_775_000,
                remaining_units: 2_734_000,
                available_units: 959_000,
                expires_at: 1_780_502_400,
              },
            ],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key: string) =>
          key === "zcodejwttoken" ? "credential-zcode-jwt" : null,
        ),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.quota?.limits[0]).toMatchObject({
      number: 3_000_000,
      usage: 266_000,
      remaining: 2_734_000,
      percentage: 2_734_000 / 3_000_000,
    });
    expect(snapshot.remaining).toMatchObject({
      count: 2_734_000,
      percentage: 2_734_000 / 3_000_000,
    });
  });

  it("Z.ai Start Plan 只请求一次 billing/balance 并从 plans 判定套餐", async () => {
    const balanceUrl = `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=${ZCODE_VERSION}`;
    const requestOrder: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        expect(url).toBe(balanceUrl);
        requestOrder.push("balance");
        return createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                status: "active",
                starts_at: 1_787_900_000,
                entitlements: [
                  {
                    entitlement_id: "ent_zcode_v3_glm_52",
                    show_name: "GLM-5.2",
                    period: "one_time",
                    effective_at: 1_788_000_000,
                  },
                ],
              },
            ],
            balances: [
              {
                entitlement_id: "ent_zcode_v3_glm_52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 100,
                used_units: 25,
                remaining_units: 75,
              },
            ],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiStartPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key: string) =>
          key === "zcodejwttoken" ? "credential-zcode-jwt" : null,
        ),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(requestOrder).toEqual(["balance"]);
    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(snapshot.quota?.limits[0]).toMatchObject({
      type: "ent_zcode_v3_glm_52",
      remaining: 75,
    });
    expect(snapshot.subscription?.details[0]?.entitlements).toEqual([
      {
        entitlementId: "ent_zcode_v3_glm_52",
        showName: "GLM-5.2",
        effectiveTime: new Date(1_788_000_000 * 1_000).toISOString(),
      },
    ]);
  });

  it("Z.ai Start Plan 缺少 zcodejwttoken 时不调用远端状态接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: { plans: [] },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [
          {
            ...createZaiStartPlanProvider(),
            apiKey: "",
          },
        ]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => null),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
      requirePreferredProvider: true,
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(snapshot.unavailableReason).toBe("not_configured");
    expect(snapshot.provider).toBeNull();
  });

  it("BigModel Start Plan 使用 OAuth callback 已落盘的 zcode JWT 读取当前套餐", async () => {
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestHeaders.push(init?.headers);

        expect(url).toContain("/billing/balance");
        return createJsonResponse({
          code: 0,
          msg: "ok",
          data: {
            plans: [
              {
                plan_id: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                status: "active",
                starts_at: 1_780_291_200,
                ends_at: 1_781_500_800,
              },
            ],
            balances: [
              {
                entitlement_id: "ent_bigmodel_glm_52",
                show_name: "GLM-5.2",
                capabilities: ["model:glm-5.2"],
                total_units: 100,
                used_units: 25,
                remaining_units: 75,
                expires_at: 1_780_502_400,
              },
              {
                entitlement_id: "ent_bigmodel_glm_5turbo",
                show_name: "GLM-5-Turbo",
                capabilities: ["model:glm-5-turbo"],
                total_units: 50,
                used_units: 0,
                remaining_units: 50,
                expires_at: 1_780_502_400,
              },
            ],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [
          {
            ...createZaiStartPlanProvider(),
            id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
            name: "BigModel- Coding Plan",
            apiKey: "stale-bigmodel-token",
          },
        ]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key: string) =>
          key === "oauth:active_provider"
            ? BIGMODEL_PROVIDER_ID
            : key === "zcodejwttoken"
              ? "bigmodel-zcode-jwt"
              : null,
        ),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      requirePreferredProvider: true,
    });

    expect(requestHeaders).toEqual([
      expect.objectContaining({ Authorization: "Bearer bigmodel-zcode-jwt" }),
    ]);
    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(apiClient.request).not.toHaveBeenCalledWith(
      "https://zcode.z.ai/api/v1/oauth/token",
      expect.anything(),
    );
    expect(snapshot.provider).toMatchObject({
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
      name: "BigModel - Coding Plan",
    });
    expect(snapshot.quota?.limits[0]).toMatchObject({
      type: "ent_bigmodel_glm_52",
      remaining: 75,
      usageDetails: [{ modelCode: "glm-5.2", displayName: "GLM-5.2", usage: 25 }],
    });
    expect(snapshot.quota?.limits[1]).toMatchObject({
      type: "ent_bigmodel_glm_5turbo",
      remaining: 50,
      usageDetails: [{ modelCode: "glm-5-turbo", displayName: "GLM-5-Turbo", usage: 0 }],
    });
  });

  it("自动续费套餐用订阅列表的 nextRenewTime 推导续费时间", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/monitor/usage/quota/limit")) {
          expect(init?.headers).toMatchObject({
            authorization: "bigmodel-api-key",
          });
          return createJsonResponse({
            code: 200,
            data: {
              level: "pro",
              limits: [
                {
                  type: "TIME_LIMIT",
                  remaining: 5,
                  percentage: 10,
                  nextResetTime: Date.UTC(2026, 4, 26),
                },
              ],
            },
          });
        }

        expect(url).toBe("https://bigmodel.cn/api/biz/subscription/list");
        expect(init?.headers).toMatchObject({
          Authorization: "bigmodel-api-key",
        });
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "product-pro-quarter",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
              autoRenew: 1,
              billingCycle: "monthly",
              nextRenewTime: "2026-06-26",
              valid: "2026-06-26 10:00:00-2026-09-26 10:00:00",
            },
            {
              productId: "product-pro-month",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: false,
              nextRenewTime: "2026-07-26",
              valid: "2026-06-26 10:00:00-2026-07-26 10:00:00",
            },
          ],
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(requestUrls).toEqual([
      "https://bigmodel.cn/api/biz/subscription/list",
      "https://bigmodel.cn/api/monitor/usage/quota/limit",
    ]);
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "product-pro-quarter",
      productName: "GLM Coding Pro",
      billingCycle: "monthly",
      renewTime: new Date("2026-06-26").toISOString(),
      expireTime: new Date("2026-09-26T10:00:00").toISOString(),
    });
    expect(snapshot.remaining?.nextResetTime).toBe(Date.UTC(2026, 4, 26));
  });

  it("缺少订阅时不会用 quota level 伪造商品和权益", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.endsWith("/api/biz/subscription/list")) {
          return createJsonResponse({ code: 200, data: [] });
        }

        return createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [
              {
                type: "TIME_LIMIT",
                remaining: 5,
              },
            ],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot.subscription).toBeNull();
    expect(snapshot.unavailableReason).toBe("no_plan");
    expect(snapshot.quota?.level).toBe("pro");
  });

  it("quota 业务失败时保留已读取的 Coding Plan 订阅快照", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.endsWith("/api/biz/subscription/list")) {
          return createJsonResponse({
            code: 200,
            data: [
              {
                productId: "product-pro",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
              },
            ],
          });
        }

        return createJsonResponse({ code: 500, msg: "quota unavailable" });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      includeSubscription: true,
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(snapshot).toMatchObject({
      provider: { id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan },
      subscription: {
        details: [{ productId: "product-pro", productName: "GLM Coding Pro" }],
      },
      quota: null,
      remaining: null,
    });
    expect(snapshot.unavailableReason).toBeUndefined();
  });

  it("ZCODE_ENV=test 时 BigModel Coding Plan quota 使用 bigmodel.cn", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/biz/subscription/list")) {
          return createJsonResponse({ code: 200, data: [] });
        }

        return createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      env: {
        ZCODE_ENV: "test",
      },
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(requestUrls).toEqual([
      "https://bigmodel.cn/api/biz/subscription/list",
      "https://bigmodel.cn/api/monitor/usage/quota/limit",
    ]);
  });

  it("BigModel Team Plan 权益查询会携带组织和项目 header", async () => {
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        requestHeaders.push(init?.headers);
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api_keys")) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-ak", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        if (url.endsWith("/api_keys/copy/team-ak")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "team-secret" },
          });
        }
        if (url.endsWith("/api/biz/team/subscribe/product/querySubscribeDetail")) {
          return createJsonResponse({
            code: 200,
            data: {
              hasSubscription: true,
              status: "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "team-max",
              productName: "团队套餐",
            },
          });
        }
        expect(url).toBe("https://bigmodel.cn/api/monitor/usage/quota/limit?type=2");
        return createJsonResponse({
          code: 200,
          data: {
            level: "team",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:bigmodel:access_token" ? "oauth-token" : null)),
      },
    });

    await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });

    expect(requestUrls.some((url) => url.includes("/api_keys"))).toBe(false);
    expect(requestHeaders[0]).toMatchObject({
      Authorization: "oauth-token",
      "bigmodel-organization": "org-team-a",
      "bigmodel-project": "proj-team-a",
    });
    expect(requestHeaders.slice(-2)).toEqual([
      expect.objectContaining({
        Authorization: "oauth-token",
        "bigmodel-organization": "org-team-a",
        "bigmodel-project": "proj-team-a",
      }),
      expect.objectContaining({
        authorization: "team-ak.team-secret",
        "bigmodel-organization": "org-team-a",
        "bigmodel-project": "proj-team-a",
      }),
    ]);
    expect(requestUrls).toEqual([
      "https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail",
      "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2",
    ]);
  });

  it("BigModel Team Plan 用量使用团队项目 API Key", async () => {
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        requestHeaders.push(init?.headers);
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api_keys")) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-ak", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        if (url.endsWith("/api_keys/copy/team-ak")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "team-secret" },
          });
        }
        if (url.endsWith("/api/biz/team/subscribe/product/querySubscribeDetail")) {
          return createJsonResponse({
            code: 200,
            data: {
              hasSubscription: true,
              status: "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "team-max",
              productName: "团队套餐",
            },
          });
        }
        return createJsonResponse({
          code: 200,
          data: {
            level: "team",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:bigmodel:access_token" ? "oauth-token" : null)),
      },
    });

    await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });

    expect(requestHeaders.at(-1)).toMatchObject({
      authorization: "team-ak.team-secret",
      "bigmodel-organization": "org-team-a",
      "bigmodel-project": "proj-team-a",
    });
    expect(requestUrls.at(-1)).toBe("https://bigmodel.cn/api/monitor/usage/quota/limit?type=2");
  });

  it("BigModel Team Plan 的用量层不再创建项目 API Key", async () => {
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const requestMethods: Array<string | undefined> = [];
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestHeaders.push(init?.headers);
        requestMethods.push(init?.method);
        requestUrls.push(url);
        if (url.endsWith("/api_keys") && init?.method === "GET") {
          return createJsonResponse({
            code: 200,
            data: [
              {
                apiKey: "wrong-type-ak",
                keyType: 1,
                name: "zcode-team-api-key",
              },
              { name: "zcode-api-key" },
            ],
          });
        }
        if (url.endsWith("/api_keys") && init?.method === "POST") {
          expect(init.headers).toMatchObject({
            "bigmodel-organization": "org-team-a",
            "bigmodel-project": "proj-team-a",
          });
          expect(init.body).toBe(JSON.stringify({ name: "zcode-team-api-key", keyType: 2 }));
          return createJsonResponse({
            code: 200,
            data: {
              apiKey: "created-team-ak",
              keyType: 2,
              name: "zcode-team-api-key",
            },
          });
        }
        if (url.endsWith("/api_keys/copy/created-team-ak")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "created-team-secret" },
          });
        }
        if (url.endsWith("/api/biz/team/subscribe/product/querySubscribeDetail")) {
          return createJsonResponse({
            code: 200,
            data: {
              hasSubscription: true,
              status: "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "team-max",
              productName: "团队套餐",
            },
          });
        }
        if (url.endsWith("/api/monitor/usage/quota/limit?type=2")) {
          return createJsonResponse({
            code: 200,
            data: {
              level: "team",
              limits: [],
            },
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:bigmodel:access_token" ? "oauth-token" : null)),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });

    expect(requestMethods).toEqual(["GET", "GET"]);
    expect(requestUrls).toEqual([
      "https://bigmodel.cn/api/biz/team/subscribe/product/querySubscribeDetail",
      "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2",
    ]);
    expect(requestHeaders.at(-1)).toMatchObject({
      authorization: "team-ak.team-secret",
      "bigmodel-organization": "org-team-a",
      "bigmodel-project": "proj-team-a",
    });
    expect(snapshot).toMatchObject({
      context: {
        scope: "team",
        organizationId: "org-team-a",
        projectId: "proj-team-a",
      },
      provider: {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      },
    });
  });

  it("BigModel Team Plan quota 使用 type=2 且不回退企业余额", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api_keys")) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-ak", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        if (url.endsWith("/api_keys/copy/team-ak")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "team-secret" },
          });
        }
        if (url.endsWith("/api/biz/team/subscribe/product/querySubscribeDetail")) {
          return createJsonResponse({
            code: 200,
            data: {
              hasSubscription: true,
              status: "EFFECTIVE",
              memberGrantStatus: "VALID",
              productId: "team-max",
              productName: "团队套餐",
            },
          });
        }
        if (url === "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2") {
          return createJsonResponse({
            code: 200,
            data: {
              level: "team",
              limits: [
                {
                  type: "TIME_LIMIT",
                  remaining: 1000,
                  currentValue: 0,
                  percentage: 0,
                },
              ],
            },
          });
        }
        return createJsonResponse({
          code: 500,
          success: false,
          msg: "当前用户不存在coding plan",
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:bigmodel:access_token" ? "oauth-token" : null)),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
    });

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.quota?.limits[0]).toMatchObject({
      type: "TIME_LIMIT",
      remaining: 1000,
      percentage: 0,
    });
    expect(
      requestUrls.some((url) => url.endsWith("/api/biz/subscription/enterprise/v2/balance")),
    ).toBe(false);
  });

  it("没有 Coding Plan apiKey 时不调用 quota 和套餐预览接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [
              {
                type: "TIME_LIMIT",
                remaining: 5,
                nextResetTime: Date.UTC(2026, 4, 26),
              },
            ],
          },
        }),
      ),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [
          {
            ...createBigModelCodingPlanProvider(),
            apiKey: "",
          },
        ]),
      } as LegacyModelProviderReader,
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(async () => null),
        resolveCurrent: vi.fn(async () => ({ apiKey: undefined })),
        assertCurrent: vi.fn(async () => undefined),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(snapshot.unavailableReason).toBe("not_configured");
    expect(snapshot.provider).toBeNull();
  });

  it("严格指定 Coding Plan 时不会回退到普通 API Key provider", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [
          {
            ...createBigModelCodingPlanProvider(),
            apiKey: "",
          },
          createBigModelApiKeyProvider(),
        ]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      requirePreferredProvider: true,
      allowEnvApiKey: false,
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(snapshot.unavailableReason).toBe("not_configured");
    expect(snapshot.provider).toBeNull();
  });

  it("严格指定 Coding Plan 时不会被环境变量 usage key 覆盖", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (_input, init) => {
        if (String(_input).includes("subscription/list")) {
          expect(init?.headers).toMatchObject({ Authorization: "bigmodel-api-key" });
          return createJsonResponse({ code: 200, data: [] });
        }
        expect(init?.headers).toMatchObject({
          authorization: "bigmodel-api-key",
        });
        return createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createBigModelCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      env: {
        ZCODE_BIGMODEL_USAGE_API_KEY: "env-usage-key",
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      requirePreferredProvider: true,
      includeSubscription: false,
    });

    expect(apiClient.request).toHaveBeenCalledTimes(2);
    expect(snapshot.provider).toMatchObject({
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });
  });

  it("Z.ai Coding Plan 用量权益直接使用 provider apiKey 请求 quota", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.includes("subscription/list")) {
          expect(init?.headers).toMatchObject({ Authorization: "zai-api-key" });
          return createJsonResponse({ code: 200, data: [] });
        }
        expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
        expect(init?.headers).toMatchObject({
          authorization: "zai-api-key",
        });
        return createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
      includeSubscription: false,
    });

    expect(requestUrls).toEqual([
      "https://api.z.ai/api/biz/subscription/list",
      "https://api.z.ai/api/monitor/usage/quota/limit",
    ]);
    expect(snapshot.provider).toMatchObject({
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });
  });

  it("Z.ai Coding Plan 团队授权不可用时不会回退个人 key 发送 team quota header", async () => {
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (_input, init) => {
        requestHeaders.push(init?.headers);
        return createJsonResponse({
          code: 200,
          data: {
            level: "pro",
            limits: [],
          },
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
      accountRequestAuthService: {
        resolveAccessCurrent: vi.fn(async () => null),
        resolveCurrent: vi.fn(async () => ({ apiKey: undefined })),
        assertCurrent: vi.fn(async () => undefined),
      },
    });

    await expect(
      provider.getSnapshotForRequest({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        requirePreferredProvider: true,
        includeSubscription: false,
        organizationId: "org-should-ignore",
        projectId: "proj-should-ignore",
      }),
    ).rejects.toThrow("Coding Plan entitlement refresh failed");

    // 修复原因：误传 team context 时不能把个人 Z.ai Coding Plan key 和 team header 混用。
    // 团队业务登录态和调用 Key 均缺失时权益未知，不能回退个人 Key。
    expect(requestHeaders).toEqual([]);
  });

  it("Z.ai Coding Plan 用 provider apiKey 读取订阅状态和到期时间", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/monitor/usage/quota/limit")) {
          expect(init?.headers).toMatchObject({
            authorization: "zai-api-key",
          });
          return createJsonResponse({
            code: 200,
            data: {
              level: "pro",
              limits: [],
            },
          });
        }

        expect(url).toBe("https://api.z.ai/api/biz/subscription/list");
        expect(init?.headers).toMatchObject({
          Authorization: "zai-api-key",
        });
        return createJsonResponse({
          code: 200,
          data: [
            {
              productId: "product-zai-pro-quarter",
              productName: "GLM Coding Pro",
              status: "VALID",
              inCurrentPeriod: true,
              billingCycle: "quarterly",
              nextRenewTime: "2026-07-10",
              valid: "2026-04-10 16:32:00-2026-07-10 10:00:00",
            },
          ],
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
    });

    expect(requestUrls).toEqual([
      "https://api.z.ai/api/biz/subscription/list",
      "https://api.z.ai/api/monitor/usage/quota/limit",
    ]);
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "product-zai-pro-quarter",
      productName: "GLM Coding Pro",
      billingCycle: "quarterly",
      renewTime: null,
      expireTime: new Date("2026-07-10").toISOString(),
    });
  });

  it("Z.ai Coding Plan quota 失败时仍用订阅列表判断已购买状态", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/biz/subscription/list")) {
          expect(init?.headers).toMatchObject({
            Authorization: "zai-api-key",
          });
          return createJsonResponse({
            code: 200,
            data: [
              {
                productId: "product-zai-pro-quarter",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
                billingCycle: "quarterly",
                nextRenewTime: "2026-07-10",
              },
            ],
          });
        }

        expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
        expect(init?.headers).toMatchObject({
          authorization: "zai-api-key",
        });
        return createJsonResponse({
          code: 401,
          msg: "token expired or incorrect",
          success: false,
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
    });

    expect(requestUrls).toEqual([
      "https://api.z.ai/api/biz/subscription/list",
      "https://api.z.ai/api/monitor/usage/quota/limit",
    ]);
    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "product-zai-pro-quarter",
      productName: "GLM Coding Pro",
      billingCycle: "quarterly",
      renewTime: null,
      expireTime: new Date("2026-07-10").toISOString(),
    });
    expect(snapshot.quota).toBeNull();
  });

  it("Z.ai Coding Plan 订阅列表有效时不被 quota no_plan 覆盖", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        if (url.endsWith("/api/biz/subscription/list")) {
          expect(init?.headers).toMatchObject({
            Authorization: "zai-api-key",
          });
          return createJsonResponse({
            code: 200,
            data: [
              {
                productId: "product-zai-pro-monthly",
                productName: "GLM Coding Pro",
                status: "VALID",
                inCurrentPeriod: true,
                billingCycle: "monthly",
                nextRenewTime: "2026-07-10",
              },
            ],
          });
        }

        expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
        expect(init?.headers).toMatchObject({
          authorization: "zai-api-key",
        });
        return createJsonResponse({
          code: 500,
          msg: "不存在coding plan",
          success: false,
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
    });

    expect(snapshot.unavailableReason).toBeUndefined();
    expect(snapshot.subscription?.details[0]).toMatchObject({
      productId: "product-zai-pro-monthly",
      productName: "GLM Coding Pro",
    });
    expect(snapshot.quota).toBeNull();
  });

  it("Z.ai Coding Plan token 失效时返回同步失败而不是未开通", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        expect(input.toString()).toBe("https://api.z.ai/api/biz/subscription/list");
        expect(init?.headers).toMatchObject({ Authorization: "zai-api-key" });
        return createJsonResponse({
          code: 401,
          msg: "token expired or incorrect",
          success: false,
        });
      }),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [createZaiCodingPlanProvider()]),
      } as LegacyModelProviderReader,
    });

    await expect(
      provider.getSnapshotForRequest({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        requirePreferredProvider: true,
        includeSubscription: false,
      }),
    ).rejects.toThrow("Coding Plan entitlement refresh failed");
  });

  it("Z.ai Coding Plan provider 未同步时不会回退 OAuth token 查询权益", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => []),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "zai-oauth-token"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
      includeSubscription: false,
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(snapshot.unavailableReason).toBe("not_configured");
    expect(snapshot.provider).toBeNull();
  });

  it("Z.ai Coding Plan 空 apiKey 时按未配置权益处理且不回退 OAuth token", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = createProviderForTest({
      apiClient,
      modelProviderService: {
        getAllCached: vi.fn(async () => [
          {
            ...createZaiCodingPlanProvider(),
            apiKey: "",
          },
        ]),
      } as LegacyModelProviderReader,
      credentialService: {
        load: vi.fn(async () => "zai-oauth-token"),
      },
    });

    const snapshot = await provider.getSnapshotForRequest({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      requirePreferredProvider: true,
      includeSubscription: false,
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(snapshot.unavailableReason).toBe("not_configured");
    expect(snapshot.provider).toBeNull();
  });
});
