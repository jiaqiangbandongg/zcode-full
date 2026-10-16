import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const { taskListCalls, stableServices, zcodeSessionStoreState } = vi.hoisted(() => ({
  taskListCalls: [] as Array<Record<string, unknown>>,
  stableServices: {
    zcodeTaskService: {
      archiveTask: async () => null,
      renameTask: async () => null,
      setTaskPinned: async () => null,
      setTaskUnread: async () => null,
    },
  },
  zcodeSessionStoreState: {
    removeOptimisticTaskListItem: () => {},
    removeTaskState: () => {},
    setTaskUnreadIndicator: () => {},
    startDraft: () => {},
    upsertOptimisticTaskListItem: () => {},
  },
}));

vi.mock("border-beam", () => ({
  BorderBeam: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    CheckIcon: createIcon("check"),
    Cloud: createIcon("cloud"),
    CopyIcon: createIcon("copy"),
    Ellipsis: createIcon("ellipsis"),
    Folder: createIcon("folder"),
    FolderOpen: createIcon("folder-open"),
    House: createIcon("house"),
    InfoIcon: createIcon("info"),
    ListTree: createIcon("list-tree"),
    LoaderCircle: createIcon("loader"),
    Loader2: createIcon("loader-2"),
    MessageCirclePlus: createIcon("message-circle-plus"),
    RefreshCwIcon: createIcon("refresh"),
    UploadCloud: createIcon("upload-cloud"),
    XIcon: createIcon("x"),
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipProvider: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/TaskList.js", () => ({
  TaskList: (props: Record<string, unknown>) => {
    taskListCalls.push(props);
    return null;
  },
}));

vi.mock("@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js", () => ({
  ReconnectingRemoteWorkspaceLogTooltip: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => stableServices,
  useWorkspaceServices: () => stableServices,
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: () => ({
    activeTaskId: null,
    selectedProvider: "codex",
  }),
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(zcodeSessionStoreState),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: () => {},
  invalidateTaskQueryCacheByScopes: () => {},
}));

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  useRemotePinnedTaskStore: {
    getState: () => ({
      removeTask: () => {},
      upsertTask: () => {},
    }),
  },
}));

vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  useRemoteTimelineTaskStore: {
    getState: () => ({
      removeTask: () => {},
      upsertTask: () => {},
    }),
  },
}));

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

function createTask(): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    provider: "codex",
    taskId: "task-1",
    title: "Task 1",
    traceId: "trace-1",
    updatedAt: 2,
    workspacePath: "/workspace",
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

describe("WorkspaceSidebarItem render stability", () => {
  afterEach(() => {
    taskListCalls.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps TaskList action props stable during unrelated row rerenders", async () => {
    const { WorkspaceSidebarItem } = await import("@/WorkspaceSidebarItem.js");
    const root: Root = createRoot(installMinimalDom());
    const tab = createWorkspaceTab();
    const taskItems = [createTask()];

    function renderWithContainerStyle() {
      act(() => {
        root.render(
          createElement(WorkspaceSidebarItem, {
            activateTab: () => {},
            closeTab: () => {},
            isActiveWorkspace: true,
            isExpanded: true,
            itemStyle: { opacity: 1 },
            mobileActiveTaskKey: null,
            onOpenFileTree: () => {},
            onReconnectRemoteWorkspace: async () => {},
            onSelectTask: () => {},
            onStartDraftInWorkspace: () => {},
            onShowMoreTasks: () => {},
            reconnectingRemoteWorkspaceKeys: [],
            reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
            remoteWorkspaceErrorByWorkspaceKey: {},
            tab,
            taskItems,
            taskListHasMore: true,
            taskListLoading: false,
            toggleWorkspaceExpanded: () => {},
          }),
        );
      });
    }

    renderWithContainerStyle();
    renderWithContainerStyle();

    expect(taskListCalls).toHaveLength(2);
    const [firstProps, secondProps] = taskListCalls;
    expect(secondProps.pinnedTasks).toBe(firstProps.pinnedTasks);
    expect(secondProps.onRenameTask).toBe(firstProps.onRenameTask);
    expect(secondProps.onSetTaskPinned).toBe(firstProps.onSetTaskPinned);
    expect(secondProps.onArchiveTask).toBe(firstProps.onArchiveTask);
    expect(secondProps.onSetTaskUnread).toBe(firstProps.onSetTaskUnread);

    act(() => {
      root.unmount();
    });
  });

  it("keeps TaskList action props stable when equivalent task arrays are recreated", async () => {
    const { WorkspaceSidebarItem } = await import("@/WorkspaceSidebarItem.js");
    const root: Root = createRoot(installMinimalDom());
    const tab = createWorkspaceTab();
    const task = createTask();

    function renderWithTaskItems(taskItems: ZCodeTaskMeta[]) {
      act(() => {
        root.render(
          createElement(WorkspaceSidebarItem, {
            activateTab: () => {},
            closeTab: () => {},
            isActiveWorkspace: true,
            isExpanded: true,
            itemStyle: { opacity: 1 },
            mobileActiveTaskKey: null,
            onOpenFileTree: () => {},
            onReconnectRemoteWorkspace: async () => {},
            onSelectTask: () => {},
            onStartDraftInWorkspace: () => {},
            onShowMoreTasks: () => {},
            reconnectingRemoteWorkspaceKeys: [],
            reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
            remoteWorkspaceErrorByWorkspaceKey: {},
            tab,
            taskItems,
            taskListHasMore: true,
            taskListLoading: false,
            toggleWorkspaceExpanded: () => {},
          }),
        );
      });
    }

    renderWithTaskItems([task]);
    renderWithTaskItems([task]);

    expect(taskListCalls).toHaveLength(2);
    const [firstProps, secondProps] = taskListCalls;
    expect(secondProps.onRenameTask).toBe(firstProps.onRenameTask);
    expect(secondProps.onSetTaskPinned).toBe(firstProps.onSetTaskPinned);
    expect(secondProps.onArchiveTask).toBe(firstProps.onArchiveTask);
    expect(secondProps.onSetTaskUnread).toBe(firstProps.onSetTaskUnread);

    act(() => {
      root.unmount();
    });
  });
});
