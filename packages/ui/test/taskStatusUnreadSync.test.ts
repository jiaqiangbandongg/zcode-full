import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  resetTaskStatusUnreadSyncForTest,
  shouldMarkStatusEventTaskUnread,
  syncTaskUnreadFromStatusWorkspaceEvent,
} from "@/lib/taskStatusUnreadSync.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
} from "@/lib/taskQueryCache.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task 1",
    workspacePath: "/repo/demo",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function createStatusEvent(
  taskMeta: ZCodeTaskMeta,
  overrides: Partial<ZCodeWorkspaceTaskListChanged> = {},
): ZCodeWorkspaceTaskListChanged {
  return {
    type: "workspace_task_list_changed",
    workspacePath: taskMeta.workspacePath,
    workspaceIdentity: taskMeta.workspaceIdentity,
    taskId: taskMeta.taskId,
    reason: "task_status_changed",
    taskMeta,
    unreadSignal: "background_terminal",
    ...overrides,
  };
}

function createService() {
  return {
    setTaskUnread: vi.fn(
      async (params: {
        taskId: string;
        workspacePath: string;
        workspaceIdentity?: string;
        unread: boolean;
      }) =>
        createTaskMeta({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          unreadAt: params.unread ? 123 : undefined,
        }),
    ),
  };
}

function seedQueryTask(task: ZCodeTaskMeta): string {
  const descriptor = buildTaskListCacheDescriptor({
    kind: "workspace",
    workspaceScopes: [
      {
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity,
      },
    ],
    sortBy: "updated",
    expanded: true,
  });
  const queryKey = buildTaskListCacheKeyFromDescriptor(descriptor);
  useTaskQueryCacheStore.getState().setQueryResult({
    queryKey,
    descriptor,
    items: [task],
    total: 1,
    hasMore: false,
  });
  return queryKey;
}

function getQueryTask(task: ZCodeTaskMeta): ZCodeTaskMeta | undefined {
  return useTaskQueryCacheStore.getState().taskMetaByEntityKey[buildTaskEntityKey(task)];
}

function syncStatusEvent(
  params: Omit<Parameters<typeof syncTaskUnreadFromStatusWorkspaceEvent>[0], "activeWorkspace"> & {
    activeWorkspace?: { workspacePath: string; workspaceIdentity?: string };
  },
): void {
  syncTaskUnreadFromStatusWorkspaceEvent({
    ...params,
    activeWorkspace: params.activeWorkspace ?? {
      workspacePath: params.event.workspacePath,
      ...(params.event.workspaceIdentity
        ? { workspaceIdentity: params.event.workspaceIdentity }
        : {}),
    },
  });
}

describe("task status unread sync", () => {
  afterEach(() => {
    resetTaskStatusUnreadSyncForTest();
    useZCodeSessionStore.setState({ workspaces: {} });
    useTaskQueryCacheStore.getState().clearAll();
  });

  it("inactive terminal status event marks the query row unread before persistence settles", async () => {
    const task = createTaskMeta({ status: "completed" });
    const service = createService();
    const store = useZCodeSessionStore.getState();
    seedQueryTask(task);
    store.setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({
      event: createStatusEvent(task),
      service,
    });

    expect(service.setTaskUnread).toHaveBeenCalledWith({
      taskId: "task-1",
      workspacePath: "/repo/demo",
      unread: true,
    });
    expect(getQueryTask(task)?.unreadAt).toEqual(expect.any(Number));
    expect(
      getTaskUnreadIndicator(
        useZCodeSessionStore.getState().getWorkspaceState("/repo/demo"),
        "task-1",
      ),
    ).toBe(true);

    await vi.waitFor(() => expect(getQueryTask(task)?.unreadAt).toBe(123));
    expect(
      useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[buildTaskEntityKey(task)],
    ).toBe(123);

    seedQueryTask({ ...task, unreadAt: 123 });
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
  });

  it("keeps the unread overlay when an older membership result arrives in flight", async () => {
    const task = createTaskMeta({ status: "completed" });
    let resolvePersistence!: (taskMeta: ZCodeTaskMeta) => void;
    const service = {
      setTaskUnread: vi.fn(
        () =>
          new Promise<ZCodeTaskMeta>((resolve) => {
            resolvePersistence = resolve;
          }),
      ),
    };
    const queryKey = seedQueryTask(task);
    const descriptor = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey]!.descriptor;
    useZCodeSessionStore.getState().setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({ event: createStatusEvent(task), service });
    const optimisticUnreadAt = getQueryTask(task)?.unreadAt;

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });

    expect(optimisticUnreadAt).toEqual(expect.any(Number));
    expect(getQueryTask(task)?.unreadAt).toBe(optimisticUnreadAt);

    resolvePersistence(createTaskMeta({ status: "completed", unreadAt: 456 }));
    await vi.waitFor(() => expect(getQueryTask(task)?.unreadAt).toBe(456));

    // RPC 已成功后，更早发出的 membership 请求仍可能迟到，不能盖掉服务端确认值。
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    expect(getQueryTask(task)?.unreadAt).toBe(456);

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [{ ...task, unreadAt: 456 }],
      total: 1,
      hasMore: false,
    });
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
  });

  it("stores the overlay before a newly created task row is published", async () => {
    const task = createTaskMeta({ status: "completed" });
    let resolvePersistence!: (taskMeta: ZCodeTaskMeta) => void;
    const service = {
      setTaskUnread: vi.fn(
        () =>
          new Promise<ZCodeTaskMeta>((resolve) => {
            resolvePersistence = resolve;
          }),
      ),
    };
    useZCodeSessionStore.getState().setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({ event: createStatusEvent(task), service });

    const taskEntityKey = buildTaskEntityKey(task);
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[taskEntityKey]).toEqual(
      expect.any(Number),
    );
    resolvePersistence(createTaskMeta({ status: "completed", unreadAt: 789 }));
    await vi.waitFor(() =>
      expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[taskEntityKey]).toBe(
        789,
      ),
    );

    seedQueryTask(task);
    expect(getQueryTask(task)?.unreadAt).toBe(789);
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[taskEntityKey]).toBe(789);

    seedQueryTask({ ...task, unreadAt: 789 });
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
  });

  it("active terminal status event stays read", () => {
    const task = createTaskMeta({ status: "completed" });
    const service = createService();
    const store = useZCodeSessionStore.getState();
    seedQueryTask(task);
    store.setActiveTaskId("/repo/demo", "task-1");

    syncStatusEvent({
      event: createStatusEvent(task),
      service,
    });

    expect(service.setTaskUnread).not.toHaveBeenCalled();
    expect(getQueryTask(task)?.unreadAt).toBeUndefined();
    expect(
      getTaskUnreadIndicator(
        useZCodeSessionStore.getState().getWorkspaceState("/repo/demo"),
        "task-1",
      ),
    ).toBe(false);
  });

  it("marks the previous workspace task unread after the user switches workspaces", async () => {
    const task = createTaskMeta({ status: "completed" });
    const service = createService();
    seedQueryTask(task);
    // 切换 workspace 不会清掉旧 workspace 保存的 activeTaskId；全局焦点已经离开时，
    // 这个 task 的终态仍应被视为后台完成。
    useZCodeSessionStore.getState().setActiveTaskId("/repo/demo", task.taskId);

    syncStatusEvent({
      event: createStatusEvent(task),
      service,
      activeWorkspace: { workspacePath: "/repo/other" },
    });

    expect(service.setTaskUnread).toHaveBeenCalledWith({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      unread: true,
    });
    await vi.waitFor(() => expect(getQueryTask(task)?.unreadAt).toBe(123));
  });

  it("ignores running status events", () => {
    expect(
      shouldMarkStatusEventTaskUnread({
        activeTaskId: "other-task",
        activeWorkspace: { workspacePath: "/repo/demo" },
        event: createStatusEvent(createTaskMeta({ status: "running" })),
      }),
    ).toBe(false);
  });

  it("ignores terminal status refreshes without an explicit unread signal", () => {
    const task = createTaskMeta({ status: "completed" });
    const service = createService();
    seedQueryTask(task);
    useZCodeSessionStore.getState().setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({
      event: createStatusEvent(task, { unreadSignal: undefined }),
      service,
    });

    expect(service.setTaskUnread).not.toHaveBeenCalled();
    expect(getQueryTask(task)?.unreadAt).toBeUndefined();
  });

  it("dedupes duplicated status events from multiple sidebar subscriptions", () => {
    const task = createTaskMeta({ status: "error", updatedAt: 9 });
    const event = createStatusEvent(task);
    const service = createService();
    const store = useZCodeSessionStore.getState();
    seedQueryTask(task);
    store.setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({ event, service });
    syncStatusEvent({ event, service });

    expect(service.setTaskUnread).toHaveBeenCalledTimes(1);
  });

  it("rolls back query and legacy unread state when persistence fails", async () => {
    const task = createTaskMeta({ status: "completed" });
    const queryKey = seedQueryTask(task);
    const service = {
      setTaskUnread: vi.fn(async () => {
        throw new Error("write failed");
      }),
    };
    useZCodeSessionStore.getState().setActiveTaskId("/repo/demo", "other-task");

    syncStatusEvent({ event: createStatusEvent(task), service });
    expect(getQueryTask(task)?.unreadAt).toEqual(expect.any(Number));

    await vi.waitFor(() => {
      expect(getQueryTask(task)?.unreadAt).toBeUndefined();
      expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
      expect(useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey]?.stale).toBe(true);
      expect(
        getTaskUnreadIndicator(
          useZCodeSessionStore.getState().getWorkspaceState("/repo/demo"),
          task.taskId,
        ),
      ).toBe(false);
    });
  });

  it("isolates unread overlays by workspace identity", async () => {
    const firstTask = createTaskMeta({
      workspaceIdentity: "ssh://host-a/repo",
      status: "completed",
    });
    const siblingTask = createTaskMeta({
      workspaceIdentity: "ssh://host-b/repo",
      status: "completed",
    });
    seedQueryTask(firstTask);
    seedQueryTask(siblingTask);
    const service = createService();
    useZCodeSessionStore
      .getState()
      .setActiveTaskId(firstTask.workspacePath, "other-task", firstTask.workspaceIdentity);

    syncStatusEvent({
      event: createStatusEvent(firstTask),
      service,
    });

    expect(getQueryTask(firstTask)?.unreadAt).toEqual(expect.any(Number));
    expect(getQueryTask(siblingTask)?.unreadAt).toBeUndefined();
    expect(service.setTaskUnread).toHaveBeenCalledWith({
      taskId: firstTask.taskId,
      workspacePath: firstTask.workspacePath,
      workspaceIdentity: firstTask.workspaceIdentity,
      unread: true,
    });
    await vi.waitFor(() => expect(getQueryTask(firstTask)?.unreadAt).toBe(123));
  });
});
