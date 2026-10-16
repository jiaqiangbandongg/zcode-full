import { describe, expect, it } from "vitest";
import type { SessionTaskType } from "@zcode/contracts";
import { resolveModelRequestSessionTypeFromTaskType } from "../src/runtime/methods/model-request-session-type.js";

describe("resolveModelRequestSessionTypeFromTaskType", () => {
  it.each<{
    expected: "main" | "subagent" | "side_chat" | "other";
    taskType: SessionTaskType | undefined;
  }>([
    { expected: "main", taskType: undefined },
    { expected: "main", taskType: "interactive" },
    { expected: "main", taskType: "fork" },
    { expected: "side_chat", taskType: "selection_side_chat" },
    { expected: "main", taskType: "workflow_parent" },
    { expected: "subagent", taskType: "subagent_child" },
    { expected: "other", taskType: "workflow_child" },
    { expected: "other", taskType: "nested_workflow_child" },
  ])("maps $taskType to $expected", ({ expected, taskType }) => {
    expect(resolveModelRequestSessionTypeFromTaskType(taskType)).toBe(expected);
  });
});
