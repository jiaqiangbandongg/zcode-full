import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
} from "@/lib/taskQueryCache.js";
import {
  increaseWorkspaceTaskVisibleLimit,
  resolveVisibleWorkspaceTaskKeys,
  resolveWorkspaceTaskVisibleLimit,
  retainWorkspaceTaskVisibleLimits,
} from "@/lib/workspaceTaskPagination.js";
import {
  buildWorkspaceTaskListDisplayGroups,
  type WorkspaceTaskListGroup,
} from "@/hooks/workspaceTaskListDisplayGroups.js";

const WORKSPACE_PATH = "/workspace";
const WORKSPACE_KEY = buildTaskWorkspaceKey(WORKSPACE_PATH);

function createTask(index: number): ZCodeTaskMeta {
  return {
    createdAt: 100 - index,
    mode: "default",
    provider: "codex",
    taskId: `task-${index + 1}`,
    title: `Task ${index + 1}`,
    traceId: `trace-${index + 1}`,
    updatedAt: 100 - index,
    workspacePath: WORKSPACE_PATH,
  };
}

function createCachedResult(
  tasks: ZCodeTaskMeta[],
  total: number,
  allTasks: ZCodeTaskMeta[],
): CachedTaskListResult {
  const descriptor = buildTaskListCacheDescriptor({
    kind: "workspace",
    workspaceScopes: [{ workspacePath: WORKSPACE_PATH }],
    sortBy: "updated",
    search: "",
    expanded: false,
    visibleLimit: Math.max(5, tasks.length),
  });
  return {
    descriptor,
    failedShardKeys: [],
    fetchedAt: 1,
    hasMore: total > tasks.length,
    invalidationVersion: 0,
    loadingShardKeys: [],
    partial: false,
    stale: false,
    taskKeys: tasks.map(buildTaskEntityKey),
    unreadTaskKeys: allTasks
      .filter((task) => typeof task.unreadAt === "number")
      .map(buildTaskEntityKey),
    total,
  };
}

function buildDisplayGroup(params: {
  allTasks: ZCodeTaskMeta[];
  cachedTasks?: ZCodeTaskMeta[];
  previousGroup?: WorkspaceTaskListGroup;
  taskUnreadOverlayByEntityKey?: Record<string, number | null>;
  visibleLimit: number;
}): WorkspaceTaskListGroup {
  const queryKey = `workspace-limit-${params.visibleLimit}`;
  const taskMetaByEntityKey = Object.fromEntries(
    params.allTasks.map((task) => [buildTaskEntityKey(task), task]),
  );
  const result = buildWorkspaceTaskListDisplayGroups({
    queryConfigs: [
      {
        queryKey,
        scope: { workspacePath: WORKSPACE_PATH },
        visibleLimit: params.visibleLimit,
        workspaceKey: WORKSPACE_KEY,
      },
    ],
    resultsByQueryKey: params.cachedTasks
      ? {
          [queryKey]: createCachedResult(
            params.cachedTasks,
            params.allTasks.length,
            params.allTasks,
          ),
        }
      : {},
    taskMetaByEntityKey,
    taskUnreadOverlayByEntityKey: params.taskUnreadOverlayByEntityKey ?? {},
    optimisticTaskOverlayByWorkspaceKey: new Map(),
    previousGroupsByWorkspaceKey: params.previousGroup
      ? new Map([[WORKSPACE_KEY, params.previousGroup]])
      : new Map(),
    sortBy: "updated",
  });
  return result.groups[0]!;
}

describe("workspace task visible limit", () => {
  it("uses 5 as the default and increases only the selected workspace by 5", () => {
    const remoteWorkspaceKey = "ssh:host:/workspace";
    const initial = {};
    const afterFirstClick = increaseWorkspaceTaskVisibleLimit(initial, WORKSPACE_KEY);
    const afterSecondClick = increaseWorkspaceTaskVisibleLimit(afterFirstClick, WORKSPACE_KEY);

    expect(resolveWorkspaceTaskVisibleLimit(initial, WORKSPACE_KEY)).toBe(5);
    expect(resolveWorkspaceTaskVisibleLimit(afterFirstClick, WORKSPACE_KEY)).toBe(10);
    expect(resolveWorkspaceTaskVisibleLimit(afterSecondClick, WORKSPACE_KEY)).toBe(15);
    expect(resolveWorkspaceTaskVisibleLimit(afterSecondClick, remoteWorkspaceKey)).toBe(5);
  });

  it("drops pagination progress for collapsed or removed workspace keys", () => {
    const limits = { [WORKSPACE_KEY]: 15, other: 10 };
    const retained = retainWorkspaceTaskVisibleLimits(limits, new Set([WORKSPACE_KEY]));

    expect(retained).toEqual({ [WORKSPACE_KEY]: 15 });
    expect(retainWorkspaceTaskVisibleLimits(retained, new Set())).toEqual({});
    expect(retainWorkspaceTaskVisibleLimits(retained, new Set([WORKSPACE_KEY]))).toBe(retained);
  });

  it("keeps only expanded workspace identities while the nested workspace view is visible", () => {
    const remoteIdentity = "ssh:host:/workspace";
    const workspaces = [
      { workspacePath: WORKSPACE_PATH },
      { workspacePath: "/remote", workspaceIdentity: remoteIdentity },
    ];
    const visibleKeys = resolveVisibleWorkspaceTaskKeys({
      enabled: true,
      expandedWorkspacePaths: new Set(["/remote"]),
      workspaces,
    });

    expect([...visibleKeys]).toEqual([remoteIdentity]);
    expect(
      resolveVisibleWorkspaceTaskKeys({
        enabled: false,
        expandedWorkspacePaths: new Set([WORKSPACE_PATH, "/remote"]),
        workspaces,
      }),
    ).toEqual(new Set());
  });
});

describe("workspace task display pagination", () => {
  const tasks = Array.from({ length: 12 }, (_, index) => createTask(index));

  it("renders cached pages as 5, 10, then the final 12 and hides the entry", () => {
    const firstPage = buildDisplayGroup({
      allTasks: tasks,
      cachedTasks: tasks.slice(0, 5),
      visibleLimit: 5,
    });
    const secondPage = buildDisplayGroup({
      allTasks: tasks,
      cachedTasks: tasks.slice(0, 10),
      visibleLimit: 10,
    });
    const finalPage = buildDisplayGroup({
      allTasks: tasks,
      cachedTasks: tasks,
      visibleLimit: 15,
    });

    expect(firstPage.items).toHaveLength(5);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.items).toHaveLength(10);
    expect(secondPage.hasMore).toBe(true);
    expect(finalPage.items).toHaveLength(12);
    expect(finalPage.hasMore).toBe(false);
  });

  it("keeps the previous page while a larger cache key is pending", () => {
    const previousGroup = buildDisplayGroup({
      allTasks: tasks,
      cachedTasks: tasks.slice(0, 5),
      visibleLimit: 5,
    });
    const pendingGroup = buildDisplayGroup({
      allTasks: tasks,
      previousGroup,
      visibleLimit: 10,
    });

    expect(pendingGroup.items).toHaveLength(5);
    expect(pendingGroup.hasMore).toBe(true);
  });

  it("trims a previous larger page immediately when reset to 5", () => {
    const previousGroup = buildDisplayGroup({
      allTasks: tasks,
      cachedTasks: tasks.slice(0, 10),
      visibleLimit: 10,
    });
    const resetGroup = buildDisplayGroup({
      allTasks: tasks,
      previousGroup,
      visibleLimit: 5,
    });

    expect(resetGroup.items).toHaveLength(5);
    expect(resetGroup.hasMore).toBe(true);
  });

  it("aggregates unread tasks outside the visible page and respects optimistic clear", () => {
    const hiddenUnreadTask = { ...tasks[11]!, unreadAt: 123 };
    const tasksWithHiddenUnread = [...tasks.slice(0, 11), hiddenUnreadTask];
    const initialGroup = buildDisplayGroup({
      allTasks: tasksWithHiddenUnread,
      cachedTasks: tasksWithHiddenUnread.slice(0, 5),
      visibleLimit: 5,
    });
    const clearedGroup = buildDisplayGroup({
      allTasks: tasksWithHiddenUnread,
      cachedTasks: tasksWithHiddenUnread.slice(0, 5),
      taskUnreadOverlayByEntityKey: { [buildTaskEntityKey(hiddenUnreadTask)]: null },
      visibleLimit: 5,
    });

    expect(initialGroup.items).toHaveLength(5);
    expect(initialGroup.hasUnread).toBe(true);
    expect(clearedGroup.hasUnread).toBe(false);
  });

  it("keeps the aggregate until the final unread task is cleared", () => {
    const firstUnreadTask = { ...tasks[10]!, unreadAt: 111 };
    const secondUnreadTask = { ...tasks[11]!, unreadAt: 222 };
    const tasksWithUnread = [...tasks.slice(0, 10), firstUnreadTask, secondUnreadTask];
    const group = buildDisplayGroup({
      allTasks: tasksWithUnread,
      cachedTasks: tasksWithUnread.slice(0, 5),
      taskUnreadOverlayByEntityKey: { [buildTaskEntityKey(firstUnreadTask)]: null },
      visibleLimit: 5,
    });

    expect(group.hasUnread).toBe(true);
  });
});
