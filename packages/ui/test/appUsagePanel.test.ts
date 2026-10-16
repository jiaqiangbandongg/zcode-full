// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { AppUsageRange, AppUsageSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  AppUsageLifetimeSummaryStrip,
  AppUsagePanel,
} from "@/settings/usage-stats/AppUsagePanel.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

function createSnapshot(
  overrides: Partial<AppUsageSnapshot> & { range?: AppUsageRange } = {},
): AppUsageSnapshot {
  return {
    range: overrides.range ?? "all",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens: 20_650_000_000,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 5,
      longestSessionMs: 2 * 60 * 60 * 1000 + 15 * 60 * 1000,
      longestStreakDays: 34,
      peakDayTokens: 370_000_000,
      favoriteModel: null,
    },
    heatmap: {
      startDate: null,
      endDate: null,
      maxTokens: 370_000_000,
      weeks: [],
    },
    dailyModelUsage: [],
    models: [],
    tools: [],
    ...overrides,
  };
}

function createOneDayHeatmap(totalTokens: number): AppUsageSnapshot["heatmap"] {
  return {
    startDate: "2026-08-15",
    endDate: "2026-08-15",
    maxTokens: totalTokens,
    weeks: [
      {
        weekIndex: 0,
        days: [
          {
            date: "2026-08-15",
            level: 1,
            totalTokens,
            turnCount: 1,
            toolCallCount: 0,
          },
        ],
      },
    ],
  };
}

function createServices(): IServiceAccessor {
  return {
    usageStatsService: {
      getAppUsageSnapshot: vi.fn(async ({ range }: { range: AppUsageRange }) =>
        createSnapshot({
          range,
          heatmap: range === "all" ? createOneDayHeatmap(99) : createOneDayHeatmap(10),
          summary: {
            ...createSnapshot().summary,
            totalTokens: range === "all" ? 20_650_000_000 : 389_000,
            totalSessions: 4,
            totalTurns: 8,
            activeDays: 1,
            favoriteModel:
              range === "all"
                ? null
                : {
                    modelId: "glm-5.3",
                    totalTokens: 280_080,
                    share: 0.72,
                  },
          },
        }),
      ),
    },
  } as unknown as IServiceAccessor;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppUsageLifetimeSummaryStrip", () => {
  it("renders all-time app usage metrics independent of the selected range", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(AppUsageLifetimeSummaryStrip, {
          snapshot: createSnapshot(),
        }),
      ),
    );

    expect(html).toContain("累计 Token 数");
    expect(html).toContain("峰值 Token 数");
    expect(html).toContain("最长聊天时长");
    expect(html).toContain("当前连续天数");
    expect(html).toContain("最长连续天数");
    expect(html).toContain("206.5 亿");
    expect(html).toContain("3.7 亿");
    expect(html).toContain("2 小时 15 分");
    expect(html).toContain("5 天");
    expect(html).toContain("34 天");
    expect(html).toContain("rounded-xl");
    expect(html).toContain("h-7");
    expect(html).toContain("w-px");
    expect(html).not.toContain("border-border");
    expect(html).not.toContain("border-t");
    expect(html).not.toContain("sm:border-l");
  });

  it("keeps the selected range for charts but removes the old range metric cards", async () => {
    // Bugfix: 两张图表是 lazy(() => import(...))（产品侧为了不让 Recharts/decimal.js 拖慢
    // 启动才按需加载），全量高负载下测试 worker 现场编译图表模块图会超过 waitFor 5s，
    // 「正在统计中」Suspense fallback 消失不了（a7cade07fb 曾放宽到 5s 仍不够）。
    // 渲染前用与组件内 lazy 完全一致的 specifier 预热模块，动态 import 命中缓存立即
    // resolve，占位不再依赖机器负载；若图表模块本身加载失败，预热会在此处直接报错。
    await Promise.all([
      import("@/settings/usage-stats/AppUsageDailyModelTrendChart.js"),
      import("@/settings/usage-stats/AppUsageModelUsagePieChart.js"),
    ]);
    render(
      createElement(
        ServiceProvider,
        { services: createServices() },
        createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, createElement(AppUsagePanel)),
      ),
    );

    await screen.findByText("累计 Token 数");
    // Bugfix: 加载过程中"正在统计中"占位会同时出现多个，queryByText 命中多元素时
    // 直接抛错（全量负载下 waitFor 默认 1s 内未收敛就以 multiple elements 超时）。
    // 改用 queryAllByText 断言占位全部消失，并放宽到 5s 容忍负载下慢收敛。
    await waitFor(
      () => {
        expect(screen.queryAllByText("正在统计中")).toHaveLength(0);
      },
      { timeout: 5000 },
    );

    const lifetimeTitle = screen.getByText("累计 Token 数");
    const tokenActivityTitle = screen.getByText("Token 活动");
    const rangeTitle = screen.getByText("时间范围");
    expect(
      lifetimeTitle.compareDocumentPosition(tokenActivityTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tokenActivityTitle.compareDocumentPosition(rangeTitle) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(rangeTitle).toBeTruthy();
    expect(document.body.innerHTML).toContain("99");
    const sevenDayTab = screen.getByText("近 7 日");
    const thirtyDayTab = screen.getByText("近 30 日");
    expect(sevenDayTab.getAttribute("aria-selected")).toBe("true");
    expect(thirtyDayTab.getAttribute("aria-selected")).toBe("false");
    expect(await screen.findByText("每日 Token 趋势图")).toBeTruthy();
    expect(screen.queryByText("趋势图")).toBeNull();
    expect(screen.queryByText("按天 Token 趋势")).toBeNull();
    expect(document.body.innerHTML).toContain("rounded-full bg-surface");
    expect(document.body.innerHTML).toContain("group-data-horizontal/tabs:h-7");
    expect(document.body.innerHTML).toContain("px-2.5 py-0 text-ui-sm");
    expect(document.body.innerHTML).not.toContain("w-16");
    expect(document.body.innerHTML).not.toContain("rounded-lg border border-border");
    expect(screen.queryByText("tokens 用量")).toBeNull();
    expect(screen.queryByText("会话数量")).toBeNull();
    expect(screen.queryByText("消息数量")).toBeNull();
    expect(screen.queryByText("活跃天数")).toBeNull();
    expect(screen.queryByText("最常用模型")).toBeNull();
  });

  it("keeps chart color indicators above the charts", async () => {
    const dailyChartSource = await readFile(
      "packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx",
      "utf8",
    );
    const modelChartSource = await readFile(
      "packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx",
      "utf8",
    );

    const dailyLegendIndex = dailyChartSource.indexOf('role="list"');
    const modelLegendIndex = modelChartSource.indexOf('role="list"');

    expect(dailyLegendIndex).toBeGreaterThan(-1);
    expect(modelLegendIndex).toBeGreaterThan(-1);
    expect(dailyLegendIndex).toBeLessThan(dailyChartSource.indexOf("<ChartContainer"));
    expect(modelLegendIndex).toBeGreaterThan(modelChartSource.indexOf("<ChartContainer"));
    expect(modelChartSource).toContain("md:grid-cols-2");
    expect(modelChartSource).toContain("grid grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(modelChartSource).toContain("size-2 shrink-0 self-center rounded-full");
    expect(modelChartSource).not.toContain("h-2.5 w-1");
    expect(modelChartSource).not.toContain("mt-0.5");
    expect(dailyChartSource).not.toContain("rounded-md bg-surface/60");
    expect(modelChartSource).not.toContain("rounded-md bg-surface/60");
    expect(dailyChartSource).toContain('className="space-y-3 rounded-xl bg-surface p-4"');
    expect(modelChartSource).toContain('className="space-y-3 rounded-xl bg-surface p-4"');
  });

  it("uses small typography for chart content while keeping chart titles unchanged", async () => {
    const [
      chartUiSource,
      dailyChartSource,
      modelChartSource,
      heatmapSource,
      codingPlanSource,
      codingPlanLineSource,
    ] = await Promise.all(
      [
        "packages/ui/src/components/ui/chart.tsx",
        "packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx",
        "packages/ui/src/settings/usage-stats/AppUsageModelUsagePieChart.tsx",
        "packages/ui/src/settings/usage-stats/UsageHeatmap.tsx",
        "packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx",
        "packages/ui/src/settings/usage-stats/CodingPlanUsageLineChart.tsx",
      ].map((path) => readFile(path, "utf8")),
    );

    expect(chartUiSource).toContain("justify-center text-ui-sm");
    expect(chartUiSource).toContain("text-ui-sm/relaxed");
    expect(dailyChartSource).toContain('className="flex min-w-0 items-center gap-2 text-ui-sm"');
    expect(dailyChartSource).toContain('<h3 className="text-ui-base font-medium text-foreground">');
    expect(modelChartSource).toContain("font-mono text-ui-sm text-foreground");
    expect(modelChartSource).toContain("font-mono text-ui-sm text-foreground-subtle tabular-nums");
    expect(modelChartSource).toContain('<h3 className="text-ui-base font-medium text-foreground">');
    expect(heatmapSource).toContain(
      'className="min-w-0 truncate text-ui-sm text-foreground-subtle"',
    );
    expect(heatmapSource).toContain(
      '<h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">',
    );
    expect(codingPlanSource).toContain(
      'className="mt-3 flex flex-wrap items-center gap-3 text-ui-sm"',
    );
    expect(codingPlanSource).toContain(
      'className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-ui-sm"',
    );
    expect(codingPlanLineSource).toContain(
      'className="flex min-w-0 items-center gap-2 text-ui-sm"',
    );
  });
});
