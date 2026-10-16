import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  leafPaneIds,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import type { WorkbenchLeafPaneProps } from "@/v4/WorkbenchPane.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

const leafPaneCapture = vi.hoisted(() => ({
  props: [] as WorkbenchLeafPaneProps[],
}));

const mountedRoots: Root[] = [];

vi.mock("@/v4/WorkbenchPane.js", async () => {
  const React = await import("react");
  return {
    WorkbenchLeafPane: (props: WorkbenchLeafPaneProps) => {
      leafPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-pane-id": props.paneId,
      });
    },
  };
});

vi.mock("@/v4/WorkbenchSplitDivider.js", async () => {
  const React = await import("react");
  return {
    WorkbenchSplitDivider: () =>
      React.createElement("div", { "data-testid": "mock-divider" }),
  };
});

function resetWorkbenchState(): void {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  leafPaneCapture.props = [];
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
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
    style: {
      removeProperty: () => {},
      setProperty: () => {},
    },
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
  return createMinimalElement(documentMock, "div");
}

function renderClient(element: ReturnType<typeof createElement>): void {
  const root = createRoot(installMinimalDom());
  mountedRoots.push(root);
  act(() => {
    root.render(element);
  });
}

function createGroupedWorkbenchState({
  readOnlyChild = false,
}: { readOnlyChild?: boolean } = {}): void {
  useWorkbenchGroupStore.getState().splitSessionIntoGroup(
    V4_PRIMARY_PANE_ID,
    "right",
    {
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "child-session",
      ...(readOnlyChild ? { readOnly: true } : {}),
    },
    {
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "main-session",
    },
  );
  const activeGroupId = useWorkbenchGroupStore.getState().activeGroupId;
  const activeGroup = activeGroupId
    ? useWorkbenchGroupStore.getState().groups[activeGroupId]
    : null;
  expect(activeGroup ? leafPaneIds(activeGroup.root) : []).toEqual([
    V4_PRIMARY_PANE_ID,
    "pane-1",
  ]);
}

function renderWorkspace({
  onPaneActiveSessionChange = vi.fn(),
}: {
  onPaneActiveSessionChange?: (
    scope: { workspacePath: string; workspaceIdentity?: string },
    sessionId: string,
  ) => void;
} = {}) {
  renderClient(
    createElement(V4WorkspaceChatArea, {
      sessionId: "main-session",
      workspacePath: "/workspace",
      onPaneActiveSessionChange,
    }),
  );
  return { onPaneActiveSessionChange };
}

describe("V4WorkspaceChatArea pane active sync", () => {
  beforeEach(resetWorkbenchState);
  afterEach(resetWorkbenchState);

  it("restores the remaining main session as shell active when closing a focused split pane", () => {
    createGroupedWorkbenchState();
    const { onPaneActiveSessionChange } = renderWorkspace();
    const childPane = leafPaneCapture.props.find((props) => props.paneId === "pane-1");

    expect(childPane).toBeTruthy();
    act(() => {
      childPane!.onClosePane("pane-1");
    });

    expect(onPaneActiveSessionChange).toHaveBeenCalledTimes(1);
    expect(onPaneActiveSessionChange).toHaveBeenCalledWith(
      { workspacePath: "/workspace" },
      "main-session",
    );
  });

  it("does not sync read-only subagent pane focus into the shell active task", () => {
    createGroupedWorkbenchState({ readOnlyChild: true });
    const groupId = useWorkbenchGroupStore.getState().activeGroupId;
    expect(groupId).toBeTruthy();
    useWorkbenchGroupStore.getState().focusPane(groupId!, V4_PRIMARY_PANE_ID);
    const { onPaneActiveSessionChange } = renderWorkspace();
    const childPane = leafPaneCapture.props.find((props) => props.paneId === "pane-1");

    expect(childPane).toBeTruthy();
    act(() => {
      childPane!.onFocusRequest("pane-1");
    });

    expect(onPaneActiveSessionChange).not.toHaveBeenCalled();
  });
});
