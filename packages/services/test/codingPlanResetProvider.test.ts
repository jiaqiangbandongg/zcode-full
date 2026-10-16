import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS, type ApiClient } from "@zcode/shared";
import { BigModelUsageQuotaProvider } from "../src/usage-stats/providers/bigmodelUsageQuotaProvider.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createProviderForTest(options: {
  apiClient: ApiClient;
  credentials?: Record<string, string>;
}) {
  const provider = new BigModelUsageQuotaProvider({
    apiClient: options.apiClient,
    accountRequestAuthService: {
      resolveCurrent: vi.fn(async () => ({ apiKey: "unused-reset-key" })),
      assertCurrent: vi.fn(async () => undefined),
    },
    credentialService: {
      load: vi.fn(async (key: string) => options.credentials?.[key] ?? null),
    },
    env: { ZCODE_ENV: "test" },
  });
  const methodNames = new Set([
    "getCodingPlanResetStatus",
    "requestCodingPlanResetOpportunity",
    "useCodingPlanReset",
    "markCodingPlanResetHistoryRead",
  ]);
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (!methodNames.has(String(property)) || typeof value !== "function") {
        return value;
      }
      return (request: Record<string, unknown>) => value.call(target, withTestResetAccess(request));
    },
  });
}

function withTestResetAccess(request: Record<string, unknown>) {
  const providerId = String(request["preferredProviderId"] ?? "");
  const organizationId = String(request["organizationId"] ?? "").trim();
  const projectId = String(request["projectId"] ?? "").trim();
  const family = providerId.includes("zai") ? ("zai" as const) : ("bigmodel" as const);
  return {
    ...request,
    accountAccess:
      organizationId && projectId
        ? {
            type: "zhipu-account" as const,
            family,
            planKind: "team-coding-plan" as const,
            productId: "test-product",
            organizationId,
            projectId,
          }
        : {
            type: "zhipu-account" as const,
            family,
            planKind: "individual-coding-plan" as const,
          },
  };
}

describe("BigModelUsageQuotaProvider coding plan reset", () => {
  it("Z.ai provider 的四个 reset 方法统一使用 Z.ai OAuth token", async () => {
    const request = vi.fn(async (url: string | URL) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/status")) {
        return jsonResponse({
          code: 0,
          data: {
            available_five_hour_resets: [],
            available_week_resets: [],
            latest_five_hour_reset_history: null,
            latest_week_reset_history: null,
            has_unread_history: false,
          },
        });
      }
      if (pathname.endsWith("/opportunity")) {
        return jsonResponse({ code: 0, data: { granted: true } });
      }
      if (pathname.endsWith("/use")) {
        return jsonResponse({ code: 0, data: { used: true } });
      }
      return jsonResponse({ code: 0, data: {} });
    });
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:zai:access_token": "zai-business-jwt",
      },
    });
    const scope = {
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    };

    await provider.getCodingPlanResetStatus(scope);
    await provider.requestCodingPlanResetOpportunity({
      ...scope,
      idempotencyKey: "zai-opportunity-key",
    });
    await provider.useCodingPlanReset({
      ...scope,
      idempotencyKey: "zai-use-key",
      resetType: "FIVE_HOUR",
    });
    await provider.markCodingPlanResetHistoryRead(scope);

    expect(request).toHaveBeenCalledTimes(4);
    for (const [, init] of request.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Bigmodel-Authorization")).toBe("zai-business-jwt");
    }
  });

  it("reset credential 必须与 provider family 一致，不跨 Z.ai 与 BigModel 回退", async () => {
    const zaiRequest = vi.fn();
    const zaiProvider = createProviderForTest({
      apiClient: { request: zaiRequest },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "wrong-bigmodel-token",
      },
    });
    await expect(
      zaiProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_maas_jwt_required");
    expect(zaiRequest).not.toHaveBeenCalled();

    const bigmodelRequest = vi.fn();
    const bigmodelProvider = createProviderForTest({
      apiClient: { request: bigmodelRequest },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:zai:access_token": "wrong-zai-token",
      },
    });
    await expect(
      bigmodelProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_maas_jwt_required");
    expect(bigmodelRequest).not.toHaveBeenCalled();
  });

  it("查询 Personal status 时发送双凭证和 PERSONAL scope，并映射 snake_case 时间字段", async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        code: 0,
        msg: "success",
        data: {
          available_five_hour_resets: [{ expire_at: 1_786_090_230_000 }],
          available_week_resets: [],
          latest_five_hour_reset_history: { used_at: 1_786_082_400_000 },
          latest_week_reset_history: null,
          has_unread_history: true,
        },
      }),
    );
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await expect(
      provider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).resolves.toEqual({
      availableFiveHourResets: [{ expireAt: 1_786_090_230_000 }],
      availableWeekResets: [],
      latestFiveHourResetHistory: { usedAt: 1_786_082_400_000 },
      latestWeekResetHistory: null,
      hasUnreadHistory: true,
    });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/status");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer zcode-jwt");
    // 后端契约:X-Bigmodel-Authorization 传 MaaS 登录态 JWT,不是 Coding Plan API key。
    expect(headers.get("X-Bigmodel-Authorization")).toBe("maas-login-jwt");
    expect(headers.get("Bigmodel-Target-Type")).toBe("PERSONAL");
    expect(headers.has("Bigmodel-Organization")).toBe(false);
    expect(headers.has("Bigmodel-Project")).toBe(false);
  });

  it("查询 Team status 时使用 MaaS 登录态 JWT 和完整 TEAM scope,不再复制团队项目 key", async () => {
    const request = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          available_five_hour_resets: [],
          available_week_resets: [],
          latest_five_hour_reset_history: null,
          latest_week_reset_history: null,
          has_unread_history: false,
        },
      }),
    );
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "oauth-token",
      },
    });

    await provider.getCodingPlanResetStatus({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "project-team-a",
    });

    // 团队凭证同样是 MaaS JWT + org/project header,不得再请求控制台复制项目 API Key。
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/status");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Bigmodel-Authorization")).toBe("oauth-token");
    expect(headers.get("Bigmodel-Target-Type")).toBe("TEAM");
    expect(headers.get("Bigmodel-Organization")).toBe("org-team-a");
    expect(headers.get("Bigmodel-Project")).toBe("project-team-a");
  });

  it("判断 Personal opportunity 时发送双凭证、幂等键并映射 granted", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "success", data: { granted: true } }),
    );
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await expect(
      provider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "opportunity-idempotency-key",
      }),
    ).resolves.toEqual({ granted: true, nextTryAt: null });

    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/opportunity");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "opportunity-idempotency-key",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer zcode-jwt");
    expect(headers.get("X-Bigmodel-Authorization")).toBe("maas-login-jwt");
    expect(headers.get("Bigmodel-Target-Type")).toBe("PERSONAL");
  });

  it("判断 Team opportunity 时发送完整 TEAM scope", async () => {
    const request = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/api_keys")) {
        return jsonResponse({
          code: 200,
          data: [{ apiKey: "team-ak", keyType: 2, name: "zcode-team-api-key" }],
        });
      }
      if (url.endsWith("/api_keys/copy/team-ak")) {
        return jsonResponse({ code: 200, data: { secretKey: "team-secret" } });
      }
      return jsonResponse({
        code: 3301,
        data: { granted: false, next_try_at: 1_786_377_600_000 },
      });
    });
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "oauth-token",
      },
    });

    await expect(
      provider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        organizationId: "org-team-a",
        projectId: "project-team-a",
        idempotencyKey: "team-opportunity-key",
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: 1_786_377_600_000 });

    const resetCall = request.mock.calls.find(([input]) =>
      String(input).endsWith("/api/v1/coding-plan/reset/opportunity"),
    );
    expect(resetCall).toBeTruthy();
    const headers = new Headers(resetCall?.[1]?.headers);
    expect(headers.get("Bigmodel-Target-Type")).toBe("TEAM");
    expect(headers.get("Bigmodel-Organization")).toBe("org-team-a");
    expect(headers.get("Bigmodel-Project")).toBe("project-team-a");
  });

  it("opportunity 业务码 3301 视为未发放，其他业务码仍拒绝", async () => {
    const notEligibleProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({
            code: 3301,
            msg: "not eligible",
            data: { granted: false, next_try_at: 1_786_377_600_000 },
          }),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      notEligibleProvider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "not-eligible-key",
      }),
    ).resolves.toEqual({ granted: false, nextTryAt: 1_786_377_600_000 });

    const malformedProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({
            code: 3301,
            msg: "not eligible",
            data: { granted: false },
          }),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      malformedProvider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "missing-next-try-at-key",
      }),
    ).rejects.toThrow("coding_plan_reset_invalid_response");

    const failedProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({ code: 2007, msg: "dependency failed", data: null }),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      failedProvider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "dependency-failed-key",
      }),
    ).rejects.toThrow("coding_plan_reset_api_error:2007");
  });

  it("opportunity HTTP 429 限流映射为稳定的 throttled 错误码", async () => {
    // 后端「请求过快或发卡锁被占用」直接回裸 429，不带 3301 信封；客户端要据此写兜底冷却。
    const throttledProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () => jsonResponse({ message: "请求过快或发卡锁被占用" }, 429)),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      throttledProvider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "throttled-key",
      }),
    ).rejects.toThrow("coding_plan_reset_opportunity_throttled");

    // 其他端点的 429 不做该映射，保持原始 ApiError 语义。
    const statusProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () => jsonResponse({ message: "too fast" }, 429)),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      statusProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("too fast");
  });

  it("opportunity 在幂等键为空或超过 64 字符时不发送请求", async () => {
    const request = vi.fn();
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await expect(
      provider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "   ",
      }),
    ).rejects.toThrow("coding_plan_reset_invalid_idempotency_key");
    await expect(
      provider.requestCodingPlanResetOpportunity({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "x".repeat(65),
      }),
    ).rejects.toThrow("coding_plan_reset_invalid_idempotency_key");
    expect(request).not.toHaveBeenCalled();
  });

  it("手动 use 发送 FIVE_HOUR 和调用方幂等键", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ code: 0, msg: "success", data: { used: true } }),
    );
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await expect(
      provider.useCodingPlanReset({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        idempotencyKey: "same-key-on-retry",
        resetType: "FIVE_HOUR",
      }),
    ).resolves.toEqual({ used: true });

    const [, init] = request.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: "same-key-on-retry",
      reset_type: "FIVE_HOUR",
    });
  });

  it("history/read 只发送 JWT、MaaS 登录态 credential，不发送 target scope", async () => {
    const request = vi.fn(async () => jsonResponse({ code: 0, msg: "success" }));
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await provider.markCodingPlanResetHistoryRead({
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    const [url, init] = request.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/coding-plan/reset/history/read");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer zcode-jwt");
    expect(headers.get("X-Bigmodel-Authorization")).toBe("maas-login-jwt");
    expect(headers.has("Bigmodel-Target-Type")).toBe(false);
  });

  it("缺少 JWT 或服务端业务 code 非 0 时拒绝，且不按 msg 分支", async () => {
    const missingJwtRequest = vi.fn();
    const missingJwtProvider = createProviderForTest({
      apiClient: { request: missingJwtRequest },
    });
    await expect(
      missingJwtProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_zcode_jwt_required");
    expect(missingJwtRequest).not.toHaveBeenCalled();

    // 只有 zcode JWT、没有 MaaS 登录态 JWT 时同样拒绝且不发请求:后端要求
    // X-Bigmodel-Authorization 必须是 MaaS JWT,不能回退 provider API key。
    const missingMaasJwtRequest = vi.fn();
    const missingMaasJwtProvider = createProviderForTest({
      apiClient: { request: missingMaasJwtRequest },
      credentials: { zcodejwttoken: "zcode-jwt" },
    });
    await expect(
      missingMaasJwtProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_maas_jwt_required");
    expect(missingMaasJwtRequest).not.toHaveBeenCalled();

    const provider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () => jsonResponse({ code: 2007, msg: "任意文案", data: null })),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      provider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_api_error:2007");

    const forbiddenProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({ code: 3101, msg: "coding plan is required", data: null }, 403),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      forbiddenProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_api_error:3101");
  });

  it("envelope 业务错误时错误信息附带 x-request-id 便于联调对账", async () => {
    // 2007 是后端 -> MAAS 依赖错误，客户端日志必须能带出后端 x-request-id，
    // 否则只能拿毫秒级时间戳让后端反向捞日志。
    const request = vi.fn(async () => {
      const response = jsonResponse({
        code: 2007,
        msg: "dependency failed",
        data: null,
      });
      response.headers.set("x-request-id", "req-abc-123");
      return response;
    });
    const provider = createProviderForTest({
      apiClient: { request },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    const error = await provider
      .getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      })
      .then(
        () => null,
        (err: Error) => err,
      );
    // 前缀契约不变，仅追加诊断后缀；失败用例会展示实际 message 便于定位。
    expect(error?.message).toBe("coding_plan_reset_api_error:2007 (x-request-id:req-abc-123)");

    // 响应不带 x-request-id 时保持原 message，不产生空诊断括号。
    const bareProvider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({ code: 2007, msg: "dependency failed", data: null }),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });
    await expect(
      bareProvider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow(Error("coding_plan_reset_api_error:2007"));
  });

  it("status 响应字段非法时拒绝进入客户端状态", async () => {
    const provider = createProviderForTest({
      apiClient: {
        request: vi.fn(async () =>
          jsonResponse({
            code: 0,
            data: {
              available_five_hour_resets: [{ expire_at: "not-a-number" }],
              available_week_resets: [],
              latest_five_hour_reset_history: null,
              latest_week_reset_history: null,
              has_unread_history: false,
            },
          }),
        ),
      },
      credentials: {
        zcodejwttoken: "zcode-jwt",
        "oauth:bigmodel:access_token": "maas-login-jwt",
      },
    });

    await expect(
      provider.getCodingPlanResetStatus({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      }),
    ).rejects.toThrow("coding_plan_reset_invalid_response");
  });
});
