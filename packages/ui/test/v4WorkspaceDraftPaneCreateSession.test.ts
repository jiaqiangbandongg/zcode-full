import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  leafPaneIds,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { V4WorkspaceChatArea } from "@/v4/V4WorkspaceChatArea.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

const sessionPaneCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));
const splitDividerCapture = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

const mountedRoots: Root[] = [];

vi.mock("@/v4/SessionPane.js", async () => {
  const React = await import("react");
  return {
    SessionPane: (props: Record<string, unknown>) => {
      sessionPaneCapture.props.push(props);
      return React.createElement("div", {
        "data-testid": "mock-session-pane",
        "data-pane-id": props.paneId,
      });
    },
  };
});

vi.mock("@/v4/V4ConversationContext.js", async () => {
  const React = await import("react");
  return {
    V4PaneConversationProvider: ({ children }: { children: ReactNode }) =>
      React.createElement("div", { "data-testid": "mock-provider" }, children),
  };
});

vi.mock("@/v4/WorkbenchSplitDivider.js", async () => {
  const React = await import("react");
  return {
    WorkbenchSplitDivider: (props: Record<string, unknown>) => {
      splitDividerCapture.props.push(props);
      return React.createElement("div", { "data-testid": "mock-divider" });
    },
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
  sessionPaneCapture.props = [];
  splitDividerCapture.props = [];
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

function renderWorkspace(
  sessionId: string | null,
  onPaneActiveSessionChange = vi.fn(),
  overrides: Partial<Parameters<typeof V4WorkspaceChatArea>[0]> = {},
): Root {
  const root = createRoot(installMinimalDom());
  mountedRoots.push(root);
  act(() => {
    root.render(
      createElement(V4WorkspaceChatArea, {
        sessionId,
        workspacePath: "/workspace",
        onPaneActiveSessionChange,
        ...overrides,
      }),
    );
  });
  return root;
}

function rerenderWorkspace(
  root: Root,
  sessionId: string | null,
  onPaneActiveSessionChange = vi.fn(),
  overrides: Partial<Parameters<typeof V4WorkspaceChatArea>[0]> = {},
): void {
  act(() => {
    root.render(
      createElement(V4WorkspaceChatArea, {
        sessionId,
        workspacePath: "/workspace",
        onPaneActiveSessionChange,
        ...overrides,
      }),
    );
  });
}

function callSessionCreated(props: Record<string, unknown>, sessionId: string): void {
  act(() => {
    (props.onSessionCreated as (createdSessionId: string) => void)(sessionId);
  });
}

function callClosePane(props: Record<string, unknown>): void {
  act(() => {
    (props.onClosePane as () => void)();
  });
}

function callSessionDeleted(props: Record<string, unknown>): void {
  act(() => {
    (props.onSessionDeleted as () => void)();
  });
}

function callCommitSplitRatio(ratio: number): void {
  const props = splitDividerCapture.props.at(-1);
  if (!props) {
    throw new Error("WorkbenchSplitDivider props not captured");
  }
  act(() => {
    (props.onCommitRatio as (splitId: string, ratio: number) => void)(
      props.splitId as string,
      ratio,
    );
  });
}

function clearCapturedSessionPaneProps(): void {
  sessionPaneCapture.props = [];
}

function capturedPaneIds(): unknown[] {
  return sessionPaneCapture.props.map((props) => props.paneId);
}

function expectTwoRenderedPanes(): void {
  expect(capturedPaneIds()).toEqual(
    expect.arrayContaining([V4_PRIMARY_PANE_ID, "pane-1"]),
  );
}

function sessionPaneProps(paneId: string): Record<string, unknown> {
  const props = sessionPaneCapture.props.find((candidate) => candidate.paneId === paneId);
  if (!props) {
    throw new Error(`SessionPane props not captured for ${paneId}`);
  }
  return props;
}

describe("V4WorkspaceChatArea split draft session creation", () => {
  beforeEach(resetWorkbenchState);
  afterEach(resetWorkbenchState);

  it("keeps the primary pane on the original session after a split draft creates a new session", () => {
    const onPaneActiveSessionChange = vi.fn();
    usePaneLayoutStore
      .getState()
      .splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "/workspace" });
    expect(leafPaneIds(usePaneLayoutStore.getState().root)).toEqual([
      V4_PRIMARY_PANE_ID,
      "pane-1",
    ]);

    const root = renderWorkspace("main-session", onPaneActiveSessionChange);
    expectTwoRenderedPanes();
    const draftPane = sessionPaneProps("pane-1");
    callSessionCreated(draftPane, "right-session");

    expect(onPaneActiveSessionChange).toHaveBeenCalledWith(
      { workspacePath: "/workspace" },
      "right-session",
    );

    clearCapturedSessionPaneProps();
    rerenderWorkspace(root, "right-session", onPaneActiveSessionChange);

    expect(sessionPaneProps(V4_PRIMARY_PANE_ID)).toMatchObject({
      sessionId: "main-session",
    });
    expect(sessionPaneProps("pane-1")).toMatchObject({
      sessionId: "right-session",
    });
  });

  it("transfers the promoted layout to the workbench group as the only owner", () => {
    usePaneLayoutStore.getState().splitPane(V4_PRIMARY_PANE_ID, "row", {
      workspacePath: "/workspace",
      workspaceIdentity: " remote:ssh:host:/workspace ",
      remoteSessionId: "remote-1",
    });
    const root = renderWorkspace("main-session", vi.fn(), {
      workspaceIdentity: " remote:ssh:host:/workspace ",
      remoteSessionId: "remote-1",
    });

    callSessionCreated(sessionPaneProps("pane-1"), "right-session");

    const activeGroupId = useWorkbenchGroupStore.getState().activeGroupId;
    expect(activeGroupId).not.toBeNull();
    expect(usePaneLayoutStore.getState().root).toEqual(INITIAL_PANE_LAYOUT.root);
    expect(useWorkbenchGroupStore.getState().groups[activeGroupId!]?.primaryBinding).toEqual({
      workspaceScope: {
        workspacePath: "/workspace",
        workspaceIdentity: " remote:ssh:host:/workspace ",
        remoteSessionId: "remote-1",
      },
      sessionId: "main-session",
    });

    clearCapturedSessionPaneProps();
    rerenderWorkspace(root, "right-session");
    expectTwoRenderedPanes();
  });

  it("commits the visible group divider ratio to the group owner", () => {
    usePaneLayoutStore
      .getState()
      .splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "/workspace" });
    const root = renderWorkspace("main-session");
    callSessionCreated(sessionPaneProps("pane-1"), "right-session");

    splitDividerCapture.props = [];
    clearCapturedSessionPaneProps();
    rerenderWorkspace(root, "right-session");
    callCommitSplitRatio(0.65);

    const groupState = useWorkbenchGroupStore.getState();
    const group = groupState.groups[groupState.activeGroupId!];
    expect(group?.root).toMatchObject({ type: "split", ratio: 0.65 });
    expect(group?.panes["pane-1"]?.sessionId).toBe("right-session");
    expect(usePaneLayoutStore.getState().root).toEqual(INITIAL_PANE_LAYOUT.root);
  });

  it("does not resurrect the consumed pane layout after closing the last group pane", () => {
    usePaneLayoutStore
      .getState()
      .splitPane(V4_PRIMARY_PANE_ID, "row", { workspacePath: "/workspace" });
    const root = renderWorkspace("main-session");
    callSessionCreated(sessionPaneProps("pane-1"), "right-session");

    clearCapturedSessionPaneProps();
    rerenderWorkspace(root, "right-session");
    callClosePane(sessionPaneProps("pane-1"));

    clearCapturedSessionPaneProps();
    rerenderWorkspace(root, "main-session");
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
    expect(usePaneLayoutStore.getState().root).toEqual(INITIAL_PANE_LAYOUT.root);
    expect(capturedPaneIds()).toEqual([V4_PRIMARY_PANE_ID]);
  });

  it("dissolves the group and notifies the shell when its primary session is deleted", () => {
    const onPaneActiveSessionChange = vi.fn();
    const onSessionDeleted = vi.fn(() => {
      expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
    });
    useWorkbenchGroupStore.getState().splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      {
        workspaceScope: {
          workspacePath: "/workspace-b",
          workspaceIdentity: "remote:ssh:dev:/workspace-b",
        },
        sessionId: "secondary-session",
      },
      {
        workspaceScope: { workspacePath: "/workspace" },
        sessionId: "main-session",
      },
    );
    renderWorkspace("main-session", onPaneActiveSessionChange, {
      onSessionDeleted,
    });

    callSessionDeleted(sessionPaneProps(V4_PRIMARY_PANE_ID));

    expect(onSessionDeleted).toHaveBeenCalledTimes(1);
    expect(onPaneActiveSessionChange).not.toHaveBeenCalled();
    expect(useWorkbenchGroupStore.getState().groups).toEqual({});
  });

  it("does not expose split controls in compact remote control mode", () => {
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "main-session",
    });
    useWorkbenchGroupStore.getState().splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      {
        workspaceScope: {
          workspacePath: "/remote/workspace",
          workspaceIdentity: "remote:ssh:host:/remote/workspace",
          remoteSessionId: "remote-1",
        },
        sessionId: "remote-right-session",
      },
      {
        workspaceScope: { workspacePath: "/workspace" },
        sessionId: "main-session",
      },
    );
    renderWorkspace("main-session", vi.fn(), { compactForRemoteControl: true });

    const primary = sessionPaneProps(V4_PRIMARY_PANE_ID);
    expect(primary.sessionId).toBe("main-session");
    expect(primary.onSplitRight).toBeUndefined();
    expect(primary.onSplitDown).toBeUndefined();
    expect(capturedPaneIds()).toEqual([V4_PRIMARY_PANE_ID]);
  });

  it("keeps the primary pane as draft when a sidebar session is dropped beside a draft", () => {
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "right-session",
    });

    renderWorkspace("right-session");
    expectTwoRenderedPanes();

    expect(sessionPaneProps(V4_PRIMARY_PANE_ID)).toMatchObject({
      sessionId: null,
    });
    expect(sessionPaneProps("pane-1")).toMatchObject({
      sessionId: "right-session",
    });
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
  });

  it("atomically promotes a primary draft beside an existing session into a workbench group", () => {
    const onSessionCreated = vi.fn();
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/workspace-b" },
      sessionId: "right-session",
    });

    const root = renderWorkspace(null, vi.fn(), { onSessionCreated });
    expect(sessionPaneProps(V4_PRIMARY_PANE_ID)).toMatchObject({ sessionId: null });

    callSessionCreated(sessionPaneProps(V4_PRIMARY_PANE_ID), "left-session");

    expect(onSessionCreated).toHaveBeenCalledWith("left-session");
    const groupState = useWorkbenchGroupStore.getState();
    const activeGroup = groupState.activeGroupId
      ? groupState.groups[groupState.activeGroupId]
      : null;
    expect(activeGroup?.primaryBinding).toEqual({
      workspaceScope: { workspacePath: "/workspace" },
      sessionId: "left-session",
    });
    expect(activeGroup?.panes["pane-1"]).toEqual({
      workspaceScope: { workspacePath: "/workspace-b" },
      sessionId: "right-session",
    });
    expect(usePaneLayoutStore.getState().root).toEqual(INITIAL_PANE_LAYOUT.root);

    clearCapturedSessionPaneProps();
    // 模拟随后 focus B 导致 shell activeTaskId 切到 B；primary 必须继续由 group binding 固定 A′。
    rerenderWorkspace(root, "right-session", vi.fn(), { workspacePath: "/workspace-b" });
    expect(sessionPaneProps(V4_PRIMARY_PANE_ID)).toMatchObject({ sessionId: "left-session" });
    expect(sessionPaneProps("pane-1")).toMatchObject({ sessionId: "right-session" });
  });
});
