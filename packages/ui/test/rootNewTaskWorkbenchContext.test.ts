import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRootWorkspaceActions } from "@/root/useRootWorkspaceActions.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  INITIAL_PANE_LAYOUT,
  V4_PRIMARY_PANE_ID,
  countPanes,
  usePaneLayoutStore,
} from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";

const mountedRoots: Root[] = [];

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

function resetState(): void {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  useZCodeSessionStore.setState((state) => ({
    ...state,
    workspaces: {},
  }));
  usePaneLayoutStore.setState({
    root: INITIAL_PANE_LAYOUT.root,
    panes: INITIAL_PANE_LAYOUT.panes,
    focusedPaneId: INITIAL_PANE_LAYOUT.focusedPaneId,
  });
  useWorkbenchGroupStore.getState().resetWorkbenchGroups();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
}

function renderRootActions({
  activeWorkspacePath = "/workspace-a",
  activeWorkspaceIdentity = null,
  workbenchGroupClientMode = "desktop-continuous",
}: {
  activeWorkspacePath?: string;
  activeWorkspaceIdentity?: string | null;
  workbenchGroupClientMode?: "desktop-continuous" | "web-remote-replayable";
} = {}) {
  let handleCreateTask: ((request?: CreateTaskRequest) => void) | null = null;
  let handleSelectConversationWorkspace: ((path: string) => void) | null = null;
  const tabState = {
    // 修复原因：新任务动作会在真实 tab store 上检查失效 workspace；测试 mock 也必须
    // 提供完整的只读判定输入，不能用缺失 tabs 的对象绕过生产契约。
    tabs: [],
    activeWorkspacePath,
    activeWorkspaceIdentity,
    activateTabByPath: vi.fn(
      (workspacePath: string, options?: { workspaceIdentity?: string }) => {
        tabState.activeWorkspacePath = workspacePath;
        tabState.activeWorkspaceIdentity = options?.workspaceIdentity ?? null;
        return true;
      },
    ),
  };
  const addTab = vi.fn((workspacePath: string, options?: { workspaceIdentity?: string }) => {
    tabState.activeWorkspacePath = workspacePath;
    tabState.activeWorkspaceIdentity = options?.workspaceIdentity ?? null;
  });

  function Probe() {
    const actions = useRootWorkspaceActions({
      intl: { formatMessage: ({ id }: { id: string }) => id },
      platform: {} as never,
      services: {} as never,
      tabStoreApi: { getState: () => tabState } as never,
      addTab,
      activeWorkspacePath: tabState.activeWorkspacePath,
      activeWorkspaceIdentity: tabState.activeWorkspaceIdentity,
      supportsSettings: true,
      allowOpenWorkspace: true,
      preferDirectoryBrowser: false,
      refreshProviderState: vi.fn(),
      updateAppSettings: vi.fn(),
      setOAuthError: vi.fn(),
      setUser: vi.fn(),
      workbenchGroupClientMode,
    });
    handleCreateTask = actions.handleCreateTask;
    handleSelectConversationWorkspace = actions.handleSelectConversationWorkspace;
    return createElement("span", null, "probe");
  }

  const root = createRoot(installMinimalDom());
  mountedRoots.push(root);
  act(() => {
    root.render(createElement(Probe));
  });
  return {
    addTab,
    getHandleCreateTask: () => {
      if (!handleCreateTask) {
        throw new Error("handleCreateTask was not captured");
      }
      return handleCreateTask;
    },
    getHandleSelectConversationWorkspace: () => {
      if (!handleSelectConversationWorkspace) {
        throw new Error("handleSelectConversationWorkspace was not captured");
      }
      return handleSelectConversationWorkspace;
    },
    tabState,
  };
}

function workspaceState(workspacePath: string, workspaceIdentity?: string) {
  return useZCodeSessionStore
    .getState()
    .getWorkspaceState(workspacePath, workspaceIdentity);
}

describe("root new task workbench context", () => {
  beforeEach(resetState);
  afterEach(resetState);

  it("creates the draft in the focused read-only subagent pane workspace and exits split view", () => {
    useZCodeSessionStore.getState().setActiveTaskId("/workspace-a", "main-session");
    useWorkbenchGroupStore.getState().splitSessionIntoGroup(
      V4_PRIMARY_PANE_ID,
      "right",
      {
        workspaceScope: {
          workspacePath: "/workspace-b",
          workspaceIdentity: "remote:ssh:dev:/workspace-b",
        },
        sessionId: "child-session",
        readOnly: true,
      },
      {
        workspaceScope: { workspacePath: "/workspace-a" },
        sessionId: "main-session",
      },
    );
    const { getHandleCreateTask, tabState } = renderRootActions();

    act(() => {
      getHandleCreateTask()();
    });

    expect(tabState.activeWorkspacePath).toBe("/workspace-b");
    expect(tabState.activeWorkspaceIdentity).toBe("remote:ssh:dev:/workspace-b");
    expect(workspaceState("/workspace-a").activeTaskId).toBe("main-session");
    expect(
      workspaceState("/workspace-b", "remote:ssh:dev:/workspace-b").activeTaskId,
    ).toBeNull();
    expect(
      workspaceState("/workspace-b", "remote:ssh:dev:/workspace-b").draftFocusVersion,
    ).toBe(1);
    expect(useWorkbenchGroupStore.getState().activeGroupId).toBeNull();
    expect(countPanes(usePaneLayoutStore.getState())).toBe(1);
  });

  it("creates the draft in a focused ordinary split pane workspace and resets to one panel", () => {
    useZCodeSessionStore.getState().setActiveTaskId("/workspace-a", "main-session");
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: { workspacePath: "/workspace-b" },
      sessionId: "session-b",
    });
    const { getHandleCreateTask, tabState } = renderRootActions();

    act(() => {
      getHandleCreateTask()();
    });

    expect(tabState.activeWorkspacePath).toBe("/workspace-b");
    expect(workspaceState("/workspace-a").activeTaskId).toBe("main-session");
    expect(workspaceState("/workspace-b").activeTaskId).toBeNull();
    expect(workspaceState("/workspace-b").draftFocusVersion).toBe(1);
    expect(countPanes(usePaneLayoutStore.getState())).toBe(1);
  });

  it("ignores a hidden workbench group when remote control creates a new task", () => {
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
        workspaceScope: {
          workspacePath: "/workspace-a",
          workspaceIdentity: "remote:ssh:dev:/workspace-a",
        },
        sessionId: "main-session",
      },
    );
    usePaneLayoutStore.getState().splitPaneWithBinding(V4_PRIMARY_PANE_ID, "right", {
      workspaceScope: {
        workspacePath: "/workspace-b",
        workspaceIdentity: "remote:ssh:dev:/workspace-b",
      },
      sessionId: "hidden-secondary-session",
    });
    const { getHandleCreateTask, tabState } = renderRootActions({
      activeWorkspaceIdentity: "remote:ssh:dev:/workspace-a",
      workbenchGroupClientMode: "web-remote-replayable",
    });

    act(() => {
      getHandleCreateTask()();
    });

    expect(tabState.activeWorkspacePath).toBe("/workspace-a");
    expect(tabState.activeWorkspaceIdentity).toBe("remote:ssh:dev:/workspace-a");
    expect(
      workspaceState("/workspace-a", "remote:ssh:dev:/workspace-a").activeTaskId,
    ).toBeNull();
  });

  it("preserves initial prompt trailing space in the targeted remote identity bucket", () => {
    const workspacePath = "/workspace-a";
    const workspaceIdentity = "remote:ssh:dev:/workspace-a";
    const otherWorkspaceIdentity = "remote:ssh:other:/workspace-a";
    const mention = {
      id: "skill:skill-creator",
      category: "skills" as const,
      label: "skill-creator",
      value: "skill-creator",
      markdown: "$skill-creator",
    };
    const { getHandleCreateTask } = renderRootActions({
      activeWorkspacePath: workspacePath,
      activeWorkspaceIdentity: workspaceIdentity,
    });

    act(() => {
      getHandleCreateTask()({
        initialPrompt: "$skill-creator ",
        initialPromptMention: mention,
      });
    });

    expect(workspaceState(workspacePath, workspaceIdentity).composerTextInsertRequest).toEqual({
      requestId: 1,
      text: "$skill-creator ",
      mention,
    });
    expect(
      workspaceState(workspacePath, otherWorkspaceIdentity).composerTextInsertRequest,
    ).toBeNull();
  });

  it("selects a conversation backing workspace without treating it as a project", () => {
    const { addTab, getHandleSelectConversationWorkspace } = renderRootActions();

    act(() => {
      getHandleSelectConversationWorkspace()("/Users/demo/.zcode/workspace/default");
    });

    expect(addTab).toHaveBeenCalledWith("/Users/demo/.zcode/workspace/default", {
      workspacePurpose: "conversation",
    });
  });
});
