import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { countWorkspaceUnreadTasks } from "@/lib/unreadTaskCount.js";
import { getTaskMeta, getTaskUnreadIndicator } from "@/store/zcodeSessionStore.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-unread",
    traceId: "trace-unread",
    title: "Unread task",
    workspacePath: "/repo/workspace",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

describe("task unread source of truth", () => {
  it("重启后 store 尚未水合时回退读取列表 task 的 unreadAt", () => {
    const workspaceState = getDefaultWorkspaceState();
    const persistedTask = createTaskMeta({ unreadAt: 100 });

    expect(getTaskUnreadIndicator(workspaceState, persistedTask.taskId, persistedTask)).toBe(true);
  });

  it("已有 optimistic task 时不让旧列表 unreadAt 覆盖已读状态", () => {
    const persistedTask = createTaskMeta({ unreadAt: 100 });
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      optimisticTaskListByTaskId: {
        [persistedTask.taskId]: createTaskMeta({ unreadAt: undefined }),
      },
    };

    expect(getTaskUnreadIndicator(workspaceState, persistedTask.taskId, persistedTask)).toBe(false);
  });

  it("优先读取 optimistic task meta 里的 unreadAt", () => {
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      taskListCache: [
        createTaskMeta({
          taskId: "task-1",
          unreadAt: 100,
        }),
      ],
      optimisticTaskListByTaskId: {
        "task-1": createTaskMeta({
          taskId: "task-1",
          unreadAt: undefined,
        }),
      },
      taskUnreadByTaskId: {},
    };

    expect(getTaskMeta(workspaceState, "task-1")?.unreadAt).toBeUndefined();
    expect(getTaskUnreadIndicator(workspaceState, "task-1")).toBe(false);
  });

  it("dock badge 统计基于可见 task meta，而不是旧 unread map", () => {
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      taskListCache: [
        createTaskMeta({
          taskId: "task-1",
          unreadAt: 100,
        }),
        createTaskMeta({
          taskId: "task-2",
        }),
      ],
      optimisticTaskListByTaskId: {
        "task-2": createTaskMeta({
          taskId: "task-2",
          unreadAt: 200,
        }),
      },
      taskUnreadByTaskId: {
        stale: true,
      },
    };

    expect(countWorkspaceUnreadTasks(workspaceState)).toBe(2);
  });
});
