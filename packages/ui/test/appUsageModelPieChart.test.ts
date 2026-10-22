import { describe, expect, it } from "vitest";
import type { AppUsageSnapshot } from "@zcode/shared";
import { buildAppUsageModelPieChartViewModel } from "@/settings/usage-stats/appUsageModelPieChartViewModel.js";

function createSnapshot(models: AppUsageSnapshot["models"]): AppUsageSnapshot {
  const totalTokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
  return {
    range: "30d",
    generatedAt: 0,
    timeZone: "UTC",
    source: "agent-db",
    summary: {
      totalTokens,
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
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
    },
    heatmap: {
      startDate: null,
      endDate: null,
      maxTokens: 0,
      weeks: [],
    },
    dailyModelUsage: [],
    models,
    tools: [],
  };
}

function createModel(modelId: string, totalTokens: number): AppUsageSnapshot["models"][number] {
  return {
    modelId,
    totalTokens,
    inputTokens: 0,
    outputTokens: 0,
    requestCount: 1,
    share: 0,
  };
}

const intl = {
  formatMessage(descriptor: { id: string }) {
    if (descriptor.id === "settings.usage.modelChart.other") {
      return "Other models";
    }
    if (descriptor.id === "settings.usage.unknownModel") {
      return "Unknown Model";
    }
    return descriptor.id;
  },
};

describe("buildAppUsageModelPieChartViewModel", () => {
  it("reuses the app usage chart palette and merges overflow models", () => {
    const snapshot = createSnapshot([
      createModel("model-a", 600),
      createModel("model-b", 500),
      createModel("model-c", 400),
      createModel("model-d", 300),
      createModel("model-e", 200),
      createModel("model-f", 80),
      createModel("model-g", 20),
    ]);

    const viewModel = buildAppUsageModelPieChartViewModel({ intl, snapshot });

    expect(viewModel.chartData).toHaveLength(6);
    expect(viewModel.chartData.at(-1)).toMatchObject({
      label: "Other models",
      totalTokens: 100,
    });
    expect(viewModel.chartData.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1);
  });
});
