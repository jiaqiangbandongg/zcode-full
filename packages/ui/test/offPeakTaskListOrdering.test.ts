import type { ZCodeOffPeakTask, ZCodeOffPeakTaskStatus } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { sortOffPeakTasksByCreatedAt } from "@/settings/OffPeakTaskList.js";

function createTask(
  offPeakTaskId: string,
  status: ZCodeOffPeakTaskStatus,
  createdAt: number,
): ZCodeOffPeakTask {
  return {
    offPeakTaskId,
    title: offPeakTaskId,
    prompt: offPeakTaskId,
    permissionMode: "default",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    status,
    queuedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("sortOffPeakTasksByCreatedAt", () => {
  it("只按创建时间倒序排列，不让状态改变卡片位置", () => {
    const tasks = [
      createTask("older-running", "running", 100),
      createTask("newer-completed", "completed", 300),
      createTask("middle-failed", "failed", 200),
    ];

    expect(sortOffPeakTasksByCreatedAt(tasks).map((task) => task.offPeakTaskId)).toEqual([
      "newer-completed",
      "middle-failed",
      "older-running",
    ]);
    expect(tasks.map((task) => task.offPeakTaskId)).toEqual([
      "older-running",
      "newer-completed",
      "middle-failed",
    ]);
  });
});
