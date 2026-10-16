import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, AppUsageSnapshot, ZCodeAccountAccess } from "@zcode/shared";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";
import { resolveCodingPlanUsageTimeRange } from "../src/usage-stats/providers/bigmodelUsageMonitorRange.js";

const TEST_BIGMODEL_PROVIDER_ID = "test-bigmodel-api-provider";
const TEST_ZAI_PROVIDER_ID = "test-zai-api-provider";

function createAppUsageSnapshot(): AppUsageSnapshot {
  return {
    range: "30d",
    generatedAt: 1_900_000_000_000,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 104,
      inputTokens: 14,
      outputTokens: 5,
      reasoningTokens: 0,
      cacheCreationTokens: 5,
      cacheReadTokens: 80,
      cacheHitRate: 0.8,
      totalSessions: 1,
      totalTurns: 1,
      toolCallCount: 2,
      toolErrorRate: 0.5,
      modelErrorRate: 0.5,
      avgTimeToFirstTokenMs: 100,
      avgTurnDurationMs: 2000,
      activeDays: 2,
      currentStreakDays: 2,
      longestSessionMs: 2000,
      longestStreakDays: 2,
      peakDayTokens: 104,
      favoriteModel: { modelId: "model-a", totalTokens: 104, share: 1 },
    },
    heatmap: { startDate: null, endDate: null, maxTokens: 100, weeks: [] },
    dailyModelUsage: [],
    models: [],
    tools: [],
  };
}

interface TestUsageProvider {
  id: string;
  name: string;
  enabled: boolean;
  apiKey: string;
}

function createProvider(overrides: Partial<TestUsageProvider>): TestUsageProvider {
  return {
    id: TEST_BIGMODEL_PROVIDER_ID,
    name: "BigModel",
    enabled: true,
    apiKey: "bigmodel-api-key",
    ...overrides,
  };
}

function createJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function createUsageStatsServiceForTest(params: {
  apiClient?: ApiClient;
  providers: TestUsageProvider[];
  env?: NodeJS.ProcessEnv;
  credentialTokens?: Record<string, string | null | undefined>;
  resolveAccountAuth?: (input: {
    providerId: string;
    accountAccess: ZCodeAccountAccess;
  }) => Promise<{ apiKey?: string }>;
  getAppUsageStats?: IZCodeAgentService["getAppUsageStats"];
}) {
  const service = createUsageStatsService({
    apiClient: params.apiClient ?? {
      request: vi.fn(),
    },
    accountRequestAuthService: {
      resolveAccessCurrent: vi.fn(async () => null),
      resolveCurrent: vi.fn(
        params.resolveAccountAuth ??
          (async ({ providerId, accountAccess }) => {
            if (accountAccess.planKind === "team-coding-plan") {
              return {
                apiKey:
                  providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
                    ? "zai-team-ak.zai-team-secret"
                    : "team-ak.team-secret",
              };
            }
            return {
              apiKey: params.providers.find((provider) => provider.id === providerId)?.apiKey,
            };
          }),
      ),
      assertCurrent: vi.fn(async () => undefined),
    },
    resolveApiAuthorization: vi.fn(async ({ preferredProviderId }) => {
      const provider = params.providers.find((candidate) =>
        preferredProviderId ? candidate.id === preferredProviderId : candidate.enabled,
      );
      const apiKey = provider?.apiKey?.trim() ?? "";
      if (!provider || !apiKey) return null;
      return {
        authorization: apiKey,
        quotaUrl:
          provider.id === TEST_ZAI_PROVIDER_ID
            ? "https://api.z.ai/api/monitor/usage/quota/limit"
            : "https://bigmodel.cn/api/monitor/usage/quota/limit",
        provider: { id: provider.id, name: provider.name },
      };
    }),
    credentialService: {
      load: vi.fn(async (key) => params.credentialTokens?.[key] ?? null),
    },
    env: params.env,
    zcodeAgentService: {
      getAppUsageStats: params.getAppUsageStats ?? vi.fn(async () => createAppUsageSnapshot()),
    },
  });
  return {
    ...service,
    getCodingPlanUsageSnapshot: (
      request: Parameters<typeof service.getCodingPlanUsageSnapshot>[0],
    ) =>
      service.getCodingPlanUsageSnapshot({
        ...request,
        accountAccess:
          request.accountAccess ??
          (request.organizationId && request.projectId
            ? {
                type: "zhipu-account",
                family: request.preferredProviderId?.includes("zai") ? "zai" : "bigmodel",
                planKind: "team-coding-plan",
                productId: "test-product",
                organizationId: request.organizationId,
                projectId: request.projectId,
              }
            : {
                type: "zhipu-account",
                family: request.preferredProviderId?.includes("zai") ? "zai" : "bigmodel",
                planKind: "individual-coding-plan",
              }),
      }),
    // Highspeed 的普通 TPS 查询同样按 accountAccess 鉴权；默认补个人套餐访问上下文，
    // 让用例专注缓存与诊断行为，需要 Team scope 的用例显式传入。
    getCodingPlanRegularTps: (
      request: Omit<
        Parameters<NonNullable<typeof service.getCodingPlanRegularTps>>[0],
        "accountAccess"
      > & {
        accountAccess?: ZCodeAccountAccess;
      },
    ) =>
      service.getCodingPlanRegularTps?.({
        ...request,
        accountAccess:
          request.accountAccess ??
          ({
            type: "zhipu-account",
            family: request.preferredProviderId.includes("zai") ? "zai" : "bigmodel",
            planKind: "individual-coding-plan",
          } satisfies ZCodeAccountAccess),
      }),
  };
}

describe("createUsageStatsService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("Highspeed 普通 TPS 只请求 7 天健康接口，并缓存及合并同 key 并发请求", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: { x_time: ["2026-05-18", "2026-05-19"], proMaxDecodeSpeed: [68, 73] },
        }),
      ),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });
    const request = {
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    };

    await expect(
      Promise.all([
        service.getCodingPlanRegularTps(request),
        service.getCodingPlanRegularTps(request),
      ]),
    ).resolves.toEqual([73, 73]);
    await expect(service.getCodingPlanRegularTps(request)).resolves.toBe(73);

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    const requestedUrl = String(vi.mocked(apiClient.request).mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("/model-performance-day");
    expect(requestedUrl).not.toContain("credit-usage");
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await expect(service.getCodingPlanRegularTps(request)).resolves.toBe(73);
    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("Highspeed 普通 TPS 按账号访问上下文隔离缓存", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        createJsonResponse({
          code: 200,
          data: { x_time: ["2026-05-18", "2026-05-19"], proMaxDecodeSpeed: [68, 73] },
        }),
      ),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });
    const preferredProviderId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;

    await expect(
      service.getCodingPlanRegularTps({ preferredProviderId, timeZone: "UTC" }),
    ).resolves.toBe(73);
    // Team scope 已内含在 accountAccess 中；缓存键必须整体覆盖它，否则同一 provider 下
    // 切换团队项目会读到上一个项目的基准 TPS。
    await expect(
      service.getCodingPlanRegularTps({
        preferredProviderId,
        timeZone: "UTC",
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "test-product",
          organizationId: "org-1",
          projectId: "project-1",
        },
      }),
    ).resolves.toBe(73);

    expect(apiClient.request).toHaveBeenCalledTimes(2);
  });

  it("Highspeed 普通 TPS 健康检查失败时记录 HTTP 链路诊断", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const apiClient: ApiClient = {
      request: vi.fn(async () =>
        Response.json(
          { code: 5030, msg: "monitor unavailable" },
          {
            status: 503,
            statusText: "Service Unavailable",
            headers: {
              "x-request-id": "req-regular-tps",
              "x-trace-id": "trace-regular-tps",
            },
          },
        ),
      ),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });

    await expect(
      service.getCodingPlanRegularTps({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("monitor unavailable");

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "Highspeed 普通 TPS 健康检查失败",
      expect.objectContaining({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        status: 503,
        responseHeaders: {
          "x-request-id": "req-regular-tps",
          "x-trace-id": "trace-regular-tps",
        },
        url: expect.stringContaining("/api/monitor/usage/model-performance-day"),
      }),
    );
  });

  it("Highspeed 普通 TPS 健康检查业务失败时保留 request id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = createUsageStatsServiceForTest({
      apiClient: {
        request: vi.fn(async () =>
          Response.json(
            { code: 2007, msg: "monitor dependency failed" },
            { headers: { "x-request-id": "req-regular-tps-business" } },
          ),
        ),
      },
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });

    await expect(
      service.getCodingPlanRegularTps({
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("monitor dependency failed");

    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "Highspeed 普通 TPS 健康检查失败",
      expect.objectContaining({
        status: 200,
        responseCode: 2007,
        responseHeaders: { "x-request-id": "req-regular-tps-business" },
      }),
    );
  });

  it("Coding Plan 按当日/7日/30日生成稳定时间轴", () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });

    const today = resolveCodingPlanUsageTimeRange({
      range: "today",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });
    const sevenDays = resolveCodingPlanUsageTimeRange({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });

    expect(today.granularity).toBe("hour");
    expect(today.xTime[0]).toBe("00:00:00");
    expect(today.xTime.at(-1)).toBe("23:00:00");
    expect(sevenDays.granularity).toBe("day");
    expect(sevenDays.xTime).toEqual([
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
      "2026-05-16",
      "2026-05-17",
      "2026-05-18",
      "2026-05-19",
    ]);
  });

  it("Coding Plan 时间范围按调用端 timeZone 生成自然日边界", () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T23:30:00.000Z") });

    const utc = resolveCodingPlanUsageTimeRange({
      range: "today",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });
    const shanghai = resolveCodingPlanUsageTimeRange({
      range: "today",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "Asia/Shanghai",
    });

    expect(utc.startTime).toBe("2026-05-19 00:00:00");
    expect(utc.endTime).toBe("2026-05-19 23:59:59");
    expect(shanghai.startTime).toBe("2026-05-20 00:00:00");
    expect(shanghai.endTime).toBe("2026-05-20 23:59:59");
  });

  it("Coding Plan 自定义日期范围限制为 30 个自然日并生成日粒度时间轴", () => {
    const custom = resolveCodingPlanUsageTimeRange({
      range: "custom",
      customStartDate: "2026-05-01",
      customEndDate: "2026-05-03",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    expect(custom.startTime).toBe("2026-05-01 00:00:00");
    expect(custom.endTime).toBe("2026-05-03 23:59:59");
    expect(custom.granularity).toBe("day");
    expect(custom.xTime).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);

    expect(() =>
      resolveCodingPlanUsageTimeRange({
        range: "custom",
        customStartDate: "2026-05-01",
        customEndDate: "2026-06-01",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).toThrow("coding_plan_usage_custom_range_too_long");
  });

  it("App Usage 经 ZCode Protocol 读取 agent 数据库统计", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot());
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [],
      getAppUsageStats,
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "30d",
      timeZone: "UTC",
    });

    // App Usage 不走 monitor HTTP，只走 agent 协议。
    expect(apiClient.request).not.toHaveBeenCalled();
    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "30d",
      timeZone: "UTC",
    });
    expect(snapshot.source).toBe("agent-db");
    expect(snapshot.summary.totalSessions).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(104);
  });

  it("App Usage 不会因为存在 Coding Plan key 而切到 monitor 接口", async () => {
    const getAppUsageStats = vi.fn(async () => createAppUsageSnapshot());
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
        }),
      ],
      getAppUsageStats,
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "7d",
      timeZone: "UTC",
    });

    expect(apiClient.request).not.toHaveBeenCalled();
    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "7d",
      timeZone: "UTC",
    });
    expect(snapshot.source).toBe("agent-db");
  });

  it("App Usage 全量概览用 all range 透传到 agent 数据库统计", async () => {
    const getAppUsageStats = vi.fn(async () => ({
      ...createAppUsageSnapshot(),
      range: "all",
    }));
    const service = createUsageStatsServiceForTest({
      providers: [],
      getAppUsageStats,
    });

    const snapshot = await service.getAppUsageSnapshot({
      range: "all",
      timeZone: "Asia/Shanghai",
    });

    expect(getAppUsageStats).toHaveBeenCalledWith({
      range: "all",
      timeZone: "Asia/Shanghai",
    });
    expect(snapshot.range).toBe("all");
  });

  it("严格指定个人 Coding Plan 时使用 provider apiKey 的 monitor 数据且不回退本地", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const requestUrls: string[] = [];
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        requestHeaders.push(init?.headers);
        expect(init?.headers).toMatchObject({
          authorization: "legacy-coding-plan-api-key",
        });
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: {
              level: "pro",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  unit: 3,
                  number: 5,
                  usage: 100,
                  currentValue: 31,
                  percentage: 31,
                },
              ],
            },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: {
              summary: {
                totalTokens: 350_720,
                peakDailyTokens: 120,
                peakDailyTokensDate: "2026-05-18",
                totalUsageDurationMs: 60_000,
                currentStreakDays: 1,
                longestStreakDays: 1,
              },
              series: [
                {
                  date: "2026-05-18",
                  totalTokens: 120,
                  modelCallCount: 2,
                  mcpCalls: 1,
                },
              ],
            },
          });
        }
        if (url.includes("/api/monitor/credit-usage/usage-detail")) {
          const usageType = new URL(url).searchParams.get("usageType");
          if (usageType === "MODEL") {
            return createJsonResponse({
              code: 200,
              data: {
                summary: {
                  cacheHitRate: { value: 0.893, trend: 0.12 },
                  totalCredits: { value: 28.95, trend: -0.2 },
                  averageDailyCredits: { value: 4.13, trend: 0 },
                },
                modelUsage: {
                  xTime: ["2026-05-18"],
                  modelDataList: [
                    {
                      modelName: "glm-5",
                      totalTokens: 120,
                      totalCredits: 28.95,
                      totalCreditsUsage: [28.95],
                      totalTokensUsage: [120],
                      cachedInputCreditsUsage: [17.68],
                      uncachedInputCreditsUsage: [8.63],
                      outputCreditsUsage: [2.64],
                      cachedInputTokensUsage: [70],
                      uncachedInputTokensUsage: [40],
                      outputTokensUsage: [10],
                      sortOrder: 1,
                    },
                  ],
                },
              },
            });
          }
          return createJsonResponse({
            code: 200,
            data: {
              summary: {
                cacheHitRate: { value: null },
                totalCredits: { value: 1, trend: 0.5 },
                averageDailyCredits: { value: 0.2, trend: 0.1 },
              },
              mcpUsage: {
                xTime: ["2026-05-18"],
                mcpDataList: [
                  {
                    mcpCode: "search-prime",
                    mcpName: "联网搜索 MCP",
                    creditsUsage: [1],
                    mcpCallCount: [1],
                    totalUsageCount: 1,
                    totalCredits: 1,
                    sortOrder: 1,
                  },
                ],
              },
            },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: {
              x_time: ["2026-05-18", "2026-05-19"],
              proMaxDecodeSpeed: [125.4, 130.1],
              liteDecodeSpeed: [55.2, 58.8],
            },
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "legacy-coding-plan-api-key",
        }),
        createProvider({
          id: TEST_BIGMODEL_PROVIDER_ID,
          name: "BigModel",
          apiKey: "ordinary-api-key",
        }),
      ],
      env: {
        ZCODE_BIGMODEL_USAGE_API_KEY: "env-usage-key",
      },
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "30d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    expect(requestUrls).toHaveLength(5);
    expect(requestHeaders).toEqual(
      Array.from({ length: 5 }, () =>
        expect.objectContaining({
          authorization: "legacy-coding-plan-api-key",
        }),
      ),
    );
    for (const headers of requestHeaders) {
      expect(headers).not.toMatchObject({
        "bigmodel-organization": expect.any(String),
        "bigmodel-project": expect.any(String),
      });
    }
    for (const url of requestUrls.filter((item) => item.includes("/api/monitor/usage/"))) {
      if (url.includes("/quota/limit")) {
        continue;
      }
      expect(new URL(url).searchParams.has("granularity")).toBe(false);
    }
    const modelUsageUrl = new URL(
      requestUrls.find((url) => url.includes("/usage-detail") && url.includes("MODEL")) ?? "",
    );
    const activityUrl = new URL(requestUrls.find((url) => url.includes("/activity")) ?? "");
    const quotaUrl = new URL(requestUrls.find((url) => url.includes("/quota/limit")) ?? "");
    const toolUsageUrl = new URL(
      requestUrls.find((url) => url.includes("/usage-detail") && url.includes("MCP")) ?? "",
    );
    const healthUrls = requestUrls
      .filter((url) => url.includes("/model-performance-day"))
      .map((url) => new URL(url));
    expect(quotaUrl.searchParams.has("type")).toBe(false);
    expect(activityUrl.searchParams.get("type")).toBe("1");
    expect(modelUsageUrl.searchParams.get("type")).toBe("1");
    expect(toolUsageUrl.searchParams.get("type")).toBe("1");
    expect(healthUrls).toHaveLength(1);
    expect(healthUrls.every((url) => !url.searchParams.has("type"))).toBe(true);
    expect(modelUsageUrl.searchParams.get("startTime")).toBe("2026-04-20 00:00:00");
    expect(modelUsageUrl.searchParams.get("endTime")).toBe("2026-05-19 23:59:59");
    expect(healthUrls[0]?.searchParams.get("startTime")).toBe("2026-05-13 00:00:00");
    expect(healthUrls[0]?.searchParams.get("endTime")).toBe("2026-05-19 23:59:59");
    expect(snapshot.rangeStartDate).toBe("2026-04-20");
    expect(snapshot.rangeEndDate).toBe("2026-05-19");
    expect(snapshot.sourceProvider).toMatchObject({
      id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });
    expect(snapshot.modelUsage.totalTokensUsage).toBe(120);
    expect(snapshot.modelUsage.granularity).toBe("day");
    expect(snapshot.modelUsage.xTime).toHaveLength(30);
    expect(snapshot.modelUsage.modelDataList[0]?.modelName).toBe("glm-5");
    expect(snapshot.modelUsage.modelDataList[0]?.tokensUsage).toContain(120);
    expect(snapshot.modelUsage.modelDataList[0]?.cachedInputCreditsUsage).toContain(17.68);
    expect(snapshot.modelUsage.modelDataList[0]?.uncachedInputCreditsUsage).toContain(8.63);
    expect(snapshot.modelUsage.modelDataList[0]?.outputCreditsUsage).toContain(2.64);
    expect(snapshot.activity.summary.totalTokens).toBe(350_720);
    expect(snapshot.detail.model.cacheHitRate).toBe(0.893);
    expect(snapshot.detail.model.cacheHitRateTrend).toBe(0.12);
    expect(snapshot.detail.model.totalCreditsTrend).toBe(-0.2);
    expect(snapshot.detail.tool.totalCredits).toBe(1);
    expect(snapshot.detail.tool.averageDailyCredits).toBe(0.2);
    expect(snapshot.toolUsage.toolDataList[0]?.toolName).toBe("联网搜索 MCP");
    expect(snapshot.toolUsage.toolDataList[0]?.usageCount).toContain(1);
    expect(snapshot.health).toEqual({
      xTime: ["2026-05-18", "2026-05-19"],
      proMaxDecodeSpeed: [125.4, 130.1],
      liteDecodeSpeed: [55.2, 58.8],
    });
    expect(snapshot.quota?.limits).toHaveLength(1);
  });

  it("Coding Plan 积分序列遇到非数字桶时归零，避免 UI 汇总显示 NaN", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "pro", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        const usageType = new URL(url).searchParams.get("usageType");
        return createJsonResponse({
          code: 200,
          data:
            usageType === "MODEL"
              ? {
                  summary: { totalCredits: { value: "bad" } },
                  modelUsage: {
                    xTime: ["2026-05-18", "2026-05-19"],
                    modelDataList: [
                      {
                        modelName: "glm-5",
                        totalCreditsUsage: ["bad", "28.95"],
                        totalTokensUsage: ["bad", "120"],
                      },
                    ],
                  },
                }
              : {
                  mcpUsage: {
                    xTime: ["2026-05-18", "2026-05-19"],
                    mcpDataList: [
                      {
                        mcpCode: "search-prime",
                        creditsUsage: ["bad", "1"],
                        mcpCallCount: ["bad", "2"],
                      },
                    ],
                  },
                },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    const modelCredits = snapshot.modelUsage.modelDataList[0]?.creditsUsage ?? [];
    const modelTokens = snapshot.modelUsage.modelDataList[0]?.tokensUsage ?? [];
    const toolCredits = snapshot.toolUsage.toolDataList[0]?.creditsUsage ?? [];
    const toolCalls = snapshot.toolUsage.toolDataList[0]?.usageCount ?? [];
    expect(modelCredits.every(Number.isFinite)).toBe(true);
    expect(modelTokens.every(Number.isFinite)).toBe(true);
    expect(toolCredits.every(Number.isFinite)).toBe(true);
    expect(toolCalls.every(Number.isFinite)).toBe(true);
    expect(modelCredits.at(-2)).toBe(0);
    expect(modelCredits.at(-1)).toBe(28.95);
    expect(toolCredits.at(-2)).toBe(0);
    expect(toolCredits.at(-1)).toBe(1);
  });

  it("Coding Plan 使用详情不会把缓存输入和输出拆分桶当成模型图例", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "pro", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        const usageType = new URL(url).searchParams.get("usageType");
        return createJsonResponse({
          code: 200,
          data:
            usageType === "MODEL"
              ? {
                  summary: { totalCredits: { value: 7 } },
                  modelUsage: {
                    xTime: ["2026-05-18"],
                    modelDataList: [
                      {
                        modelCode: "cached_input",
                        modelName: "缓存",
                        totalCreditsUsage: [1],
                        totalTokensUsage: [10],
                        sortOrder: 1,
                      },
                      {
                        modelCode: "uncached_input",
                        modelName: "未缓存",
                        totalCreditsUsage: [2],
                        totalTokensUsage: [20],
                        sortOrder: 2,
                      },
                      {
                        modelCode: "output",
                        modelName: "输出",
                        totalCreditsUsage: [4],
                        totalTokensUsage: [40],
                        sortOrder: 3,
                      },
                    ],
                  },
                }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    expect(snapshot.modelUsage.modelDataList.map((item) => item.modelName)).toEqual([]);
    expect(snapshot.modelUsage.totalTokensUsage).toBe(70);
  });

  it("Coding Plan 总用量在真实模型行与拆分桶同时返回时不会双倍计算", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "pro", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        const usageType = new URL(url).searchParams.get("usageType");
        return createJsonResponse({
          code: 200,
          data:
            usageType === "MODEL"
              ? {
                  summary: { totalCredits: { value: 7 } },
                  modelUsage: {
                    xTime: ["2026-05-18"],
                    modelDataList: [
                      {
                        modelCode: "glm-5",
                        modelName: "GLM-5",
                        totalTokensUsage: [120],
                        sortOrder: 0,
                      },
                      {
                        modelCode: "cached_input",
                        modelName: "缓存",
                        totalCreditsUsage: [1],
                        totalTokensUsage: [10],
                        sortOrder: 1,
                      },
                      {
                        modelCode: "uncached_input",
                        modelName: "未缓存",
                        totalCreditsUsage: [2],
                        totalTokensUsage: [20],
                        sortOrder: 2,
                      },
                      {
                        modelCode: "output",
                        modelName: "输出",
                        totalCreditsUsage: [4],
                        totalTokensUsage: [40],
                        sortOrder: 3,
                      },
                    ],
                  },
                }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "coding-plan-api-key",
        }),
      ],
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    expect(snapshot.modelUsage.modelDataList.map((item) => item.modelName)).toEqual(["GLM-5"]);
    expect(snapshot.modelUsage.totalTokensUsage).toBe(120);
  });

  it("Team Plan 用量使用 Account Auth 返回的团队项目 API Key", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const requestUrls: string[] = [];
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        requestHeaders.push(init?.headers);
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
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: {
              level: "team",
              limits: [],
            },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: { summary: { totalTokens: 120 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        expect(url).toContain("/api/monitor/credit-usage/usage-detail");
        return createJsonResponse({
          code: 0,
          msg: "操作成功",
          success: true,
          data:
            new URL(url).searchParams.get("usageType") === "MODEL"
              ? {
                  modelUsage: {
                    xTime: ["2026-05-18"],
                    modelDataList: [
                      {
                        modelName: "glm-5",
                        totalTokens: 120,
                        totalTokensUsage: [120],
                      },
                    ],
                  },
                }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "",
        }),
      ],
      credentialTokens: {
        "oauth:bigmodel:access_token": "oauth-token",
      },
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "30d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
      timeZone: "UTC",
    });

    expect(requestUrls.some((url) => url.includes("/api_keys"))).toBe(false);
    expect(requestHeaders.slice(-3)).toEqual([
      expect.objectContaining({
        authorization: "team-ak.team-secret",
        "bigmodel-organization": "org-team-a",
        "bigmodel-project": "proj-team-a",
      }),
      expect.objectContaining({
        authorization: "team-ak.team-secret",
        "bigmodel-organization": "org-team-a",
        "bigmodel-project": "proj-team-a",
      }),
      expect.objectContaining({
        authorization: "team-ak.team-secret",
        "bigmodel-organization": "org-team-a",
        "bigmodel-project": "proj-team-a",
      }),
    ]);
    const teamQuotaUrl = new URL(
      requestUrls.find((url) => url.includes("/api/monitor/usage/quota/limit")) ?? "",
    );
    const teamCreditUsageUrls = requestUrls
      .filter((url) => url.includes("/api/monitor/credit-usage/"))
      .map((url) => new URL(url));
    expect(teamQuotaUrl.searchParams.get("type")).toBe("2");
    expect(teamCreditUsageUrls).toHaveLength(3);
    expect(teamCreditUsageUrls.every((url) => url.searchParams.get("type") === "3")).toBe(true);
    expect(snapshot.modelUsage.totalTokensUsage).toBe(120);
    expect(snapshot.toolUsage.toolDataList).toEqual([]);
    expect(snapshot.sourceProvider.id).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
  });

  it("Team Plan 用量允许已登录但被禁用的 BigModel Coding Plan provider", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
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
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "team", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        return createJsonResponse({
          code: 200,
          data:
            new URL(url).searchParams.get("usageType") === "MODEL"
              ? { modelUsage: { xTime: ["2026-05-18"], modelDataList: [] } }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "",
          enabled: false,
        }),
      ],
      credentialTokens: {
        "oauth:bigmodel:access_token": "oauth-token",
      },
    });

    await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      organizationId: "org-team-a",
      projectId: "proj-team-a",
      timeZone: "UTC",
    });

    expect(requestUrls[0]).toBe("https://bigmodel.cn/api/monitor/usage/quota/limit?type=2");
  });

  it("Z.ai Team Plan 用量使用 Account Auth 返回的团队项目 API Key（对齐 BigModel）", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const requestUrls: string[] = [];
    const requestHeaders: Array<HeadersInit | undefined> = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input, init) => {
        const url = input.toString();
        requestUrls.push(url);
        requestHeaders.push(init?.headers);
        if (url.endsWith("/api_keys")) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-ak-zai", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        if (url.endsWith("/api_keys/copy/team-ak-zai")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "team-secret-zai" },
          });
        }
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: { level: "team", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: { summary: { totalTokens: 88 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 0,
            msg: "操作成功",
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        expect(url).toContain("/api/monitor/credit-usage/usage-detail");
        return createJsonResponse({
          code: 0,
          msg: "操作成功",
          success: true,
          data:
            new URL(url).searchParams.get("usageType") === "MODEL"
              ? {
                  modelUsage: {
                    xTime: ["2026-05-18"],
                    modelDataList: [
                      {
                        modelName: "glm-5",
                        totalTokens: 88,
                        totalTokensUsage: [88],
                      },
                    ],
                  },
                }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          name: "Z.ai - Coding Plan",
          apiKey: "",
        }),
      ],
      credentialTokens: {
        "oauth:zai:access_token": "zai-oauth-token",
      },
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "30d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      organizationId: "org-zai-team",
      projectId: "proj-zai-team",
      timeZone: "UTC",
    });

    expect(requestUrls.some((url) => url.includes("/api_keys"))).toBe(false);
    // monitor 接口用复制的团队项目 API Key + org/project header（与 bigmodel 同构）
    expect(requestHeaders.slice(-3)).toEqual([
      expect.objectContaining({
        authorization: "zai-team-ak.zai-team-secret",
        "bigmodel-organization": "org-zai-team",
        "bigmodel-project": "proj-zai-team",
      }),
      expect.objectContaining({
        authorization: "zai-team-ak.zai-team-secret",
        "bigmodel-organization": "org-zai-team",
        "bigmodel-project": "proj-zai-team",
      }),
      expect.objectContaining({
        authorization: "zai-team-ak.zai-team-secret",
        "bigmodel-organization": "org-zai-team",
        "bigmodel-project": "proj-zai-team",
      }),
    ]);
    expect(snapshot.modelUsage.totalTokensUsage).toBe(88);
    expect(snapshot.sourceProvider.id).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  });

  it("Z.ai Team Plan 用量允许已登录但被禁用的 Coding Plan provider（对齐 BigModel）", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const requestUrls: string[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        requestUrls.push(url);
        if (url.endsWith("/api_keys")) {
          return createJsonResponse({
            code: 200,
            data: [{ apiKey: "team-ak-zai", keyType: 2, name: "zcode-team-api-key" }],
          });
        }
        if (url.endsWith("/api_keys/copy/team-ak-zai")) {
          return createJsonResponse({
            code: 200,
            data: { secretKey: "team-secret-zai" },
          });
        }
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "team", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        return createJsonResponse({
          code: 200,
          data:
            new URL(url).searchParams.get("usageType") === "MODEL"
              ? { modelUsage: { xTime: ["2026-05-18"], modelDataList: [] } }
              : { mcpUsage: { xTime: ["2026-05-18"], mcpDataList: [] } },
        });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          name: "Z.ai - Coding Plan",
          apiKey: "",
          enabled: false,
        }),
      ],
      credentialTokens: {
        "oauth:zai:access_token": "zai-oauth-token",
      },
    });

    await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      organizationId: "org-zai-team",
      projectId: "proj-zai-team",
      timeZone: "UTC",
    });

    expect(requestUrls[0]).toBe("https://api.z.ai/api/monitor/usage/quota/limit?type=2");
  });

  it("Team Plan monitor 缺少明确成功信号时不能把错误响应降级为空统计", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
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
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: { level: "team", limits: [] },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          return createJsonResponse({
            code: 200,
            data: { summary: { totalTokens: 0 }, series: [] },
          });
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: { x_time: [], proMaxDecodeSpeed: [], liteDecodeSpeed: [] },
          });
        }
        expect(url).toContain("/api/monitor/credit-usage/usage-detail");
        return createJsonResponse({ msg: "token expired" });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "",
        }),
      ],
      credentialTokens: {
        "oauth:bigmodel:access_token": "oauth-token",
      },
    });

    await expect(
      service.getCodingPlanUsageSnapshot({
        range: "7d",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        organizationId: "org-team-a",
        projectId: "proj-team-a",
        timeZone: "UTC",
      }),
    ).rejects.toThrow("token expired");
  });

  // CR-01 回归：activity / usage-detail / model-performance-day 是可选数据面。
  // 任一接口传输层失败（HTTP 非 2xx、超时、断网）时只清空对应区域，
  // 不能让 Promise.all 提前 reject 拖垮整张 Coding Plan Usage 面板。
  it("可选 monitor 接口网络失败时只清空对应区域，quota 与其它区域正常返回", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes("/api/monitor/usage/quota/limit")) {
          return createJsonResponse({
            code: 200,
            data: {
              level: "pro",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  unit: 3,
                  number: 5,
                  usage: 100,
                  currentValue: 31,
                  percentage: 31,
                },
              ],
            },
          });
        }
        if (url.includes("/api/monitor/credit-usage/activity")) {
          // 传输层失败一：HTTP 非 2xx，readApiJson 会抛 ApiError。
          return new Response("Internal Server Error", { status: 500 });
        }
        if (url.includes("/api/monitor/credit-usage/usage-detail")) {
          if (new URL(url).searchParams.get("usageType") === "MODEL") {
            return createJsonResponse({
              code: 200,
              data: {
                summary: {
                  cacheHitRate: { value: 0.893, trend: null },
                  totalCredits: { value: 28.95, trend: null },
                  averageDailyCredits: { value: 4.13, trend: null },
                },
                modelUsage: { xTime: ["2026-05-18"], modelDataList: [] },
              },
            });
          }
          // 传输层失败二：请求超时，request 直接 reject。
          throw new Error("Request timed out after 15000ms");
        }
        if (url.includes("/api/monitor/usage/model-performance-day")) {
          return createJsonResponse({
            code: 200,
            data: {
              x_time: ["2026-05-18"],
              proMaxDecodeSpeed: [125.4],
              liteDecodeSpeed: [55.2],
            },
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
        }),
      ],
    });

    const snapshot = await service.getCodingPlanUsageSnapshot({
      range: "7d",
      preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      timeZone: "UTC",
    });

    // 未失败的区域不受影响：quota 剩余、模型维度详情和 health 都正常。
    expect(snapshot.quota?.limits).toHaveLength(1);
    expect(snapshot.detail.model.totalCredits).toBe(28.95);
    expect(snapshot.health?.xTime).toEqual(["2026-05-18"]);
    // 传输失败的区域清空为空统计，而不是拖垮整张面板。
    expect(snapshot.activity.summary.totalTokens).toBe(0);
    expect(snapshot.detail.tool.totalCredits).toBe(0);
  });

  it("quota monitor 网络失败时 Coding Plan 用量整体失败", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.includes("/api/monitor/usage/quota/limit")) {
          throw new Error("Request timed out after 15000ms");
        }
        return createJsonResponse({ code: 200, data: {} });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
        }),
      ],
    });

    // quota 是面板核心数据，传输失败必须保留整体报错语义，
    // 避免“查不到额度”被伪装成一张全空面板。
    await expect(
      service.getCodingPlanUsageSnapshot({
        range: "7d",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("Request timed out after 15000ms");
  });

  it("严格指定 Coding Plan 缺 apiKey 时不回退普通 provider 或本地 session", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "",
        }),
        createProvider({
          id: TEST_BIGMODEL_PROVIDER_ID,
          name: "BigModel",
          apiKey: "ordinary-api-key",
        }),
      ],
    });

    await expect(
      service.getCodingPlanUsageSnapshot({
        range: "today",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("bigmodel_coding_plan_api_key_required");
    expect(apiClient.request).not.toHaveBeenCalled();
  });

  it("个人套餐缺少 Account Auth 凭据时不再触发旧 Provider 刷新", async () => {
    const providers = [
      createProvider({
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        name: "BigModel - Coding Plan",
        apiKey: "",
        enabled: false,
      }),
    ];
    const requestHeaders: Record<string, string>[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(async (_input, init) => {
        requestHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return createJsonResponse({ code: 200, data: {} });
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers,
    });

    await expect(
      service.getCodingPlanUsageSnapshot({
        range: "7d",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("bigmodel_coding_plan_api_key_required");
    expect(requestHeaders).toEqual([]);
  });

  it("Team Plan Account Auth 失败时透传真实错误", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-19T10:00:00.000Z") });
    const apiClient: ApiClient = {
      request: vi.fn(async (input) => {
        const url = input.toString();
        if (url.endsWith("/api_keys")) {
          // 修复原因：list 无可用 key 时走 create；create 被远端拒绝并返回业务 msg，
          // 原实现只抛错误码 bigmodel_coding_plan_api_key_required，UI 无法展示真实原因。
          return createJsonResponse({
            code: 500,
            success: false,
            msg: "您当前暂无有效的团队套餐授权记录，无法创建API Key",
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [
        createProvider({
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          name: "BigModel - Coding Plan",
          apiKey: "",
        }),
      ],
      resolveAccountAuth: async () => {
        throw new Error("您当前暂无有效的团队套餐授权记录，无法创建API Key");
      },
    });

    await expect(
      service.getCodingPlanUsageSnapshot({
        range: "7d",
        preferredProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        organizationId: "org-team-a",
        projectId: "proj-team-a",
        timeZone: "UTC",
      }),
    ).rejects.toThrow("您当前暂无有效的团队套餐授权记录，无法创建API Key");
  });

  it("显式选择供应商时缺 key 不回落到本地数据", async () => {
    const service = createUsageStatsServiceForTest({
      providers: [],
    });

    await expect(
      service.getSnapshot({
        range: "all",
        preferredProviderId: TEST_BIGMODEL_PROVIDER_ID,
        timeZone: "UTC",
      }),
    ).rejects.toThrow("no_bigmodel_api_key");
  });

  it("已配置供应商但 monitor 接口失败时保留真实错误", async () => {
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("Request timed out after 15000ms");
      }),
    };
    const service = createUsageStatsServiceForTest({
      apiClient,
      providers: [createProvider({})],
    });

    await expect(
      service.getSnapshot({
        range: "all",
        timeZone: "UTC",
      }),
    ).rejects.toThrow("Request timed out after 15000ms");
  });
});
