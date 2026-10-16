import { describe, expect, it } from "vitest";
import { SESSION_TASK_TYPES } from "@zcode/contracts";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../src/zcode-protocol-v4/task-list-session-membership.js";

describe("task-list session membership", () => {
  it("只把主任务类型投影进 sessions-index", () => {
    expect(TASK_LIST_SESSION_TYPES).toEqual([
      "interactive",
      "fork",
      "workflow_parent",
    ]);
    expect(
      Object.fromEntries(
        SESSION_TASK_TYPES.map((taskType) => [
          taskType,
          isTaskListSessionType(taskType),
        ]),
      ),
    ).toEqual({
      fork: true,
      interactive: true,
      nested_workflow_child: false,
      selection_side_chat: false,
      subagent_child: false,
      workflow_child: false,
      workflow_parent: true,
    });
  });

  it("把缺省 taskType 按 legacy interactive 处理", () => {
    expect(isTaskListSessionType(undefined)).toBe(true);
  });
});
