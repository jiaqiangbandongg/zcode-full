// timeline/pinned/archived 查询路径：tasks-index 提供持久行与 membership，
// sessions-index 只补充实时 activity/detail。验证 kind 过滤与字段权威边界；
// 纯本地无搜索场景旧 listTaskList 零调用；搜索场景回落旧全文检索路径。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor, ZCodeTaskListKind } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "s-1",
    workspaceId: "ws-1",
    title: "Session 1",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 2,
    createdAt: 1,
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

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    createdAt: 1,
    mode: "default",
    taskId: "s-1",
    title: "Task 1",
    traceId: "trace-s-1",
    updatedAt: 2,
    workspacePath: "/workspace",
    ...overrides,
  } as ZCodeTaskMeta;
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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function snapshotFrame(sessions: SessionSummary[]): SessionsIndexTopicFrame {
  return {
    topic: "sessions-index//workspace",
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: { protocolVersion: 1, workspaceId: "ws-1", logEpoch: "e1", sessions },
    },
  };
}

let logicalFrameSerial = 0;
function physicalFrame(
  frame: SessionsIndexTopicFrame,
  deliveryKind: "initial" | "online" = "online",
): SessionsIndexTopicWireFrame {
  logicalFrameSerial += 1;
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `logical-global-local-${logicalFrameSerial}`,
    logicalFrameOrdinal: logicalFrameSerial,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

interface HarnessOptions {
  kind: ZCodeTaskListKind;
  expanded?: boolean;
  searchQuery?: string;
  sessions: SessionSummary[];
  pinnedIds?: string[];
  archivedTaskIds?: string[];
  activeTaskMetas?: ZCodeTaskMeta[];
  archivedTaskMetas?: ZCodeTaskMeta[];
  pinnedTaskMetas?: ZCodeTaskMeta[];
}

function v4Handshake() {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId: "connection-local",
      clientMode: "desktop-continuous" as const,
      deliveryProfile: "continuous" as const,
      serverTime: 1,
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none" as const,
      },
      auth: {},
    })),
    initializeConversationV4: vi.fn(async () => {}),
    resyncSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => ({
      ack: { subscriptionId: params.subscriptionId, mode: "snapshot" as const, logEpoch: "e1" },
    })),
    onAgentRuntimeRestarted: runtimeRestarts.event,
  };
}

async function renderHarness(options: HarnessOptions) {
  const listTaskList = vi.fn(async () => ({ items: [], total: 0, hasMore: false }));
  const frameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> = [];
  const archivedIds = new Set(options.archivedTaskIds ?? []);
  const pinnedIds = new Set(options.pinnedIds ?? []);
  const defaultTaskMetas = options.sessions.map((session) =>
    createTaskMeta({
      createdAt: session.createdAt,
      taskId: session.sessionId,
      title: session.title,
      traceId: `trace-${session.sessionId}`,
      updatedAt: session.lastActivityAt,
    }),
  );
  const activeTaskMetas =
    options.activeTaskMetas ??
    defaultTaskMetas.filter(
      (task) => !pinnedIds.has(task.taskId) && !archivedIds.has(task.taskId),
    );
  const pinnedTaskMetas =
    options.pinnedTaskMetas ??
    defaultTaskMetas.filter(
      (task) => pinnedIds.has(task.taskId) && !archivedIds.has(task.taskId),
    );
  const archivedTaskMetas =
    options.archivedTaskMetas ??
    (options.archivedTaskIds ?? []).map((taskId) =>
      createTaskMeta({ taskId, title: taskId, traceId: `trace-${taskId}` }),
    );
  const controllerFrames = new Emitter<never>();
  const controllerListTaskList = vi.fn(async (params: { kind: ZCodeTaskListKind; search?: string; limit?: number }) => {
    if (params.search) {
      return listTaskList();
    }
    const rows =
      params.kind === "pinned"
        ? pinnedTaskMetas
        : params.kind === "archived"
          ? archivedTaskMetas
          : params.kind === "active"
            ? [...activeTaskMetas, ...pinnedTaskMetas]
            : activeTaskMetas;
    const sessionById = new Map(options.sessions.map((session) => [session.sessionId, session]));
    const items = rows
      .map((task) => {
        const session = sessionById.get(task.taskId);
        return {
          ...task,
          ...(session
            ? {
                title: session.title,
                updatedAt: session.lastActivityAt,
                status:
                  session.phase === "completedSuccess"
                    ? ("completed" as const)
                    : session.phase === "completedError"
                      ? ("error" as const)
                      : task.status,
              }
            : {}),
          sourceAvailability: "online" as const,
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const visible = params.limit == null ? items : items.slice(0, params.limit);
    return { items: visible, total: items.length, hasMore: items.length > visible.length };
  });
  const services = {
    windowControllerService: {
      listTaskList: controllerListTaskList,
      mutateTask: vi.fn(async () => null),
      subscribeControllerV4: vi.fn(async ({ topic }: { topic: string }) => ({
        ack: { subscriptionId: `sub-${topic}`, mode: "snapshot" as const, logEpoch: "e1" },
      })),
      resyncControllerV4: vi.fn(async ({ subscriptionId }: { subscriptionId: string }) => ({
        ack: { subscriptionId, mode: "snapshot" as const, logEpoch: "e1" },
      })),
      unsubscribeControllerV4: vi.fn(async () => {}),
      onDynamicControllerFrame: () => controllerFrames.event,
    },
    zcodeTaskService: {
      listTaskList,
      listPinnedTaskIds: vi.fn(async () => options.pinnedIds ?? []),
      listArchivedTasks: vi.fn(async () => archivedTaskMetas),
      listTasks: vi.fn(async () => activeTaskMetas),
      listPinnedTasks: vi.fn(async () => pinnedTaskMetas),
      onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
    },
    zcodeAgentService: {
      ...v4Handshake(),
      subscribeSessionsIndexV4: vi.fn(async () => {
        const initial = snapshotFrame(options.sessions);
        for (const listener of frameListeners) listener(physicalFrame(initial, "initial"));
        return {
          ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "e1" },
        };
      }),
      unsubscribeSessionsIndexV4: vi.fn(async () => {}),
      onDynamicSessionsIndexFrame:
        () => (listener: (frame: SessionsIndexTopicWireFrame) => void) => {
          frameListeners.push(listener);
          return { dispose: () => {} };
        },
    },
  } as unknown as IServiceAccessor;
  const workspaceTabs = [createWorkspaceTab()];
  let latest: ReturnType<typeof useGlobalTaskList> | null = null;

  function Probe() {
    latest = useGlobalTaskList({
      collapsedLimit: 5,
      expanded: options.expanded ?? false,
      kind: options.kind,
      searchQuery: options.searchQuery ?? "",
      sortBy: "updated",
      workspaceTabs,
    });
    return null;
  }

  const root: Root = createRoot(installMinimalDom());
  await act(async () => {
    root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
    await flushMicrotasks();
  });
  await act(async () => {
    await flushMicrotasks();
  });
  return {
    getItems: () => latest?.items ?? [],
    listTaskList,
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

describe("useGlobalTaskList tasks-index 行 + sessions-index detail", () => {
  afterEach(() => {
    useTaskQueryCacheStore.getState().clearAll();
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspaceIdentity: {},
      sessionIdByWorkspacePath: {},
    });
    useZCodeSessionStore.setState({ workspaces: {} });
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("timeline：行来自 tasks-index，排除 pinned/archived，listTaskList 零调用", async () => {
    const harness = await renderHarness({
      kind: "timeline",
      sessions: [
        createSession({ sessionId: "s-1", lastActivityAt: 10 }),
        createSession({ sessionId: "s-2", lastActivityAt: 30 }),
        createSession({ sessionId: "s-3", lastActivityAt: 20 }),
      ],
      pinnedIds: ["s-2"],
      archivedTaskIds: ["s-3"],
    });
    expect(harness.getItems().map((task) => task.taskId)).toEqual(["s-1"]);
    expect(harness.listTaskList).not.toHaveBeenCalled();
    harness.unmount();
  });

  it("timeline：从 tasks-index membership join 未读，但实时状态归 sessions-index", async () => {
    const harness = await renderHarness({
      kind: "timeline",
      sessions: [createSession({ sessionId: "s-1", phase: "completedSuccess" })],
      activeTaskMetas: [createTaskMeta({ taskId: "s-1", unreadAt: 123, status: "error" })],
    });
    const item = harness.getItems()[0];

    expect(item?.taskId).toBe("s-1");
    expect(item?.unreadAt).toBe(123);
    expect(item?.status).toBe("completed");
    expect(harness.listTaskList).not.toHaveBeenCalled();
    harness.unmount();
  });

  it("pinned：只含 pinned 且非 archived", async () => {
    const harness = await renderHarness({
      kind: "pinned",
      sessions: [
        createSession({ sessionId: "s-1" }),
        createSession({ sessionId: "s-2", lastActivityAt: 5 }),
      ],
      pinnedIds: ["s-1", "s-2"],
      archivedTaskIds: ["s-2"],
    });
    expect(harness.getItems().map((task) => task.taskId)).toEqual(["s-1"]);
    expect(harness.listTaskList).not.toHaveBeenCalled();
    harness.unmount();
  });

  it("archived：只含 archived", async () => {
    const harness = await renderHarness({
      kind: "archived",
      sessions: [
        createSession({ sessionId: "s-1" }),
        createSession({ sessionId: "s-2", lastActivityAt: 5 }),
      ],
      archivedTaskIds: ["s-2"],
    });
    expect(harness.getItems().map((task) => task.taskId)).toEqual(["s-2"]);
    expect(harness.listTaskList).not.toHaveBeenCalled();
    harness.unmount();
  });

  it("tasks-index 有 25 行而 sessions-index 仅有 5 条摘要时，timeline 仍保留 25 行", async () => {
    const taskMetas = Array.from({ length: 25 }, (_, index) => {
      const taskId = `task-${String(index + 1).padStart(2, "0")}`;
      return createTaskMeta({ taskId, traceId: `trace-${taskId}`, updatedAt: index + 1 });
    });
    const harness = await renderHarness({
      kind: "timeline",
      expanded: true,
      sessions: taskMetas.slice(0, 5).map((task) =>
        createSession({
          sessionId: task.taskId,
          lastActivityAt: task.updatedAt + 100,
          title: `Live ${task.taskId}`,
        }),
      ),
      activeTaskMetas: taskMetas,
    });

    expect(harness.getItems()).toHaveLength(25);
    expect(harness.getItems().some((task) => task.taskId === "task-25")).toBe(true);
    harness.unmount();
  });

  it("搜索场景回落旧 listTaskList（全文检索/snippets 依赖 sqlite）", async () => {
    const harness = await renderHarness({
      kind: "active",
      searchQuery: "hello",
      sessions: [createSession({ sessionId: "s-1" })],
    });
    expect(harness.listTaskList).toHaveBeenCalled();
    harness.unmount();
  });
});
