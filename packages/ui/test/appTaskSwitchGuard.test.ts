import { describe, it, expect } from "vitest";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";

describe("shouldBlockTaskSelectionDuringModelRestart", () => {
  it("模型切换重建阶段且 pending 时应阻止任务切换", () => {
    expect(
      shouldBlockTaskSelectionDuringModelRestart(true, "restartingRuntime"),
    ).toBe(true);
  });

  it("pending 但非重建阶段时不阻止任务切换", () => {
    expect(
      shouldBlockTaskSelectionDuringModelRestart(true, "syncingSession"),
    ).toBe(false);
  });

  it("非 pending 时不阻止任务切换", () => {
    expect(
      shouldBlockTaskSelectionDuringModelRestart(false, "restartingRuntime"),
    ).toBe(false);
  });
});
