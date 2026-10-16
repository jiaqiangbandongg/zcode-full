import type { InputId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import { getTaskMeta, resolveWorkspaceStateKey, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  mergeTaskMetaCandidates,
  mergeTaskWithOptimisticMeta,
} from "@/lib/zcodeTaskMetaMerge.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function inferTaskMembershipFromQueryCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): TaskListMembershipState | null {
  const entityKey = buildTaskEntityKey(params);
  const workspaceKey = buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const { resultsByQueryKey } = useTaskQueryCacheStore.getState();
  let foundActive = false;
  let foundPinned = false;

  for (const result of Object.values(resultsByQueryKey)) {
    if (!result.taskKeys.includes(entityKey)) {
      continue;
    }
    if (!result.descriptor.workspaceKeys.includes(workspaceKey)) {
      continue;
    }
    if (result.descriptor.kind === "archived") {
      return { pinned: false, archived: true };
    }
    if (result.descriptor.kind === "pinned") {
      foundPinned = true;
      continue;
    }
    if (
      result.descriptor.kind === "workspace" ||
      result.descriptor.kind === "timeline" ||
      // Bugfix: active 是搜索/Command Center 使用的正式 active 列表。
      // 漏掉它会把 active-only 可见 task 推断成 absent，置顶/归档事件会误增减 total。
      result.descriptor.kind === "active"
    ) {
      foundActive = true;
    }
  }

  if (foundPinned) {
    return { pinned: true, archived: false };
  }
  if (foundActive) {
    return { pinned: false, archived: false };
  }

  return null;
}

function membershipForWorkspaceEventReason(
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned",
): TaskListMembershipState {
  switch (reason) {
    case "task_archived":
      return { pinned: false, archived: true };
    case "task_pinned":
      return { pinned: true, archived: false };
    case "task_unarchived":
    case "task_unpinned":
      return { pinned: false, archived: false };
  }
}

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask = useTaskQueryCacheStore.getState().taskMetaByEntityKey[
    buildTaskEntityKey({
      taskId: params.task.taskId,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
    })
  ];
  // Bugfix: session/readSession 快照的 updatedAt 可能落后于首发 prompt 写入的前端乐观时间。
  // 同步快照时必须先和本地已有 task meta 单调合并，否则新建任务会在 sqlite 首屏刷新后跳回下面。
  // Bugfix: 重启恢复时 workspace store 可能还没有当前 task，但 query cache 已经有 sqlite indexed meta。
  // raw session snapshot 不带 titleOverridden，必须一起合并，避免手动重命名标题在 renderer 被还原。
  const task =
    mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: 终态/回滚类操作之前统一 bump 整个 taskListVersion，只是为了把最新 snapshot.meta
  // 重新捞回列表。这里改成按 task 增量回写 taskListCache，避免所有 task 列表整轮重查。
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: Header / 当前会话信息会优先拿 optimistic meta 覆盖旧缓存。
  // 如果这里只改 query cache，不补 optimistic 池，当前激活 task 仍可能继续显示旧标题/旧摘要。
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: 手机 shared-host 创建 task 时，桌面 renderer 只收到 workspace 事件，
    // 没有本地首发路径的 insertTaskIntoTaskCaches。previousTask 缺失时仍要按 active
    // 成员关系插入 query cache，否则远控首页会继续同步旧列表顺序。
    // Bugfix: 本地首发会先写 optimistic meta，再插入列表成员；此时 previousTask 虽然存在，
    // 但它只代表“已有元数据”，不代表“已经计入列表 total”。新建任务必须显式按 absent -> active
    // 处理，否则第 6 个 workspace task 的 total 仍停在 5，Show more 不会出现。
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership
          ? params.membership
          : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function syncTaskMembershipEventToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned";
}): void {
  const previousMembership =
    inferTaskMembershipFromQueryCaches({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.task.taskId,
    }) ?? ABSENT_MEMBERSHIP;
  const nextMembership = membershipForWorkspaceEventReason(params.reason);

  // Bugfix: 远控/其它窗口触发归档或置顶时，本窗口没有本地 optimistic mutation。
  // 过去只能失效整表 query cache，导致点击后列表闪烁；这里根据当前缓存位置推断旧 membership 后增量移动。
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: nextMembership,
    applyQueryCacheMutation: false,
  });
  applyTaskQueryCacheMutation({
    previousTask: params.task,
    nextTask: params.task,
    previousState: previousMembership,
    nextState: nextMembership,
  });
}

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

export function patchTaskMetaInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  patch: (task: ZCodeTaskMeta) => Partial<ZCodeTaskMeta>;
}): ZCodeTaskMeta | null {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const identityWorkspaceState = params.workspaceIdentity
    ? store.workspaces[resolveWorkspaceStateKey(params.workspacePath, params.workspaceIdentity)]
    : undefined;
  const taskCacheState = identityWorkspaceState ?? workspaceState;
  const currentTask =
    getTaskMeta(workspaceState, params.taskId) ??
    (identityWorkspaceState ? getTaskMeta(identityWorkspaceState, params.taskId) : null);
  if (!currentTask) {
    return null;
  }

  const patch = params.patch(currentTask);
  const shouldPreserveManualTitle =
    currentTask.titleOverridden === true &&
    patch.title !== undefined &&
    patch.title !== currentTask.title &&
    patch.titleOverridden !== false;
  const patchedTask = {
    ...currentTask,
    ...patch,
    // Bugfix: 用户手动重命名后，运行中的 session_info_update 仍可能带回自动标题。
    // 这些 patch 只该刷新运行态字段，不能把 titleOverridden 的手动标题短暂冲掉。
    title: shouldPreserveManualTitle ? currentTask.title : patch.title ?? currentTask.title,
    titleOverridden: patch.titleOverridden ?? currentTask.titleOverridden,
  };
  // Bugfix: session_info_update / snapshot patch 可能只是在补运行态，却带回 "New session" 占位标题。
  // patch 后再和当前 meta 合并一次，保留 status/target/updatedAt 的同时，不让占位标题写进 task/query cache。
  const nextTask = mergeTaskWithOptimisticMeta(patchedTask, currentTask);

  store.upsertOptimisticTaskListItem(params.workspacePath, nextTask, params.workspaceIdentity);
  if (taskCacheState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      taskCacheState.taskListCache.map((task) =>
        task.taskId === params.taskId ? nextTask : task,
      ),
      params.workspaceIdentity,
    );
  }
  // Bugfix: 手机端从聊天页返回任务列表时，运行开始只会 patch 当前 task 的 status/updatedAt。
  // 如果 query cache 只替换 meta 不重排，按更新时间排序的远控首页会继续停在旧顺序。
  updateTaskQueryCacheTaskMetaPreservingMembership(nextTask);

  return nextTask;
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: 新建/fork/远控 shared-host 创建 task 都应走同一条“无 -> 有”成员变更。
  // syncTaskMetaToTaskCaches 会在 previousTask 缺失时按 ABSENT_MEMBERSHIP 插入 query cache，
  // 这里不能再二次 apply mutation，否则 total 会被重复加一。
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });

}

export function initializeBackgroundTaskInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  provider: ZCodeProvider;
  activeInputId: InputId;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const task = previousTask
    ? mergeTaskWithOptimisticMeta(params.task, previousTask)
    : params.task;

  store.initializeBackgroundTaskRuntime(params.workspacePath, {
    workspaceIdentity: params.workspaceIdentity,
    task,
    provider: params.provider,
    activeInputId: params.activeInputId,
  });
  upsertTaskQueryCacheTaskMeta(task);
  // 修复原因：后台首发不再先写 optimistic 再 insert cache；query cache 仍需按“无 -> active”
  // 插入成员，保证侧栏 total / show more 与普通首发一致。
  applyTaskQueryCacheMutation({
    previousTask: previousTask ?? task,
    nextTask: task,
    previousState: ABSENT_MEMBERSHIP,
    nextState: { pinned: false, archived: false },
  });
}
