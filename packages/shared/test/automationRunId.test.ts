import { describe, expect, it } from "vitest";
import { parseAutomationRunId } from "../src/automation-types.js";

describe("parseAutomationRunId", () => {
  it("解析 schedule runId 的 automationId 与 scheduledAt", () => {
    expect(parseAutomationRunId("automation-1:1700000000000")).toEqual({
      automationId: "automation-1",
      trigger: "schedule",
      scheduledAt: 1_700_000_000_000,
    });
  });

  it("解析 manual runId，不产出 scheduledAt", () => {
    expect(parseAutomationRunId("automation-1:manual:run-1")).toEqual({
      automationId: "automation-1",
      trigger: "manual",
    });
  });

  it("不符合契约的输入一律返回 null，不猜格式", () => {
    expect(parseAutomationRunId("command-uuid-without-colon")).toBeNull();
    expect(parseAutomationRunId(":1700000000000")).toBeNull();
    expect(parseAutomationRunId("automation-1:not-a-timestamp")).toBeNull();
    expect(parseAutomationRunId("automation-1:manual:")).toBeNull();
    expect(parseAutomationRunId("automation-1:-5")).toBeNull();
    expect(parseAutomationRunId("automation-1:1700000000000.5")).toBeNull();
  });
});
