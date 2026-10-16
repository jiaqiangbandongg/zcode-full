import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const { globalTaskListResult, remotePinnedState } = vi.hoisted(() => ({
  globalTaskListResult: {
    items: [] as ZCodeTaskMeta[],
    loading: false,
  },
  remotePinnedState: {
    itemsByWorkspaceKey: {} as Record<string, ZCodeTaskMeta[]>,
    loadingByWorkspaceKey: {} as Record<string, boolean>,
  },
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => globalTaskListResult,
}));

vi.mock("@/hooks/useLocalWorkspaceScopes.js", () => ({
  useLocalWorkspaceScopes: ({ workspaceTabs }: { workspaceTabs: WorkspaceTabState[] }) =>
    workspaceTabs,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({
    legacyTaskService: {
      archiveTask: async () => ({}),
      renameTask: async () => ({}),
      setTaskPinned: async () => ({}),
      setTaskUnread: async () => ({}),
    },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "taskList.loading": "正在获取任务...",
          "taskList.pinnedSection": "已置顶",
          "taskList.showLess": "显示更少",
          "taskList.showMore": "显示更多",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

vi.mock("@/TaskListItem.js", () => ({
  MemoTaskItem: ({ task }: { task: ZCodeTaskMeta }) =>
    createElement("li", { "data-testid": "pinned-task-item" }, task.title),
  TaskListItemContextMenuContent: () => null,
}));

vi.mock("@/TaskRenameDialog.js", () => ({
  TaskRenameDialog: () => null,
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      removeOptimisticTaskListItem: () => {},
      removeTaskState: () => {},
      setTaskUnreadIndicator: () => {},
      upsertOptimisticTaskListItem: () => {},
    }),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: () => {},
}));

function useRemotePinnedTaskStore(selector: (state: typeof remotePinnedState) => unknown) {
  return selector(remotePinnedState);
}

useRemotePinnedTaskStore.getState = () => ({
  removeTask: () => {},
  upsertTask: () => {},
});

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  useRemotePinnedTaskStore,
}));

vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  useRemoteTimelineTaskStore: {
    getState: () => ({
      removeTask: () => {},
      upsertTask: () => {},
    }),
  },
}));

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  getRemoteWorkspaceServicesForIdentity: () => null,
  useRemoteWorkspaceSessionStore: (
    selector: (state: { sessionIdByWorkspaceIdentity: Record<string, string> }) => unknown,
  ) => selector({ sessionIdByWorkspaceIdentity: {} }),
}));

function createTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-pinned",
    title: "Pinned task",
    traceId: "trace-pinned",
    updatedAt: 2,
    workspacePath: "/workspace",
    ...overrides,
  };
}

function createWorkspaceTab(): WorkspaceTabState {
  return {
    id: "workspace-local",
    kind: "workspace",
    label: "workspace",
    workspacePath: "/workspace",
  };
}

function renderPinnedSection() {
  return renderToStaticMarkup(
    createElement(WorkspacePinnedTasksSection, {
      activeTaskId: null,
      activeWorkspacePath: "/workspace",
      onSelectTask: () => {},
      taskSortBy: "updated",
      workspaceTabs: [createWorkspaceTab()],
    }),
  );
}

import { WorkspacePinnedTasksSection } from "@/WorkspacePinnedTasksSection.js";

describe("WorkspacePinnedTasksSection", () => {
  beforeEach(() => {
    globalTaskListResult.items = [];
    globalTaskListResult.loading = false;
    remotePinnedState.itemsByWorkspaceKey = {};
    remotePinnedState.loadingByWorkspaceKey = {};
  });

  it("shows a title above pinned tasks", () => {
    globalTaskListResult.items = [createTask()];

    const html = renderPinnedSection();

    expect(html).toContain("已置顶");
    expect(html).toContain('data-testid="pinned-task-item"');
  });

  it("renders cached pinned tasks while the list is refreshing", () => {
    globalTaskListResult.items = [createTask()];
    globalTaskListResult.loading = true;

    const html = renderPinnedSection();

    expect(html).toContain("已置顶");
    expect(html).toContain('data-testid="pinned-task-item"');
    expect(html).not.toContain("正在获取任务...");
  });

  it("stays hidden while pinned tasks are loading without data", () => {
    globalTaskListResult.loading = true;

    expect(renderPinnedSection()).toBe("");
  });

  it("stays hidden when there are no pinned tasks", () => {
    expect(renderPinnedSection()).toBe("");
  });
});
