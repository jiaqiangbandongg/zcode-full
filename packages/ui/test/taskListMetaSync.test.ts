import { beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskGoal, ZCodeTaskMeta } from "@zcode/shared";
import {
  initializeBackgroundTaskInTaskCaches,
  insertTaskIntoTaskCaches,
  patchTaskMetaInTaskCaches,
  removeTaskFromTaskCaches,
  syncTaskMembershipEventToTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";
import {
  buildTaskListCacheDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  getTaskMeta,
  getTaskRuntimeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import {
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";

const WORKSPACE_PATH = "/repo/goal-clear-cache";
const TASK_ID = "task-goal-clear-cache";

function createGoal(): ZCodeTaskGoal {
  return {
    objective: "清理残留目标面板",
    sessionID: "session-goal-clear-cache",
    status: "paused",
    summaryTitle: null,
    targetID: "target-goal-clear-cache",
    time: {
      created: 1,
      updated: 1,
    },
    timeUsedSeconds: 0,
    tokenBudget: null,
    tokensUsed: 0,
  };
}

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

describe("patchTaskMetaInTaskCaches", () => {
  it("同步更新当前 task 的 optimistic、列表和查询缓存", () => {
    const task = createTaskMeta({ target: createGoal() });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [task]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, task);
    upsertTaskQueryCacheTaskMeta(task);

    const patched = patchTaskMetaInTaskCaches({
      workspacePath: WORKSPACE_PATH,
      taskId: TASK_ID,
      patch: (currentTask) => ({
        target: null,
        updatedAt: Math.max(currentTask.updatedAt, 2),
      }),
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${TASK_ID}`;

    expect(patched?.target).toBeNull();
    expect(getTaskMeta(workspaceState, TASK_ID)?.target).toBeNull();
    expect(workspaceState.taskListCache?.[0]?.target).toBeNull();
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.target).toBeNull();
  });

  it("更新 updatedAt/status 后保留成员关系并重排查询缓存", () => {
    const olderTask = createTaskMeta({
      taskId: "older-task",
      title: "旧任务",
      updatedAt: 10,
    });
    const targetTask = createTaskMeta({
      taskId: TASK_ID,
      title: "手机端追问任务",
      updatedAt: 5,
    });
    const descriptor = buildTaskListCacheDescriptor({
      kind: "workspace",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const queryKey = "workspace-updated-query";
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [olderTask, targetTask]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, olderTask);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, targetTask);
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [olderTask, targetTask],
      total: 2,
      hasMore: false,
    });

    const patched = patchTaskMetaInTaskCaches({
      workspacePath: WORKSPACE_PATH,
      taskId: TASK_ID,
      patch: (currentTask) => ({
        status: "running",
        updatedAt: Math.max(currentTask.updatedAt, 30),
      }),
    });

    const cacheState = useTaskQueryCacheStore.getState();
    const result = cacheState.resultsByQueryKey[queryKey];
    const taskIds = result?.taskKeys.map(
      (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
    );

    expect(patched?.status).toBe("running");
    expect(taskIds).toEqual([TASK_ID, "older-task"]);
  });

  it("不会让较新的 New session patch 写进 task/query cache", () => {
    const firstPromptTask = createTaskMeta({
      title: "用户首条 query",
      updatedAt: 20,
    });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [firstPromptTask]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, firstPromptTask);
    upsertTaskQueryCacheTaskMeta(firstPromptTask);

    const patched = patchTaskMetaInTaskCaches({
      workspacePath: WORKSPACE_PATH,
      taskId: TASK_ID,
      patch: (currentTask) => ({
        status: "running",
        title: "New session",
        updatedAt: Math.max(currentTask.updatedAt, 30),
      }),
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${TASK_ID}`;

    expect(patched?.title).toBe("用户首条 query");
    expect(patched?.status).toBe("running");
    expect(patched?.updatedAt).toBe(30);
    expect(getTaskMeta(workspaceState, TASK_ID)?.title).toBe("用户首条 query");
    expect(workspaceState.taskListCache?.[0]?.title).toBe("用户首条 query");
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.title).toBe(
      "用户首条 query",
    );
  });

  it("不会让运行中的自动标题覆盖手动重命名标题", () => {
    const renamedTask = createTaskMeta({
      title: "首页重构",
      titleOverridden: true,
      updatedAt: 20,
    });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [renamedTask]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, renamedTask);
    upsertTaskQueryCacheTaskMeta(renamedTask);

    const patched = patchTaskMetaInTaskCaches({
      workspacePath: WORKSPACE_PATH,
      taskId: TASK_ID,
      patch: (currentTask) => ({
        status: "running",
        title: "OpenSpec Change Proposal Workflow",
        updatedAt: Math.max(currentTask.updatedAt, 30),
      }),
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const entityKey = `${buildTaskWorkspaceKey(WORKSPACE_PATH)}::${TASK_ID}`;

    expect(patched?.title).toBe("首页重构");
    expect(patched?.titleOverridden).toBe(true);
    expect(patched?.status).toBe("running");
    expect(patched?.updatedAt).toBe(30);
    expect(getTaskMeta(workspaceState, TASK_ID)?.title).toBe("首页重构");
    expect(workspaceState.taskListCache?.[0]?.title).toBe("首页重构");
    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey[entityKey]?.title).toBe(
      "首页重构",
    );
  });

  it("带 active 成员关系同步不存在的 task 时插入并重排查询缓存", () => {
    const olderTask = createTaskMeta({
      taskId: "older-task",
      title: "旧任务",
      updatedAt: 10,
    });
    const incomingTask = createTaskMeta({
      taskId: TASK_ID,
      title: "手机端新任务",
      updatedAt: 30,
    });
    const descriptor = buildTaskListCacheDescriptor({
      kind: "timeline",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const queryKey = "web-remote-expanded-timeline-query";
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [olderTask]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, olderTask);
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [olderTask],
      total: 1,
      hasMore: false,
    });

    syncTaskMetaToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task: incomingTask,
      membership: { pinned: false, archived: false },
    });

    const cacheState = useTaskQueryCacheStore.getState();
    const result = cacheState.resultsByQueryKey[queryKey];
    const taskIds = result?.taskKeys.map(
      (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
    );

    expect(taskIds).toEqual([TASK_ID, "older-task"]);
    expect(result?.total).toBe(2);
  });
});

describe("syncTaskMetaToTaskCaches", () => {
  it("后台首发初始化写入列表和运行态，但不写入消息内容", () => {
    const existingTask = createTaskMeta({
      taskId: "existing-task",
      title: "已有任务",
      updatedAt: 10,
    });
    const backgroundTask = createTaskMeta({
      title: "后台压测任务",
      updatedAt: 100,
    });
    const descriptor = buildTaskListCacheDescriptor({
      kind: "workspace",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const queryKey = "background-first-send-query";
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [existingTask]);
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey,
      descriptor,
      items: [existingTask],
      total: 1,
      hasMore: false,
    });

    initializeBackgroundTaskInTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task: backgroundTask,
      provider: "glm",
      activeInputId: "input-background-first-send",
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);
    const runtime = getTaskRuntimeState(workspaceState, TASK_ID);
    const cacheState = useTaskQueryCacheStore.getState();
    const result = cacheState.resultsByQueryKey[queryKey];
    const taskIds = result?.taskKeys.map(
      (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
    );

    expect(workspaceState.taskListCache?.map((task) => task.taskId)).toEqual([
      TASK_ID,
      "existing-task",
    ]);
    expect(runtime.status).toBe("streaming");
    expect(runtime.activeInputId).toBe("input-background-first-send");
    expect(runtime.provider).toBe("glm");
    expect(taskIds).toEqual([TASK_ID, "existing-task"]);
    expect(result?.total).toBe(2);
  });

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

describe("syncTaskMembershipEventToTaskCaches", () => {
  it("从 active 查询推断旧成员关系，置顶时 active total 不会误增", () => {
    const task = createTaskMeta({
      taskId: "active-pin",
      title: "active 置顶",
      updatedAt: 20,
    });
    const activeDescriptor = buildTaskListCacheDescriptor({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const pinnedDescriptor = buildTaskListCacheDescriptor({
      kind: "pinned",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "active-membership-pin",
      descriptor: activeDescriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "pinned-membership-pin",
      descriptor: pinnedDescriptor,
      items: [],
      total: 0,
      hasMore: false,
    });

    syncTaskMembershipEventToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task,
      reason: "task_pinned",
    });

    const cacheState = useTaskQueryCacheStore.getState();

    expect(
      cacheState.resultsByQueryKey["active-membership-pin"]?.taskKeys.map(
        (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
      ),
    ).toEqual(["active-pin"]);
    expect(cacheState.resultsByQueryKey["active-membership-pin"]?.total).toBe(1);
    expect(
      cacheState.resultsByQueryKey["pinned-membership-pin"]?.taskKeys.map(
        (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
      ),
    ).toEqual(["active-pin"]);
    expect(cacheState.resultsByQueryKey["pinned-membership-pin"]?.total).toBe(1);
  });

  it("从 active 查询推断旧成员关系，归档时同步扣减 active total", () => {
    const task = createTaskMeta({
      taskId: "active-archive",
      title: "active 归档",
      updatedAt: 20,
    });
    const activeDescriptor = buildTaskListCacheDescriptor({
      kind: "active",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const archivedDescriptor = buildTaskListCacheDescriptor({
      kind: "archived",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "active-membership-archive",
      descriptor: activeDescriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "archived-membership-active",
      descriptor: archivedDescriptor,
      items: [],
      total: 0,
      hasMore: false,
    });

    syncTaskMembershipEventToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task,
      reason: "task_archived",
    });

    const cacheState = useTaskQueryCacheStore.getState();

    expect(cacheState.resultsByQueryKey["active-membership-archive"]?.taskKeys).toEqual([]);
    expect(cacheState.resultsByQueryKey["active-membership-archive"]?.total).toBe(0);
    expect(
      cacheState.resultsByQueryKey["archived-membership-active"]?.taskKeys.map(
        (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
      ),
    ).toEqual(["active-archive"]);
    expect(cacheState.resultsByQueryKey["archived-membership-active"]?.total).toBe(1);
  });

  it("根据当前缓存成员关系把远端归档事件增量移动到 archived 列表", () => {
    const task = createTaskMeta({
      taskId: "remote-archive",
      title: "远端归档",
      updatedAt: 20,
    });
    const workspaceDescriptor = buildTaskListCacheDescriptor({
      kind: "workspace",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const archivedDescriptor = buildTaskListCacheDescriptor({
      kind: "archived",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [task]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, task);
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "workspace-membership",
      descriptor: workspaceDescriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "archived-membership",
      descriptor: archivedDescriptor,
      items: [],
      total: 0,
      hasMore: false,
    });

    syncTaskMembershipEventToTaskCaches({
      workspacePath: WORKSPACE_PATH,
      task,
      reason: "task_archived",
    });

    const cacheState = useTaskQueryCacheStore.getState();

    expect(cacheState.resultsByQueryKey["workspace-membership"]?.taskKeys).toEqual([]);
    expect(cacheState.resultsByQueryKey["workspace-membership"]?.stale).toBe(false);
    expect(
      cacheState.resultsByQueryKey["archived-membership"]?.taskKeys.map(
        (taskKey) => cacheState.taskMetaByEntityKey[taskKey]?.taskId,
      ),
    ).toEqual(["remote-archive"]);
    expect(
      useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH).taskListCache,
    ).toEqual([]);
  });
});

describe("removeTaskFromTaskCaches", () => {
  it("删除 task 时同步清理 workspace cache、运行态和 query cache", () => {
    const task = createTaskMeta({
      taskId: "delete-from-caches",
      updatedAt: 20,
    });
    const descriptor = buildTaskListCacheDescriptor({
      kind: "archived",
      workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
      sortBy: "updated",
      expanded: true,
    });
    const store = useZCodeSessionStore.getState();
    store.setTaskListCache(WORKSPACE_PATH, [task]);
    store.upsertOptimisticTaskListItem(WORKSPACE_PATH, task);
    useTaskQueryCacheStore.getState().setQueryResult({
      queryKey: "delete-query",
      descriptor,
      items: [task],
      total: 1,
      hasMore: false,
    });

    const removed = removeTaskFromTaskCaches({
      workspacePath: WORKSPACE_PATH,
      taskId: "delete-from-caches",
    });

    const workspaceState = useZCodeSessionStore.getState().getWorkspaceState(WORKSPACE_PATH);

    expect(removed).toBe(true);
    expect(workspaceState.taskListCache).toEqual([]);
    expect(getTaskMeta(workspaceState, "delete-from-caches")).toBeNull();
    expect(useTaskQueryCacheStore.getState().resultsByQueryKey["delete-query"]?.taskKeys).toEqual(
      [],
    );
  });
});
