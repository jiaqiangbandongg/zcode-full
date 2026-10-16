import type { ZCodeTaskMeta } from "@zcode/shared";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TASK_ORDER_STORAGE_KEY_PREFIX = "zcode-task-order:";

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getTaskOrderStorageKey(workspacePath: string) {
  return `${TASK_ORDER_STORAGE_KEY_PREFIX}${workspacePath}`;
}

function normalizeTaskOrder(taskIds: readonly unknown[]): string[] {
  const seen = new Set<string>();

  return taskIds.filter((taskId): taskId is string => {
    if (typeof taskId !== "string" || taskId.length === 0 || seen.has(taskId)) {
      return false;
    }

    seen.add(taskId);
    return true;
  });
}

export function readTaskOrder(
  workspacePath: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const rawValue = storage?.getItem(getTaskOrderStorageKey(workspacePath));
  if (!rawValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeTaskOrder(parsed);
  } catch {
    return [];
  }
}

export function persistTaskOrder(
  workspacePath: string,
  taskIds: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
) {
  storage?.setItem(getTaskOrderStorageKey(workspacePath), JSON.stringify(normalizeTaskOrder(taskIds)));
}

export function pruneTaskOrder(taskOrder: readonly string[], tasks: readonly ZCodeTaskMeta[]): string[] {
  const taskIds = new Set(tasks.map((task) => task.taskId));
  return normalizeTaskOrder(taskOrder).filter((taskId) => taskIds.has(taskId));
}

export function sortTasksByOrder(tasks: readonly ZCodeTaskMeta[], taskOrder: readonly string[]): ZCodeTaskMeta[] {
  const normalizedTaskOrder = normalizeTaskOrder(taskOrder);
  const orderedIndexByTaskId = new Map(
    normalizedTaskOrder.map((taskId, index) => [taskId, index] as const),
  );

  return [...tasks].sort((left, right) => {
    const leftIndex = orderedIndexByTaskId.get(left.taskId);
    const rightIndex = orderedIndexByTaskId.get(right.taskId);

    if (leftIndex == null && rightIndex == null) {
      return right.updatedAt - left.updatedAt;
    }

    // 新出现、还没被手动排过序的任务优先放在前面，避免被历史自定义顺序完全埋住。
    if (leftIndex == null) {
      return -1;
    }

    if (rightIndex == null) {
      return 1;
    }

    return leftIndex - rightIndex;
  });
}
