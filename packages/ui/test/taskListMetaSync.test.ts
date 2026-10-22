import { beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { insertTaskIntoTaskCaches, syncTaskMetaToTaskCaches } from "@/lib/taskListMetaSync.js";
import { buildTaskListCacheDescriptor, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";

const WORKSPACE_PATH = "/repo/goal-clear-cache";
const TASK_ID = "task-goal-clear-cache";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "glm",
    taskId: TASK_ID,
    title: "目标清理任务",
    traceId: "trace-goal-clear-cache",
    updatedAt: 1,
    workspacePath: WORKSPACE_PATH,
    ...overrides,
  };
}

beforeEach(() => {
  useZCodeSessionStore.setState((state) => ({
    ...state,
    workspaces: {},
  }));
  useTaskQueryCacheStore.getState().clearAll();
});

describe("syncTaskMetaToTaskCaches", () => {
  it("首发 optimistic meta 已存在时仍按新成员增加折叠 workspace 列表 total", () => {
    const existingTasks = Array.from({ length: 5 }, (_, index) =>
      createTaskMeta({
        taskId: `existing-${index}`,
        title: `已有任务 ${index}`,
        updatedAt: 50 - index,
      }),
    );
    const firstSendTask = createTaskMeta({
      taskId: TASK_ID,
      title: "第六个首发任务",
      updatedAt: 100,
    });
    const descriptor = buildTaskListCacheDescriptor({
      kind: "workspace",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: false,
      visibleLimit: 5,
    });
    const queryKey = "collapsed-workspace-query";
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, existingTasks);
    for (const task of existingTasks) {
      store.upsertOptimisticTaskListItem(WORKSPACE_PATH, task);
    }
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: existingTasks,
      total: 5,
      hasMore: false,
    });

    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, firstSendTask);
    insertTaskIntoTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task: firstSendTask,
      membership: { pinned: false, archived: false },
    });

    const cacheState = useTaskQueryCacheStore.getState();
    const result = cacheState.resultsByQueryKey[queryKey];
    const taskIds = result?.taskKeys.map(
      (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
    );

    expect(taskIds).toEqual([TASK_ID, "existing-0", "existing-1", "existing-2", "existing-3"]);
    expect(result?.total).toBe(6);
    expect(result?.hasMore).toBe(true);
    expect(result?.stale).toBe(true);
  });

  it("不会让旧快照覆盖首发乐观任务的 updatedAt 和标题", () => {
    const optimisticTask = createTaskMeta({
      title: "首发问题标题",
      updatedAt: 100,
    });
    const staleSnapshotTask = createTaskMeta({
      title: "New session",
      updatedAt: 10,
    });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [optimisticTask]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, optimisticTask);
    upsertTaskQueryCacheTaskMeta(optimisticTask);

    syncTaskMetaToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task: staleSnapshotTask,
      membership: { pinned: false, archived: false },
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${TASK_ID}`;

    expect(getTaskMeta(workspaceState, TASK_ID)?.title).toBe("首发问题标题");
    expect(getTaskMeta(workspaceState, TASK_ID)?.updatedAt).toBe(100);
    expect(workspaceState.taskListCache?.[0]?.title).toBe("首发问题标题");
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.updatedAt).toBe(100);
  });

  it("workspace cache 为空时也不会让 raw snapshot 覆盖 query cache 的手动标题", () => {
    const indexedRenamedTask = createTaskMeta({
      title: "airline-1",
      titleOverridden: true,
      updatedAt: 20,
    });
    const rawSnapshotTask = createTaskMeta({
      title: "Analyze airline import flow",
      status: "running",
      updatedAt: 30,
    });
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${TASK_ID}`;

    upsertTaskQueryCacheTaskMeta(indexedRenamedTask);

    syncTaskMetaToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task: rawSnapshotTask,
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const workspaceTask = getTaskMeta(workspaceState, TASK_ID);
    const queryTask = useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey];

    expect(workspaceTask?.title).toBe("airline-1");
    expect(workspaceTask?.titleOverridden).toBe(true);
    expect(workspaceTask?.status).toBe("running");
    expect(workspaceTask?.updatedAt).toBe(30);
    expect(queryTask?.title).toBe("airline-1");
    expect(queryTask?.titleOverridden).toBe(true);
    expect(queryTask?.status).toBe("running");
  });
});
