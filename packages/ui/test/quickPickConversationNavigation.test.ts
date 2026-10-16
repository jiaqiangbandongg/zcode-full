import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey, buildTaskListCacheDescriptor } from "@/lib/taskQueryCache.js";
import {
  resolveQuickPickConversationNavigation,
  selectQuickPickConversationTaskIds,
} from "@/lib/quickPickConversationNavigation.js";

function createTask(taskId: string, updatedAt: number, workspaceIdentity?: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/workspace",
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    createdAt: updatedAt,
    updatedAt,
    mode: "default",
  };
}

describe("quickPickConversationNavigation", () => {
  it("resolves previous and next from the ordered task ids", () => {
    expect(
      resolveQuickPickConversationNavigation({
        taskIds: ["newest", "middle", "oldest"],
        activeTaskId: "middle",
      }),
    ).toMatchObject({
      canSelectPreviousConversation: true,
      canSelectNextConversation: true,
      previousTaskId: "newest",
      nextTaskId: "oldest",
    });
  });

  it("uses edge availability when the active task is at the list boundary", () => {
    expect(
      resolveQuickPickConversationNavigation({
        taskIds: ["newest", "oldest"],
        activeTaskId: "newest",
      }),
    ).toMatchObject({
      canSelectPreviousConversation: false,
      canSelectNextConversation: true,
      previousTaskId: null,
      nextTaskId: "oldest",
    });
  });

  it("prefers workspace task query cache over stale fallback ids", () => {
    const tasks = [createTask("cache-new", 3), createTask("cache-old", 1)];
    const descriptor = buildTaskListCacheDescriptor({
      kind: "workspace",
      workspaceScopes: [{ workspacePath: "/workspace" }],
      sortBy: "updated",
      search: "",
      expanded: true,
    });
    const taskMetaByEntityKey = Object.fromEntries(
      tasks.map((task) => [buildTaskEntityKey(task), task]),
    );
    const taskIds = selectQuickPickConversationTaskIds({
      workspacePath: "/workspace",
      resultsByQueryKey: {
        workspace: {
          taskKeys: tasks.map(buildTaskEntityKey),
          total: tasks.length,
          hasMore: false,
          invalidationVersion: 0,
          fetchedAt: 1,
          stale: false,
          partial: false,
          loadingShardKeys: [],
          failedShardKeys: [],
          descriptor,
        },
      },
      taskMetaByEntityKey,
      fallbackTaskIds: ["fallback-only"],
    });

    expect(taskIds).toEqual(["cache-new", "cache-old"]);
  });

  it("falls back to old task ids before task query cache is ready", () => {
    expect(
      selectQuickPickConversationTaskIds({
        workspacePath: "/workspace",
        resultsByQueryKey: {},
        taskMetaByEntityKey: {},
        fallbackTaskIds: ["fallback-new", "fallback-old"],
      }),
    ).toEqual(["fallback-new", "fallback-old"]);
  });
});
