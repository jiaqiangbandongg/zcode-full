import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeWorkspaceTaskListItemsWithOptimistic } from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import {
  buildWorkspaceRemoteSessionSignature,
  buildWorkspaceTaskListVersionSignature,
} from "@/hooks/workspaceTaskListRefreshSignatures.js";

function createTask(
  taskId: string,
  updatedAt: number,
  patch: Partial<ZCodeTaskMeta> = {},
): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/tmp/workspace",
    createdAt: updatedAt,
    updatedAt,
    mode: "default",
    provider: "glm",
    ...patch,
  };
}

function createSessionTask(
  taskId: string,
  lastActivityAt: number,
  patch: Partial<ZCodeTaskMeta> = {},
): ZCodeTaskMeta {
  return attachTaskListRowActivity(createTask(taskId, lastActivityAt, patch), {
    phase: "completedSuccess",
    lastActivityAt,
    hasBackgroundWork: false,
  });
}

describe("mergeWorkspaceTaskListItemsWithOptimistic", () => {
  it("updates the first-send title without replacing sessions-index activity order", () => {
    const queryItems = [
      createSessionTask("task-1", 300),
      createSessionTask("task-2", 200),
      createSessionTask("task-3", 100, { title: "New session" }),
    ];
    const optimisticTask = createTask("task-3", 400, { title: "hello" });

    expect(
      mergeWorkspaceTaskListItemsWithOptimistic({
        items: queryItems,
        optimisticTasks: [optimisticTask],
        activeTaskId: "task-3",
        sortBy: "updated",
        visibleLimit: 3,
      }).map((task) => [task.taskId, task.title]),
    ).toEqual([
      ["task-1", "task-1"],
      ["task-2", "task-2"],
      ["task-3", "hello"],
    ]);
  });

  it("adds a missing optimistic active task but ignores unrelated missing tasks", () => {
    const queryItems = [createTask("task-1", 300), createTask("task-2", 200)];

    expect(
      mergeWorkspaceTaskListItemsWithOptimistic({
        items: queryItems,
        optimisticTasks: [createTask("task-3", 400), createTask("task-archived-elsewhere", 500)],
        activeTaskId: "task-3",
        sortBy: "updated",
        visibleLimit: 3,
      }).map((task) => task.taskId),
    ).toEqual(["task-3", "task-1", "task-2"]);
  });

  it("keeps sessions-index updatedAt when optimistic metadata is newer", () => {
    const queryItems = [
      createSessionTask("task-1", 300),
      createSessionTask("task-2", 200),
      createSessionTask("task-3", 100, { title: "New session" }),
    ];
    const optimisticTask = createTask("task-3", 400, { title: "first prompt" });

    const merged = mergeWorkspaceTaskListItemsWithOptimistic({
      items: queryItems,
      optimisticTasks: [optimisticTask],
      activeTaskId: "task-1",
      sortBy: "updated",
      visibleLimit: 3,
    });

    expect(merged.map((task) => [task.taskId, task.title, task.updatedAt])).toEqual([
      ["task-1", "task-1", 300],
      ["task-2", "task-2", 200],
      ["task-3", "first prompt", 100],
    ]);
  });

  it.each([
    {
      name: "已读 overlay 不被旧 optimistic 未读盖回",
      queryUnreadAt: undefined,
      optimisticUnreadAt: 123,
      expectedUnreadAt: undefined,
    },
    {
      name: "持久化失败 rollback 不被 optimistic 已读盖掉",
      queryUnreadAt: 123,
      optimisticUnreadAt: undefined,
      expectedUnreadAt: 123,
    },
  ])(
    "keeps query membership authoritative: $name",
    ({ queryUnreadAt, optimisticUnreadAt, expectedUnreadAt }) => {
      const merged = mergeWorkspaceTaskListItemsWithOptimistic({
        items: [createSessionTask("task-1", 300, { unreadAt: queryUnreadAt })],
        optimisticTasks: [createTask("task-1", 400, { unreadAt: optimisticUnreadAt })],
        activeTaskId: "task-1",
        sortBy: "updated",
        visibleLimit: 3,
      });

      expect(merged[0]?.unreadAt).toBe(expectedUnreadAt);
    },
  );

  it("optimistic overlay 后仍保持 running 的 createdAt 层内顺序", () => {
    const parent = attachTaskListRowActivity(createTask("parent", 1_000, { createdAt: 10 }), {
      phase: "running",
      lastActivityAt: 1_000,
      hasBackgroundWork: false,
    });
    const fork = attachTaskListRowActivity(createTask("fork", 1, { createdAt: 20 }), {
      phase: "running",
      lastActivityAt: 1,
      hasBackgroundWork: false,
    });
    const completed = createSessionTask("completed", 2_000, { createdAt: 30 });

    const merged = mergeWorkspaceTaskListItemsWithOptimistic({
      items: [parent, fork, completed],
      optimisticTasks: [],
      activeTaskId: "parent",
      sortBy: "updated",
      visibleLimit: 3,
    });

    expect(merged.map((task) => task.taskId)).toEqual(["fork", "parent", "completed"]);
  });
});

describe("workspace task list refresh signatures", () => {
  it("keeps task list version signatures stable when workspaces are reordered", () => {
    const original = buildWorkspaceTaskListVersionSignature([
      ["/tmp/a", 1],
      ["ssh://host/tmp/b", 3],
      ["/tmp/c", 2],
    ]);
    const reordered = buildWorkspaceTaskListVersionSignature([
      ["/tmp/c", 2],
      ["/tmp/a", 1],
      ["ssh://host/tmp/b", 3],
    ]);

    expect(reordered).toBe(original);
  });

  it("keeps remote session signatures order-independent but sensitive to readiness", () => {
    const original = buildWorkspaceRemoteSessionSignature([
      { workspaceKey: "/tmp/a", ready: true },
      { workspaceKey: "ssh://host/tmp/b", remoteSessionId: "remote-1", ready: false },
    ]);
    const reordered = buildWorkspaceRemoteSessionSignature([
      { workspaceKey: "ssh://host/tmp/b", remoteSessionId: "remote-1", ready: false },
      { workspaceKey: "/tmp/a", ready: true },
    ]);
    const connected = buildWorkspaceRemoteSessionSignature([
      { workspaceKey: "/tmp/a", ready: true },
      { workspaceKey: "ssh://host/tmp/b", remoteSessionId: "remote-1", ready: true },
    ]);

    expect(reordered).toBe(original);
    expect(connected).not.toBe(original);
  });
});
