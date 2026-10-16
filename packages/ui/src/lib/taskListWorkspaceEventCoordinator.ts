import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  getTaskMetaWorkspaceEventSyncMode,
  isTaskListDeletionWorkspaceEvent,
  isTaskListMembershipWorkspaceEvent,
  shouldApplyTaskMetaFromWorkspaceEvent,
  shouldRefreshTaskListForWorkspaceEvent,
} from "@/lib/taskListRefreshPolicy.js";
import {
  removeTaskFromTaskCaches,
  syncTaskMembershipEventToTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const COORDINATED_EVENT_TTL_MS = 2_000;
const MAX_COORDINATED_EVENTS = 200;

export interface TaskListWorkspaceEventCacheSyncResult {
  shouldRefresh: boolean;
  handledIncrementally: boolean;
  reused: boolean;
}

const coordinatedResults = new Map<
  string,
  TaskListWorkspaceEventCacheSyncResult & { expiresAt: number }
>();

function pruneCoordinatedResults(currentTime: number): void {
  for (const [key, result] of coordinatedResults) {
    if (result.expiresAt <= currentTime) {
      coordinatedResults.delete(key);
    }
  }

  while (coordinatedResults.size > MAX_COORDINATED_EVENTS) {
    const oldestKey = coordinatedResults.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    coordinatedResults.delete(oldestKey);
  }
}

function buildCoordinatedEventKey(event: ZCodeWorkspaceTaskListChanged): string | null {
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (!taskId) {
    return null;
  }

  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  const metaRevision = event.taskMeta
    ? [
        event.taskMeta.updatedAt,
        event.taskMeta.createdAt,
        event.taskMeta.status ?? "",
      ].join(":")
    : "";
  return [workspaceKey, event.reason, taskId, metaRevision].join("\u0000");
}

function cacheResult(
  eventKey: string | null,
  result: TaskListWorkspaceEventCacheSyncResult,
): TaskListWorkspaceEventCacheSyncResult {
  if (!eventKey) {
    return result;
  }

  const currentTime = Date.now();
  pruneCoordinatedResults(currentTime);
  coordinatedResults.set(eventKey, {
    ...result,
    reused: false,
    expiresAt: currentTime + COORDINATED_EVENT_TTL_MS,
  });
  return result;
}

export function handleTaskListWorkspaceEventCacheSync(
  event: ZCodeWorkspaceTaskListChanged,
): TaskListWorkspaceEventCacheSyncResult {
  if (shouldApplyTaskMetaFromWorkspaceEvent(event)) {
    const syncMode = getTaskMetaWorkspaceEventSyncMode(event);
    syncTaskMetaToTaskCaches({
      workspacePath: event.taskMeta.workspacePath,
      workspaceIdentity: event.taskMeta.workspaceIdentity,
      task: event.taskMeta,
      ...(syncMode === "insert-active"
        ? { membership: { pinned: false, archived: false } }
        : {}),
      // Bugfix: 这类事件只表示 task meta/status 变化，不携带 pinned/archived 变更语义。
      // 手机远控现在常驻 pinned 查询，必须保留任务原本所在列表，否则置顶任务会被误移出 pinned 区。
      preserveListMembership: syncMode === "preserve-membership",
    });
    // Bugfix: 普通 meta/status 更新是幂等写入，不能用不完整的 meta revision 去重。
    // 2 秒内连续标题、错误详情或 change summary 更新被吞掉，比重复应用同一份 meta 风险更高。
    return {
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    };
  }

  const eventKey = buildCoordinatedEventKey(event);
  const currentTime = Date.now();
  pruneCoordinatedResults(currentTime);
  const cached = eventKey ? coordinatedResults.get(eventKey) : undefined;
  if (cached && cached.expiresAt > currentTime) {
    // Bugfix: 同一个 workspace_task_list_changed 会被 timeline/pinned/archived/workspace 行多个 hook 收到。
    // 全局 query cache mutation 只能按 membership/delete 广播处理一次，否则后续 listener 会看到已变更状态并误判。
    return {
      handledIncrementally: cached.handledIncrementally,
      reused: true,
      shouldRefresh: cached.shouldRefresh,
    };
  }

  if (isTaskListMembershipWorkspaceEvent(event) && event.taskMeta) {
    syncTaskMembershipEventToTaskCaches({
      workspacePath: event.taskMeta.workspacePath,
      workspaceIdentity: event.taskMeta.workspaceIdentity,
      task: event.taskMeta,
      reason: event.reason,
    });
    return cacheResult(eventKey, {
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    });
  }

  if (isTaskListDeletionWorkspaceEvent(event) && event.taskId) {
    const removedFromVisibleCache = removeTaskFromTaskCaches({
      workspacePath: event.workspacePath,
      workspaceIdentity: event.workspaceIdentity,
      taskId: event.taskId,
    });
    return cacheResult(eventKey, {
      handledIncrementally: removedFromVisibleCache,
      reused: false,
      shouldRefresh: !removedFromVisibleCache,
    });
  }

  return cacheResult(eventKey, {
    handledIncrementally: false,
    reused: false,
    shouldRefresh: shouldRefreshTaskListForWorkspaceEvent(event),
  });
}

export function clearTaskListWorkspaceEventCoordinatorForTest(): void {
  coordinatedResults.clear();
}
