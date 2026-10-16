import { describe, expect, it } from "vitest";
import {
  countAllUnreadTasks,
  countWorkspaceUnreadTasks,
} from "../src/lib/unreadTaskCount.js";

describe("unread task count", () => {
  it("按 workspace 统计未读 task 数", () => {
    expect(
      countWorkspaceUnreadTasks({
        taskUnreadByTaskId: {
          "task-1": true,
          "task-2": true,
        },
      }),
    ).toBe(2);
  });

  it("聚合所有 workspace 的未读 task 数", () => {
    expect(
      countAllUnreadTasks({
        "/tmp/workspace-a": {
          taskUnreadByTaskId: {
            "task-1": true,
            "task-2": true,
          },
        },
        "/tmp/workspace-b": {
          taskUnreadByTaskId: {
            "task-3": true,
          },
        },
      }),
    ).toBe(3);
  });

  it("空 workspace 集合返回 0", () => {
    expect(countAllUnreadTasks({})).toBe(0);
  });
});
