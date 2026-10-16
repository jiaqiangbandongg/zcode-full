// 运行历史的归组与呈现（docs/dynamic-workflow/launch.md「Cards」）。
import { describe, expect, it } from "vitest";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import {
  formatSavedWorkflowRunArgs,
  formatSavedWorkflowTokens,
  lastRunByWorkflowName,
  savedWorkflowRunBadgeKind,
  savedWorkflowRunDurationMs,
} from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

function run(overrides: Partial<ZCodeSavedWorkflowRun> & { runId: string }): ZCodeSavedWorkflowRun {
  return {
    status: "completed",
    createdAt: 1_000,
    updatedAt: 2_000,
    spentTokens: 0,
    ...overrides,
  };
}

describe("lastRunByWorkflowName", () => {
  it("每个名字取 updatedAt 最新的一行；无名 run 不归任何工作流", () => {
    const map = lastRunByWorkflowName([
      run({ runId: "a", name: "x", updatedAt: 10 }),
      run({ runId: "b", name: "x", updatedAt: 30 }),
      run({ runId: "c", name: "y", updatedAt: 20 }),
      run({ runId: "d", updatedAt: 99 }),
    ]);
    expect(map.get("x")?.runId).toBe("b");
    expect(map.get("y")?.runId).toBe("c");
    expect(map.size).toBe(2);
  });
});

describe("savedWorkflowRunBadgeKind", () => {
  it("status → 徽标态映射；pending 与 running 同画成活动态", () => {
    expect(savedWorkflowRunBadgeKind(undefined)).toBe("never");
    expect(savedWorkflowRunBadgeKind("pending")).toBe("running");
    expect(savedWorkflowRunBadgeKind("running")).toBe("running");
    expect(savedWorkflowRunBadgeKind("completed")).toBe("completed");
    // 新旧终态词同语义折进同一个徽标（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
    expect(savedWorkflowRunBadgeKind("failed")).toBe("errored");
    expect(savedWorkflowRunBadgeKind("errored")).toBe("errored");
    expect(savedWorkflowRunBadgeKind("cancelled")).toBe("stopped");
    expect(savedWorkflowRunBadgeKind("stopped")).toBe("stopped");
  });
});

describe("呈现辅助", () => {
  it("实参芯片：字符串裸出，其余 JSON 压缩", () => {
    expect(formatSavedWorkflowRunArgs({ branch: "main", dry: false, list: [1] })).toEqual([
      "branch=main",
      "dry=false",
      "list=[1]",
    ]);
    expect(formatSavedWorkflowRunArgs(undefined)).toEqual([]);
  });

  it("时长：终态用 updatedAt，非终态按 now 计，不为负", () => {
    expect(savedWorkflowRunDurationMs(run({ runId: "a" }), 9_999)).toBe(1_000);
    expect(savedWorkflowRunDurationMs(run({ runId: "b", status: "running" }), 5_000)).toBe(4_000);
    expect(savedWorkflowRunDurationMs(run({ runId: "c", createdAt: 5, updatedAt: 1 }), 0)).toBe(0);
  });

  it("token 数：k / M 缩写", () => {
    expect(formatSavedWorkflowTokens(999)).toBe("999");
    expect(formatSavedWorkflowTokens(12_345)).toBe("12.3k");
    expect(formatSavedWorkflowTokens(2_500_000)).toBe("2.5M");
    expect(formatSavedWorkflowTokens(Number.NaN)).toBe("—");
  });
});
