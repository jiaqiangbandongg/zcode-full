// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  ChatCodingPlanUsageRemainingPanel,
  hasChatCodingPlanUsageRemaining,
  shouldShowContextQuotaResetTime,
} from "../src/chat-input-toolbar/CodingPlanContextUsage.js";
import {
  ChatStartPlanBalancePanel,
  hasChatStartPlanBalance,
} from "../src/chat-input-toolbar/StartPlanContextBalance.js";
import {
  ChatContextUsage,
  buildContextUsageBreakdownSegments,
  formatContextCacheHitRateLabel,
  formatContextUsageSummary,
  formatContextUsageTokenCount,
  refreshContextUsageOnOpen,
} from "../src/chat-input-toolbar/contextUsage.js";
import {
  CodingPlanUsageRemainingPanel,
  type CodingPlanUsageAvailableProvider,
  hasCodingPlanUsageRemainingPanel,
  resolveCodingPlanUsageRemainingState,
} from "../src/CodingPlanUsageRemainingPanel.js";
import {
  resolveSidebarCodingPlanUpgradeFallbackProviderId,
  resolveSidebarCodingPlanUpgradeProviderId,
} from "../src/lib/sidebarCodingPlanUpgrade.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";

const activeSubscription = {
  identityType: "unknown" as const,
  identityMasked: null,
  details: [{ productId: "coding-pro", productName: "Coding Pro" }],
};

const codingPlanQuotaResetUiMock = vi.hoisted(() => {
  const createController = () => ({
    entry: null,
    opportunityVisible: false,
    processing: false,
    done: false,
    statusVisible: false,
    reset: vi.fn(async () => undefined),
  });
  const createValue = () => ({
    enabled: false,
    ...createController(),
    week: createController(),
    reserveAutomaticCompletion: vi.fn(async () => ({ status: "blocked" })),
    commitAutomaticCompletion: vi.fn(() => false),
    releaseAutomaticCompletion: vi.fn(async () => undefined),
  });
  return { current: createValue() as unknown, createValue };
});

vi.mock("@/hooks/useCodingPlanQuotaResetUi.js", () => ({
  useCodingPlanQuotaResetUi: () => codingPlanQuotaResetUiMock.current,
}));

vi.mock("../src/CodingPlanBillingDiscount.js", () => ({
  CodingPlanBillingDiscountBadge: ({ size, variant }: { size?: string; variant?: string }) =>
    `billing-discount-badge:${variant ?? "gradient"}:${size ?? "default"}`,
  CodingPlanBillingDiscountBadgePill: ({ size, variant }: { size?: string; variant?: string }) =>
    `billing-discount-badge:${variant ?? "gradient"}:${size ?? "default"}`,
  CodingPlanBillingDiscountInfoDialog: () => "billing-discount-info",
  useCodingPlanBillingDiscount: () => ({ active: true, loading: false }),
}));

describe("context usage access refresh", () => {
  it("只在 Context 打开时触发后台额度刷新", () => {
    const onAccess = vi.fn();

    refreshContextUsageOnOpen(false, onAccess);
    refreshContextUsageOnOpen(true, onAccess);

    expect(onAccess).toHaveBeenCalledTimes(1);
  });

  it("无缓存快照时仍保留 hover 触发器", () => {
    expect(
      hasChatCodingPlanUsageRemaining({
        availableProviders: [],
        entitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            snapshot: null,
            loading: false,
            error: null,
          },
        ],
        modelProvidersLoading: false,
        onAccess: vi.fn(),
      }),
    ).toBe(true);
  });
});

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/components/ai-elements/context.js", async () => {
  const React = await import("react");
  const passthrough =
    (tag: "button" | "div") =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);

  return {
    Context: passthrough("div"),
    ContextContent: passthrough("div"),
    ContextContentBody: passthrough("div"),
    ContextTrigger: passthrough("button"),
  };
});

afterEach(() => {
  codingPlanQuotaResetUiMock.current = codingPlanQuotaResetUiMock.createValue();
  cleanup();
  vi.useRealTimers();
});

function createCodingPlanProvider(
  id:
    | typeof BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    | typeof BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
): CodingPlanUsageAvailableProvider {
  return {
    providerId: id,
    label: id,
  };
}

function renderFiveHourResetPanel() {
  const availableProviders = [
    createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
  ];

  // 完成态会用 nextResetAt 兜底展示重置时间（带 Tooltip）；真实应用中面板总在 TooltipProvider 下。
  render(
    createElement(
      TooltipProvider,
      null,
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders,
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    {
                      type: "TOKENS_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 35,
                      usageDetails: [],
                    },
                  ],
                },
              },
            },
          ],
          modelProvidersLoading: false,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    ),
  );
}

describe("ChatCodingPlanUsageRemainingPanel reset action", () => {
  it("五小时有两次重置机会时仍在额度标题旁显示直接重置按钮", () => {
    const reset = vi.fn(async () => undefined);
    codingPlanQuotaResetUiMock.current = {
      ...codingPlanQuotaResetUiMock.createValue(),
      enabled: true,
      entry: {
        status: "available",
        opportunityCount: 2,
        opportunityExpiresAt: Date.now() + 60_000,
        startedAt: null,
        completedAt: null,
        observedAt: null,
        quotaOverridePending: false,
        nextResetAt: null,
        idempotencyKey: "five-hour-two-opportunities",
        error: null,
      },
      opportunityVisible: true,
      reset,
    };
    renderFiveHourResetPanel();

    expect(screen.getByRole("button", { name: "codingPlan.quotaReset.openDialog" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "codingPlan.quotaReset.resetAria" })).toBeTruthy();
  });

  it("核销一张后同类型仍有余下机会时，额度标题旁保持可点击「重置」而非「已重置」", () => {
    const completedAt = Date.now() - 1_000;
    codingPlanQuotaResetUiMock.current = {
      ...codingPlanQuotaResetUiMock.createValue(),
      enabled: true,
      entry: {
        status: "completed",
        opportunityCount: 1,
        opportunityExpiresAt: Date.now() + 60_000,
        startedAt: completedAt - 1_000,
        completedAt,
        observedAt: completedAt,
        quotaOverridePending: false,
        nextResetAt: completedAt + 5 * 60 * 60 * 1_000,
        idempotencyKey: null,
        error: null,
      },
      opportunityVisible: true,
      done: true,
    };
    renderFiveHourResetPanel();

    expect(screen.getByRole("button", { name: "codingPlan.quotaReset.resetAria" })).toBeTruthy();
    expect(screen.queryByText("codingPlan.quotaReset.completed")).toBeNull();
  });
});

describe("ChatCodingPlanUsageRemainingPanel MCP 额度", () => {
  it("从三类主额度与 MCP 混合快照展示真实剩余额度和桶日期", () => {
    codingPlanQuotaResetUiMock.current = codingPlanQuotaResetUiMock.createValue();
    const html = renderToStaticMarkup(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders: [
            createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
          ],
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 2, usageDetails: [] },
                    { type: "TOKENS_LIMIT", unit: 6, percentage: 1, usageDetails: [] },
                    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, usageDetails: [] },
                  ],
                },
                mcpQuota: {
                  serverTime: 1_755_571_234_000,
                  level: "pro",
                  scope: { providerFamily: "zai", targetType: "PERSONAL" },
                  buckets: [{ bucket: "search_image", used: 25, limit: 100, remaining: 75 }],
                  aggregate: {
                    type: "MCP_USAGE_LIMIT",
                    percentage: 25,
                    remaining: 75,
                    nextResetTime: Date.UTC(2025, 7, 21),
                    usageDetails: [],
                  },
                },
              },
            },
          ],
          modelProvidersLoading: false,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );
    expect(html).toContain('data-context-mcp-usage="inline"');
    expect(html).toContain('data-primary-quota-count="3"');
    expect(html).toContain("sidebar.usage.plan.zcodeMcp");
    expect(html).toContain('data-context-mcp-info="true"');
    expect(html).toContain('aria-label="sidebar.usage.plan.zcodeMcpDescription"');
    // percentage 是已使用占比，展示时反转成剩余。
    expect(html).toContain("75%");
    expect(html).toMatch(/>75%<\/span><span[^>]*> · Aug 21<\/span>/);
    expect(html).toContain("width:75%");
  });

  it("没有 MCP 额度时不展示 MCP", () => {
    codingPlanQuotaResetUiMock.current = codingPlanQuotaResetUiMock.createValue();
    const html = renderToStaticMarkup(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders: [
            createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
          ],
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 2, usageDetails: [] },
                    { type: "TOKENS_LIMIT", unit: 6, percentage: 1, usageDetails: [] },
                    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, usageDetails: [] },
                  ],
                },
              },
            },
          ],
          modelProvidersLoading: false,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );
    expect(html).not.toContain("sidebar.usage.plan.mcp");
  });
});

describe("ChatCodingPlanUsageRemainingPanel refresh action", () => {
  it("远端刷新成功时用 loading 与成功勾临时代替详情入口", () => {
    vi.useFakeTimers();
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlement = {
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      loading: true,
      error: null,
      snapshot: {
        generatedAt: 1,
        authenticated: true,
        provider: {
          id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          name: "Z.ai Coding Plan",
        },
        remaining: null,
        subscription: activeSubscription,
        quota: {
          level: "pro",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 35,
              usageDetails: [],
            },
          ],
        },
      },
    } satisfies ComponentProps<
      typeof ChatCodingPlanUsageRemainingPanel
    >["config"]["entitlements"][number];
    const props = {
      config: {
        availableProviders,
        entitlements: [entitlement],
        modelProvidersLoading: false,
        onUsageClick: vi.fn(),
      },
      intl: {
        formatMessage: ({ id }: { id: string }) => id,
      } as never,
      locale: "en-US",
    } satisfies ComponentProps<typeof ChatCodingPlanUsageRemainingPanel>;

    const view = render(createElement(ChatCodingPlanUsageRemainingPanel, props));

    expect(screen.queryByRole("button", { name: "sidebar.usage.plan.open" })).toBeNull();
    expect(screen.getByRole("status", { name: "sidebar.usage.plan.refreshing" })).toBeTruthy();

    view.rerender(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        ...props,
        config: {
          ...props.config,
          entitlements: [{ ...entitlement, loading: false }],
        },
      }),
    );

    expect(screen.queryByRole("button", { name: "sidebar.usage.plan.open" })).toBeNull();
    expect(screen.getByRole("status", { name: "sidebar.usage.plan.updated" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1_000));

    expect(screen.queryByRole("status", { name: "sidebar.usage.plan.updated" })).toBeNull();
    expect(screen.getByRole("button", { name: "sidebar.usage.plan.open" })).toBeTruthy();
  });

  it("静默 access 刷新中即使缓存快照不标记 loading 也显示 loading", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlement = {
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      loading: false,
      error: null,
      snapshot: {
        generatedAt: 1,
        authenticated: true,
        provider: {
          id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          name: "Z.ai Coding Plan",
        },
        remaining: null,
        subscription: activeSubscription,
        quota: {
          level: "pro",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 35,
              usageDetails: [],
            },
          ],
        },
      },
    } satisfies ComponentProps<
      typeof ChatCodingPlanUsageRemainingPanel
    >["config"]["entitlements"][number];

    render(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders,
          entitlements: [entitlement],
          modelProvidersLoading: false,
          refreshing: true,
          onUsageClick: vi.fn(),
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );

    expect(screen.queryByRole("button", { name: "sidebar.usage.plan.open" })).toBeNull();
    expect(screen.getByRole("status", { name: "sidebar.usage.plan.refreshing" })).toBeTruthy();
  });

  it("有缓存快照刷新失败时在更多旁边显示 warning info tooltip", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const onEntitlementRefresh = vi.fn();

    const view = render(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders,
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: "usage_entitlement_request_timeout:20000",
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    {
                      type: "TOKENS_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 35,
                      usageDetails: [],
                    },
                  ],
                },
              },
            },
          ],
          modelProvidersLoading: false,
          onEntitlementRefresh,
          onUsageClick: vi.fn(),
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );

    expect(view.container.textContent).toContain("sidebar.usage.plan.fiveHour");
    expect(view.container.textContent).not.toContain("usage_entitlement_request_timeout");
    expect(screen.getByLabelText("sidebar.usage.plan.updateFailed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "sidebar.usage.plan.open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "sidebar.usage.plan.refresh" })).toBeNull();
  });

  it("无可展示额度时复用 info notice 和刷新按钮", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const onEntitlementRefresh = vi.fn();
    const view = render(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders,
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: null,
                  limits: [],
                },
              },
            },
          ],
          modelProvidersLoading: false,
          onEntitlementRefresh,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );

    expect(view.container.textContent).toContain("sidebar.usage.plan.unavailable");
    expect(view.container.innerHTML).toContain("data-coding-plan-usage-notice");
    expect(screen.getByRole("button", { name: "sidebar.usage.plan.refresh" })).toBeTruthy();
  });
});

describe("buildContextUsageBreakdownSegments", () => {
  it("aggregates valid chars by source and sorts largest first", () => {
    expect(
      buildContextUsageBreakdownSegments([
        { source: "messages", chars: 700 },
        { source: "system_tool_schemas", chars: 200 },
        { source: "messages", chars: 100 },
        { source: "skills", chars: 0 },
      ]),
    ).toEqual([
      { source: "messages", chars: 800, percent: 0.8 },
      { source: "system_tool_schemas", chars: 200, percent: 0.2 },
    ]);
  });

  it("returns an empty list when no positive chars are available", () => {
    expect(
      buildContextUsageBreakdownSegments([
        { source: "messages", chars: 0 },
        { source: "skills", chars: -1 },
      ]),
    ).toEqual([]);
  });
});

describe("formatContextUsageTokenCount", () => {
  it("uses uppercase compact suffixes for English context usage", () => {
    expect(formatContextUsageTokenCount(399_900, "en-US")).toBe("399.9K");
    expect(formatContextUsageTokenCount(200_000, "en-US")).toBe("200K");
    expect(formatContextUsageTokenCount(1_250_000, "en-US")).toBe("1.3M");
  });

  it("uses localized compact units for Chinese context usage", () => {
    expect(formatContextUsageTokenCount(399_900, "zh-CN")).toBe("40万");
    expect(formatContextUsageTokenCount(200_000, "zh-CN")).toBe("20万");
    expect(formatContextUsageTokenCount(120_000_000, "zh-CN")).toBe("1.2亿");
  });
});

describe("formatContextUsageSummary", () => {
  it("combines compact token values and usage percentage", () => {
    expect(
      formatContextUsageSummary({
        locale: "en-US",
        percent: 1,
        size: 200_000,
        used: 399_900,
      }),
    ).toBe("399.9K/200K (100%)");
  });
});

describe("formatContextCacheHitRateLabel", () => {
  it("keeps the production threshold for low cache hit rates", () => {
    expect(formatContextCacheHitRateLabel(0.048, "en-US")).toBeNull();
  });

  it("formats low cache hit rates when development diagnostics are enabled", () => {
    expect(
      formatContextCacheHitRateLabel(0.048, "en-US", {
        showBelowThreshold: true,
      }),
    ).toBe("4.8%");
  });

  it("does not invent a cache hit rate when the provider omits it", () => {
    expect(
      formatContextCacheHitRateLabel(null, "en-US", {
        showBelowThreshold: true,
      }),
    ).toBeNull();
  });
});

describe("ChatContextUsage", () => {
  it("在 Context 面板外点击时关闭额度重置提醒并清理监听器", async () => {
    codingPlanQuotaResetUiMock.current = {
      ...codingPlanQuotaResetUiMock.createValue(),
      enabled: true,
      entry: {
        status: "available",
        opportunityCount: 1,
        opportunityExpiresAt: Date.now() + 60_000,
        startedAt: null,
        completedAt: null,
        observedAt: null,
        quotaOverridePending: false,
        nextResetAt: null,
        idempotencyKey: "context-outside-dismiss",
        error: null,
      },
      opportunityVisible: true,
    };
    const provider = createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ChatContextUsage, {
          codingPlanUsageRemaining: {
            availableProviders: [provider],
            entitlements: [
              {
                providerId: provider.providerId,
                loading: false,
                error: null,
                snapshot: {
                  generatedAt: 1,
                  authenticated: true,
                  provider: { id: provider.providerId, name: provider.label },
                  remaining: null,
                  subscription: activeSubscription,
                  quota: {
                    level: "pro",
                    limits: [
                      {
                        type: "TOKENS_LIMIT",
                        unit: 3,
                        number: 5,
                        percentage: 35,
                        usageDetails: [],
                      },
                    ],
                  },
                },
              },
            ],
            modelProvidersLoading: false,
          },
          intl: {
            formatMessage: ({ id }: { id: string }) => id,
          } as never,
          locale: "en-US",
          selectedProvider: "glm",
          taskUsage: null,
        }),
      ),
    );

    expect(
      screen.getAllByText("codingPlan.quotaReset.contextReminder.expiresIn").length,
    ).toBeGreaterThan(0);
    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(screen.queryAllByText("codingPlan.quotaReset.contextReminder.expiresIn")).toEqual([]);
    });
  });

  it("does not render derived zero-usage capacity without task usage or plan data", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        ...({
          contextCapacityTokens: 1_000_000,
        } as Partial<ComponentProps<typeof ChatContextUsage>>),
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: null,
      }),
    );

    expect(html).not.toContain("chat.contextUsage.title");
    expect(html).not.toContain("0/1M (0%)");
  });

  it("renders cache hit rate when the context usage reaches the display threshold", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          cache: { hitRate: 0.8 },
        },
      }),
    );

    expect(html).toContain("chat.contextUsage.cacheHitRate");
    expect(html).toContain("80%");
  });

  it("renders a low cache hit rate in the development environment", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          cache: { hitRate: 0.048 },
        },
      }),
    );

    expect(import.meta.env.DEV).toBe(true);
    expect(html).toContain("chat.contextUsage.cacheHitRate");
    expect(html).toContain("4.8%");
  });

  it("renders Coding Plan quota without real task context usage", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        codingPlanUsageRemaining: {
          availableProviders,
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    {
                      type: "TOKENS_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 35,
                      usageDetails: [],
                    },
                  ],
                },
              },
            },
          ],
          modelProvidersLoading: false,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: null,
      }),
    );

    expect(html).toContain("sidebar.usage.plan.title");
    expect(html).toContain("sidebar.usage.plan.fiveHour");
  });

  it("does not render per-source token counts in the breakdown rows", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: {
          used: 17_000,
          size: 1_000_000,
          breakdown: [
            { source: "system_tool_schemas", chars: 52_000 },
            { source: "messages", chars: 38_000 },
          ],
        },
      }),
    );

    expect(html).toContain("chat.contextUsage.breakdown.systemTools");
    expect(html).toContain("chat.contextUsage.breakdown.messages");
    expect(html).toContain("57.8%");
    expect(html).toContain("42.2%");
    expect(html).not.toContain("52K");
    expect(html).not.toContain("38K");
  });
});

describe("Coding Plan usage remaining panel state", () => {
  it("does not show the billing discount badge in sidebar usage remaining", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const html = renderToStaticMarkup(
      createElement(CodingPlanUsageRemainingPanel, {
        availableProviders,
        entitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            loading: false,
            error: null,
            snapshot: {
              generatedAt: 1,
              authenticated: true,
              provider: {
                id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                name: "Z.ai Coding Plan",
              },
              remaining: null,
              subscription: activeSubscription,
              quota: {
                level: "pro",
                limits: [],
              },
            },
          },
        ],
        modelProvidersLoading: false,
      }),
    );

    expect(html).toContain("sidebar.usage.plan.codingPlanTitle");
    expect(html).not.toContain("billing-discount-badge");
  });

  it("renders a single sidebar audience badge without source tabs", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan),
    ];
    const html = renderToStaticMarkup(
      createElement(CodingPlanUsageRemainingPanel, {
        audience: "team",
        availableProviders,
        entitlements: [
          {
            sourceId: "team:bigmodel:team-pro:project-a",
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            label: "BigModel - Project A",
            loading: false,
            error: null,
            snapshot: {
              generatedAt: 1,
              authenticated: true,
              provider: {
                id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                name: "BigModel Coding Plan",
              },
              remaining: null,
              subscription: activeSubscription,
              quota: {
                level: "team",
                limits: [
                  {
                    type: "TOKENS_LIMIT",
                    unit: 3,
                    number: 5,
                    percentage: 80,
                    usageDetails: [],
                  },
                ],
              },
            },
          },
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            loading: false,
            error: null,
            snapshot: {
              generatedAt: 1,
              authenticated: true,
              provider: {
                id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
                name: "BigModel Coding Plan",
              },
              remaining: null,
              subscription: activeSubscription,
              quota: {
                level: "pro",
                limits: [
                  {
                    type: "TOKENS_LIMIT",
                    unit: 6,
                    percentage: 50,
                    usageDetails: [],
                  },
                ],
              },
            },
          },
        ],
        modelProvidersLoading: false,
        selectedProviderId: "team:bigmodel:team-pro:project-a",
      }),
    );

    expect(html).toContain("sidebar.usage.plan.codingPlanTitle");
    expect(html).toContain("sidebar.usage.plan.audienceTeam");
    expect(html).not.toContain("aria-pressed");
  });

  it("会话 Coding Plan 用量面板不显示 150% 活动徽标", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const html = renderToStaticMarkup(
      createElement(ChatCodingPlanUsageRemainingPanel, {
        config: {
          availableProviders,
          entitlements: [
            {
              providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
              loading: false,
              error: null,
              snapshot: {
                generatedAt: 1,
                authenticated: true,
                provider: {
                  id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                  name: "Z.ai Coding Plan",
                },
                remaining: null,
                subscription: activeSubscription,
                quota: {
                  level: "pro",
                  limits: [
                    {
                      type: "TOKENS_LIMIT",
                      unit: 3,
                      number: 5,
                      percentage: 35,
                      nextResetTime: Date.UTC(2026, 0, 2, 8, 30),
                      usageDetails: [],
                    },
                    {
                      type: "TOKENS_LIMIT",
                      unit: 6,
                      percentage: 45,
                      nextResetTime: Date.UTC(2026, 0, 9, 0, 0),
                      usageDetails: [],
                    },
                    {
                      type: "TIME_LIMIT",
                      unit: 5,
                      number: 1,
                      percentage: 55,
                      nextResetTime: Date.UTC(2026, 0, 31, 0, 0),
                      usageDetails: [],
                    },
                  ],
                },
              },
            },
          ],
          modelProvidersLoading: false,
        },
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        } as never,
        locale: "en-US",
      }),
    );

    expect(html).toContain("sidebar.usage.plan.title");
    expect(html).not.toContain("billing-discount-badge:gradient:compact");
  });

  it("hides a Coding Plan reset time when its full value exceeds the meter width", () => {
    expect(shouldShowContextQuotaResetTime({ availableWidth: 120, contentWidth: 119 })).toBe(true);
    expect(shouldShowContextQuotaResetTime({ availableWidth: 120, contentWidth: 121 })).toBe(false);
  });

  it("shows only time for non-today 5 hour Coding Plan reset in chat context usage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 7, 0));

    try {
      const availableProviders = [
        createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
      ];
      const html = renderToStaticMarkup(
        createElement(ChatCodingPlanUsageRemainingPanel, {
          config: {
            availableProviders,
            entitlements: [
              {
                providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                loading: false,
                error: null,
                snapshot: {
                  generatedAt: 1,
                  authenticated: true,
                  provider: {
                    id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
                    name: "Z.ai Coding Plan",
                  },
                  remaining: null,
                  subscription: activeSubscription,
                  quota: {
                    level: "pro",
                    limits: [
                      {
                        type: "TOKENS_LIMIT",
                        unit: 3,
                        number: 5,
                        percentage: 35,
                        nextResetTime: new Date(2026, 0, 3, 8, 30).getTime(),
                        usageDetails: [],
                      },
                    ],
                  },
                },
              },
            ],
            modelProvidersLoading: false,
          },
          intl: {
            formatMessage: ({ id }: { id: string }) => id,
          } as never,
          locale: "en-US",
        }),
      );

      expect(html).toContain(" · 08:30");
      expect(html).not.toContain("Jan 3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is renderable from entitlement data even without task context usage", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlements = [
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        loading: false,
        error: null,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            name: "Z.ai Coding Plan",
          },
          remaining: null,
          subscription: activeSubscription,
          quota: {
            level: "pro",
            limits: [],
          },
        },
      },
    ];

    expect(
      hasCodingPlanUsageRemainingPanel({
        availableProviders,
        entitlements,
        modelProvidersLoading: false,
      }),
    ).toBe(true);
    expect(
      resolveCodingPlanUsageRemainingState({
        availableProviders,
        entitlements,
        modelProvidersLoading: false,
      })?.activeProviderId,
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  });

  it("keeps Team Plan usage renderable without a personal Coding Plan provider", () => {
    const entitlements = [
      {
        sourceId: "team:bigmodel:team-pro:org-a:project-a",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccess: {
          type: "zhipu-account" as const,
          family: "bigmodel" as const,
          planKind: "team-coding-plan" as const,
          productId: "team-pro",
          organizationId: "org-a",
          projectId: "project-a",
        },
        label: "BigModel - Project A",
        loading: false,
        error: null,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            name: "BigModel Coding Plan",
          },
          remaining: null,
          subscription: activeSubscription,
          quota: {
            level: "team",
            limits: [
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 80,
                usageDetails: [],
              },
            ],
          },
        },
      },
    ];

    expect(
      hasCodingPlanUsageRemainingPanel({
        availableProviders: [],
        entitlements,
        modelProvidersLoading: false,
        selectedProviderId: "team:bigmodel:team-pro:org-a:project-a",
      }),
    ).toBe(true);
    expect(
      resolveCodingPlanUsageRemainingState({
        availableProviders: [],
        entitlements,
        modelProvidersLoading: false,
        selectedProviderId: "team:bigmodel:team-pro:org-a:project-a",
      })?.activeProviderId,
    ).toBe("team:bigmodel:team-pro:org-a:project-a");
  });

  it("shows the sidebar upgrade entry for authenticated users without an active plan", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlements = [
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        loading: false,
        error: null,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          unavailableReason: "no_plan" as const,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            name: "Z.ai Coding Plan",
          },
          remaining: null,
          subscription: null,
          quota: null,
        },
      },
    ];

    expect(
      resolveSidebarCodingPlanUpgradeProviderId({
        availableProviders,
        entitlements,
        modelProvidersLoading: false,
      }),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  });

  it("falls back to the current provider family for the profile upgrade entry", () => {
    expect(resolveSidebarCodingPlanUpgradeFallbackProviderId("bigmodel")).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    );
    expect(resolveSidebarCodingPlanUpgradeFallbackProviderId("zai")).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    );
    expect(resolveSidebarCodingPlanUpgradeFallbackProviderId(null)).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
    );
  });

  it("keeps the sidebar upgrade entry for max plan users", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlements = [
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        loading: false,
        error: null,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            name: "Z.ai Coding Plan",
          },
          remaining: null,
          subscription: {
            identityType: "unknown" as const,
            identityMasked: null,
            details: [{ productId: "coding-max", productName: "Coding Max" }],
          },
          quota: {
            level: "max",
            limits: [],
          },
        },
      },
    ];

    expect(
      resolveSidebarCodingPlanUpgradeProviderId({
        availableProviders,
        entitlements,
        modelProvidersLoading: false,
      }),
    ).toBe(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan);
  });

  it("hides the sidebar upgrade entry for team plan users", () => {
    const availableProviders = [
      createCodingPlanProvider(BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan),
    ];
    const entitlements = [
      {
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        loading: false,
        error: null,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
            name: "Z.ai Coding Plan",
          },
          remaining: null,
          subscription: {
            identityType: "unknown" as const,
            identityMasked: null,
            details: [
              {
                productId: "team-standard",
                productName: "Team Standard",
              },
            ],
          },
          quota: null,
        },
      },
    ];

    expect(
      resolveSidebarCodingPlanUpgradeProviderId({
        availableProviders,
        entitlements,
        modelProvidersLoading: false,
      }),
    ).toBeUndefined();
  });
});

describe("Start Plan context balance panel", () => {
  it("renders Today's balance meters with an upgrade action", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStartPlanBalancePanel, {
        config: {
          loading: false,
          onUpgradeClick: vi.fn(),
          snapshot: {
            generatedAt: new Date(2026, 5, 13, 8, 15).getTime(),
            authenticated: true,
            provider: {
              id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
              name: "Z.ai Start Plan",
            },
            remaining: null,
            subscription: {
              identityType: "unknown",
              identityMasked: null,
              details: [
                {
                  productId: "zcode-v3-start-plan",
                  productName: "ZCode Start Plan",
                  purchaseTime: null,
                  beginTime: null,
                  renewTime: new Date(2026, 5, 13, 10, 0).toISOString(),
                  expireTime: new Date(2026, 5, 20, 23, 59).toISOString(),
                },
              ],
            },
            quota: {
              level: "Start",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  number: 1_000_000,
                  remaining: 750_000,
                  usage: 250_000,
                  nextResetTime: new Date(2026, 5, 14, 23, 2).getTime(),
                  usageDetails: [
                    {
                      modelCode: "glm-5.2",
                      displayName: "GLM-5.2",
                      usage: 250_000,
                    },
                  ],
                },
              ],
            },
          },
        },
        intl: {
          formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
            values?.value ? `${id}:${values.value}` : id,
        } as never,
        locale: "en-US",
      }),
    );

    expect(html).toContain("settings.modelProvider.startPlan.balance.title");
    expect(html).not.toContain("settings.modelProvider.codingPlan.expiresAt");
    expect(html).toContain("GLM-5.2");
    expect(html).toContain("75%");
    // 桶刷新时间只来自本桶 expires_at（nextResetTime），不再采用套餐级 renewTime；
    // 非当日与 Coding Plan 对齐只展示日期，不携带时间。
    expect(html).toContain("Jun 14");
    expect(html).not.toContain("Jun 14 23:02");
    expect(html).not.toContain("Jun 13 10:00");
    expect(html).not.toContain("750K");
    expect(html).not.toContain("1M");
    expect(html).not.toContain("settings.modelProvider.startPlan.balance.used");
    expect(html).toContain("chat.quota.action.upgrade");
    expect(html).toContain("billing-discount-info");
  });

  it("omits the date for today's Start Plan balance renew time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 5, 15, 12, 0));
      const html = renderToStaticMarkup(
        createElement(ChatStartPlanBalancePanel, {
          config: {
            loading: false,
            snapshot: {
              generatedAt: new Date(2026, 5, 14, 8, 15).getTime(),
              authenticated: true,
              provider: {
                id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
                name: "Z.ai Start Plan",
              },
              remaining: null,
              subscription: {
                identityType: "unknown",
                identityMasked: null,
                details: [
                  {
                    productId: "zcode-v3-start-plan",
                    productName: "ZCode Start Plan",
                    purchaseTime: null,
                    beginTime: null,
                    renewTime: null,
                    expireTime: new Date(2026, 5, 20, 23, 59).toISOString(),
                  },
                ],
              },
              quota: {
                level: "Start",
                limits: [
                  {
                    type: "TOKENS_LIMIT",
                    number: 1_000_000,
                    remaining: 990_000,
                    nextResetTime: new Date(2026, 5, 15, 23, 2).getTime(),
                    usageDetails: [
                      {
                        modelCode: "glm-5.2",
                        displayName: "GLM-5.2",
                        usage: 10_000,
                      },
                    ],
                  },
                ],
              },
            },
          },
          intl: {
            formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
              values?.value ? `${id}:${values.value}` : id,
          } as never,
          locale: "en-US",
        }),
      );

      expect(html).toContain("99%");
      expect(html).toContain("23:02");
      expect(html).not.toContain("Jun 15 23:02");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders each Start Plan bucket with its own reset time", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 5, 15, 12, 0));
      const html = renderToStaticMarkup(
        createElement(ChatStartPlanBalancePanel, {
          config: {
            loading: false,
            snapshot: {
              generatedAt: new Date(2026, 5, 15, 8, 15).getTime(),
              authenticated: true,
              provider: {
                id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
                name: "Z.ai Start Plan",
              },
              remaining: {
                count: 1_750_000,
                isShow: true,
                // 全局聚合时间（最早桶时间）不得复制到每个桶。
                nextResetTime: new Date(2026, 5, 15, 20, 0).getTime(),
              },
              subscription: {
                identityType: "unknown",
                identityMasked: null,
                details: [
                  {
                    productId: "start-plan-welcome",
                    productName: "Welcome Plan",
                    purchaseTime: null,
                    beginTime: null,
                    renewTime: new Date(2026, 5, 13, 10, 0).toISOString(),
                    expireTime: new Date(2026, 5, 20, 23, 59).toISOString(),
                  },
                ],
              },
              quota: {
                level: "Start",
                limits: [
                  {
                    type: "welcome-glm-52",
                    planId: "start-plan-welcome",
                    number: 1_000_000,
                    remaining: 750_000,
                    nextResetTime: new Date(2026, 5, 15, 18, 45).getTime(),
                    usageDetails: [
                      {
                        modelCode: "glm-5.2",
                        displayName: "GLM-5.2",
                        usage: 250_000,
                      },
                    ],
                  },
                  {
                    type: "welcome-glm-5-turbo",
                    planId: "start-plan-welcome",
                    number: 1_000_000,
                    remaining: 1_000_000,
                    nextResetTime: new Date(2026, 5, 16, 9, 30).getTime(),
                    usageDetails: [
                      {
                        modelCode: "glm-5-turbo",
                        displayName: "GLM-5-Turbo",
                        usage: 0,
                      },
                    ],
                  },
                ],
              },
            },
          },
          intl: {
            formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
              values?.value ? `${id}:${values.value}` : id,
          } as never,
          locale: "en-US",
        }),
      );

      // 每个 meter 只展示本桶的 expires_at：当日仅 HH:mm（对齐 Coding Plan 五小时窗口），
      // 非当日仅日期（对齐 Coding Plan 周/月重置），互不串用。
      expect(html).toContain("18:45");
      expect(html).toContain("Jun 16");
      expect(html).not.toContain("Jun 16 09:30");
      // 全局 remaining 聚合时间与套餐级 renewTime 不得串入任何桶。
      expect(html).not.toContain("20:00");
      expect(html).not.toContain("Jun 13 10:00");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders both Start Plan bucket model labels", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStartPlanBalancePanel, {
        config: {
          loading: false,
          snapshot: {
            generatedAt: 1,
            authenticated: true,
            provider: {
              id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
              name: "Z.ai Start Plan",
            },
            remaining: null,
            subscription: activeSubscription,
            quota: {
              level: "Start",
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  number: 1_000_000,
                  remaining: 750_000,
                  usage: 250_000,
                  usageDetails: [
                    {
                      modelCode: "glm-5.2",
                      displayName: "GLM-5.2",
                      usage: 250_000,
                    },
                  ],
                },
                {
                  type: "TOKENS_LIMIT",
                  number: 500_000,
                  remaining: 250_000,
                  usage: 250_000,
                  usageDetails: [
                    {
                      modelCode: "glm-5.1",
                      displayName: "GLM-5.1",
                      usage: 250_000,
                    },
                  ],
                },
              ],
            },
          },
        },
        intl: {
          formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
            values?.value ? `${id}:${values.value}` : id,
        } as never,
        locale: "en-US",
      }),
    );
    expect(html).toContain("GLM-5.2");
    expect(html).toContain("GLM-5.1");
  });

  it("is visible while loading or when displayable limits exist", () => {
    expect(hasChatStartPlanBalance({ loading: true, snapshot: null })).toBe(true);
    expect(
      hasChatStartPlanBalance({
        loading: false,
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
            name: "Z.ai Start Plan",
          },
          remaining: null,
          subscription: activeSubscription,
          quota: { level: "Start", limits: [] },
        },
      }),
    ).toBe(false);
  });
});
