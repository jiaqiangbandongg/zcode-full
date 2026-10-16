import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const { childCalls, sortableRefs } = vi.hoisted(() => ({
  childCalls: [] as Array<Record<string, unknown>>,
  sortableRefs: {
    attributes: { role: "button" },
    listeners: { onPointerDown: () => {} },
    setNodeRef: () => {},
  },
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: sortableRefs.attributes,
    isDragging: false,
    listeners: sortableRefs.listeners,
    setNodeRef: sortableRefs.setNodeRef,
    transform: {
      scaleX: 0.5,
      scaleY: 0.75,
      x: 10,
      y: 20,
    },
    transition: "transform 120ms ease",
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: (
        transform: {
          scaleX?: number;
          scaleY?: number;
          x: number;
          y: number;
        } | null,
      ) =>
        transform
          ? `${transform.x},${transform.y},${transform.scaleX},${transform.scaleY}`
          : undefined,
    },
  },
}));

vi.mock("@/WorkspaceSidebarItem.js", () => ({
  WorkspaceSidebarItem: (props: Record<string, unknown>) => {
    childCalls.push(props);
    return null;
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

function createWorkspaceTab(): WorkspaceTabState {
  return {
    id: "workspace-1",
    kind: "workspace",
    label: "workspace",
    workspacePath: "/workspace",
  };
}

describe("SortableWorkspaceSidebarItem render stability", () => {
  afterEach(() => {
    childCalls.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps child style, sortable bindings, and show-more handler stable across equivalent drag state", async () => {
    const { SortableWorkspaceSidebarItem } = await import("@/SortableWorkspaceSidebar.js");
    const root: Root = createRoot(installMinimalDom());
    const tab = createWorkspaceTab();
    const onShowMoreWorkspaceTasks = vi.fn();

    function renderWithLoading(taskListLoading: boolean) {
      act(() => {
        root.render(
          createElement(SortableWorkspaceSidebarItem, {
            activateTab: () => {},
            closeTab: () => {},
            isActiveWorkspace: true,
            isExpanded: true,
            mobileActiveTaskKey: null,
            onOpenFileTree: () => {},
            onReconnectRemoteWorkspace: async () => {},
            onSelectTask: () => {},
            onShowMoreWorkspaceTasks,
            reconnectingRemoteWorkspaceKeys: [],
            reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
            remoteWorkspaceErrorByWorkspaceKey: {},
            tab,
            taskItems: [],
            taskListHasMore: true,
            taskListLoading,
            toggleWorkspaceExpanded: () => {},
            workspaceKey: "workspace-key",
          }),
        );
      });
    }

    renderWithLoading(false);
    renderWithLoading(true);

    expect(childCalls).toHaveLength(2);
    const [firstProps, secondProps] = childCalls;
    expect(secondProps.itemStyle).toBe(firstProps.itemStyle);
    expect(secondProps.sortableBindings).toBe(firstProps.sortableBindings);
    expect(secondProps.onShowMoreTasks).toBe(firstProps.onShowMoreTasks);
    expect(typeof firstProps.onShowMoreTasks).toBe("function");

    (firstProps.onShowMoreTasks as () => void)();
    expect(onShowMoreWorkspaceTasks).toHaveBeenCalledWith("workspace-key");

    act(() => {
      root.unmount();
    });
  });
});
