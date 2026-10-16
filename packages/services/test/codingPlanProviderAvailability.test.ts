import { BUILTIN_MODEL_PROVIDER_IDS, type ApiClient } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  validateBigModelAccountProviderAvailability,
  validateCodingPlanProviderAvailability,
  validateZaiAccountProviderAvailability,
  type CodingPlanAvailabilityProvider,
} from "../src/model-provider/codingPlanProviderAvailability.js";

describe("codingPlanProviderAvailability", () => {
  it.each(["bigmodel", "zai"] as const)(
    "%s 个人订阅请求保留完整 PAT，不按旧 id.secret 截断",
    async (family) => {
      const token = [
        Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })).toString(
          "base64url",
        ),
        Buffer.from(JSON.stringify({ token_use: "project_access", sub: "test-account" })).toString(
          "base64url",
        ),
        "synthetic_signature_only_for_test",
      ].join(".");
      const request = vi.fn<ApiClient["request"]>(async (_url, init) => {
        const authorization = new Headers(init?.headers).get("Authorization");
        return Response.json(
          {
            code: 200,
            data: [{ productId: "coding-pro", status: "VALID", inCurrentPeriod: true }],
          },
          { status: authorization === token ? 200 : 401 },
        );
      });
      for (const apiKey of [token, `  Bearer ${token}  `]) {
        await expect(
          validateCodingPlanProviderAvailability(
            { providerId: "personal", family, planKind: "individual-coding-plan", apiKey },
            { apiClient: { request } },
          ),
        ).resolves.toEqual({ kind: "available" });
      }
      expect(request).toHaveBeenCalledTimes(2);
      for (const [url, init] of request.mock.calls) {
        expect(String(url)).toContain("/api/biz/subscription/list");
        expect(new Headers(init?.headers).get("Authorization")).toBe(token);
      }
    },
  );

  it.each(["bigmodel", "zai"] as const)("%s 混合列表中的有效订阅仍启用账号套餐", async (family) => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 200,
            data: [
              {},
              { productName: "Storage" },
              { productId: "coding-pro", status: "VALID", inCurrentPeriod: true },
            ],
          }),
        ),
    );
    await expect(
      validateCodingPlanProviderAvailability(
        {
          providerId: "personal",
          family,
          planKind: "individual-coding-plan",
          apiKey: "personal-key",
        },
        { apiClient: { request } },
      ),
    ).resolves.toEqual({ kind: "available" });
  });

  it.each(["bigmodel", "zai"] as const)(
    "%s 团队权益仅用业务 token 查询指定项目，不获取 Key 或 quota",
    async (family) => {
      const request = vi.fn(async (url: string) => {
        if (url.endsWith("/customer/getCustomerInfo"))
          return new Response(
            JSON.stringify({
              code: 200,
              data: {
                organizations: [
                  { organizationId: "org", projects: [{ projectId: "project", projectType: 2 }] },
                ],
              },
            }),
          );
        if (url.endsWith("/team/subscribe/product/querySubscribeDetail"))
          return new Response(
            JSON.stringify({
              success: true,
              data: { hasSubscription: true, status: "EFFECTIVE", memberGrantStatus: "VALID" },
            }),
          );
        throw new Error("权益查询不得访问其他接口");
      });
      const validate =
        family === "bigmodel"
          ? validateBigModelAccountProviderAvailability
          : validateZaiAccountProviderAvailability;
      const result = await validate(
        [{ providerId: "team", family, planKind: "team-coding-plan" }],
        {
          apiClient: { request },
          credentialService: {
            load: async (key) => (key === `oauth:${family}:access_token` ? "business" : null),
          },
          providerFamilyConnectionSelections: {
            [family]: {
              kind: "team-coding-plan",
              organizationId: "org",
              projectId: "project",
              productId: "pricing",
            },
          },
        },
      );
      expect(result.team).toEqual({ kind: "available" });
      expect(request).toHaveBeenCalledTimes(2);
      expect(request.mock.calls[1]?.[0]).toContain(
        "/api/biz/team/subscribe/product/querySubscribeDetail",
      );
      expect((request.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toEqual({
        Authorization: family === "zai" ? "Bearer business" : "business",
        "bigmodel-organization": "org",
        "bigmodel-project": "project",
      });
    },
  );

  describe.each(["zai", "bigmodel"] as const)("%s 个人套餐缺 Key 的分类", (family) => {
    it.each([true, false])("有本地登录信息=%s；不能将取 Key 失败当成未连接", async (loggedIn) => {
      const request = vi.fn();
      const load = vi.fn(async (key: string) =>
        key === `oauth:${family}:user_info` && loggedIn ? "local-user-info" : null,
      );
      await expect(
        validateCodingPlanProviderAvailability(
          {
            providerId: "personal",
            family,
            planKind: "individual-coding-plan",
            apiKey: null,
          },
          { apiClient: { request }, credentialService: { load } },
        ),
      ).resolves.toEqual({
        kind: "unknown",
      });
      expect(load).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });
  });
  it.each([
    {
      effectiveAt: 2_000,
      serverTime: 1_000,
      expected: { kind: "pending", effectiveAt: 2_000, models: [] },
    },
    { effectiveAt: 0, serverTime: 1_000, expected: { kind: "available" } },
    { effectiveAt: 2_000, serverTime: 3_000, expected: { kind: "available" } },
  ])(
    "待生效按 billing 服务端秒时钟判断：$effectiveAt / $serverTime",
    async ({ effectiveAt, serverTime, expected }) => {
      const apiClient: ApiClient = {
        request: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                code: 200,
                success: true,
                data: {
                  server_time: serverTime,
                  balances: [],
                  plans: [
                    {
                      plan_id: "zcode-v3-start-plan",
                      status: "active",
                      entitlements: [{ effective_at: effectiveAt }],
                    },
                  ],
                },
              }),
              { status: 200 },
            ),
        ),
      };
      await expect(
        validateCodingPlanProviderAvailability(
          availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "zai", "start-plan"),
          {
            apiClient,
            credentialService: {
              load: async (key) => (key === "zcodejwttoken" ? "jwt" : null),
            },
          },
        ),
      ).resolves.toEqual(expected);
    },
  );
  it("权益判定只依赖结构化 Account Access 与鉴权输入", async () => {
    const provider: CodingPlanAvailabilityProvider = {
      providerId: "provider-name-is-not-a-product-protocol",
      family: "zai",
      planKind: "individual-coding-plan",
      apiKey: "",
    };
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("缺少 API Key 时不应发起网络请求");
      }),
    };

    await expect(
      validateCodingPlanProviderAvailability(provider, {
        apiClient,
        credentialService: { load: async () => null },
      }),
    ).resolves.toEqual({ kind: "unknown" });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("Start Plan 在同一次 balance 响应中返回权益与权威模型集合", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 200,
              success: true,
              data: {
                plans: [
                  {
                    plan_id: "zcode-v3-start-plan",
                    status: "active",
                  },
                ],
                balances: [
                  { capabilities: ["model:GLM-5.2", "model:GLM-5-Turbo"] },
                  { capabilities: ["model:glm-5.2"] },
                ],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    };

    await expect(
      validateCodingPlanProviderAvailability(
        availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "zai", "start-plan"),
        {
          apiClient,
          credentialService: {
            load: async (key) => (key === "zcodejwttoken" ? "jwt" : null),
          },
        },
      ),
    ).resolves.toEqual({
      kind: "available",
      models: ["GLM-5.2", "GLM-5-Turbo"],
    });
  });

  it("Start Plan balance 没有模型明细时保留可用状态", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 200,
              success: true,
              data: {
                plans: [
                  {
                    plan_id: "zcode-v3-start-plan",
                    status: "active",
                  },
                ],
                balances: [],
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    };

    await expect(
      validateCodingPlanProviderAvailability(
        availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "zai", "start-plan"),
        {
          apiClient,
          credentialService: {
            load: async (key) => (key === "zcodejwttoken" ? "jwt" : null),
          },
        },
      ),
    ).resolves.toEqual({ kind: "available" });
  });

  it("独立检查每种权益，没有 Team 身份时不猜测目标团队", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("未登录时不应发起网络请求");
      }),
    };

    await expect(
      validateZaiAccountProviderAvailability(
        [
          availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "zai", "start-plan"),
          availabilityProvider(
            BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            "zai",
            "individual-coding-plan",
          ),
          availabilityProvider(
            BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
            "zai",
            "team-coding-plan",
          ),
        ],
        {
          apiClient,
          credentialService: { load: async () => null },
          providerFamilyConnectionSelections: { zai: { kind: "start-plan" } },
        },
      ),
    ).resolves.toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: {
        kind: "unavailable",
        reason: "coding_plan_not_authenticated",
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: { kind: "unknown" },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: {
        kind: "unknown",
      },
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("Z.ai 只有 Start Plan 权益时保留 Start 并关闭 Coding", async () => {
    const apiClient = createZaiPairApiClient({
      startPlanActive: true,
      codingPlanActive: false,
    });

    await expect(
      validateZaiAccountProviderAvailability(zaiPairProviders(), {
        apiClient,
        credentialService: createZaiCredentialService(),
        providerFamilyConnectionSelections: { zai: { kind: "start-plan" } },
      }),
    ).resolves.toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: { kind: "available" },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        kind: "unavailable",
        reason: "coding_plan_not_entitled",
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: {
        kind: "unknown",
      },
    });
  });

  it("Individual 选择时仍独立查询 Start Plan 权益", async () => {
    const apiClient = createZaiPairApiClient({
      startPlanActive: true,
      codingPlanActive: true,
    });

    await expect(
      validateZaiAccountProviderAvailability(zaiPairProviders(), {
        apiClient,
        credentialService: createZaiCredentialService(),
        providerFamilyConnectionSelections: {
          zai: { kind: "individual-coding-plan" },
        },
      }),
    ).resolves.toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: { kind: "available" },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: {
        kind: "available",
      },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: {
        kind: "unknown",
      },
    });
  });

  it("Coding Plan 查询暂时失败时仍保留已经确定的 Start Plan 权益", async () => {
    const apiClient = createZaiPairApiClient({
      startPlanActive: true,
      codingPlanStatus: 503,
    });

    await expect(
      validateZaiAccountProviderAvailability(zaiPairProviders(), {
        apiClient,
        credentialService: createZaiCredentialService(),
        providerFamilyConnectionSelections: {
          zai: { kind: "individual-coding-plan" },
        },
      }),
    ).resolves.toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan]: { kind: "available" },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: { kind: "unknown" },
      [BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan]: {
        kind: "unknown",
      },
    });
  });

  it("已选 Team Plan 但远端校验暂时失败时保留上一版连接状态", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => new Response("temporary unavailable", { status: 503 })),
    };

    await expect(
      validateBigModelAccountProviderAvailability(
        [
          availabilityProvider(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
            "bigmodel",
            "start-plan",
          ),
          availabilityProvider(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            "bigmodel",
            "individual-coding-plan",
            "personal-key",
          ),
          availabilityProvider(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            "bigmodel",
            "team-coding-plan",
          ),
        ],
        {
          apiClient,
          credentialService: {
            load: async (key) => (key === "oauth:bigmodel:access_token" ? "business-token" : null),
          },
          providerFamilyConnectionSelections: {
            bigmodel: {
              kind: "team-coding-plan",
              productId: "product",
              organizationId: "organization",
              projectId: "project",
            },
          },
        },
      ),
    ).resolves.toEqual({
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]: {
        kind: "unavailable",
        reason: "coding_plan_not_authenticated",
      },
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: {
        kind: "unknown",
      },
      [BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan]: { kind: "unknown" },
    });
  });
});

function zaiPairProviders(): CodingPlanAvailabilityProvider[] {
  return [
    availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan, "zai", "start-plan"),
    availabilityProvider(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      "zai",
      "individual-coding-plan",
      "coding-plan-key",
    ),
    availabilityProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan, "zai", "team-coding-plan"),
  ];
}

function availabilityProvider(
  providerId: string,
  family: CodingPlanAvailabilityProvider["family"],
  planKind: CodingPlanAvailabilityProvider["planKind"],
  apiKey?: string,
): CodingPlanAvailabilityProvider {
  return {
    providerId,
    family,
    planKind,
    ...(apiKey === undefined ? {} : { apiKey }),
  };
}

function createZaiCredentialService(): {
  load(key: string): Promise<string | null>;
} {
  return {
    load: async (key) => (key === "zcodejwttoken" ? "start-plan-jwt" : null),
  };
}

function createZaiPairApiClient(options: {
  startPlanActive: boolean;
  codingPlanActive?: boolean;
  codingPlanStatus?: number;
}): ApiClient {
  return {
    request: vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/billing/balance")) {
        return new Response(
          JSON.stringify({
            code: 200,
            success: true,
            data: {
              plans: options.startPlanActive
                ? [{ plan_id: "zcode-v3-start-plan", status: "active" }]
                : [],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/biz/subscription/list")) {
        if (options.codingPlanStatus && options.codingPlanStatus !== 200) {
          return new Response("temporary unavailable", {
            status: options.codingPlanStatus,
          });
        }
        return new Response(
          JSON.stringify({
            code: 0,
            success: true,
            data: options.codingPlanActive
              ? [
                  {
                    productId: "coding-plan-pro",
                    status: "VALID",
                    inCurrentPeriod: true,
                  },
                ]
              : [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  };
}
