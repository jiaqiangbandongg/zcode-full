import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  persistTaskOrder,
  pruneTaskOrder,
  readTaskOrder,
  sortTasksByOrder,
} from "../src/lib/taskOrderPreference.js";

function createTask(taskId: string, updatedAt: number): ZCodeTaskMeta {
  return {
    taskId,
    workspacePath: "/tmp/workspace-sort",
    title: taskId,
    createdAt: updatedAt,
    updatedAt,
    provider: "claude",
  };
}

describe("taskOrderPreference", () => {
  it("reads back a normalized task order", () => {
    const storage = new Map<string, string>();

    persistTaskOrder("/tmp/workspace-sort", ["task-b", "task-b", "", "task-a"], {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => {
        storage.set(key, value);
      },
    });

    expect(
      readTaskOrder("/tmp/workspace-sort", {
        getItem: (key) => storage.get(key) ?? null,
        setItem: () => {},
      }),
    ).toEqual(["task-b", "task-a"]);
  });

  it("keeps new unordered tasks ahead of manually ordered history", () => {
    const tasks = [createTask("task-a", 100), createTask("task-b", 200), createTask("task-c", 300)];

    expect(sortTasksByOrder(tasks, ["task-a", "task-b"]).map((task) => task.taskId)).toEqual([
      "task-c",
      "task-a",
      "task-b",
    ]);
  });

  it("prunes deleted tasks from a saved order", () => {
    const tasks = [createTask("task-a", 100), createTask("task-c", 300)];

    expect(pruneTaskOrder(["task-a", "task-b", "task-c"], tasks)).toEqual(["task-a", "task-c"]);
  });
});
