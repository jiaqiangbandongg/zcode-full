import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";

const { activeWorkspaceState } = vi.hoisted(() => ({
  activeWorkspaceState: {
    current: {
      optimisticTaskListByTaskId: {} as Record<string, ZCodeTaskMeta>,
      taskListCache: [] as ZCodeTaskMeta[],
      taskMessagesByTaskId: {} as Record<string, unknown[]>,
    },
  },
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  getTaskMessages: (
    workspaceState: { taskMessagesByTaskId?: Record<string, unknown[]> },
    taskId: string,
  ) => workspaceState.taskMessagesByTaskId?.[taskId] ?? [],
  getTaskMeta: (
    workspaceState: {
      optimisticTaskListByTaskId?: Record<string, ZCodeTaskMeta>;
      taskListCache?: ZCodeTaskMeta[];
    },
    taskId: string,
  ) =>
    workspaceState.optimisticTaskListByTaskId?.[taskId] ??
    workspaceState.taskListCache?.find((task) => task.taskId === taskId) ??
    null,
  selectWorkspaceZCodeState: () => activeWorkspaceState.current,
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({}),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  useTaskQueryCacheStore: (selector: (state: { taskMetaByEntityKey: {} }) => unknown) =>
    selector({ taskMetaByEntityKey: {} }),
}));

vi.mock("@/hooks/useActiveTaskSnapshotMeta.js", () => ({
  useActiveTaskSnapshotMeta: () => null,
}));

vi.mock("@/hooks/useTaskNativeSessionLogFile.js", () => ({
  useTaskNativeSessionLogFile: () => ({
    exists: false,
    loading: false,
    path: null,
    provider: null,
  }),
}));

vi.mock("@/hooks/useTaskSessionFilePath.js", () => ({
  useTaskSessionFilePath: () => ({
    exists: false,
    loading: false,
    path: null,
  }),
}));

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
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

describe("useWorkspaceActiveTaskState", () => {
  afterEach(() => {
    activeWorkspaceState.current = {
      optimisticTaskListByTaskId: {},
      taskListCache: [],
      taskMessagesByTaskId: {},
    };
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reuses resolvedActiveTaskMeta reference when stream updates keep meta fields equal", () => {
    const observedMetas: Array<ZCodeTaskMeta | null | undefined> = [];
    const root: Root = createRoot(installMinimalDom());

    function Probe({ renderId }: { renderId: number }) {
      const result = useWorkspaceActiveTaskState({
        activeTaskId: "task-1",
        intl: {
          formatMessage: ({ id }: { id: string }) => id,
        },
        selectedProvider: "codex",
        workspaceAbsPath: "/workspace",
      });
      observedMetas.push(result.resolvedActiveTaskMeta);
      return createElement("span", null, renderId);
    }

    activeWorkspaceState.current = {
      optimisticTaskListByTaskId: {},
      taskListCache: [createTaskMeta()],
      taskMessagesByTaskId: {},
    };
    act(() => {
      root.render(createElement(Probe, { renderId: 1 }));
    });

    activeWorkspaceState.current = {
      optimisticTaskListByTaskId: {},
      taskListCache: [createTaskMeta()],
      taskMessagesByTaskId: {
        "task-1": [{ id: "stream-update" }],
      },
    };
    act(() => {
      root.render(createElement(Probe, { renderId: 2 }));
    });

    expect(observedMetas).toHaveLength(2);
    expect(observedMetas[1]).toBe(observedMetas[0]);

    act(() => {
      root.unmount();
    });
  });
});
