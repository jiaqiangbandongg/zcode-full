import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { subscribeTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

const WORKSPACE_PATH = "/repo/app";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: "task-default",
    traceId: "trace-default",
    title: "默认任务",
    workspacePath: WORKSPACE_PATH,
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function createDescriptor(params: {
  kind: "workspace" | "pinned" | "archived" | "timeline" | "active";
  visibleLimit?: number | null;
  search?: string;
}) {
  return buildTaskListCacheDescriptor({
    kind: params.kind,
    workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
    sortBy: "updated",
    search: params.search,
    expanded: params.visibleLimit === null,
    visibleLimit: params.visibleLimit,
  });
}

function taskIdsFor(queryKey: string): string[] {
  const state = useTaskQueryCacheStore.getState();
  const result = state.resultsByQueryKey[queryKey];
  if (!result) {
    return [];
  }
  return result.taskKeys.map((taskKey) => state.taskMetaByEntityKey[taskKey]?.taskId ?? "");
}

afterEach(() => {
  useTaskQueryCacheStore.getState().clearAll();
});

describe("taskQueryCache key", () => {
  it("区分折叠列表的不同可见数量", () => {
    const firstPageKey = buildTaskListCacheKeyFromDescriptor(
      createDescriptor({ kind: "timeline", visibleLimit: 20 }),
    );
    const expandedPageKey = buildTaskListCacheKeyFromDescriptor(
      createDescriptor({ kind: "timeline", visibleLimit: 40 }),
    );

    expect(firstPageKey).not.toBe(expandedPageKey);
    expect(expandedPageKey).toContain("limit=40");
  });
});

describe("taskQueryCacheStore clearAll", () => {
  it("清空 query result 和 task meta", () => {
    const queryKey = "workspace-clear-all";
    const task = createTaskMeta({ taskId: "task-clear-all", updatedAt: 10 });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [task],
      total: 1,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().clearAll();

    expect(useTaskQueryCacheStore.getState().resultsByQueryKey).toEqual({});
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey).toEqual({});
  });
});

describe("taskQueryCacheStore invalidation generation", () => {
  it("连续失效会递增代次，并拒绝旧异步结果清除 stale", () => {
    const queryKey = "workspace-invalidation-generation";
    const descriptor = createDescriptor({ kind: "workspace", visibleLimit: null });
    const completed = createTaskMeta({
      taskId: "task-generation",
      title: "completed",
      status: "completed",
      updatedAt: 10,
    });
    const staleRunning = createTaskMeta({
      taskId: "task-generation",
      title: "stale-running",
      status: "running",
      updatedAt: 20,
    });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [completed],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().markWorkspaceKeysStale([WORKSPACE_PATH]);
    useTaskQueryCacheStore.getState().markWorkspaceKeysStale([WORKSPACE_PATH]);

    const invalidated = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
    expect(invalidated?.stale).toBe(true);
    expect(invalidated?.invalidationVersion).toBe(2);

    useTaskQueryCacheStore.getState().setQueryResults([
      {
        queryKey,
        descriptor,
        items: [staleRunning],
        total: 1,
        hasMore: false,
        expectedInvalidationVersion: 0,
      },
    ]);

    const afterStaleResponse = useTaskQueryCacheStore.getState();
    expect(afterStaleResponse.resultsByQueryKey[queryKey]?.stale).toBe(true);
    expect(afterStaleResponse.resultsByQueryKey[queryKey]?.invalidationVersion).toBe(2);
    expect(taskIdsFor(queryKey)).toEqual(["task-generation"]);
    expect(
      afterStaleResponse.taskMetaByEntityKey[`${WORKSPACE_PATH}::task-generation`]?.title,
    ).toBe("completed");

    useTaskQueryCacheStore.getState().setQueryResults([
      {
        queryKey,
        descriptor,
        items: [staleRunning],
        total: 1,
        hasMore: false,
        expectedInvalidationVersion: 2,
      },
    ]);

    const resolved = useTaskQueryCacheStore.getState();
    expect(resolved.resultsByQueryKey[queryKey]?.stale).toBe(false);
    expect(resolved.resultsByQueryKey[queryKey]?.invalidationVersion).toBe(2);
    expect(resolved.taskMetaByEntityKey[`${WORKSPACE_PATH}::task-generation`]?.title).toBe(
      "stale-running",
    );
  });
});

describe("task lifecycle events", () => {
  it("归档和删除时发布父任务生命周期事件", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskLifecycle(listener);
    const task = createTaskMeta({ taskId: "task-lifecycle" });

    applyTaskQueryCacheMutation({
      previousTask: task,
      nextTask: task,
      previousState: { pinned: false, archived: false },
      nextState: { pinned: false, archived: true },
    });
    removeTaskFromTaskQueryCaches(task);
    unsubscribe();

    expect(listener).toHaveBeenNthCalledWith(1, {
      type: "archived",
      taskId: task.taskId,
      workspaceKey: WORKSPACE_PATH,
    });
    expect(listener).toHaveBeenNthCalledWith(2, {
      type: "deleted",
      taskId: task.taskId,
      workspaceKey: WORKSPACE_PATH,
    });
  });
});

describe("taskQueryCacheStore sessions activity", () => {
  it("搜索结果更新 meta 时保留已缓存的 sessions-index activity", () => {
    const task = attachTaskListRowActivity(
      createTaskMeta({ taskId: "search-running", updatedAt: 10 }),
      { phase: "running", lastActivityAt: 10, hasBackgroundWork: false },
    );
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "workspace-before-search",
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [task],
      total: 1,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "workspace-search",
      descriptor: createDescriptor({
        kind: "workspace",
        visibleLimit: null,
        search: "running",
      }),
      items: [
        {
          ...createTaskMeta({
            taskId: "search-running",
            title: "running result",
            updatedAt: 99,
          }),
          searchSnippet: "matched body",
        },
      ],
      total: 1,
      hasMore: false,
    });

    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::search-running`;
    const cached = useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey];
    expect(cached?.title).toBe("running result");
    expect(cached?.updatedAt).toBe(10);
    expect(cached ? getTaskListRowActivity(cached)?.phase : null).toBe("running");
  });
});

describe("taskQueryCacheStore applyTaskMutation", () => {
  it("更新 membership/meta 但不使用 tasks-index updatedAt 重排 activity", () => {
    const queryKey = "workspace-updated";
    const olderTask = attachTaskListRowActivity(
      createTaskMeta({ taskId: "older", updatedAt: 10 }),
      {
        phase: "completedSuccess",
        lastActivityAt: 10,
        hasBackgroundWork: false,
      },
    );
    const targetTask = attachTaskListRowActivity(
      createTaskMeta({ taskId: "target", updatedAt: 5 }),
      {
        phase: "completedSuccess",
        lastActivityAt: 5,
        hasBackgroundWork: false,
      },
    );
    const updatedTargetTask = {
      ...targetTask,
      title: "更新后的任务",
      updatedAt: 30,
    };

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [olderTask, targetTask],
      total: 2,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().applyTaskMutation({
      previousTask: targetTask,
      nextTask: updatedTargetTask,
      previousState: { pinned: false, archived: false },
      nextState: { pinned: false, archived: false },
    });

    const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
    const targetEntityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::target`;

    expect(taskIdsFor(queryKey)).toEqual(["older", "target"]);
    expect(result?.total).toBe(2);
    expect(result?.hasMore).toBe(false);
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[targetEntityKey]?.title).toBe(
      "更新后的任务",
    );
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[targetEntityKey]?.updatedAt).toBe(
      5,
    );
    expect(
      getTaskListRowActivity(
        useTaskQueryCacheStore.getState().taskMetaByEntityKey[targetEntityKey]!,
      )?.phase,
    ).toBe("completedSuccess");
  });

  it("未读乐观 overlay 会挡住在途的旧 membership 回包", () => {
    const queryKey = "workspace-unread-overlay";
    const descriptor = createDescriptor({
      kind: "workspace",
      visibleLimit: null,
    });
    const unreadTask = attachTaskListRowActivity(
      createTaskMeta({ taskId: "unread", unreadAt: 100, updatedAt: 10 }),
      {
        phase: "completedSuccess",
        lastActivityAt: 10,
        hasBackgroundWork: false,
      },
    );
    const target = {
      taskId: unreadTask.taskId,
      workspacePath: unreadTask.workspacePath,
    };

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [unreadTask],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setTaskUnreadOverlay(target, undefined);

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [unreadTask],
      total: 1,
      hasMore: false,
    });

    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::unread`;
    expect(
      useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.unreadAt,
    ).toBeUndefined();

    useTaskQueryCacheStore.getState().reconcileTaskUnread(target, undefined);
    expect(
      useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.unreadAt,
    ).toBeUndefined();
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[entityKey]).toBeNull();

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [{ ...unreadTask, unreadAt: undefined }],
      total: 1,
      hasMore: false,
    });
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
  });

  it("服务端确认未读后继续阻挡迟到旧回包，直到 membership 发布同值", () => {
    const queryKey = "workspace-unread-confirmed-overlay";
    const descriptor = createDescriptor({ kind: "workspace", visibleLimit: null });
    const task = createTaskMeta({ taskId: "confirmed-unread", updatedAt: 10 });
    const target = { taskId: task.taskId, workspacePath: task.workspacePath };
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::confirmed-unread`;

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setTaskUnreadOverlay(target, 50);
    useTaskQueryCacheStore.getState().reconcileTaskUnread(target, 100);

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.unreadAt).toBe(100);
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey[entityKey]).toBe(100);

    useTaskQueryCacheStore.getState().setQueryResults([
      {
        queryKey,
        descriptor,
        items: [{ ...task, unreadAt: 100 }],
        total: 1,
        hasMore: false,
      },
    ]);
    expect(useTaskQueryCacheStore.getState().taskUnreadOverlayByEntityKey).toEqual({});
  });

  it("任务从 workspace 列表移动到 pinned 列表时同步更新两个缓存", () => {
    const workspaceQueryKey = "workspace-list";
    const pinnedQueryKey = "pinned-list";
    const task = createTaskMeta({ taskId: "task-to-pin", updatedAt: 10 });
    const pinnedTask = { ...task, pinned: true };

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: workspaceQueryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [task],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: pinnedQueryKey,
      descriptor: createDescriptor({ kind: "pinned", visibleLimit: null }),
      items: [],
      total: 0,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().applyTaskMutation({
      previousTask: task,
      nextTask: pinnedTask,
      previousState: { pinned: false, archived: false },
      nextState: { pinned: true, archived: false },
    });

    expect(taskIdsFor(workspaceQueryKey)).toEqual([]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey[workspaceQueryKey]?.total).toBe(0);
    expect(taskIdsFor(pinnedQueryKey)).toEqual(["task-to-pin"]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey[pinnedQueryKey]?.total).toBe(1);
  });

  it("只更新任务元数据时保留原有 pinned 列表成员关系", () => {
    const workspaceQueryKey = "workspace-list";
    const pinnedQueryKey = "pinned-list";
    const pinnedTask = createTaskMeta({
      taskId: "active-pinned",
      title: "置顶任务",
      updatedAt: 10,
    });
    const updatedPinnedTask = {
      ...pinnedTask,
      title: "置顶任务有新回复",
      updatedAt: 30,
    };

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: workspaceQueryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [],
      total: 0,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: pinnedQueryKey,
      descriptor: createDescriptor({ kind: "pinned", visibleLimit: null }),
      items: [pinnedTask],
      total: 1,
      hasMore: false,
    });

    updateTaskQueryCacheTaskMetaPreservingMembership(updatedPinnedTask);

    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::active-pinned`;

    expect(taskIdsFor(pinnedQueryKey)).toEqual(["active-pinned"]);
    expect(taskIdsFor(workspaceQueryKey)).toEqual([]);
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.title).toBe(
      "置顶任务有新回复",
    );
  });

  it("任务进入折叠列表时按排序进入可见区，并标记后台刷新补齐截断结果", () => {
    const queryKey = "collapsed-pinned-list";
    const visiblePinnedTask = createTaskMeta({
      taskId: "visible-pinned",
      updatedAt: 20,
    });
    const task = createTaskMeta({ taskId: "newly-pinned", updatedAt: 30 });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor: createDescriptor({ kind: "pinned", visibleLimit: 1 }),
      items: [visiblePinnedTask],
      total: 1,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().applyTaskMutation({
      previousTask: task,
      nextTask: { ...task, pinned: true },
      previousState: { pinned: false, archived: false },
      nextState: { pinned: true, archived: false },
    });

    const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];

    expect(taskIdsFor(queryKey)).toEqual(["newly-pinned"]);
    expect(result?.total).toBe(2);
    expect(result?.hasMore).toBe(true);
    expect(result?.stale).toBe(true);
  });

  it("带搜索词的列表变更时只标记 stale，避免用标题规则误删正文命中结果", () => {
    const queryKey = "content-search-list";
    const task = createTaskMeta({
      taskId: "content-hit",
      title: "标题不包含关键词",
      updatedAt: 10,
    });
    const updatedTask = {
      ...task,
      updatedAt: 20,
    };

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor: createDescriptor({
        kind: "workspace",
        visibleLimit: null,
        search: "body-keyword",
      }),
      items: [task],
      total: 1,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().applyTaskMutation({
      previousTask: task,
      nextTask: updatedTask,
      previousState: { pinned: false, archived: false },
      nextState: { pinned: false, archived: false },
    });

    const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];

    expect(taskIdsFor(queryKey)).toEqual(["content-hit"]);
    expect(result?.total).toBe(1);
    expect(result?.stale).toBe(true);
  });

  it("普通列表刷新不会抹掉搜索结果项上的正文摘要", () => {
    const searchQueryKey = "content-search-result";
    const workspaceQueryKey = "workspace-result";
    const task = createTaskMeta({
      taskId: "content-hit",
      title: "标题不包含关键词",
      updatedAt: 10,
    });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: searchQueryKey,
      descriptor: createDescriptor({
        kind: "workspace",
        visibleLimit: null,
        search: "body-keyword",
      }),
      items: [{ ...task, searchSnippet: "这里命中了 body-keyword" }],
      total: 1,
      hasMore: false,
    });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: workspaceQueryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [task],
      total: 1,
      hasMore: false,
    });

    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::content-hit`;

    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.searchSnippet).toBe(
      "这里命中了 body-keyword",
    );
    expect(
      useTaskQueryCacheStore.getState().resultsByQueryKey[searchQueryKey]
        ?.searchSnippetsByTaskKey?.[entityKey],
    ).toBe("这里命中了 body-keyword");
  });

  it("旧 sqlite 刷新不会把刚本地插入的新任务从可见缓存抹掉", () => {
    const queryKey = "workspace-first-send-race";
    const descriptor = createDescriptor({ kind: "workspace", visibleLimit: 2 });
    const olderTask = createTaskMeta({ taskId: "older", updatedAt: 20 });
    const anotherTask = createTaskMeta({ taskId: "another", updatedAt: 10 });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [olderTask, anotherTask],
      total: 2,
      hasMore: false,
    });

    const previousFetchedAt =
      useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey]?.fetchedAt ?? Date.now();
    const newTask = createTaskMeta({
      taskId: "new-first-send",
      title: "首发问题",
      updatedAt: previousFetchedAt + 10,
    });

    useTaskQueryCacheStore.getState().applyTaskMutation({
      previousTask: newTask,
      nextTask: newTask,
      previousState: { pinned: true, archived: true },
      nextState: { pinned: false, archived: false },
    });

    useTaskQueryCacheStore.getState().setQueryResults([
      {
        queryKey,
        descriptor,
        // 模拟 sqlite 同步慢半拍，刷新结果仍然只返回旧任务。
        items: [olderTask, anotherTask],
        total: 2,
        hasMore: false,
      },
    ]);

    const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::new-first-send`;

    expect(taskIdsFor(queryKey)).toEqual(["new-first-send", "older"]);
    expect(result?.total).toBe(3);
    expect(result?.hasMore).toBe(true);
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.title).toBe(
      "首发问题",
    );
  });
});

describe("taskQueryCacheStore removeTask", () => {
  it("从所有命中的 query cache 中移除目标 task 并更新 total", () => {
    const workspaceQueryKey = "workspace-delete";
    const archivedQueryKey = "archived-delete";
    const targetTask = createTaskMeta({ taskId: "delete-me", updatedAt: 20 });
    const otherTask = createTaskMeta({ taskId: "keep-me", updatedAt: 10 });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: workspaceQueryKey,
      descriptor: createDescriptor({ kind: "workspace", visibleLimit: null }),
      items: [targetTask, otherTask],
      total: 2,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: archivedQueryKey,
      descriptor: createDescriptor({ kind: "archived", visibleLimit: null }),
      items: [targetTask],
      total: 1,
      hasMore: false,
    });

    const removed = useTaskQueryCacheStore.getState().removeTask({
      workspacePath: WORKSPACE_PATH,
      taskId: "delete-me",
    });

    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::delete-me`;

    expect(removed).toBe(true);
    expect(taskIdsFor(workspaceQueryKey)).toEqual(["keep-me"]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey[workspaceQueryKey]?.total).toBe(1);
    expect(taskIdsFor(archivedQueryKey)).toEqual([]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey[archivedQueryKey]?.total).toBe(0);
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]).toBeUndefined();
  });

  it("删除隐藏项未命中可见缓存时返回 false，等待调用方刷新事实源", () => {
    const queryKey = "active-delete-hidden";
    const visibleTask = createTaskMeta({
      taskId: "visible-task",
      updatedAt: 20,
    });

    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor: createDescriptor({ kind: "active", visibleLimit: 1 }),
      items: [visibleTask],
      total: 2,
      hasMore: true,
    });

    const removed = useTaskQueryCacheStore.getState().removeTask({
      workspacePath: WORKSPACE_PATH,
      taskId: "hidden-task",
    });

    const result = useTaskQueryCacheStore.getState().resultsByQueryKey[queryKey];

    expect(removed).toBe(false);
    expect(taskIdsFor(queryKey)).toEqual(["visible-task"]);
    expect(result?.total).toBe(2);
    expect(result?.hasMore).toBe(true);
  });
});
