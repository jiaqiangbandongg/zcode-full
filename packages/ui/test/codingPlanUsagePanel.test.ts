import { readSourceTextAsync } from "./readSourceText.js";
import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  buildCodingPlanModelLineChartSeries,
  buildCodingPlanToolLineChartSeries,
  buildCodingPlanUsageDetailLineChartSeries,
} from "@/settings/usage-stats/codingPlanUsageChartSeries.js";
import { calculateCodingPlanBarChartMaxValue } from "@/settings/usage-stats/CodingPlanUsageBarChart.js";
import {
  buildCodingPlanUsageSources,
  formatUsageStatsQuotaResetTime,
  hasCodingPlanCreditUsageData,
  resolveCodingPlanUsageProviderName,
  shouldShowCodingPlanUsageDetailSummary,
} from "@/settings/usage-stats/CodingPlanUsagePanel.js";
import enMessages from "@/i18n/locales/en-US.js";
import zhMessages from "@/i18n/locales/zh-CN.js";
import {
  findCodingPlanQuotaLimit,
  formatQuotaRemainingPercentage,
  formatQuotaResetTime,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import {
  buildPersonalCodingPlanUsageSource,
  matchesTeamPlanUsageSourceKey,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "@/lib/codingPlanUsageSources.js";
import { formatSummaryCompactTokenUsage } from "@/settings/usage-stats/usageStatsUiParts.js";

describe("CodingPlanUsagePanel", () => {
  it("个人与团队套餐的中文 Token 摘要在数字和单位之间保留空格", () => {
    expect(formatSummaryCompactTokenUsage("zh-CN", 370_000_000)).toBe("3.7 亿");
    expect(formatSummaryCompactTokenUsage("en-US", 370_000_000)).toBe("370M");
  });

  it("Usage stats 和模型设置的 ZCode MCP 卡片都提供统一 info tooltip", async () => {
    const [usageSource, modelSettingsSource] = await Promise.all([
      readSourceTextAsync(
        new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
        "utf8",
      ),
      readSourceTextAsync(
        new URL("../src/settings/model-provider-section/StatusCards.tsx", import.meta.url),
        "utf8",
      ),
    ]);

    expect(usageSource).toContain('data-zcode-mcp-info="usage-stats"');
    expect(modelSettingsSource).toContain('data-zcode-mcp-info="model-settings"');
    expect(usageSource).toContain('id: "sidebar.usage.plan.zcodeMcpDescription"');
    expect(modelSettingsSource).toContain('id: "sidebar.usage.plan.zcodeMcpDescription"');
  });

  it("统一使用工具调用和 ZCode MCP 的额度名称", () => {
    expect(zhMessages["settings.usage.entitlementMonthlyMcpUsage"]).toBe("工具调用");
    expect(enMessages["settings.usage.entitlementMonthlyMcpUsage"]).toBe("Tool calls");
    expect(zhMessages["settings.usage.entitlementServerMcpUsage"]).toBe("ZCode MCP");
    expect(enMessages["settings.usage.entitlementServerMcpUsage"]).toBe("ZCode MCP");
    expect(zhMessages["sidebar.usage.plan.mcp"]).toBe("ZCode MCP");
    expect(enMessages["sidebar.usage.plan.mcp"]).toBe("ZCode MCP");
  });

  it("个人套餐来源使用 Account Access，而不是请求凭据", () => {
    expect(
      buildPersonalCodingPlanUsageSource({
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "individual-coding-plan",
        },
        label: "Z.ai - Coding Plan",
      }),
    ).toEqual({
      id: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      accountAccess: {
        type: "zhipu-account",
        family: "zai",
        planKind: "individual-coding-plan",
      },
      label: "Z.ai - Coding Plan",
    });
  });

  it("把已购 Team Plan 展开为可查询的 usage source", () => {
    const sources = buildCodingPlanUsageSources({
      accountAccesses: {
        bigmodel: {
          type: "zhipu-account",
          family: "bigmodel",
          mode: "team-coding-plan",
        },
      },
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "Pro",
          projectName: "Team A",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-team",
              organizationName: "Org",
              projectId: "proj-team",
              projectName: "Team A",
            },
          ],
        } as never,
      ],
    });

    expect(sources).toEqual([
      {
        id: "team:bigmodel:product-team:org-team:proj-team",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccess: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "product-team",
          organizationId: "org-team",
          projectId: "proj-team",
        },
        label: "BigModel - Org",
      },
    ]);
  });

  it("把 zai 已购 Team Plan 展开为带 zai providerId 和 Z.ai 品牌前缀的 usage source", () => {
    const sources = buildCodingPlanUsageSources({
      accountAccesses: {
        zai: {
          type: "zhipu-account",
          family: "zai",
          mode: "team-coding-plan",
        },
      },
      subscribedTeamProducts: [
        {
          productId: "zai-product-team",
          productName: "Pro",
          projectName: "ZAI Team A",
          subscribed: true,
          family: "zai",
          teamProjects: [
            {
              organizationId: "zai-org",
              organizationName: "ZAI Org",
              projectId: "zai-proj",
              projectName: "ZAI Team A",
            },
          ],
        } as never,
      ],
    });

    expect(sources).toEqual([
      {
        id: "team:zai:zai-product-team:zai-org:zai-proj",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
        accountAccess: {
          type: "zhipu-account",
          family: "zai",
          planKind: "team-coding-plan",
          productId: "zai-product-team",
          organizationId: "zai-org",
          projectId: "zai-proj",
        },
        label: "Z.ai - ZAI Org",
      },
    ]);
  });

  it("resolveSidebarCurrentCodingPlanUsageSource 把 zai team selectedKey 解析成 team source", () => {
    const teamSources = buildCodingPlanUsageSources({
      accountAccesses: {
        zai: {
          type: "zhipu-account",
          family: "zai",
          mode: "team-coding-plan",
        },
      },
      subscribedTeamProducts: [
        {
          productId: "zai-product-team",
          productName: "Pro",
          projectName: "ZAI Team A",
          subscribed: true,
          family: "zai",
          teamProjects: [
            {
              organizationId: "zai-org",
              organizationName: "ZAI Org",
              projectId: "zai-proj",
              projectName: "ZAI Team A",
            },
          ],
        } as never,
      ],
    });

    const resolved = resolveSidebarCurrentCodingPlanUsageSource({
      selections: {
        zai: {
          kind: "team-coding-plan",
          productId: "zai-product-team",
          organizationId: "zai-org",
          projectId: "zai-proj",
        },
      },
      selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
      accountAccesses: {},
      teamSources,
    });

    expect(resolved).toEqual({
      audience: "team",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
      sourceId: "team:zai:zai-product-team:zai-org:zai-proj",
      teamSource: teamSources[0],
    });
  });

  it("resolveSidebarCurrentCodingPlanUsageSource 在 zai team key 未匹配 source 时返回 null（不回退 individual）", () => {
    const resolved = resolveSidebarCurrentCodingPlanUsageSource({
      selections: {
        zai: {
          kind: "team-coding-plan",
          productId: "unknown",
          organizationId: "unknown",
          projectId: "unknown",
        },
      },
      selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
      accountAccesses: {},
      teamSources: [],
    });

    expect(resolved).toBeNull();
  });

  it("resolveSidebarCurrentCodingPlanUsageSource 把 zai 个人 coding-plan key 解析成 individual", () => {
    const resolved = resolveSidebarCurrentCodingPlanUsageSource({
      selections: { zai: { kind: "individual-coding-plan" } },
      selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      accountAccesses: {
        zai: {
          type: "zhipu-account",
          family: "zai",
          mode: "individual-coding-plan",
        },
      },
      teamSources: [],
    });

    expect(resolved).toEqual({
      audience: "individual",
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      sourceId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      accountAccess: {
        type: "zhipu-account",
        family: "zai",
        mode: "individual-coding-plan",
      },
    });
  });

  it("matchesTeamPlanUsageSourceKey 对 zai team sourceId/selectedKey 正确匹配", () => {
    const zaiSourceId = "team:zai:prod:org:proj";
    const zaiSelectedKey = "team:zai:prod:org:proj";
    expect(matchesTeamPlanUsageSourceKey(zaiSourceId, zaiSelectedKey)).toBe(true);

    // 不同 projectId 不匹配
    expect(matchesTeamPlanUsageSourceKey(zaiSourceId, "team:zai:prod:org:other")).toBe(false);
  });

  it("缺少组织名称时不生成空白 Team Plan usage source", () => {
    const sources = buildCodingPlanUsageSources({
      accountAccesses: {
        bigmodel: {
          type: "zhipu-account",
          family: "bigmodel",
          planKind: "team-coding-plan",
          productId: "product-team",
          organizationId: "org-team",
          projectId: "proj-team",
        },
      },
      subscribedTeamProducts: [
        {
          productId: "product-team",
          productName: "Pro",
          projectName: "Team A",
          subscribed: true,
          teamProjects: [
            {
              organizationId: "org-team",
              organizationName: null,
              projectId: "proj-team",
              projectName: "Team A",
            },
          ],
        } as never,
      ],
    });

    expect(sources).toEqual([]);
  });

  it("Team Plan 剩余额度标题优先显示团队项目名称", () => {
    expect(
      resolveCodingPlanUsageProviderName({
        fallbackProviderName: "BigModel - Coding Plan",
        source: {
          id: "team:bigmodel:product-team:org-team:proj-team",
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
          label: "BigModel - Team A",
          accountAccess: {
            type: "zhipu-account",
            family: "bigmodel",
            planKind: "team-coding-plan",
            productId: "product-team",
            organizationId: "org-team",
            projectId: "proj-team",
          },
        },
        snapshot: {
          sourceProvider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            name: "BigModel - Coding Plan",
          },
        } as never,
      }),
    ).toBe("BigModel - Team A");
  });

  it("个人套餐剩余额度标题不显示 BigModel 内建连接名", () => {
    expect(
      resolveCodingPlanUsageProviderName({
        fallbackProviderName: "BigModel - Coding Plan",
        source: {
          id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
          label: "BigModel - Coding Plan",
        },
        snapshot: {
          sourceProvider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            name: "BigModel - Coding Plan",
          },
        } as never,
      }),
    ).toBeUndefined();
  });

  it("使用统计编程套餐不再跟随当前 workspace 连接方式", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("selectWorkspaceZCodeState");
    expect(source).not.toContain("parseCustomProviderIdFromSupplierKey");
    expect(source).not.toContain("resolveSidebarCurrentCodingPlanUsageSource");
    expect(source).toContain("selectedSource");
    expect(source).not.toContain("function ProviderSelector");
    expect(source).not.toContain("onSourceChange");
  });

  it("使用统计顶部把 Coding Plan sources 展开成独立 tab", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/SettingsPage.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("createSettingsUsageCodingPlanTabId");
    expect(source).toContain("usageCodingPlanSources");
    expect(source).toContain("codingPlanSources.map");
    // 修复原因：JSX 格式化可能把属性换行，断言应验证绑定语义而不是排版。
    expect(source).toMatch(/selectedCodingPlanSource=\{\s*selectedUsageCodingPlanSource\s*\}/);
  });

  it("使用统计打开时主动探测个人 Coding Plan entitlement", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/SettingsPage.tsx", import.meta.url),
      "utf8",
    );

    // Bugfix 回归：个人 source 依赖 entitlement snapshot。冷启动无缓存时必须先进行
    // access 探测，否则 source 不会出现，子面板也没有机会触发后续刷新。
    const usageEntitlementBlock = source.slice(
      source.indexOf("const usageZaiEntitlement"),
      source.indexOf("const usageBigmodelEnterpriseProducts"),
    );
    expect(usageEntitlementBlock.match(/refreshOnMount: true/g)).toHaveLength(2);
  });

  it("使用统计个人 Coding Plan tab 显示个人套餐文案", () => {
    expect(zhMessages["settings.usage.tab.codingPlan"]).toBe("个人套餐");
    expect(enMessages["settings.usage.tab.codingPlan"]).toBe("Individual Plan");
  });

  it("把 Coding Plan 模型和工具用量映射为图表 series", () => {
    expect(
      buildCodingPlanModelLineChartSeries([
        {
          modelName: "glm-4.5",
          sortOrder: 1,
          tokensUsage: [10, 20],
          totalTokens: 30,
        },
      ]),
    ).toEqual([{ name: "glm-4.5", values: [10, 20] }]);
    expect(
      buildCodingPlanToolLineChartSeries([
        {
          toolCode: "search",
          toolName: "Search",
          sortOrder: 1,
          usageCount: [1, 2],
          totalUsageCount: 3,
        },
      ]),
    ).toEqual([{ name: "Search", values: [1, 2] }]);
  });

  it("使用详情的新旧数据都统一通过 Recharts 柱状图展示", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );
    const barChartSource = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsageBarChart.tsx", import.meta.url),
      "utf8",
    );
    const lineChartSource = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsageLineChart.tsx", import.meta.url),
      "utf8",
    );
    const uiPartsSource = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/usageStatsUiParts.tsx", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/series=\{snapshot\.[^}]+\.map\(/);
    expect(source).toContain("buildCodingPlanUsageDetailLineChartSeries");
    expect(source).toContain("buildCodingPlanModelLineChartSeries");
    expect(source).toContain("buildCodingPlanToolLineChartSeries");
    expect(source).toContain("series={visibleSeries}");
    expect(source).toContain("{hasCreditUsageData ? (");
    expect(source).toContain('<div className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm">');
    expect(source).not.toContain(
      '{hasCreditUsageData ? (\n          <div className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm">',
    );
    expect(source).toContain("<CodingPlanUsageBarChart");
    expect(source.match(/<CodingPlanUsageLineChart/g)).toHaveLength(1);
    expect(source).not.toContain("legacyChartMeta");
    expect(source).toContain("aria-pressed={!hidden}");
    expect(source).toContain('<Check className="size-3" aria-hidden="true" />');
    expect(source).toContain("CODING_PLAN_DETAIL_SERIES_COLORS");
    expect(source).toContain("MAX_SELECTED_CODING_PLAN_DETAIL_SERIES");
    expect(source).toContain("settings.usage.activityTitle");
    // 修复回归：summary.totalUsageDurationMs 是累计使用时长，曾被错标成
    // “最长聊天时长”（longestSessionMs 是 App Usage 侧字段，Coding Plan 快照没有）。
    expect(source).toContain("settings.usage.totalUsageDuration");
    expect(source).not.toContain("settings.usage.longestSession");
    expect(source).not.toContain("settings.usage.favoriteModel");
    expect(source).not.toContain("favoriteModelName");
    expect(source).toContain(
      '<div className="truncate text-ui-lg font-medium text-foreground">{item.value}</div>',
    );
    expect(source).toContain(
      '<div className="mt-1 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle">',
    );
    expect(source).not.toContain(
      '<div className="truncate text-ui-xl font-semibold text-foreground">\n            {item.value}',
    );
    expect(source).not.toContain(
      '<div className="mt-2 flex min-w-0 items-center gap-2 text-ui-lg text-foreground-subtle">',
    );
    expect(zhMessages["settings.usage.activityTitle"]).toBe("活跃度");
    expect(enMessages["settings.usage.activityTitle"]).toBe("Activity");
    expect(source).toContain("setSelectedSeriesNames");
    expect(source).toContain("return [...current.slice(1), name];");
    expect(source).toContain("borderColor: hidden ? undefined : seriesColor");
    expect(source).toContain("bg-input border-border text-transparent");
    expect(source).toContain("text-foreground-subtle");
    expect(source).toContain('className="font-mono font-medium"');
    expect(barChartSource).toContain('className="text-foreground-subtle">tokens/s</span>');
    expect(lineChartSource).toContain('className="text-foreground-subtle">tokens/s</span>');
    expect(barChartSource).not.toContain("`${formatCompactNumber(locale, value)} tokens/s`");
    expect(lineChartSource).not.toContain("`${formatCompactNumber(locale, value)} tokens/s`");
    expect(source).toMatch(/const detailUnit =\s*valueKind === "token"/);
    expect(source).toContain('id: "settings.usage.creditUnit"');
    expect(source).toContain("{detailUnit}</span>");
    expect(barChartSource.match(/valueKind === "token"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(barChartSource.match(/\{tokenUnit\}<\/span>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(barChartSource).toContain(
      'const creditUnit = intl.formatMessage({ id: "settings.usage.creditUnit" })',
    );
    expect(barChartSource.match(/\{creditUnit\}<\/span>/g)?.length).toBeGreaterThanOrEqual(2);
    expect(zhMessages["settings.usage.creditUnit"]).toBe("积分");
    expect(enMessages["settings.usage.creditUnit"]).toBe("credits");
    expect(source).not.toContain('className="font-medium text-foreground"');
    expect(source).not.toContain('className="truncate">{item.name}:');
    expect(source).toContain("USAGE_STATS_TABS_LIST_CLASS");
    expect(source).toContain("USAGE_STATS_TABS_TRIGGER_CLASS");
    expect(uiPartsSource).toContain("px-2.5 py-0 text-ui-sm");
    expect(uiPartsSource).not.toContain("w-16");
    expect(uiPartsSource).not.toContain("px-0 py-0 text-ui-sm");
    expect(source).toContain('className="h-4 w-px bg-border"');
    expect(source).not.toContain('className="h-7 w-px bg-border"');
    expect(source).not.toContain("onRefresh: () => void");
    expect(source).not.toContain("onClick={onRefresh}");
    expect(source).toContain("RefreshCw");
    expect(source).toContain('variant="ghost"');
    expect(source).not.toContain('variant="outline"\n            size="icon-sm"');
    expect(source).toContain('size="icon-sm"');
    expect(source).not.toContain('className="h-8 rounded-md bg-background"');
    expect(source).toContain('aria-label={intl.formatMessage({ id: "settings.usage.refresh" })}');
    expect(source).not.toContain("providerName={effectiveProviderName}");
    expect(source).not.toContain("{providerName ? (");
    expect(source).not.toContain("BarChart3");
    expect(source).not.toContain("settings.usage.charts");
    expect(source).not.toContain("handleScrollToCharts");
    expect(source).toContain("handleUsageStatsRefresh");
    expect(source).toContain("refreshCodingPlanUsage({ force: true })");
    expect(source).not.toContain("document.getElementById(CODING_PLAN_USAGE_TRENDS_SECTION_ID)");
    expect(source).toContain('const options: CodingPlanUsageTrendRange[] = ["7d", "30d"];');
    expect(source).not.toContain('"today", "7d", "30d", "custom"');
    expect(source).not.toContain('range === "custom"');
    expect(source).not.toContain('type="date"');
    expect(source).not.toContain(
      'className="flex h-8 rounded-lg border border-border bg-background p-1"',
    );
    expect(source).toContain(
      '<div className="rounded-xl bg-surface/70 p-3">\n        <UsageChartLoadBoundary\n          scope="settings.usage.coding-plan-health-chart"',
    );
    expect(barChartSource).toContain("BarChart");
    expect(barChartSource).toContain("<Bar");
    expect(barChartSource).not.toContain("rounded-lg bg-surface/60");
    expect(lineChartSource).not.toContain("rounded-lg bg-surface/60");
    expect(lineChartSource).toContain(
      "const CODING_PLAN_LINE_CHART_MARGIN = { top: 8, right: 24, left: 24 } as const;",
    );
    expect(lineChartSource).not.toContain(
      "const CODING_PLAN_LINE_CHART_MARGIN = { top: 8, right: 12, left: 8 } as const;",
    );
    expect(barChartSource).toContain('className="max-w-96 min-w-72"');
    expect(barChartSource).toContain("getModelBreakdownColor");
    expect(barChartSource).toContain("getModelColor(index, item.color)");
    expect(barChartSource).toContain("color-mix");
    expect(barChartSource).not.toContain("BREAKDOWN_COLORS");
    expect(barChartSource).toContain("radius: [4, 4, 0, 0]");
    expect(barChartSource).toContain("radius: [0, 0, 0, 0]");
    expect(barChartSource).toContain("radius={item.radius}");
    expect(barChartSource).toContain("CODING_PLAN_BAR_CHART_MAX_BAR_SIZE");
    expect(barChartSource).toContain("CODING_PLAN_BAR_CHART_MAX_BAR_SIZE = 24");
    expect(barChartSource).toContain("maxBarSize={CODING_PLAN_BAR_CHART_MAX_BAR_SIZE}");
    expect(barChartSource).toContain("name={item.label}");
    expect(barChartSource).toContain("backgroundColor: indicatorColor");
    expect(barChartSource).toContain("return (");
    expect(barChartSource).toContain('className="text-foreground-subtle"');
    expect(barChartSource).toContain(
      'className="mt-3 flex items-center justify-between gap-8 text-foreground"',
    );
    expect(barChartSource).toContain('className="mt-3 border-t border-border"');
    expect(barChartSource).toContain("settings.usage.codingPlanLegendTotal");
    expect(barChartSource).toContain("size-2 shrink-0 self-center rounded-full");
    expect(barChartSource).toContain("min-w-0 flex-1 truncate text-foreground-subtle");
    expect(barChartSource).not.toContain("whitespace-normal break-words");
    expect(barChartSource).not.toContain("mt-1 size-2");
    expect(lineChartSource).toContain("size-2 shrink-0 self-center rounded-full");
    expect(lineChartSource).not.toContain("h-2.5 w-1");
    expect(lineChartSource).toContain('role="list"');
    expect(lineChartSource.indexOf('role="list"')).toBeLessThan(
      lineChartSource.indexOf("<ChartContainer"),
    );
    expect(lineChartSource).not.toContain("ChartLegend");
    expect(lineChartSource).not.toContain("ChartLegendContent");
    expect(barChartSource).not.toContain("LineChart");
    expect(barChartSource).not.toContain("<Line");
  });

  it("使用详情模型维度按真实模型生成柱状图 series", () => {
    expect(
      buildCodingPlanUsageDetailLineChartSeries({
        metric: "credits",
        subject: "model",
        modelDataList: [
          {
            modelName: "glm-5",
            sortOrder: 1,
            tokensUsage: [10, 20],
            creditsUsage: [1, 2],
            cachedInputCreditsUsage: [0.4, 0.8],
            uncachedInputCreditsUsage: [0.5, 1],
            outputCreditsUsage: [0.1, 0.2],
            totalTokens: 30,
            totalCredits: 3,
          },
        ],
        toolDataList: [],
      }),
    ).toEqual([
      {
        breakdown: {
          cachedInput: [0.4, 0.8],
          output: [0.1, 0.2],
          uncachedInput: [0.5, 1],
        },
        name: "glm-5",
        values: [1, 2],
      },
    ]);
  });

  it("Coding Plan 柱状图按单个并排柱高度计算 Y 轴最大值", () => {
    expect(
      calculateCodingPlanBarChartMaxValue(
        [
          {
            name: "GLM-5.3",
            values: [100],
            breakdown: {
              cachedInput: [70],
              uncachedInput: [20],
              output: [10],
            },
          },
          {
            name: "GLM-5-Turbo",
            values: [90],
            breakdown: {
              cachedInput: [60],
              uncachedInput: [20],
              output: [10],
            },
          },
        ],
        1,
      ),
    ).toBe(100);
  });

  it("旧版 Coding Plan 只有 token 用量时不展示积分摘要卡", () => {
    const legacyUsage = {
      summary: {
        cacheHitRate: 0.894,
        cacheHitRateTrend: -0.06,
        totalCredits: 0,
        totalCreditsTrend: 0,
        averageDailyCredits: 0,
        averageDailyCreditsTrend: 0,
      },
      modelDataList: [
        {
          modelName: "GLM-5.2",
          sortOrder: 1,
          tokensUsage: [12_950_000],
          totalTokens: 12_950_000,
        },
      ],
      toolDataList: [],
    };

    expect(hasCodingPlanCreditUsageData(legacyUsage)).toBe(false);
    expect(shouldShowCodingPlanUsageDetailSummary(legacyUsage)).toBe(false);
  });

  it("新版 Coding Plan 有 credits 数据时展示积分摘要卡", () => {
    const creditUsage = {
      summary: {
        cacheHitRate: 0.89,
        cacheHitRateTrend: null,
        totalCredits: 28.95,
        totalCreditsTrend: null,
        averageDailyCredits: 28.95,
        averageDailyCreditsTrend: null,
      },
      modelDataList: [
        {
          modelName: "GLM-5.3",
          sortOrder: 1,
          tokensUsage: [120],
          creditsUsage: [28.95],
          totalTokens: 120,
          totalCredits: 28.95,
        },
      ],
      toolDataList: [],
    };

    expect(hasCodingPlanCreditUsageData(creditUsage)).toBe(true);
    expect(shouldShowCodingPlanUsageDetailSummary(creditUsage)).toBe(true);
  });

  it("打开 Coding Plan Usage 页会同步刷新 entitlement quota", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'void effectiveEntitlementRefresh({ silent: true, reason: "access" });',
    );
    expect(source).not.toContain("void refresh({ force: true });");
  });

  it("系统健康度固定展示近 7 日且不提供范围筛选", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );
    const healthSection = source.slice(
      source.indexOf("function CodingPlanHealthSection"),
      source.indexOf("function formatCodingPlanRate"),
    );

    expect(healthSection).toContain('id: "settings.usage.healthRange.7d"');
    expect(healthSection).not.toContain("<SegmentedTabs");
    expect(healthSection).not.toContain("setRange");
    expect(healthSection).not.toContain('"30d"');
  });

  it("峰值 Token 卡片只显示固定标题，并通过信息图标展示峰值日期", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("peakDailyTokensDate: summary.peakDailyTokensDate");
    expect(source).toContain("<InfoIcon");
    expect(source).toContain("title={formatFullDay(locale, item.peakDailyTokensDate)}");
    expect(source).not.toContain(
      '? `${intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" })}',
    );
  });

  it("缺少重置时间时不展示兜底文案", async () => {
    const sources = await Promise.all(
      [
        "../src/settings/usage-stats/CodingPlanUsagePanel.tsx",
        "../src/WorkspaceSidebarFooterUsageSummary.tsx",
        "../src/i18n/locales/en-US.ts",
        "../src/i18n/locales/zh-CN.ts",
      ].map((path) => readSourceTextAsync(new URL(path, import.meta.url), "utf8")),
    );

    expect(sources.join("\n")).not.toContain("∞");
    expect(sources.join("\n")).not.toContain("sidebar.usage.plan.unlimited");
    expect(sources.join("\n")).not.toContain("settings.usage.entitlementNoReset");
    expect(sources.join("\n")).not.toContain("No reset time");
    expect(sources.join("\n")).not.toContain("暂无重置时间");
  });

  it("个人套餐 quota 卡片把重置时间放在百分比同一信息行", async () => {
    const source = await readSourceTextAsync(
      new URL("../src/settings/usage-stats/CodingPlanUsagePanel.tsx", import.meta.url),
      "utf8",
    );
    const quotaCardBlock = source.slice(
      source.indexOf('className="min-w-0 flex-1 rounded-xl bg-surface/70 p-4"'),
      source.indexOf("function CodingPlanUsageTrendsSection"),
    );

    expect(quotaCardBlock).not.toBe("");
    expect(quotaCardBlock.indexOf("formatQuotaRemainingPercentage")).toBeLessThan(
      quotaCardBlock.indexOf("{resetTime ? ("),
    );
    expect(quotaCardBlock.indexOf("{resetTime ? (")).toBeLessThan(
      quotaCardBlock.indexOf('className="mt-3 h-2 overflow-hidden rounded-full bg-background"'),
    );
  });

  it("quota 卡片显示剩余额度百分比而不是已用百分比", () => {
    const limit = {
      type: "TOKENS_LIMIT",
      unit: 3,
      number: 5,
      percentage: 25,
      usageDetails: [],
    };

    expect(getQuotaRemainingPercentage(limit)).toBe(75);
    expect(formatQuotaRemainingPercentage("en-US", limit)).toBe("75%");
  });

  it("三个剩余用量入口的重置按钮都只打开统一弹窗", async () => {
    const sources = await Promise.all(
      [
        "../src/settings/usage-stats/CodingPlanUsagePanel.tsx",
        "../src/settings/model-provider-section/StatusCards.tsx",
        "../src/chat-input-toolbar/CodingPlanContextUsage.tsx",
      ].map((path) => readSourceTextAsync(new URL(path, import.meta.url))),
    );

    for (const source of sources) {
      expect(source).toContain("onOpenDialog={() => setQuotaResetDialogOpen(true)}");
      expect(source).not.toContain("onReset={resetUi.reset}");
      expect(source).not.toContain("onReset={resetUi.week.reset}");
    }
  });

  it("Usage 页和 Usage Remaining 菜单复用相同重置时间格式", () => {
    const resetAt = new Date(2026, 6, 10, 8, 30).getTime();

    expect(
      formatQuotaResetTime({
        locale: "en-US",
        value: resetAt,
        format: "dateTime",
      }),
    ).toBe("Jul 10, 08:30");
    expect(
      formatQuotaResetTime({
        locale: "en-US",
        value: resetAt,
        format: "date",
      }),
    ).toBe("Jul 10");
  });

  it("只有 Usage stats 的额度卡统一显示月日和时分", () => {
    const resetAt = new Date(2026, 8, 16, 23, 0).getTime();

    expect(formatUsageStatsQuotaResetTime("zh-CN", resetAt)).toBe("9月16日 23:00");
    expect(formatUsageStatsQuotaResetTime("zh-CN", undefined)).toBeUndefined();
  });

  // 修复原因：zai 业务后端 Team Plan 的 quota/limit 用 CREDIT_LIMIT 作为 type，
  // bigmodel 用 TOKENS_LIMIT。unit/number 语义一致，消费方按 TOKENS_LIMIT 查询时
  // 必须命中 CREDIT_LIMIT，否则 zai team plan 的 5 小时/每周配额卡不会渲染。
  it("findCodingPlanQuotaLimit 按 TOKENS_LIMIT 查询时等价命中 CREDIT_LIMIT", () => {
    const zaiTeamLimits = [
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        percentage: 27,
        usageDetails: [],
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        percentage: 10,
        usageDetails: [],
      },
    ];

    // 5 小时窗口（unit=3, number=5）
    expect(findCodingPlanQuotaLimit(zaiTeamLimits, "TOKENS_LIMIT", 3, 5)).toEqual(zaiTeamLimits[0]);
    // 每周（unit=6）
    expect(findCodingPlanQuotaLimit(zaiTeamLimits, "TOKENS_LIMIT", 6)).toEqual(zaiTeamLimits[1]);
    // 缺失的 monthly tool 仍返回 null
    expect(findCodingPlanQuotaLimit(zaiTeamLimits, "TIME_LIMIT", 5, 1)).toBeNull();
  });

  it("findCodingPlanQuotaLimit 对 bigmodel TOKENS_LIMIT 保持原行为", () => {
    const bigmodelLimits = [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 40,
        usageDetails: [],
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        percentage: 15,
        usageDetails: [],
      },
    ];

    expect(findCodingPlanQuotaLimit(bigmodelLimits, "TOKENS_LIMIT", 3, 5)).toEqual(
      bigmodelLimits[0],
    );
    expect(findCodingPlanQuotaLimit(bigmodelLimits, "TIME_LIMIT", 5, 1)).toEqual(bigmodelLimits[1]);
    // CREDIT_LIMIT 不会误匹配 TIME_LIMIT 查询
    expect(findCodingPlanQuotaLimit(bigmodelLimits, "CREDIT_LIMIT", 5, 1)).toBeNull();
  });
});
