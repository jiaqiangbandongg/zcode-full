import { describe, expect, it } from "vitest";
import {
  createTaskFindEntries,
  getTaskFindState,
  moveTaskFindSelection,
} from "@/quickpick/taskFindSearch.js";

const tasks = [
  {
    taskId: "task-1",
    title: "Quick pick keyboard search",
    workspacePath: "/workspace/z-code",
    traceId: "trace-1",
    createdAt: 1,
    updatedAt: 3,
    mode: "default",
    changeSummary: {
      fileCount: 1,
      added: 12,
      removed: 3,
      files: [{ path: "/workspace/z-code/packages/ui/src/App.tsx", added: 12, removed: 3 }],
    },
  },
  {
    taskId: "task-2",
    title: "Remote workspace identity fix",
    workspacePath: "/workspace/z-code",
    traceId: "trace-2",
    createdAt: 2,
    updatedAt: 2,
    mode: "default",
  },
  {
    taskId: "task-3",
    title: "Quick file search",
    workspacePath: "/workspace/z-code",
    traceId: "trace-3",
    createdAt: 3,
    updatedAt: 1,
    mode: "default",
    changeSummary: {
      fileCount: 1,
      added: 4,
      removed: 0,
      files: [
        {
          path: "/workspace/z-code/packages/ui/src/quickpick/TaskFindDialog.tsx",
          added: 4,
          removed: 0,
        },
      ],
    },
  },
] as const;

describe("taskFindSearch", () => {
  it("finds conversations by title and task id", () => {
    const entries = createTaskFindEntries(tasks, "conversation");
    const state = getTaskFindState(entries, "quick", null);

    expect(state.matches.map((entry) => entry.task.taskId)).toEqual(["task-1", "task-3"]);
    expect(state.currentIndex).toBe(0);
    expect(state.total).toBe(2);
  });

  it("keeps the active result while it remains in the filtered list", () => {
    const entries = createTaskFindEntries(tasks, "conversation");
    const state = getTaskFindState(entries, "quick", "task-3");

    expect(state.activeTaskId).toBe("task-3");
    expect(state.currentIndex).toBe(1);
  });

  it("wraps result navigation", () => {
    const entries = createTaskFindEntries(tasks, "conversation");
    const state = getTaskFindState(entries, "quick", "task-3");

    expect(moveTaskFindSelection(state, "next")).toBe("task-1");
    expect(moveTaskFindSelection(state, "previous")).toBe("task-1");
  });

  it("can search by changed files instead of conversation titles", () => {
    const entries = createTaskFindEntries(tasks, "changes");
    const state = getTaskFindState(entries, "TaskFindDialog", null);

    expect(state.matches.map((entry) => entry.task.taskId)).toEqual(["task-3"]);
  });
});
