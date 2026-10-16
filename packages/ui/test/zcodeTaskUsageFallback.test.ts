import { beforeEach, describe, expect, it } from "vitest";
import {
  buildPromptCompletionUsageFallback,
  buildTaskContextUsageFromUsageUpdate,
  recordTaskContextUsageUpdate,
  resetTaskContextUsageUpdateRecordsForTest,
} from "../src/lib/zcodeTaskUsageFallback.js";

function createUsage(totalTokens: number) {
  return {
    inputTokens: totalTokens,
    outputTokens: 0,
    totalTokens,
  };
}

describe("zcodeTaskUsageFallback", () => {
  beforeEach(() => {
    resetTaskContextUsageUpdateRecordsForTest();
  });

  it("收到正数 usage_update 后，不再用 task_complete usage 覆盖 context used", () => {
    recordTaskContextUsageUpdate({
      workspacePath: "/tmp/workspace-usage",
      taskId: "task-usage",
      used: 65_274,
      size: 200_000,
    });

    expect(
      buildPromptCompletionUsageFallback({
        workspacePath: "/tmp/workspace-usage",
        taskId: "task-usage",
        currentUsage: {
          used: 65_274,
          size: 200_000,
        },
        usage: createUsage(2_149_900),
      }),
    ).toBeNull();
  });

  it("没有 usage_update 的 provider 仍可用 task_complete usage 做弱 fallback", () => {
    expect(
      buildPromptCompletionUsageFallback({
        workspacePath: "/tmp/workspace-fallback",
        taskId: "task-fallback",
        currentUsage: {
          used: 0,
          size: 200_000,
        },
        usage: createUsage(38_000),
      }),
    ).toEqual({
      used: 38_000,
      size: 200_000,
    });

    expect(
      buildPromptCompletionUsageFallback({
        workspacePath: "/tmp/workspace-fallback",
        taskId: "task-fallback",
        currentUsage: {
          used: 38_000,
          size: 200_000,
        },
        usage: createUsage(42_000),
      }),
    ).toEqual({
      used: 42_000,
      size: 200_000,
    });
  });

  it("只有独立 contextWindow 时也能用 task_complete usage 做弱 fallback", () => {
    expect(
      buildPromptCompletionUsageFallback({
        workspacePath: "/tmp/workspace-window-only",
        taskId: "task-window-only",
        currentUsage: null,
        currentContextWindow: 1_000_000,
        usage: createUsage(12_000),
      }),
    ).toEqual({
      used: 12_000,
      size: 1_000_000,
    });
  });

  it("used 为 0 的初始化 usage_update 不会阻止 completion fallback", () => {
    recordTaskContextUsageUpdate({
      workspacePath: "/tmp/workspace-zero",
      taskId: "task-zero",
      used: 0,
      size: 200_000,
    });

    expect(
      buildPromptCompletionUsageFallback({
        workspacePath: "/tmp/workspace-zero",
        taskId: "task-zero",
        currentUsage: {
          used: 0,
          size: 200_000,
        },
        usage: createUsage(1_024),
      }),
    ).toEqual({
      used: 1_024,
      size: 200_000,
    });
  });

  it("普通轮次里 used=0 的 usage_update 不覆盖已有正数 context usage", () => {
    expect(
      buildTaskContextUsageFromUsageUpdate({
        currentUsage: {
          used: 25_483,
          size: 200_000,
          cost: { amount: 0.12, currency: "USD" },
        },
        incomingUsage: {
          used: 0,
          size: 200_000,
          cost: null,
        },
        latestUserPrompt: "继续分析代码",
      }),
    ).toEqual({
      used: 25_483,
      size: 200_000,
      cost: { amount: 0.12, currency: "USD" },
    });
  });

  it("压缩轮次允许 used=0 清空 context usage", () => {
    expect(
      buildTaskContextUsageFromUsageUpdate({
        currentUsage: {
          used: 25_483,
          size: 200_000,
          cost: null,
        },
        incomingUsage: {
          used: 0,
          size: 200_000,
          cost: null,
        },
        latestUserPrompt: "/compact",
      }),
    ).toEqual({
      used: 0,
      size: 200_000,
      cost: null,
    });
  });

  it("相同 used/size 的重复 usage_update 会保留已有 breakdown", () => {
    expect(
      buildTaskContextUsageFromUsageUpdate({
        currentUsage: {
          used: 25_483,
          size: 200_000,
          breakdown: [{ source: "messages", chars: 1200 }],
        },
        incomingUsage: {
          used: 25_483,
          size: 200_000,
          cost: null,
        },
        latestUserPrompt: "继续分析代码",
      }),
    ).toEqual({
      used: 25_483,
      size: 200_000,
      cost: null,
      breakdown: [{ source: "messages", chars: 1200 }],
    });
  });

  it("新 used/size 没有 breakdown 时不会沿用上一轮比例", () => {
    expect(
      buildTaskContextUsageFromUsageUpdate({
        currentUsage: {
          used: 25_483,
          size: 200_000,
          breakdown: [{ source: "messages", chars: 1200 }],
        },
        incomingUsage: {
          used: 30_000,
          size: 200_000,
          cost: null,
        },
        latestUserPrompt: "继续分析代码",
      }),
    ).toEqual({
      used: 30_000,
      size: 200_000,
      cost: null,
    });
  });
});
