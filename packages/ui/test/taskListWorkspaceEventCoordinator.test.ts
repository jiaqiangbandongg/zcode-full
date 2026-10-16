import { afterEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  clearTaskListWorkspaceEventCoordinatorForTest,
  handleTaskListWorkspaceEventCacheSync,
} from "@/lib/taskListWorkspaceEventCoordinator.js";
import {
  buildTaskListCacheDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

const WORKSPACE_PATH = "/repo/event-coordinator";

function createTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-1",
    title: "Task 1",
    traceId: "trace-1",
    updatedAt: 2,
    workspacePath: WORKSPACE_PATH,
    ...overrides,
  };
}

function createDescriptor(kind: "active" | "archived" | "pinned") {
  return buildTaskListCacheDescriptor({
    kind,
    workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
    sortBy: "updated",
    expanded: true,
  });
}

function taskIdsFor(queryKey: string): string[] {
  const cacheState = useTaskQueryCacheStore.getState();
  const result = cacheState.resultsByQueryKey[queryKey];
  return result?.taskKeys.map((taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId ?? "") ?? [];
}

function createDeleteEvent(taskId: string): ZCodeWorkspaceTaskListChanged {
  return {
    reason: "task_deleted",
    taskId,
    type: "workspace_task_list_changed",
    workspacePath: WORKSPACE_PATH,
  };
}

function titleFor(taskId: string): string | undefined {
  const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${taskId}`;
  return useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.title;
}

afterEach(() => {
  clearTaskListWorkspaceEventCoordinatorForTest();
  useTaskQueryCacheStore.getState().clearAll();
  useZCodeSessionStore.setState({ workspaces: {} });
});

describe("taskListWorkspaceEventCoordinator", () => {
  it("同一个 visible 删除广播只按 mutation 前状态决策一次，后续订阅者不触发刷新", () => {
    const task = createTask({ taskId: "delete-visible" });
    useTaskQueryCacheStore.getState().setQueryResult({
      descriptor: createDescriptor("archived"),
      hasMore: false,
      items: [task],
      queryKey: "archived-visible-delete",
      total: 1,
    });

    const first = handleTaskListWorkspaceEventCacheSync(createDeleteEvent("delete-visible"));
    const second = handleTaskListWorkspaceEventCacheSync(createDeleteEvent("delete-visible"));

    expect(first).toEqual({
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    });
    expect(second).toEqual({
      handledIncrementally: true,
      reused: true,
      shouldRefresh: false,
    });
    expect(taskIdsFor("archived-visible-delete")).toEqual([]);
    expect(
      useTaskQueryCacheStore.getState().resultsByQueryKey["archived-visible-delete"]?.total,
    ).toBe(0);
  });

  it("隐藏删除项未命中可见缓存时复用同一个刷新决策", () => {
    const visibleTask = createTask({ taskId: "visible-task" });
    useTaskQueryCacheStore.getState().setQueryResult({
      descriptor: createDescriptor("active"),
      hasMore: true,
      items: [visibleTask],
      queryKey: "active-hidden-delete",
      total: 2,
    });

    const first = handleTaskListWorkspaceEventCacheSync(createDeleteEvent("hidden-task"));
    const second = handleTaskListWorkspaceEventCacheSync(createDeleteEvent("hidden-task"));

    expect(first).toEqual({
      handledIncrementally: false,
      reused: false,
      shouldRefresh: true,
    });
    expect(second).toEqual({
      handledIncrementally: false,
      reused: true,
      shouldRefresh: true,
    });
    expect(taskIdsFor("active-hidden-delete")).toEqual(["visible-task"]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey["active-hidden-delete"]?.total).toBe(
      2,
    );
  });

  it("重复 membership 广播不会二次增减列表 total", () => {
    const task = createTask({ taskId: "archive-once" });
    useTaskQueryCacheStore.getState().setQueryResult({
      descriptor: createDescriptor("active"),
      hasMore: false,
      items: [task],
      queryKey: "active-archive-once",
      total: 1,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      descriptor: createDescriptor("archived"),
      hasMore: false,
      items: [],
      queryKey: "archived-archive-once",
      total: 0,
    });
    const event: ZCodeWorkspaceTaskListChanged = {
      reason: "task_archived",
      taskId: "archive-once",
      taskMeta: task,
      type: "workspace_task_list_changed",
      workspacePath: WORKSPACE_PATH,
    };

    const first = handleTaskListWorkspaceEventCacheSync(event);
    const second = handleTaskListWorkspaceEventCacheSync({ ...event });

    const archivedEntityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::archive-once`;

    expect(first.shouldRefresh).toBe(false);
    expect(second.reused).toBe(true);
    expect(taskIdsFor("active-archive-once")).toEqual([]);
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey["active-archive-once"]?.total).toBe(
      0,
    );
    expect(taskIdsFor("archived-archive-once")).toEqual(["archive-once"]);
    expect(
      useTaskQueryCacheStore.getState().resultsByQueryKey["archived-archive-once"]?.total,
    ).toBe(1);
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[archivedEntityKey]?.taskId).toBe(
      "archive-once",
    );
  });

  it("2 秒内同 task 的 meta 更新不会被 coordinator 去重吞掉", () => {
    const task = createTask({
      taskId: "meta-updates",
      title: "first title",
      updatedAt: 20,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      descriptor: createDescriptor("active"),
      hasMore: false,
      items: [task],
      queryKey: "active-meta-updates",
      total: 1,
    });
    const firstEvent: ZCodeWorkspaceTaskListChanged = {
      reason: "task_meta_changed",
      taskId: "meta-updates",
      taskMeta: { ...task, title: "second title" },
      type: "workspace_task_list_changed",
      workspacePath: WORKSPACE_PATH,
    };
    const secondEvent: ZCodeWorkspaceTaskListChanged = {
      ...firstEvent,
      taskMeta: { ...task, title: "third title latest" },
    };

    const first = handleTaskListWorkspaceEventCacheSync(firstEvent);
    const second = handleTaskListWorkspaceEventCacheSync(secondEvent);

    expect(first).toEqual({
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    });
    expect(second).toEqual({
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    });
    expect(titleFor("meta-updates")).toBe("third title latest");
  });
});
