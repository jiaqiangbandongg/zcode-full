import { describe, expect, it } from "vitest";
import type { AppUsageQueryResult } from "@zcode/contracts";
import {
  buildAppUsageSnapshot,
  resolveTzOffsetMs,
} from "../src/zcode-protocol/usage-stats-builder.js";

const DAY = 86_400_000;

function emptyResult(): AppUsageQueryResult {
  return {
    totals: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      avgTimeToFirstTokenMs: null,
    },
    turnTotals: {
      totalSessions: 0,
      totalTurns: 0,
      avgTurnDurationMs: null,
      longestSessionMs: 0,
    },
    toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
    models: [],
    tools: [],
    days: [],
    dayModels: [],
  };
}

describe("buildAppUsageSnapshot", () => {
  it("computes summary, cache hit rate, error rates and pads heatmap days", () => {
    const until = 7 * DAY; // tzOffset 0 → dayIndex 7 == until 当天
    const since = until - 7 * DAY;
    const result = emptyResult();
    result.totals = {
      totalTokens: 1000,
      inputTokens: 800,
      outputTokens: 200,
      reasoningTokens: 0,
      cacheCreationTokens: 100,
      cacheReadTokens: 600,
      modelRequestCount: 10,
      modelErrorCount: 2,
      avgTimeToFirstTokenMs: 120,
    };
    result.turnTotals = {
      totalSessions: 3,
      totalTurns: 12,
      avgTurnDurationMs: 1500,
      longestSessionMs: 3500,
    };
    result.toolTotals = { toolCallCount: 20, toolErrorCount: 5 };
    result.models = [
      { modelId: "a", totalTokens: 800, inputTokens: 640, outputTokens: 160, requestCount: 8 },
      { modelId: "b", totalTokens: 200, inputTokens: 160, outputTokens: 40, requestCount: 2 },
    ];
    result.tools = [
      { toolName: "Read", callCount: 12, errorCount: 2, avgDurationMs: 50 },
      { toolName: "Bash", callCount: 8, errorCount: 3, avgDurationMs: 300 },
    ];
    // 连续两天活跃，末尾对齐 until 当天
    result.days = [
      { dayIndex: 6, totalTokens: 400, turnCount: 5, toolCallCount: 8 },
      { dayIndex: 7, totalTokens: 600, turnCount: 7, toolCallCount: 12 },
    ];
    result.dayModels = [
      { dayIndex: 7, modelId: "a", totalTokens: 500 },
      { dayIndex: 7, modelId: "b", totalTokens: 100 },
    ];

    const snapshot = buildAppUsageSnapshot(result, {
      range: "7d",
      timeZone: "UTC",
      tzOffsetMs: 0,
      generatedAt: until,
      since,
      until,
    });

    expect(snapshot.source).toBe("agent-db");
    expect(snapshot.summary.totalTokens).toBe(1000);
    // cacheHitRate = cacheRead / inputTokens(total input) = 600/800
    expect(snapshot.summary.cacheHitRate).toBeCloseTo(0.75, 5);
    expect(snapshot.summary.modelErrorRate).toBeCloseTo(0.2, 5);
    expect(snapshot.summary.toolErrorRate).toBeCloseTo(0.25, 5);
    expect(snapshot.summary.totalSessions).toBe(3);
    expect(snapshot.summary.totalTurns).toBe(12);
    expect(snapshot.summary.longestSessionMs).toBe(3500);
    expect(snapshot.summary.activeDays).toBe(2);
    expect(snapshot.summary.currentStreakDays).toBe(2);
    expect(snapshot.summary.longestStreakDays).toBe(2);
    expect(snapshot.summary.peakDayTokens).toBe(600);
    expect(snapshot.summary.favoriteModel?.modelId).toBe("a");
    expect(snapshot.summary.favoriteModel?.share).toBeCloseTo(0.8, 5);

    // heatmap 覆盖 8 天（since..until inclusive），缺失日补 level 0
    const cells = snapshot.heatmap.weeks.flatMap((w) => w.days).filter((c) => c !== null);
    expect(cells.length).toBe(8);
    expect(snapshot.heatmap.maxTokens).toBe(600);

    // trend: until 当天有两个模型
    const lastDay = snapshot.dailyModelUsage.at(-1);
    expect(lastDay?.models.length).toBe(2);

    expect(snapshot.models[0].share).toBeCloseTo(0.8, 5);
    expect(snapshot.tools[0].errorRate).toBeCloseTo(2 / 12, 5);
  });

  it("computes all-time peak tokens, longest chat duration and longest streak", () => {
    const until = 10 * DAY;
    const result = emptyResult();
    result.turnTotals = {
      totalSessions: 2,
      totalTurns: 4,
      avgTurnDurationMs: 2000,
      longestSessionMs: 9_000,
    };
    result.days = [
      { dayIndex: 1, totalTokens: 100, turnCount: 1, toolCallCount: 0 },
      { dayIndex: 2, totalTokens: 300, turnCount: 1, toolCallCount: 0 },
      { dayIndex: 4, totalTokens: 200, turnCount: 1, toolCallCount: 0 },
      { dayIndex: 5, totalTokens: 800, turnCount: 1, toolCallCount: 0 },
      { dayIndex: 6, totalTokens: 700, turnCount: 1, toolCallCount: 0 },
    ];

    const snapshot = buildAppUsageSnapshot(result, {
      range: "all",
      timeZone: "UTC",
      tzOffsetMs: 0,
      generatedAt: until,
      since: 0,
      until,
    });

    expect(snapshot.summary.peakDayTokens).toBe(800);
    expect(snapshot.summary.longestSessionMs).toBe(9_000);
    expect(snapshot.summary.longestStreakDays).toBe(3);
    expect(snapshot.summary.currentStreakDays).toBe(0);
  });

  it("resolveTzOffsetMs returns a finite offset for a named zone", () => {
    const off = resolveTzOffsetMs("UTC", 0);
    expect(off).toBe(0);
    expect(Number.isFinite(resolveTzOffsetMs("America/New_York", 0))).toBe(true);
  });
});
