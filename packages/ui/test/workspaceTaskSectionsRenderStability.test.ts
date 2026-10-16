import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const {
  capturedTaskItemProps,
  globalTaskListResult,
  remotePinnedState,
  remoteTimelineState,
  remoteWorkspaceSessionState,
  stableBaseServices,
  stableIntl,
  zcodeSessionStoreState,
} = vi.hoisted(() => ({
  capturedTaskItemProps: [] as Array<Record<string, unknown>>,
  globalTaskListResult: {
    hasMore: false,
    items: [] as ZCodeTaskMeta[],
    loading: false,
    syncingRemoteWorkspaces: false,
    total: 0,
  },
  remotePinnedState: {
    itemsByWorkspaceKey: {} as Record<string, ZCodeTaskMeta[]>,
    loadingByWorkspaceKey: {} as Record<string, boolean>,
  },
  remoteTimelineState: {
    hasMoreByWorkspaceKey: {} as Record<string, boolean>,
    itemsByWorkspaceKey: {} as Record<string, ZCodeTaskMeta[]>,
    loadingByWorkspaceKey: {} as Record<string, boolean>,
    totalByWorkspaceKey: {} as Record<string, number>,
  },
  remoteWorkspaceSessionState: {
    sessionIdByWorkspaceIdentity: {} as Record<string, string>,
    sessionIdByWorkspacePath: {} as Record<string, string>,
    sessionsById: {} as Record<string, unknown>,
  },
  stableBaseServices: {
    zcodeTaskService: {
      archiveTask: vi.fn(async () => null),
      renameTask: vi.fn(async () => null),
      setTaskPinned: vi.fn(async () => null),
      setTaskUnread: vi.fn(async () => null),
    },
  },
  stableIntl: {
    formatMessage: ({ id }: { id: string }) => id,
  },
  zcodeSessionStoreState: {
    removeOptimisticTaskListItem: vi.fn(),
    removeTaskState: vi.fn(),
    setTaskUnreadIndicator: vi.fn(),
    upsertOptimisticTaskListItem: vi.fn(),
  },
}));

vi.mock("@/components/ui/context-menu.js", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => globalTaskListResult,
}));

vi.mock("@/hooks/useLocalWorkspaceScopes.js", () => ({
  useLocalWorkspaceScopes: ({
    workspaceTabs,
  }: {
    workspaceTabs: WorkspaceTabState[];
  }) => workspaceTabs,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => stableBaseServices,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: stableIntl,
    locale: "en",
  }),
}));

vi.mock("@/TaskListItem.js", () => ({
  MemoTaskItem: (props: Record<string, unknown>) => {
    capturedTaskItemProps.push(props);
    return createElement("li", null, (props.task as ZCodeTaskMeta).title);
  },
  TaskListItemContextMenuContent: () => null,
}));

vi.mock("@/TaskListLoadingHint.js", () => ({
  TaskListLoadingHint: () => null,
}));

vi.mock("@/TaskListRemoteSyncHint.js", () => ({
  TaskListRemoteSyncHint: () => null,
}));

vi.mock("@/TaskRenameDialog.js", () => ({
  TaskRenameDialog: () => null,
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(zcodeSessionStoreState),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: () => {},
}));

function useRemotePinnedTaskStore(
  selector: (state: typeof remotePinnedState) => unknown,
) {
  return selector(remotePinnedState);
}

useRemotePinnedTaskStore.getState = () => ({
  removeTask: () => {},
  upsertTask: () => {},
});

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  useRemotePinnedTaskStore,
}));

function useRemoteTimelineTaskStore(
  selector: (state: typeof remoteTimelineState) => unknown,
) {
  return selector(remoteTimelineState);
}

useRemoteTimelineTaskStore.getState = () => ({
  refreshWorkspace: () => {},
  removeTask: () => {},
  upsertTask: () => {},
});

vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  useRemoteTimelineTaskStore,
}));

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  getRemoteWorkspaceServicesForIdentity: () => null,
  useRemoteWorkspaceSessionStore: (
    selector: (state: typeof remoteWorkspaceSessionState) => unknown,
  ) => selector(remoteWorkspaceSessionState),
}));

function createTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-1",
    title: "Task 1",
    traceId: "trace-1",
    updatedAt: 2,
    workspacePath: "/workspace",
    ...overrides,
  };
}

function createWorkspaceTab(): WorkspaceTabState {
  return {
    id: "workspace-1",
    kind: "workspace",
    label: "workspace",
    workspacePath: "/workspace",
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    querySelector: () => null,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function expectActionPropsStable(
  initialProps: Record<string, unknown> | undefined,
  rerenderedProps: Record<string, unknown> | undefined,
) {
  expect(rerenderedProps?.onSelectTask).toBe(initialProps?.onSelectTask);
  expect(rerenderedProps?.onArchiveTaskInline).toBe(
    initialProps?.onArchiveTaskInline,
  );
  expect(rerenderedProps?.onTogglePinTask).toBe(
    initialProps?.onTogglePinTask,
  );
  expect(rerenderedProps?.onStartRenameTask).toBe(
    initialProps?.onStartRenameTask,
  );
  expect(rerenderedProps?.onArchiveTask).toBe(initialProps?.onArchiveTask);
  expect(rerenderedProps?.onMarkTaskAsUnread).toBe(
    initialProps?.onMarkTaskAsUnread,
  );
  expect(rerenderedProps?.onOpenTaskContextMenu).toBe(
    initialProps?.onOpenTaskContextMenu,
  );
}

describe("workspace task section render stability", () => {
  afterEach(() => {
    capturedTaskItemProps.length = 0;
    globalTaskListResult.hasMore = false;
    globalTaskListResult.items = [];
    globalTaskListResult.loading = false;
    globalTaskListResult.syncingRemoteWorkspaces = false;
    globalTaskListResult.total = 0;
    remotePinnedState.itemsByWorkspaceKey = {};
    remotePinnedState.loadingByWorkspaceKey = {};
    remoteTimelineState.hasMoreByWorkspaceKey = {};
    remoteTimelineState.itemsByWorkspaceKey = {};
    remoteTimelineState.loadingByWorkspaceKey = {};
    remoteTimelineState.totalByWorkspaceKey = {};
    stableBaseServices.zcodeTaskService.archiveTask.mockReset();
    stableBaseServices.zcodeTaskService.renameTask.mockReset();
    stableBaseServices.zcodeTaskService.setTaskPinned.mockReset();
    stableBaseServices.zcodeTaskService.setTaskUnread.mockReset();
    zcodeSessionStoreState.removeOptimisticTaskListItem.mockReset();
    zcodeSessionStoreState.removeTaskState.mockReset();
    zcodeSessionStoreState.setTaskUnreadIndicator.mockReset();
    zcodeSessionStoreState.upsertOptimisticTaskListItem.mockReset();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps pinned MemoTaskItem action props stable during unrelated parent rerenders", async () => {
    const { WorkspacePinnedTasksSection } = await import(
      "@/WorkspacePinnedTasksSection.js"
    );
    const root: Root = createRoot(installMinimalDom());
    const workspaceTabs = [createWorkspaceTab()];
    globalTaskListResult.items = [createTask()];
    globalTaskListResult.total = 1;
    const onSelectTask = vi.fn();

    function Parent({ tick }: { tick: number }) {
      return createElement(
        "section",
        null,
        createElement("span", null, tick),
        createElement(WorkspacePinnedTasksSection, {
          activeTaskId: null,
          activeWorkspacePath: "/workspace",
          onSelectTask,
          taskSortBy: "updated",
          workspaceTabs,
        }),
      );
    }

    act(() => {
      root.render(createElement(Parent, { tick: 1 }));
    });
    act(() => {
      root.render(createElement(Parent, { tick: 2 }));
    });

    expectActionPropsStable(capturedTaskItemProps[0], capturedTaskItemProps[1]);

    act(() => {
      root.unmount();
    });
  });

});
