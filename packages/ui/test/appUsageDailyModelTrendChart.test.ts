import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import {
  APP_USAGE_TREND_CHART_MARGIN,
  buildAppUsageDailyModelChartViewModel,
  filterDailyModelTooltipPayload,
  resolveDailyModelTooltipTokenParts,
} from "@/settings/usage-stats/AppUsageDailyModelTrendChart.js";

const intl = {
  formatMessage({ id }: { id: string }) {
    return id === "settings.usage.unknownModel" ? "Unknown model" : id;
  },
};

function createSnapshot(overrides: Partial<AppUsageSnapshot> = {}): AppUsageSnapshot {
  return {
    range: "7d",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {} as AppUsageSnapshot["summary"],
    heatmap: { startDate: null, endDate: null, maxTokens: 0, weeks: [] },
    models: [],
    dailyModelUsage: [],
    tools: [],
    ...overrides,
  };
}

function createDateKey(index: number): string {
  return new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
}

describe("AppUsageDailyModelTrendChart view model", () => {
  it("使用折线图而不是柱状图渲染趋势", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("LineChart");
    expect(source).toContain("<Line");
    expect(source).not.toContain("BarChart");
    expect(source).not.toContain("<Bar");
  });

  it("为首尾日期刻度保留水平安全区", () => {
    expect(APP_USAGE_TREND_CHART_MARGIN).toMatchObject({
      left: 24,
      right: 24,
    });
  });

  it("按 7d range 的每日模型 token 用量保留未知模型", () => {
    const snapshot = createSnapshot({
      models: [
        {
          modelId: "glm-4.5",
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 60,
          requestCount: 2,
          share: 0.625,
        },
        {
          modelId: null,
          totalTokens: 60,
          inputTokens: 20,
          outputTokens: 40,
          requestCount: 1,
          share: 0.375,
        },
      ],
      dailyModelUsage: [
        {
          date: "2026-01-01",
          models: [{ modelId: "glm-4.5", totalTokens: 40 }],
        },
        {
          date: "2026-01-08",
          models: [
            { modelId: "glm-4.5", totalTokens: 60 },
            { modelId: null, totalTokens: 60 },
          ],
        },
      ],
    });

    const viewModel = buildAppUsageDailyModelChartViewModel({
      intl,
      locale: "en-US",
      snapshot,
    });

    expect(viewModel.maxTokens).toBe(60);
    expect(viewModel.modelKeys.map((model) => model.label)).toEqual(["glm-4.5", "Unknown model"]);
    expect(viewModel.chartData).toEqual([
      {
        label: "Jan 1",
        tooltipLabel: "Jan 1",
        total: 40,
        model0: 40,
        model1: 0,
      },
      {
        label: "Jan 8",
        tooltipLabel: "Jan 8",
        total: 120,
        model0: 60,
        model1: 60,
      },
    ]);
  });

  it("Y 轴峰值只统计实际展示的模型折线", () => {
    const models = Array.from({ length: 7 }, (_, index) => ({
      modelId: `model-${index}`,
      totalTokens: 700 - index,
      inputTokens: 0,
      outputTokens: 700 - index,
      requestCount: 1,
      share: 1 / 7,
    }));
    const snapshot = createSnapshot({
      models,
      dailyModelUsage: [
        {
          date: "2026-01-01",
          models: [
            { modelId: "model-0", totalTokens: 40 },
            { modelId: "model-1", totalTokens: 60 },
            { modelId: "model-6", totalTokens: 1_000 },
          ],
        },
      ],
    });

    const viewModel = buildAppUsageDailyModelChartViewModel({
      intl,
      locale: "en-US",
      snapshot,
    });

    expect(viewModel.maxTokens).toBe(60);
    expect(viewModel.chartData[0]?.total).toBe(1_100);
  });

  it("30d range 按日保留 30 个趋势点", () => {
    const snapshot = createSnapshot({
      range: "30d",
      models: [
        {
          modelId: "glm-4.5",
          totalTokens: 465,
          inputTokens: 200,
          outputTokens: 265,
          requestCount: 30,
          share: 1,
        },
      ],
      dailyModelUsage: Array.from({ length: 30 }, (_, index) => ({
        date: createDateKey(index),
        models: [{ modelId: "glm-4.5", totalTokens: index + 1 }],
      })),
    });

    const viewModel = buildAppUsageDailyModelChartViewModel({
      intl,
      locale: "en-US",
      snapshot,
    });

    expect(viewModel.chartData).toHaveLength(30);
    expect(viewModel.chartData[0]).toMatchObject({
      label: "Jan 1",
      tooltipLabel: "Jan 1",
      total: 1,
      model0: 1,
    });
    expect(viewModel.chartData[29]).toMatchObject({
      label: "Jan 30",
      tooltipLabel: "Jan 30",
      total: 30,
      model0: 30,
    });
  });

  it("每日模型图表使用应用用量专用色板", () => {
    const snapshot = createSnapshot({
      models: Array.from({ length: 6 }, (_, index) => ({
        modelId: `model-${index}`,
        totalTokens: 100 - index,
        inputTokens: 40,
        outputTokens: 60,
        requestCount: 1,
        share: 1 / 6,
      })),
    });

    const viewModel = buildAppUsageDailyModelChartViewModel({
      intl,
      locale: "en-US",
      snapshot,
    });

    expect(viewModel.modelKeys.map((model) => model.color)).toEqual([
      "var(--color-usage-chart-1)",
      "var(--color-usage-chart-2)",
      "var(--color-usage-chart-3)",
      "var(--color-usage-chart-4)",
      "var(--color-usage-chart-5)",
      "var(--color-usage-chart-6)",
    ]);
  });

  it("tooltip payload 过滤当天用量为 0 的模型", () => {
    const activeModel = { name: "glm-4.5", value: 128 };
    const zeroModel = { name: "glm-4.6", value: 0 };
    const stringZeroModel = { name: "glm-4.7", value: "0" };

    expect(filterDailyModelTooltipPayload([activeModel, zeroModel, stringZeroModel])).toEqual([
      activeModel,
    ]);
  });

  it("tooltip 的每个模型值使用紧凑 Token 单位", () => {
    expect(resolveDailyModelTooltipTokenParts("zh-CN", 419_884_094, "tokens")).toEqual({
      number: "4.2亿",
      unit: "tokens",
    });
    expect(resolveDailyModelTooltipTokenParts("en-US", 419_884_094, "tokens")).toEqual({
      number: "419.9M",
      unit: "tokens",
    });

    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/ui/src/settings/usage-stats/AppUsageDailyModelTrendChart.tsx",
      ),
      "utf8",
    );
    expect(source).toContain('className="font-mono font-medium tabular-nums"');
    expect(source).toContain('className="text-foreground-subtle">{tokenValue.unit}</span>');
  });
});
