import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";

const {
  memoTaskItemCalls,
  taskListItemContextMenuContentCalls,
  taskRenameDialogCalls,
  stableIntl,
  stableStartDraft,
  stableOpenSettingsTab,
} = vi.hoisted(() => ({
  memoTaskItemCalls: [] as Array<Record<string, unknown>>,
  taskListItemContextMenuContentCalls: [] as Array<Record<string, unknown>>,
  taskRenameDialogCalls: [] as Array<Record<string, unknown>>,
  stableIntl: {
    formatMessage: ({ id }: { id: string }) => id,
  },
  stableOpenSettingsTab: vi.fn(),
  stableStartDraft: vi.fn(),
}));

vi.mock("lucide-react", () => ({
  Settings2: (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": "settings", ...props }),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/context-menu.js", () => ({
  ContextMenu: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  ContextMenuTrigger: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: () => {},
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: stableIntl }),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: { startDraft: () => void }) => unknown) =>
    selector({ startDraft: stableStartDraft }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { openSettingsTab: () => void }) => unknown) =>
    selector({ openSettingsTab: stableOpenSettingsTab }),
}));

vi.mock("@/NewTaskButtonGroup.js", () => ({
  NewTaskButtonGroup: () => null,
}));

vi.mock("@/TaskRenameDialog.js", () => ({
  TaskRenameDialog: (props: Record<string, unknown>) => {
    taskRenameDialogCalls.push(props);
    return null;
  },
}));

vi.mock("@/TaskListLoadingHint.js", () => ({
  TaskListLoadingHint: () => null,
}));

vi.mock("@/TaskListItem.js", () => ({
  MemoTaskItem: (props: Record<string, unknown>) => {
    memoTaskItemCalls.push(props);
    return createElement("li", null, (props.task as ZCodeTaskMeta).title);
  },
  TaskListItemContextMenuContent: (props: Record<string, unknown>) => {
    taskListItemContextMenuContentCalls.push(props);
    return null;
  },
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
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
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

describe("TaskList render stability", () => {
  afterEach(() => {
    memoTaskItemCalls.length = 0;
    taskListItemContextMenuContentCalls.length = 0;
    taskRenameDialogCalls.length = 0;
    stableOpenSettingsTab.mockReset();
    stableStartDraft.mockReset();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not mount the rename dialog while no row is being renamed", async () => {
    const { TaskList } = await import("@/TaskList.js");
    const root: Root = createRoot(installMinimalDom());

    act(() => {
      root.render(
        createElement(TaskList, {
          activeTaskId: null,
          isWorkspaceActive: true,
          onArchiveTask: vi.fn(async () => null),
          onRenameTask: vi.fn(async () => null),
          onSelectTask: vi.fn(),
          onSetTaskPinned: vi.fn(async () => null),
          onSetTaskUnread: vi.fn(async () => null),
          showCreateButton: false,
          showFooter: false,
          tasks: [createTask()],
          workspacePath: "/workspace",
        }),
      );
    });

    expect(taskRenameDialogCalls).toHaveLength(0);
    expect(taskListItemContextMenuContentCalls).toHaveLength(0);

    act(() => {
      root.unmount();
    });
  });

  it("shows only the one-way show-more entry while another page exists", async () => {
    const { TaskList } = await import("@/TaskList.js");
    const html = renderToStaticMarkup(
      createElement(TaskList, {
        activeTaskId: null,
        hasMore: true,
        onArchiveTask: vi.fn(async () => null),
        onRenameTask: vi.fn(async () => null),
        onSelectTask: vi.fn(),
        onSetTaskPinned: vi.fn(async () => null),
        onSetTaskUnread: vi.fn(async () => null),
        onShowMore: vi.fn(),
        showCreateButton: false,
        showFooter: false,
        tasks: [createTask()],
        workspacePath: "/workspace",
      }),
    );

    expect(html).toContain("taskList.showMore");
    expect(html).not.toContain("taskList.showLess");
  });

  it("hides the show-more entry after the final page", async () => {
    const { TaskList } = await import("@/TaskList.js");
    const html = renderToStaticMarkup(
      createElement(TaskList, {
        activeTaskId: null,
        hasMore: false,
        onArchiveTask: vi.fn(async () => null),
        onRenameTask: vi.fn(async () => null),
        onSelectTask: vi.fn(),
        onSetTaskPinned: vi.fn(async () => null),
        onSetTaskUnread: vi.fn(async () => null),
        onShowMore: vi.fn(),
        showCreateButton: false,
        showFooter: false,
        tasks: [createTask()],
        workspacePath: "/workspace",
      }),
    );

    expect(html).not.toContain("taskList.showMore");
  });

  it("does not re-render unchanged memo task rows when parent rerenders with identical list props", async () => {
    const { TaskList } = await import("@/TaskList.js");
    const root: Root = createRoot(installMinimalDom());
    const tasks = [createTask()];
    const onSelectTask = vi.fn();
    const onRenameTask = vi.fn(async () => null);
    const onSetTaskPinned = vi.fn(async () => null);
    const onArchiveTask = vi.fn(async () => null);
    const onSetTaskUnread = vi.fn(async () => null);

    function Parent({ tick }: { tick: number }) {
      return createElement(
        "section",
        null,
        createElement("span", null, tick),
        createElement(TaskList, {
          activeTaskId: null,
          isWorkspaceActive: true,
          onArchiveTask,
          onRenameTask,
          onSelectTask,
          onSetTaskPinned,
          onSetTaskUnread,
          showCreateButton: false,
          showFooter: false,
          tasks,
          workspacePath: "/workspace",
        }),
      );
    }

    act(() => {
      root.render(createElement(Parent, { tick: 1 }));
    });
    act(() => {
      root.render(createElement(Parent, { tick: 2 }));
    });

    expect(memoTaskItemCalls).toHaveLength(1);

    act(() => {
      root.unmount();
    });
  });

  it("keeps unchanged row action props stable when archive confirmation state changes", async () => {
    const { TaskList } = await import("@/TaskList.js");
    const root: Root = createRoot(installMinimalDom());
    const tasks = [
      createTask(),
      createTask({
        taskId: "task-2",
        title: "Task 2",
        traceId: "trace-2",
        updatedAt: 3,
      }),
    ];
    const onSelectTask = vi.fn();
    const onRenameTask = vi.fn(async () => null);
    const onSetTaskPinned = vi.fn(async () => null);
    const onArchiveTask = vi.fn(async () => null);
    const onSetTaskUnread = vi.fn(async () => null);

    act(() => {
      root.render(
        createElement(TaskList, {
          activeTaskId: null,
          isWorkspaceActive: true,
          onArchiveTask,
          onRenameTask,
          onSelectTask,
          onSetTaskPinned,
          onSetTaskUnread,
          showCreateButton: false,
          showFooter: false,
          tasks,
          workspacePath: "/workspace",
        }),
      );
    });

    const untouchedRowInitialProps = memoTaskItemCalls.find(
      (props) => (props.task as ZCodeTaskMeta).taskId === "task-2",
    );
    expect(untouchedRowInitialProps).toBeDefined();

    const archiveInline = memoTaskItemCalls[0]?.onArchiveTaskInline;
    expect(archiveInline).toBeDefined();
    await act(async () => {
      await archiveInline?.({ stopPropagation: vi.fn() }, "task-1");
    });

    const untouchedRowUpdatedProps = memoTaskItemCalls
      .slice(2)
      .find((props) => (props.task as ZCodeTaskMeta).taskId === "task-2");
    expect(untouchedRowUpdatedProps).toBeDefined();
    expect(untouchedRowUpdatedProps?.onSelectTask).toBe(untouchedRowInitialProps?.onSelectTask);
    expect(untouchedRowUpdatedProps?.onArchiveTaskInline).toBe(
      untouchedRowInitialProps?.onArchiveTaskInline,
    );
    expect(untouchedRowUpdatedProps?.onTogglePinTask).toBe(
      untouchedRowInitialProps?.onTogglePinTask,
    );
    expect(untouchedRowUpdatedProps?.onStartRenameTask).toBe(
      untouchedRowInitialProps?.onStartRenameTask,
    );
    expect(untouchedRowUpdatedProps?.onArchiveTask).toBe(untouchedRowInitialProps?.onArchiveTask);
    expect(untouchedRowUpdatedProps?.onMarkTaskAsUnread).toBe(
      untouchedRowInitialProps?.onMarkTaskAsUnread,
    );

    act(() => {
      root.unmount();
    });
  });
});
