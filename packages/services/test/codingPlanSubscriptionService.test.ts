import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, CODING_PLAN_SYSTEM_BUSY, type ApiClient } from "@zcode/shared";
import {
  BigModelCodingPlanSubscriptionProvider,
  createBigModelLoginAuthHeaders,
  createZaiLoginAuthHeaders,
  resolveCodingPlanClientConfigUrl,
} from "../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js";
import { ZaiCodingPlanSubscriptionProvider } from "../src/coding-plan-subscription/zaiCodingPlanSubscriptionProvider.js";
import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createZaiBatchPreviewResponse(): Response {
  return createJsonResponse({
    code: 200,
    data: {
      productList: [
        {
          productId: "zai-product-pro",
          productName: "Z.ai Coding Pro",
          payAmount: 72,
        },
      ],
      isSubscribed: false,
      isAuthenticated: true,
    },
  });
}

function createHtmlErrorResponse(): Response {
  const body = [
    '<!doctypehtml><html lang="zh-cn"><title>405</title>',
    "<body>Sorry, your request has been blocked.</body></html>",
  ].join("");
  return new Response(body, {
    status: 405,
    headers: { "Content-Type": "text/html" },
  });
}

function createBigModelCredentialService(token = "oauth-token") {
  return {
    load: vi.fn(async (key: string) => (key === "oauth:bigmodel:access_token" ? token : null)),
  };
}

describe("BigModelCodingPlanSubscriptionProvider", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("off-peak mock 直接使用 Built-in 模型，不等待远端 client config", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_MOCK", "1");
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("mock mode must not request remote client config");
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
      resolveOffPeakModelSelectionView: async () =>
        ({
          revision: 1,
          providers: [
            {
              providerId: "account:zai-offpeak-idle-plan",
              config: { visibility: "hidden" },
              models: [{ modelId: "GLM-5.2", config: {} }],
            },
          ],
        }) as never,
    });

    await expect(provider.getOffPeakClientConfig({ forceRefresh: true })).resolves.toMatchObject({
      enabled: true,
      modelSelectionView: expect.objectContaining({
        providers: [
          expect.objectContaining({
            providerId: "account:zai-offpeak-idle-plan",
          }),
        ],
      }),
      codingPlanActive: true,
    });
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("读取手动领取 preview 并归一化 plans", async () => {
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "https://preview.example.com");
    // Bugfix: 开发机 ambient ZCODE_BASE_URL 优先级高于 ZCODE_ENDPOINT_ORIGIN，置空避免 preview 域被生产域覆盖
    vi.stubEnv("ZCODE_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: {
            server_time: 1_788_000_123,
            plans: [
              {
                plan_id: "weekend-plan",
                name: "Weekend Start Plan",
                description: "Weekend plan",
                priority: 100,
                entitlements: [
                  {
                    entitlement_id: "weekend-model",
                    show_name: "GLM-5.1",
                    meter: "model_usage",
                    unit_type: "token",
                    capabilities: ["model:GLM-5.1"],
                    grant_units: 100_000,
                    period: "daily",
                    priority: 10,
                    effective_at: 1_788_000_000,
                  },
                ],
              },
            ],
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key: string) => (key === "zcodejwttoken" ? "zcode-jwt" : null)),
      },
    });

    await expect(provider.getManualClaimPlanPreviews()).resolves.toEqual({
      serverTime: 1_788_000_123_000,
      plans: [
        expect.objectContaining({
          planId: "weekend-plan",
          priority: 100,
          entitlements: [
            expect.objectContaining({
              entitlementId: "weekend-model",
              grantUnits: 100_000,
              effectiveAt: 1_788_000_000,
            }),
          ],
        }),
      ],
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining(
          "https://preview.example.com/api/v1/zcode-plan/billing/preview",
        ),
      }),
      expect.objectContaining({
        headers: { Authorization: "Bearer zcode-jwt" },
        method: "GET",
      }),
    );
  });

  it("未登录读取手动领取 preview 时不发送 Authorization", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: { server_time: "invalid", plans: [] },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn(async () => null) },
    });

    await expect(provider.getManualClaimPlanPreviews()).resolves.toEqual({
      plans: [],
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ headers: undefined, method: "GET" }),
    );
  });

  it("保留手动领取失败 code 但忽略顶层 msg", async () => {
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient: {
        request: vi.fn(async () =>
          createJsonResponse({
            code: 1003,
            msg: "already claimed",
            data: null,
          }),
        ),
      },
      credentialService: { load: vi.fn(async () => "zcode-jwt") },
    });

    await expect(
      provider.claimManualPlan({
        planId: "weekend-plan",
      }),
    ).resolves.toEqual({ success: false, code: 1003, message: "" });
  });

  it("保留领取额度耗尽响应中的 plan 结束时间供 UI 生成日期提示", async () => {
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient: {
        request: vi.fn(async () =>
          createJsonResponse({
            code: 1005,
            msg: "quota exhausted",
            data: {
              server_time: 1_788_000_123,
              plan: { ends_at: 1_788_431_999 },
            },
          }),
        ),
      },
      credentialService: { load: vi.fn(async () => "zcode-jwt") },
    });

    await expect(
      provider.claimManualPlan({
        planId: "weekend-plan",
      }),
    ).resolves.toEqual({
      success: false,
      code: 1005,
      message: "",
      serverTime: 1_788_000_123_000,
      failureEndsAt: 1_788_431_999,
    });
  });

  it.each([1005, "1005"])("领取失败 %s 原样传递 data.message 并忽略 msg", async (code) => {
    const message = "今日额度已领完。\n<b>请下次再来</b>";
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient: {
        request: vi.fn(async () =>
          createJsonResponse({
            code,
            msg: "DO NOT SHOW",
            data: { message, server_time: 1788000123 },
          }),
        ),
      },
      credentialService: { load: vi.fn(async () => "zcode-jwt") },
    });
    await expect(
      provider.claimManualPlan({
        planId: "weekend",
      }),
    ).resolves.toMatchObject({
      success: false,
      code: 1005,
      message,
      serverTime: 1788000123000,
    });
  });

  it.each([undefined, null, 42, "", "  "])(
    "领取失败不使用 msg 兜底：message=%s",
    async (message) => {
      const provider = new BigModelCodingPlanSubscriptionProvider({
        apiClient: {
          request: vi.fn(async () =>
            createJsonResponse({
              code: "1005",
              msg: "DO NOT SHOW",
              data: { message },
            }),
          ),
        },
        credentialService: { load: vi.fn(async () => "zcode-jwt") },
      });
      const result = await provider.claimManualPlan({
        planId: "weekend",
      });
      expect(result.message).toBe(typeof message === "string" ? message : "");
    },
  );

  it.each(["legacy", "preflight-v1", "unknown", undefined])(
    "预算固定 preflight-v1，不消费远端 strategy=%s 的缓存",
    async (strategy) => {
      const request = vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: { configs: { modelContextBudget: { strategy } } },
        }),
      );
      const provider = new BigModelCodingPlanSubscriptionProvider({
        apiClient: { request },
        credentialService: { load: vi.fn() },
      });
      // 由其他消费者填充真实共享缓存；预算不能再读出旧算法或发起刷新。
      await provider.getForceUpdateConfig();
      request.mockClear();
      await expect(provider.getModelContextBudgetStrategy()).resolves.toBe("preflight-v1");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("配置永不返回时预算立即完成，不发请求也不启动超时器", async () => {
    vi.useFakeTimers();
    const request = vi.fn(() => new Promise<Response>(() => {}));
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient: { request },
      credentialService: { load: vi.fn() },
    });
    let value: string | undefined;
    void provider.getModelContextBudgetStrategy().then((result) => {
      value = result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(value).toBe("preflight-v1");
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("预算读取不触发配置失败请求", async () => {
    const request = vi.fn(async () => {
      throw new Error("offline");
    });
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient: { request },
      credentialService: { load: vi.fn() },
    });
    await expect(provider.getModelContextBudgetStrategy()).resolves.toBe("preflight-v1");
    expect(request).not.toHaveBeenCalled();
  });

  it("batchPreview 使用 BigModel OAuth token 且不添加 Bearer", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productList: [
              {
                productId: "product-pro",
                productName: "Coding Plan Pro",
                payAmount: 149,
              },
            ],
            isSubscribed: false,
            isAuthenticated: true,
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:bigmodel:access_token" ? "oauth-token" : null)),
      },
    });

    const result = await provider.batchPreview();

    expect(result.productList).toHaveLength(1);
    expect(apiClient.request).toHaveBeenCalledWith(
      "https://bigmodel.cn/api/biz/pay/batch-preview",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "oauth-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("ZCODE_ENV=test 时 BigModel Coding Plan API 使用 bigmodel.cn", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productList: [],
            isSubscribed: false,
            isAuthenticated: true,
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    await provider.batchPreview();

    expect(apiClient.request).toHaveBeenCalledWith(
      "https://bigmodel.cn/api/biz/pay/batch-preview",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("缺少 BigModel OAuth token 时不回退其他 key", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => null),
      },
    });

    await expect(provider.batchPreview()).rejects.toThrow("bigmodel_oauth_required");
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("BigModel OAuth token 被旧版 zcode JWT 污染时不请求套餐接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key) =>
          key === "oauth:bigmodel:access_token" || key === "zcodejwttoken"
            ? "stale-zcode-jwt"
            : null,
        ),
      },
    });

    await expect(provider.batchPreview()).rejects.toThrow("bigmodel_oauth_required");
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("支付接口返回 HTML/WAF 页面时统一返回系统繁忙错误", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createHtmlErrorResponse()),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    await expect(
      provider.preview({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        productId: "product-pro",
      }),
    ).rejects.toThrow(CODING_PLAN_SYSTEM_BUSY);
  });

  it("Z.ai batchPreview 直接使用持久化的业务 token", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createZaiBatchPreviewResponse()),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:zai:access_token" ? "zai-business-jwt" : null)),
      },
    });

    const result = await provider.batchPreview({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });

    expect(result.productList).toHaveLength(1);
    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(apiClient.request).toHaveBeenCalledWith(
      "https://api.z.ai/api/biz/pay/batch-preview",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "zai-business-jwt",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("ZCODE_ENV=test 时 Z.ai Coding Plan 业务接口使用 api.z.ai", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    // 修复原因：开发机若设了 ZAI_BUSINESS_BASE_URL=https://api.z.ai，
    // resolveZaiBusinessBaseUrl 会优先读它，覆盖 ZCODE_ENV fallback，导致断言不稳定。
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = String(input);
        if (url.includes("/product/info")) {
          return createJsonResponse({
            code: 200,
            data: { productId: "zai-product-pro" },
          });
        }
        if (url.includes("/pay/check") && !url.includes("check-pending-orders")) {
          return createJsonResponse({ code: 200, data: "SUCCESS" });
        }
        if (url.includes("check-pending-orders") || url.includes("stripe/query")) {
          return createJsonResponse({ code: 200, data: [] });
        }
        return createJsonResponse({
          code: 200,
          data: {
            productList: [],
            productId: "zai-product-pro",
            bizId: "zai-biz-1",
            soldOut: false,
            payAmount: 18,
            orderId: "order-1",
            status: "SUCCEEDED",
            resultStatus: "SUCCESS",
            setupTokenId: "setup-token-1",
          },
        });
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:zai:access_token" ? "zai-business-jwt" : null)),
      },
    });

    await provider.batchPreview({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });
    await provider.productInfo({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
    });
    await provider.preview({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
    });
    await provider.checkPayment({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      bizId: "zai-biz-1",
    });
    await provider.checkPendingOrders({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });
    await provider.queryStripeCards({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    });
    await provider.payStripe({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
      paymentMethodId: "pm_1",
      returnUrl: "https://chat.z.ai",
      estimatePayAmount: { thirdPartyPayAmount: 18 },
      bizId: "zai-biz-1",
    });
    await provider.createPaypalSetupToken({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      returnUrl: "https://chat.z.ai/return",
      cancelUrl: "https://chat.z.ai/cancel",
    });

    expect(vi.mocked(apiClient.request).mock.calls.map((call) => String(call[0]))).toEqual([
      "https://api.z.ai/api/biz/pay/batch-preview",
      "https://api.z.ai/api/biz/product/info?productId=zai-product-pro",
      "https://api.z.ai/api/biz/pay/zai-preview",
      "https://api.z.ai/api/biz/pay/check?bizId=zai-biz-1",
      "https://api.z.ai/api/biz/pay/check-pending-orders",
      "https://api.z.ai/api/pay/stripe/query",
      "https://api.z.ai/api/pay/stripe/pay",
      "https://api.z.ai/api/pay/paypal/setupToken",
    ]);
  });

  it("Z.ai 缺少登录态 token 时返回未登录错误", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => null),
      },
    });

    await expect(
      provider.batchPreview({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      }),
    ).rejects.toThrow("zai_oauth_required");
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  describe.each(["bigmodel", "zai"] as const)("%s 静态套餐配置 ID 兼容", (family) => {
    it.each(["legacy", "current", "both", "empty", "missing"] as const)(
      "%s 同时覆盖个人与团队目录",
      async (scenario) => {
        const currentId =
          family === "bigmodel"
            ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
            : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
        const legacyId = `builtin:${family}-coding-plan`;
        const product = (productId: string) => ({
          productId,
          productName: productId,
          tier: "LITE",
          subscribeMode: "CONTINUOUS",
          subscribePeriod: "MONTHLY",
          purchaseMethodName: "月付",
          priceCurrency: "CNY",
          payAmount: 123,
        });
        const config = {
          ...(scenario === "legacy" || scenario === "both"
            ? { [legacyId]: [product("legacy")] }
            : {}),
          ...(scenario === "empty" ? { [legacyId]: [] } : {}),
          ...(scenario === "current" || scenario === "both" || scenario === "empty"
            ? { [currentId]: [product("current")] }
            : {}),
        };
        const load = vi.fn();
        const provider = new BigModelCodingPlanSubscriptionProvider({
          apiClient: {
            request: vi.fn(async () =>
              createJsonResponse({
                code: 0,
                data: {
                  configs: {
                    codingPlanStaticProducts: config,
                    codingPlanStaticTeamProducts: config,
                  },
                },
              }),
            ),
          },
          credentialService: { load },
        });
        for (const result of [
          await provider.getStaticProducts(),
          await provider.getStaticTeamProducts(),
        ]) {
          expect(result[currentId]?.map((item) => item.productId)).toEqual(
            scenario === "missing"
              ? undefined
              : scenario === "empty"
                ? []
                : [scenario === "current" ? "current" : "legacy"],
          );
          expect(Object.hasOwn(result, legacyId)).toBe(false);
        }
        expect(load).not.toHaveBeenCalled();
      },
    );
  });

  it("getStaticProducts 从 ZCode client config 读取套餐配置且不需要 OAuth", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {
              codingPlanStaticProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]: [
                  {
                    productId: "remote-zai-lite",
                    productName: "Remote Lite",
                    description: ["Base usage included", "Small repo iteration"],
                    priceUnit: "month",
                    displayOrder: 1,
                    priceCurrency: "USD",
                    payAmount: 18,
                  },
                ],
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    const result = await provider.getStaticProducts();

    expect(result[BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]?.[0]?.productId).toBe(
      "remote-zai-lite",
    );
    expect(result[BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan]?.[0]?.description).toEqual([
      "Base usage included",
      "Small repo iteration",
    ]);
    const requestUrl = String(vi.mocked(apiClient.request).mock.calls[0]?.[0]);
    expect(requestUrl).toContain("https://zcode.z.ai/api/v1/client/configs?");
    expect(requestUrl).toContain("app_version=");
    expect(requestUrl).toContain(`platform=${process.platform}-${process.arch}`);
    expect(apiClient.request).toHaveBeenCalledWith(expect.any(URL), expect.anything());
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("getStaticTeamProducts 按 provider 读取团队套餐静态配置", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: {
            configs: {
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                  {
                    productId: "team-lite-monthly-continuous",
                    productName: "标准版",
                    tier: "LITE",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "连续包月",
                    priceCurrency: "CNY",
                    payAmount: 199,
                    equity: [{ text: "5小时最多：0.6亿 tokens" }],
                    description: [{ text: "团队成员席位统一管理" }],
                  },
                ],
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    const result = await provider.getStaticTeamProducts();

    expect(result[BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]?.[0]).toMatchObject({
      productName: "标准版",
      equity: [{ text: "5小时最多：0.6亿 tokens" }],
      description: [{ text: "团队成员席位统一管理" }],
    });
  });

  it("getStaticTeamProducts 拒绝非数组 provider 配置", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: {
            configs: {
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: {},
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    await expect(provider.getStaticTeamProducts()).rejects.toThrow(
      "invalid Coding Plan team products",
    );
  });

  it("getStaticTeamProducts 拒绝字段或枚举无效的商品", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: {
            configs: {
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                  {
                    productId: "",
                    productName: "标准版",
                    tier: "UNKNOWN",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "连续包月",
                    priceCurrency: "CNY",
                  },
                ],
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    await expect(provider.getStaticTeamProducts()).rejects.toThrow(
      "invalid Coding Plan team products",
    );
  });

  it("getStaticTeamProducts 拒绝无效的团队文案条目", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          data: {
            configs: {
              codingPlanStaticTeamProducts: {
                [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                  {
                    productId: "team-lite-monthly-continuous",
                    productName: "标准版",
                    tier: "LITE",
                    subscribeMode: "CONTINUOUS",
                    subscribePeriod: "MONTHLY",
                    purchaseMethodName: "连续包月",
                    priceCurrency: "CNY",
                    equity: [null],
                  },
                ],
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    await expect(provider.getStaticTeamProducts()).rejects.toThrow(
      "invalid Coding Plan team products",
    );
  });

  it("client configs 根据 ZCODE_ENV 选择测试或生产环境", () => {
    expect(
      resolveCodingPlanClientConfigUrl({
        ZCODE_ENV: "test",
      }).toString(),
    ).toBe("https://zcode.z.ai/api/v1/client/configs");
    expect(
      resolveCodingPlanClientConfigUrl({
        ZCODE_ENV: "production",
        ZCODE_PRODUCTION_BASE_URL: "https://runtime.example.com",
      }).toString(),
    ).toBe("https://runtime.example.com/api/v1/client/configs");
  });

  it("getForceUpdateConfig 从 ZCode client config 读取强制升级配置", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {
              forceUpdate: {
                minimalVersion: " 4.0.0 ",
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getForceUpdateConfig()).resolves.toEqual({
      minimalVersion: "4.0.0",
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("getForceUpdateConfig 在字段缺失时返回 null", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {},
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getForceUpdateConfig()).resolves.toBeNull();
  });

  it("getForceUpdateConfig 在 minimalVersion 类型不合法时返回 null", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {
              forceUpdate: {
                minimalVersion: 4,
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getForceUpdateConfig()).resolves.toBeNull();
  });

  it("getStartPlanPreview 从 ZCode client config 读取未登录 Start Plan 预览", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {
              startPlanPreview: {
                planId: "zcode-v3-start-plan",
                name: "ZCode V3 Start Plan",
                entitlements: [
                  {
                    grantUnits: 10_000_000,
                    meter: "model_usage",
                    period: "daily",
                    showName: "GLM-5.2",
                    unitType: "token",
                  },
                ],
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    const result = await provider.getStartPlanPreview();

    expect(result).toEqual({
      planId: "zcode-v3-start-plan",
      name: "ZCode V3 Start Plan",
      entitlements: [
        {
          grantUnits: 10_000_000,
          meter: "model_usage",
          period: "daily",
          showName: "GLM-5.2",
          unitType: "token",
        },
      ],
    });
    expect(apiClient.request).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("getBillingDiscount 仅在字段存在时返回活动配置", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {
              codingPlanBillingDiscount: {
                "zh-CN": {
                  cardTitle: "限时 150% 配额活动",
                  cardBody: "升级 Coding Plan，可在活动期内获得150% 配额",
                  badgeBody: "150% 配额",
                },
                "en-US": {
                  cardTitle: "Limited-time 150% Quota Campaign",
                  cardBody: "Upgrade your Coding Plan to get 150% quota during the campaign period",
                  badgeBody: "150% Quota",
                },
              },
            },
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getBillingDiscount()).resolves.toEqual({
      "zh-CN": {
        cardTitle: "限时 150% 配额活动",
        cardBody: "升级 Coding Plan，可在活动期内获得150% 配额",
        badgeBody: "150% 配额",
      },
      "en-US": {
        cardTitle: "Limited-time 150% Quota Campaign",
        cardBody: "Upgrade your Coding Plan to get 150% quota during the campaign period",
        badgeBody: "150% Quota",
      },
    });
  });

  it("getBillingDiscount 在字段缺失时返回 undefined", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 0,
          msg: "",
          data: {
            configs: {},
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getBillingDiscount()).resolves.toBeUndefined();
  });

  it("getStartPlanPreview、getStaticProducts 和 getBillingDiscount 共享同一次 client config 请求", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    const apiClient: ApiClient = {
      request: vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    const previewPromise = provider.getStartPlanPreview();
    const productsPromise = provider.getStaticProducts();
    const discountPromise = provider.getBillingDiscount();
    resolveRequest?.(
      createJsonResponse({
        code: 0,
        msg: "",
        data: {
          configs: {
            startPlanPreview: {
              planId: "zcode-v3-start-plan",
              name: "ZCode V3 Start Plan",
              entitlements: [
                {
                  grantUnits: 10_000_000,
                  meter: "model_usage",
                  period: "daily",
                  showName: "GLM-5.2",
                  unitType: "token",
                },
              ],
            },
            codingPlanStaticProducts: {
              [BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]: [
                {
                  productId: "remote-bigmodel-lite",
                  productName: "Remote BigModel Lite",
                  productEquityList: [],
                  priceUnit: "month",
                  displayOrder: 1,
                  priceCurrency: "CNY",
                  payAmount: 49,
                },
              ],
            },
            codingPlanBillingDiscount: {
              "zh-CN": {
                cardTitle: "限时 150% 配额活动",
                cardBody: "升级 Coding Plan，可在活动期内获得150% 配额",
                badgeBody: "150% 配额",
              },
            },
          },
        },
      }),
    );

    const [preview, products, discount] = await Promise.all([
      previewPromise,
      productsPromise,
      discountPromise,
    ]);

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(preview?.planId).toBe("zcode-v3-start-plan");
    expect(products[BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan]?.[0]?.productId).toBe(
      "remote-bigmodel-lite",
    );
    expect(discount).toEqual({
      "zh-CN": {
        cardTitle: "限时 150% 配额活动",
        cardBody: "升级 Coding Plan，可在活动期内获得150% 配额",
        badgeBody: "150% 配额",
      },
    });
    await provider.getStartPlanPreview();
    await provider.getStaticProducts();
    await provider.getBillingDiscount();
    expect(apiClient.request).toHaveBeenCalledTimes(1);
  });

  it("client configs 缓存 1 小时后重新请求", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 0,
            msg: "",
            data: {
              configs: {
                codingPlanBillingDiscount: {
                  "zh-CN": {
                    badgeBody: "第一版",
                  },
                },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 0,
            msg: "",
            data: {
              configs: {
                codingPlanBillingDiscount: {
                  "zh-CN": {
                    badgeBody: "第二版",
                  },
                },
              },
            },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(),
      },
    });

    await expect(provider.getBillingDiscount()).resolves.toEqual({
      "zh-CN": { badgeBody: "第一版" },
    });
    vi.setSystemTime(new Date("2026-06-12T00:59:59.000Z"));
    await expect(provider.getBillingDiscount()).resolves.toEqual({
      "zh-CN": { badgeBody: "第一版" },
    });
    expect(apiClient.request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-06-12T01:00:01.000Z"));
    await expect(provider.getBillingDiscount()).resolves.toEqual({
      "zh-CN": { badgeBody: "第二版" },
    });
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("getEnterprisePricing 未登录时走公开定价接口且不读取 OAuth", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productList: [
              {
                productId: "enterprise-lite-monthly",
                tier: "LITE",
                subscribeMode: "ONE_TIME",
                subscribePeriod: "MONTHLY",
                purchaseMethodName: "按月采购",
                originalAmount: 270,
                discountAmount: 27,
                payAmount: 243,
                renewAmount: 243,
              },
            ],
          },
        }),
      ),
    };
    const credentialService = { load: vi.fn() };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService,
    });

    const result = await provider.getEnterprisePricing({
      authenticated: false,
    });

    expect(result.productList[0]?.productId).toBe("enterprise-lite-monthly");
    expect(credentialService.load).not.toHaveBeenCalled();
    expect(apiClient.request).toHaveBeenCalledWith(
      "https://bigmodel.cn/api/biz/campaign/partner/enterprise/pricing",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("getEnterprisePricing 登录态使用 BigModel OAuth token 且不添加 Bearer", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: { productList: [] },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    await provider.getEnterprisePricing({ authenticated: true });

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
    );
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("getEnterprisePricing 会用 customerInfo 给已购 Team Plan 补齐项目上下文", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-0e2085",
                  tier: "PRO",
                  subscribeMode: "CONTINUOUS",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-team",
                  organizationName: "默认机构",
                  projects: [
                    {
                      projectId: "proj-default",
                      projectName: "团队编程套餐项目",
                      projectType: 1,
                    },
                    {
                      projectId: "proj-team",
                      projectName: "自定义团队项目",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[0]).toMatchObject({
      organizationId: "org-team",
      projectId: "proj-team",
      projectName: "自定义团队项目",
      teamProjects: [
        {
          organizationId: "org-team",
          projectId: "proj-team",
          projectName: "自定义团队项目",
        },
      ],
    });
  });

  it("getEnterprisePricing 已购 Team Plan 只有机构 ID 时仍从机构数组补齐项目上下文", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-0e2085",
                  tier: "PRO",
                  subscribeMode: "CONTINUOUS",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                  organizationId: "org-target",
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-other",
                  organizationName: "其他机构",
                  projects: [
                    {
                      projectId: "proj-other",
                      projectName: "其他团队项目",
                      projectType: 2,
                    },
                  ],
                },
                {
                  organizationId: "org-target",
                  organizationName: "目标机构",
                  projects: [
                    {
                      projectId: "proj-default",
                      projectName: "默认项目",
                      projectType: 1,
                    },
                    {
                      projectId: "proj-team",
                      projectName: "目标团队项目",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[0]).toMatchObject({
      organizationId: "org-target",
      organizationName: "目标机构",
      projectId: "proj-team",
      projectName: "目标团队项目",
      teamProjects: [
        {
          organizationId: "org-target",
          projectId: "proj-team",
          projectName: "目标团队项目",
        },
      ],
    });
  });

  it("getEnterprisePricing pricing 未标记订阅但 customerInfo 有团队项目时补 Team Plan 入口", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-max",
                  tier: "MAX",
                  subscribeMode: "CONTINUOUS",
                  subscribePeriod: "MONTHLY",
                  subscribed: false,
                },
                {
                  productId: "product-pro-monthly",
                  tier: "PRO",
                  subscribeMode: "ONE_TIME",
                  subscribePeriod: "MONTHLY",
                  subscribed: false,
                },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-default",
                  organizationName: "默认机构",
                  projects: [
                    {
                      projectId: "proj-default",
                      projectName: "默认项目",
                      projectType: 1,
                    },
                  ],
                },
                {
                  organizationId: "org-team",
                  organizationName: "团队机构",
                  projects: [
                    {
                      projectId: "proj-team",
                      projectName: "团队编程套餐项目",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[1]).toMatchObject({
      productId: "product-pro-monthly",
      subscribed: true,
      organizationId: "org-team",
      projectId: "proj-team",
      projectName: "团队编程套餐项目",
    });
  });

  it("getEnterprisePricing 会为多个已购 Team Plan 项目预热 zcode-team-api-key", async () => {
    const requestUrls: string[] = [];
    const requestMethods: Array<string | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        requestMethods.push(init?.method);
        if (url.endsWith("/api/biz/subscription/enterprise/v2/pricing")) {
          return createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-pro-monthly",
                  tier: "PRO",
                  subscribeMode: "ONE_TIME",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                },
              ],
            },
          });
        }
        if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
          return createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-a",
                  organizationName: "团队 A",
                  projects: [
                    {
                      projectId: "proj-a",
                      projectName: "项目 A",
                      projectType: 2,
                    },
                  ],
                },
                {
                  organizationId: "org-b",
                  organizationName: "团队 B",
                  projects: [
                    {
                      projectId: "proj-b",
                      projectName: "项目 B",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (url.endsWith("/organization/org-a/projects/proj-a/api_keys")) {
          if (init?.method === "GET") {
            return createJsonResponse({
              code: 200,
              data: [{ apiKey: "team-a-ak", keyType: 2, name: "zcode-team-api-key" }],
            });
          }
        }
        if (url.endsWith("/organization/org-b/projects/proj-b/api_keys")) {
          if (init?.method === "GET") {
            return createJsonResponse({ code: 200, data: [] });
          }
          if (init?.method === "POST") {
            expect(init.headers).toMatchObject({
              "bigmodel-organization": "org-b",
              "bigmodel-project": "proj-b",
            });
            expect(JSON.parse(String(init.body))).toEqual({
              name: "zcode-team-api-key",
              keyType: 2,
              usageScene: 1,
            });
            return createJsonResponse({
              code: 200,
              data: {
                apiKey: "team-b-ak",
                keyType: 2,
                name: "zcode-team-api-key",
              },
            });
          }
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[0]?.teamProjects).toHaveLength(2);
    expect(result.productList[0]?.teamProjects).toMatchObject([
      {
        organizationId: "org-a",
        projectId: "proj-a",
        apiKeyStatus: "available",
      },
      {
        organizationId: "org-b",
        projectId: "proj-b",
        apiKeyStatus: "available",
      },
    ]);
    expect(requestUrls).toEqual([
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
      "https://bigmodel.cn/api/biz/customer/getCustomerInfo",
      "https://bigmodel.cn/api/biz/v1/organization/org-a/projects/proj-a/api_keys",
      "https://bigmodel.cn/api/biz/v1/organization/org-b/projects/proj-b/api_keys",
      "https://bigmodel.cn/api/biz/v1/organization/org-b/projects/proj-b/api_keys",
    ]);
    expect(requestMethods).toEqual(["GET", "GET", "GET", "GET", "POST"]);
  });

  it("getEnterprisePricing 单个 Team Plan 项目 key 预热失败不阻断其他团队", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/biz/subscription/enterprise/v2/pricing")) {
          return createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-pro-monthly",
                  tier: "PRO",
                  subscribeMode: "ONE_TIME",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                },
              ],
            },
          });
        }
        if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
          return createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-a",
                  organizationName: "团队 A",
                  projects: [
                    {
                      projectId: "proj-a",
                      projectName: "项目 A",
                      projectType: 2,
                    },
                  ],
                },
                {
                  organizationId: "org-b",
                  organizationName: "团队 B",
                  projects: [
                    {
                      projectId: "proj-b",
                      projectName: "项目 B",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (url.endsWith("/organization/org-a/projects/proj-a/api_keys")) {
          throw new Error("org-a key failed");
        }
        if (
          url.endsWith("/organization/org-b/projects/proj-b/api_keys") &&
          init?.method === "GET"
        ) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-b-ak", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[0]?.teamProjects).toHaveLength(2);
    expect(result.productList[0]?.teamProjects).toMatchObject([
      {
        organizationId: "org-a",
        projectId: "proj-a",
        apiKeyStatus: "unavailable",
        apiKeyUnavailableReason: "request_failed",
      },
      {
        organizationId: "org-b",
        projectId: "proj-b",
        apiKeyStatus: "available",
      },
    ]);
    expect(requestUrls).toContain(
      "https://bigmodel.cn/api/biz/v1/organization/org-b/projects/proj-b/api_keys",
    );
  });

  it("getEnterprisePricing 会把没有有效团队套餐授权的 Team Plan 项目标为不可用", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        if (url.endsWith("/api/biz/subscription/enterprise/v2/pricing")) {
          return createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "product-pro-monthly",
                  tier: "PRO",
                  subscribeMode: "ONE_TIME",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                },
              ],
            },
          });
        }
        if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
          return createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "org-missing",
                  organizationName: "团队 Missing",
                  projects: [
                    {
                      projectId: "proj-missing",
                      projectName: "项目 Missing",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (
          url.endsWith("/organization/org-missing/projects/proj-missing/api_keys") &&
          init?.method === "GET"
        ) {
          return createJsonResponse({ code: 200, data: [] });
        }
        if (
          url.endsWith("/organization/org-missing/projects/proj-missing/api_keys") &&
          init?.method === "POST"
        ) {
          return createJsonResponse({
            code: 500,
            success: false,
            msg: "您当前暂无有效的团队套餐授权记录，无法创建API Key",
            data: null,
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    expect(result.productList[0]?.teamProjects?.[0]).toMatchObject({
      organizationId: "org-missing",
      projectId: "proj-missing",
      apiKeyStatus: "unavailable",
      apiKeyUnavailableReason: "no_valid_team_plan_authorization",
      apiKeyUnavailableMessage: "您当前暂无有效的团队套餐授权记录，无法创建API Key",
    });
  });

  it("ZCODE_ENV=test 时 Team Plan 企业接口使用 bigmodel.cn", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: { productList: [] },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: { productList: [] },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              giveBalance: 0,
              cashBalance: 0,
              totalBalance: 0,
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: [],
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: { status: "SUCCESS" },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    await provider.getEnterprisePricing({ authenticated: false });
    await provider.getEnterprisePricing({ authenticated: true });
    await provider.getEnterpriseBalance();
    await provider.getEnterprisePendingOrders();
    await provider.checkEnterpriseOrderStatus({ orderNo: "ORDER-1" });

    expect(vi.mocked(apiClient.request).mock.calls.map((call) => String(call[0]))).toEqual([
      "https://bigmodel.cn/api/biz/campaign/partner/enterprise/pricing",
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/balance",
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/orders/pending",
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/order/ORDER-1/status",
    ]);
  });

  it("企业套餐试算和下单使用 BigModel OAuth token 并原样传递金额", async () => {
    const apiClient: ApiClient = {
      request: vi
        .fn()
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              totalOriginalAmount: 2700,
              campaignDiscountAmount: 270,
              discountDetails: [],
              totalPayAmount: 2430,
              giveDeductAmount: 0,
              balanceDeductAmount: 0,
              thirdPayAmount: 2430,
            },
          }),
        )
        .mockResolvedValueOnce(
          createJsonResponse({
            code: 200,
            data: {
              orderNo: "20260507001",
              subscriptionNo: "SUB20260507",
              totalOriginalAmount: 2700,
              campaignDiscountAmount: 270,
              totalPayAmount: 2430,
              thirdPayAmount: 2430,
              discountDetails: [],
              payUrl: "https://openapi.alipay.com/pay",
              alipayJumpSchema: "alipays://platformapi/startApp",
              expireTime: "2026-05-07 10:30:00",
            },
          }),
        ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    const estimate = await provider.calculateEnterpriseOrder({
      productId: "enterprise-lite-monthly",
      maxSeats: 10,
      subscribePeriod: "MONTHLY",
      subscribeMode: "ONE_TIME",
      duration: 1,
      giveAmount: 0,
      balanceDeductAmount: 0,
    });
    await provider.createEnterpriseOrder({
      productId: "enterprise-lite-monthly",
      maxSeats: 10,
      subscribePeriod: "MONTHLY",
      subscribeMode: "ONE_TIME",
      purchaseType: "PAY",
      duration: 1,
      giveAmount: 0,
      balanceDeductAmount: 0,
      totalOriginalAmount: estimate.totalOriginalAmount,
      totalPayAmount: estimate.totalPayAmount,
      thirdPayAmount: estimate.thirdPayAmount,
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/order/calculate",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "oauth-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productId: "enterprise-lite-monthly",
          maxSeats: 10,
          subscribePeriod: "MONTHLY",
          subscribeMode: "ONE_TIME",
          duration: 1,
          giveAmount: 0,
          balanceDeductAmount: 0,
        }),
      }),
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      2,
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/order",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          productId: "enterprise-lite-monthly",
          maxSeats: 10,
          subscribePeriod: "MONTHLY",
          subscribeMode: "ONE_TIME",
          purchaseType: "PAY",
          duration: 1,
          giveAmount: 0,
          balanceDeductAmount: 0,
          totalOriginalAmount: 2700,
          totalPayAmount: 2430,
          thirdPayAmount: 2430,
        }),
      }),
    );
  });

  it("getEnterpriseBalance 使用 BigModel OAuth token 查询企业余额", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            giveBalance: 1000,
            cashBalance: 1500,
            totalBalance: 2500,
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService("oauth-token"),
    });

    await expect(provider.getEnterpriseBalance()).resolves.toEqual({
      giveBalance: 1000,
      cashBalance: 1500,
      totalBalance: 2500,
    });
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/balance",
    );
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "oauth-token",
        "Content-Type": "application/json",
      },
    });
  });

  it("createSign 默认 ALI 且固定 isDelay=0", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            orderId: "order-1",
            sign: "<form></form>",
            signType: "ALI",
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    await provider.createSign({ bizId: "biz-1" });

    const init = (apiClient.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      bizId: "biz-1",
      payType: "ALI",
      renew: null,
      isDelay: 0,
      effectiveTime: null,
    });
  });

  it("updateSign 调用套餐变更签约接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            orderId: "order-2",
            sign: "https://pay.example",
            signType: "ALI",
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    await provider.updateSign({ bizId: "biz-2" });

    expect(apiClient.request).toHaveBeenCalledWith(
      "https://bigmodel.cn/api/biz/pay/product/update/sign",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("preview 透传安全校验 ticket 和 randstr", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productId: "product-1",
            bizId: "biz-1",
            soldOut: false,
            payAmount: 149,
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    await provider.preview({
      productId: "product-1",
      ticket: "fixture-ticket",
      randstr: "fixture-randstr",
    });

    const init = (apiClient.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      productId: "product-1",
      ticket: "fixture-ticket",
      randstr: "fixture-randstr",
      salesChannel: "zcode",
    });
  });

  it("Z.ai preview 使用海外试算接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        return createJsonResponse({
          code: 200,
          data: {
            productId: "zai-product-pro",
            bizId: "zai-biz-1",
            soldOut: false,
            payAmount: 18,
          },
        });
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async (key) => (key === "oauth:zai:access_token" ? "zai-business-jwt" : null)),
      },
    });

    await provider.preview({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
      ticket: "fixture-ticket",
      randstr: "fixture-randstr",
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "https://api.z.ai/api/biz/pay/zai-preview",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "zai-business-jwt",
          "Content-Type": "application/json",
        },
      }),
    );
    const init = (apiClient.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      productId: "zai-product-pro",
      ticket: "fixture-ticket",
      randstr: "fixture-randstr",
      salesChannel: "zcode",
    });
  });

  it("Z.ai 不走 BigModel 支付宝签约接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => "zai-business-jwt"),
      },
    });

    await expect(
      provider.createSign({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        bizId: "zai-biz-1",
      }),
    ).rejects.toThrow("coding_plan_zai_overseas_payment_required");
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("Z.ai Stripe 支付使用 pay 服务接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        return createJsonResponse({
          code: 200,
          data: {
            orderId: "order-stripe-1",
            paymentIntentId: "pi_1",
            status: "SUCCEEDED",
          },
        });
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => "zai-business-jwt"),
      },
    });

    await provider.payStripe({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
      paymentMethodId: "pm_1",
      returnUrl: "https://chat.z.ai",
      estimatePayAmount: {
        cashPayAmount: 0,
        givePayAmount: 0,
        thirdPartyPayAmount: 18,
      },
      bizId: "zai-biz-1",
      renew: true,
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "https://api.z.ai/api/pay/stripe/pay",
      expect.objectContaining({
        method: "POST",
      }),
    );
    const init = (apiClient.request as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      productId: "zai-product-pro",
      paymentMethodId: "pm_1",
      returnUrl: "https://chat.z.ai",
      estimatePayAmount: {
        thirdPartyPayAmount: 18,
      },
      bizId: "zai-biz-1",
      renew: true,
    });
  });

  it("Z.ai Stripe 绑卡和解绑使用 pay 服务接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        if (String(input).includes("/stripe/bind")) {
          return createJsonResponse({
            code: 200,
            data: {
              paymentMethodId: "pm_1",
              brand: "visa",
              last4: "4242",
              requiresAction: false,
            },
          });
        }
        return createJsonResponse({
          code: 200,
          data: "ok",
        });
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => "zai-business-jwt"),
      },
    });

    await provider.bindStripeCard({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      paymentMethodId: "pm_1",
      returnUrl: "https://chat.z.ai",
    });
    await provider.unbindStripeCard({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      paymentMethodId: "pm_1",
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "https://api.z.ai/api/pay/stripe/bind",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      2,
      "https://api.z.ai/api/pay/stripe/unbind",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("Z.ai PayPal setupToken 和 subscribe 使用 pay 服务接口", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        if (String(input).includes("/paypal/setupToken")) {
          return createJsonResponse({
            code: 200,
            data: {
              resultStatus: "SUCCESS",
              setupTokenId: "setup-token-1",
              approveUrl: "https://paypal.example/approve",
            },
          });
        }
        return createJsonResponse({
          code: 200,
          data: {
            resultStatus: "SUCCESS",
            payStatus: "SUCCESS",
            orderId: "paypal-order-1",
          },
        });
      }),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: {
        load: vi.fn(async () => "zai-business-jwt"),
      },
    });

    await provider.createPaypalSetupToken({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      returnUrl: "https://chat.z.ai/return",
      cancelUrl: "https://chat.z.ai/cancel",
    });
    await provider.subscribePaypal({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      productId: "zai-product-pro",
      setupTokenId: "setup-token-1",
      amount: 18,
      estimatePayAmount: {
        thirdPartyPayAmount: 18,
      },
      bizId: "zai-biz-1",
    });

    expect(apiClient.request).toHaveBeenNthCalledWith(
      1,
      "https://api.z.ai/api/pay/paypal/setupToken",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiClient.request).toHaveBeenNthCalledWith(
      2,
      "https://api.z.ai/api/pay/paypal/subscribe",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("productInfo 使用产品详情接口补齐套餐展示信息", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productId: "product-lite",
            productName: "GLM Coding Lite",
            productBigTitle: "GLM Coding Plan",
            productSmallTitle: "轻量日常使用",
          },
        }),
      ),
    };
    const provider = new BigModelCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createBigModelCredentialService(),
    });

    const result = await provider.productInfo({ productId: "product-lite" });

    expect(result.productName).toBe("GLM Coding Lite");
    expect(apiClient.request).toHaveBeenCalledWith(
      new URL("https://bigmodel.cn/api/biz/product/info?productId=product-lite"),
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "oauth-token",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("鉴权 header helper 只返回裸 token", () => {
    expect(createBigModelLoginAuthHeaders("token-1")).toEqual({
      Authorization: "token-1",
      "Content-Type": "application/json",
    });
  });

  it("Z.ai 鉴权 header helper 只返回裸登录 token", () => {
    expect(createZaiLoginAuthHeaders("zai-token")).toEqual({
      Authorization: "zai-token",
      "Content-Type": "application/json",
    });
  });
});

describe("ZaiCodingPlanSubscriptionProvider (family-aware Team Plan)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 修复原因：开发机可能设了 ZAI_BUSINESS_BASE_URL=https://api.z.ai 环境变量，
  // resolveZaiBusinessBaseUrl 会优先读它，覆盖 ZCODE_ENV 逻辑导致测试域名断言不稳定。
  // 测试里统一 stub 成空，强制走 ZCODE_ENV fallback 链。
  function createZaiCredentialService(token = "zai-business-jwt") {
    return {
      load: vi.fn(async (key: string) => (key === "oauth:zai:access_token" ? token : null)),
    };
  }

  it("getEnterprisePricing 未登录走 zai 域名公开定价接口", async () => {
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: {
            productList: [
              {
                productId: "zai-team-pro",
                tier: "PRO",
                subscribeMode: "ONE_TIME",
                subscribePeriod: "MONTHLY",
                originalAmount: 18,
                discountAmount: 0,
                payAmount: 18,
                renewAmount: 18,
              },
            ],
          },
        }),
      ),
    };
    const provider = new ZaiCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn() },
    });

    const result = await provider.getEnterprisePricing({
      authenticated: false,
    });

    expect(result.productList[0]?.productId).toBe("zai-team-pro");
    // 关键：zai 域名，不能误用 bigmodel.cn
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://api.z.ai/api/biz/campaign/partner/enterprise/pricing",
    );
  });

  it("getEnterprisePricing 登录态使用 zai 域名 + zai OAuth token（非 bigmodel）", async () => {
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createJsonResponse({ code: 200, data: { productList: [] } })),
    };
    const provider = new ZaiCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createZaiCredentialService("zai-business-jwt"),
    });

    await provider.getEnterprisePricing({ authenticated: true });

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    // 关键：host 是 zai 域名，不是 bigmodel.cn
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing",
    );
    // 关键：token 是 zai 的，不带 Bearer
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "zai-business-jwt",
        "Content-Type": "application/json",
      },
    });
  });

  it("ZCODE_ENV=test 时 zai Team Plan 企业接口使用 api.z.ai", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    // 开发机 ZAI_BUSINESS_BASE_URL 会覆盖 ZCODE_ENV fallback，这里 stub 成空强制走 fallback
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createJsonResponse({ code: 200, data: { productList: [] } })),
    };
    const provider = new ZaiCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createZaiCredentialService(),
    });

    await provider.getEnterprisePricing({ authenticated: true });

    // 关键：测试环境走 z.ai，不能把测试 token 发到生产 api.z.ai
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing",
    );
  });

  it("getEnterprisePricing 缺少 zai OAuth token 时抛 zai_oauth_required 且不请求", async () => {
    const apiClient: ApiClient = { request: vi.fn() };
    const provider = new ZaiCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: { load: vi.fn(async () => null) },
    });

    await expect(provider.getEnterprisePricing({ authenticated: true })).rejects.toThrow(
      "zai_oauth_required",
    );
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("getEnterprisePricing 用 zai 域名的 customerInfo 给已购 Team Plan 补齐项目上下文", async () => {
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api/biz/subscription/enterprise/v2/pricing")) {
          return createJsonResponse({
            code: 200,
            data: {
              productList: [
                {
                  productId: "zai-team-pro",
                  tier: "PRO",
                  subscribeMode: "CONTINUOUS",
                  subscribePeriod: "MONTHLY",
                  subscribed: true,
                },
              ],
            },
          });
        }
        if (url.endsWith("/api/biz/customer/getCustomerInfo")) {
          return createJsonResponse({
            code: 200,
            data: {
              organizations: [
                {
                  organizationId: "zai-org",
                  organizationName: "zai 默认机构",
                  projects: [
                    {
                      projectId: "zai-proj",
                      projectName: "zai 团队项目",
                      projectType: 2,
                    },
                  ],
                },
              ],
            },
          });
        }
        if (url.endsWith("/organization/zai-org/projects/zai-proj/api_keys")) {
          // team-api-key 预热：返回已有可用 key，避免 create 调用
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "zai-team-ak", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    };
    const provider = new ZaiCodingPlanSubscriptionProvider({
      apiClient,
      credentialService: createZaiCredentialService("zai-token"),
    });

    const result = await provider.getEnterprisePricing({ authenticated: true });

    // 关键：pricing + customerInfo + team-api-key 预热都走 zai 域名，
    // 不能串到 bigmodel.cn。预热也必须用 zai host（符合"除购买外路径可复用"契约）。
    expect(requestUrls).toEqual([
      "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing",
      "https://api.z.ai/api/biz/customer/getCustomerInfo",
      "https://api.z.ai/api/biz/v1/organization/zai-org/projects/zai-proj/api_keys",
    ]);
    expect(result.productList[0]).toMatchObject({
      organizationId: "zai-org",
      projectId: "zai-proj",
      projectName: "zai 团队项目",
    });
  });
});

describe("createCodingPlanSubscriptionService (family routing)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createCredentialService() {
    return {
      load: vi.fn(async (key: string) => {
        if (key === "oauth:bigmodel:access_token") return "bigmodel-token";
        if (key === "oauth:zai:access_token") return "zai-token";
        return null;
      }),
    };
  }

  it("getEnterprisePricing 缺省 family 时走 bigmodel 域名（向后兼容）", async () => {
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        requestUrls.push(input.toString());
        return createJsonResponse({ code: 200, data: { productList: [] } });
      }),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: createCredentialService(),
    });

    await service.getEnterprisePricing({ authenticated: true });

    expect(requestUrls).toEqual(["https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing"]);
  });

  it("getEnterprisePricing family=bigmodel 走 bigmodel 域名 + bigmodel token", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => createJsonResponse({ code: 200, data: { productList: [] } })),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: createCredentialService(),
    });

    await service.getEnterprisePricing({
      authenticated: true,
      family: "bigmodel",
    });

    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/pricing",
    );
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "bigmodel-token" },
    });
  });

  it("getEnterprisePricing family=zai 走 zai 域名 + zai token", async () => {
    vi.stubEnv("ZAI_BUSINESS_BASE_URL", "");
    const apiClient: ApiClient = {
      request: vi.fn(async () => createJsonResponse({ code: 200, data: { productList: [] } })),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: createCredentialService(),
    });

    await service.getEnterprisePricing({ authenticated: true, family: "zai" });

    // 关键：service 层按 family 路由，zai 不能误用 bigmodel.cn
    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://api.z.ai/api/biz/subscription/enterprise/v2/pricing",
    );
    expect(vi.mocked(apiClient.request).mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: "zai-token" },
    });
  });

  it("企业购买闭环接口仍走 bigmodel 域名（与 family 无关）", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: { giveBalance: 0, cashBalance: 0, totalBalance: 0 },
        }),
      ),
    };
    const service = createCodingPlanSubscriptionService({
      apiClient,
      credentialService: createCredentialService(),
    });

    await service.getEnterpriseBalance();

    expect(String(vi.mocked(apiClient.request).mock.calls[0]?.[0])).toBe(
      "https://bigmodel.cn/api/biz/subscription/enterprise/v2/balance",
    );
  });
});
