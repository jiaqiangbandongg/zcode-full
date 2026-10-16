// remote shard（web/手机远控/SSH workspace）也以各 endpoint 的 tasks-index
// 持久行为列表左表，sessions-index 帧只补 activity/detail；旧 listTaskList 零调用。
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useSessionsMentionProvider } from "@/mentions/providers/sessionsMentionProvider.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildWorkspaceSessionsIndexSourceKey,
  useWorkspaceSessionsIndexItems,
  type WorkspaceSessionsIndexScope,
} from "@/v4/useWorkspaceSessionsIndexItems.js";

const REMOTE_IDENTITY = "host-a:/remote-ws";
const REMOTE_SESSION_ID = "remote-session-1";

function createSession(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    sessionId: "s-local-1",
    workspaceId: "ws-1",
    title: "Session",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 2,
    createdAt: 1,
    ...overrides,
  };
}

function createTaskMeta(
  taskId: string,
  overrides: Partial<ZCodeTaskMeta> = {},
): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/workspace",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
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

function snapshotFrame(
  workspaceId: string,
  sessions: SessionSummary[],
): SessionsIndexTopicFrame {
  return {
    topic: `sessions-index/${workspaceId}`,
    subscriptionId: `sub-${workspaceId}`,
    fromSeq: 0,
    toSeq: 1,
    sentAt: 1,
    payload: {
      kind: "snapshot",
      snapshot: { protocolVersion: 1, workspaceId, logEpoch: "e1", sessions },
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
    logicalFrameId: `logical-global-remote-${logicalFrameSerial}`,
    logicalFrameOrdinal: logicalFrameSerial,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

interface EndpointMockOptions {
  workspaceId: string;
  sessions: SessionSummary[];
  sessionsByWorkspaceKey?: Record<string, SessionSummary[]>;
  pinnedTaskIds?: string[];
  /** listTasks 返回的 tasks-index 持久行。 */
  activeTaskMetas?: ZCodeTaskMeta[];
  pinnedTaskMetas?: ZCodeTaskMeta[];
  /** 用于覆盖 ACK 延迟期间 scope 集合变化的竞态。 */
  subscribeGate?: Promise<void>;
  subscribeGatesByWorkspaceKey?: Record<string, Promise<void>>;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((currentResolve) => {
    resolve = currentResolve;
  });
  return { promise, resolve };
}

function v4Handshake(connectionId: string) {
  const runtimeRestarts = new Emitter<{ workspaceKey: string }>();
  return {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello" as const,
      protocolVersion: 3 as const,
      connectionId,
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
    resyncSessionsIndexV4: vi.fn(
      async (params: { subscriptionId: string }) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot" as const,
          logEpoch: "e1",
        },
      }),
    ),
    onAgentRuntimeRestarted: runtimeRestarts.event,
  };
}

function createEndpointServices(options: EndpointMockOptions) {
  const frameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> =
    [];
  const listTaskList = vi.fn(async () => ({
    items: [],
    total: 0,
    hasMore: false,
  }));
  const subscribeSessionsIndexV4 = vi.fn(
    async (params: { workspacePath: string; workspaceIdentity?: string }) => {
      const workspaceKey =
        params.workspaceIdentity?.trim() || params.workspacePath;
      const subscriptionId = options.sessionsByWorkspaceKey
        ? `sub-${workspaceKey}`
        : `sub-${options.workspaceId}`;
      const ack = {
        subscriptionId,
        mode: "snapshot" as const,
        logEpoch: "e1",
      };
      await (options.subscribeGatesByWorkspaceKey?.[workspaceKey] ??
        options.subscribeGate);
      const initial = {
        ...snapshotFrame(
          workspaceKey,
          options.sessionsByWorkspaceKey?.[workspaceKey] ?? options.sessions,
        ),
        subscriptionId,
        topic: `sessions-index/${workspaceKey}`,
      };
      for (const listener of frameListeners)
        listener(physicalFrame(initial, "initial"));
      return { ack };
    },
  );
  const unsubscribeSessionsIndexV4 = vi.fn(async () => {});
  const defaultTaskMetasForScope = (params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): ZCodeTaskMeta[] => {
    const workspaceKey =
      params.workspaceIdentity?.trim() || params.workspacePath;
    const sessions =
      options.sessionsByWorkspaceKey?.[workspaceKey] ?? options.sessions;
    return sessions.map((session) =>
      createTaskMeta(session.sessionId, {
        createdAt: session.createdAt,
        title: session.title,
        updatedAt: session.lastActivityAt,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity
          ? { workspaceIdentity: params.workspaceIdentity }
          : {}),
      }),
    );
  };
  const pinnedIds = new Set(options.pinnedTaskIds ?? []);
  const controllerFrames = new Emitter<never>();
  const controllerListTaskList = vi.fn(
    async (params: {
      kind: "pinned" | "archived" | "timeline" | "active";
      workspaceScopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
      limit?: number;
    }) => {
      const rows = params.workspaceScopes.flatMap((scope) => {
        const sourceRows =
          options.activeTaskMetas ?? defaultTaskMetasForScope(scope);
        const filtered = sourceRows.filter((task) => {
          const pinned = pinnedIds.has(task.taskId);
          if (params.kind === "pinned") return pinned;
          if (params.kind === "archived") return false;
          if (params.kind === "timeline") return !pinned;
          return true;
        });
        return filtered.map((task) => ({
          ...task,
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity
            ? { workspaceIdentity: scope.workspaceIdentity, remoteSessionId: REMOTE_SESSION_ID }
            : {}),
          sourceAvailability: "online" as const,
        }));
      });
      rows.sort((left, right) => right.updatedAt - left.updatedAt);
      const items = params.limit == null ? rows : rows.slice(0, params.limit);
      return { items, total: rows.length, hasMore: rows.length > items.length };
    },
  );
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
      listPinnedTaskIds: vi.fn(
        async (): Promise<string[]> => options.pinnedTaskIds ?? [],
      ),
      listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
      listTasks: vi.fn(
        async (params: { workspacePath: string; workspaceIdentity?: string }) =>
          options.activeTaskMetas ??
          defaultTaskMetasForScope(params).filter(
            (task) => !pinnedIds.has(task.taskId),
          ),
      ),
      listPinnedTasks: vi.fn(
        async (params: { workspacePath: string; workspaceIdentity?: string }) =>
          options.pinnedTaskMetas ??
          defaultTaskMetasForScope(params).filter((task) =>
            pinnedIds.has(task.taskId),
          ),
      ),
      onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
    },
    zcodeAgentService: {
      ...v4Handshake(`connection-${options.workspaceId}`),
      subscribeSessionsIndexV4,
      unsubscribeSessionsIndexV4,
      onDynamicSessionsIndexFrame:
        () => (listener: (frame: SessionsIndexTopicWireFrame) => void) => {
          frameListeners.push(listener);
          return { dispose: () => {} };
        },
    },
  } as unknown as IServiceAccessor;
  return {
    services,
    frameListeners,
    listTaskList,
    subscribeSessionsIndexV4,
    unsubscribeSessionsIndexV4,
    controllerListTaskList,
  };
}

function createWorkspaceTabs(): WorkspaceTabState[] {
  return [
    {
      id: "workspace-local",
      kind: "workspace",
      label: "local",
      workspacePath: "/workspace",
    },
    {
      id: "workspace-remote",
      kind: "workspace",
      label: "remote",
      workspacePath: "/remote-ws",
      workspaceIdentity: REMOTE_IDENTITY,
      remoteSessionId: REMOTE_SESSION_ID,
    } as WorkspaceTabState,
  ];
}

function WorkspaceTabsSeed({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  children,
  tabs,
}: {
  activeWorkspaceIdentity?: string;
  activeWorkspacePath: string;
  children: ReactNode;
  tabs: WorkspaceTabState[];
}) {
  const store = useTabStoreApi();
  if (store.getState().tabs.length === 0) {
    const activeTab = tabs.find(
      (tab) =>
        (tab.workspaceIdentity?.trim() || tab.workspacePath) ===
        (activeWorkspaceIdentity?.trim() || activeWorkspacePath),
    );
    store.setState({
      tabs,
      activeTabId: activeTab?.id ?? null,
      activeWorkspacePath,
      activeWorkspaceIdentity: activeWorkspaceIdentity ?? null,
    });
  }
  return children;
}

describe("useGlobalTaskList remote shard tasks-index 行 + sessions-index detail", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("remote A 已就绪后分步追加并移除 ACK 延迟的 remote B，不重启 A", async () => {
    const zcodeAck = createDeferred();
    const base = createEndpointServices({
      workspaceId: "ws-base",
      sessions: [],
    });
    const macIdentity = "remote:ssh:mac:/Users/dev";
    const macProjectIdentity = "remote:ssh:mac:/Users/dev/ZCodeProject";
    const mac = createEndpointServices({
      workspaceId: "ws-mac",
      sessions: [],
      sessionsByWorkspaceKey: {
        [macIdentity]: [
          createSession({
            sessionId: "s-mac",
            workspaceId: macIdentity,
            lastActivityAt: 10,
          }),
        ],
        [macProjectIdentity]: [
          createSession({
            sessionId: "s-mac-project",
            workspaceId: macProjectIdentity,
            lastActivityAt: 20,
          }),
        ],
      },
    });
    const zcodeIdentity = "remote:ssh:zcode:/root";
    const zcodeProjectIdentity = "remote:ssh:zcode:/root/demo-project";
    const zcode = createEndpointServices({
      workspaceId: "ws-zcode",
      sessions: [],
      sessionsByWorkspaceKey: {
        [zcodeIdentity]: [
          createSession({
            sessionId: "s-zcode",
            workspaceId: zcodeIdentity,
            lastActivityAt: 30,
          }),
        ],
        [zcodeProjectIdentity]: [
          createSession({
            sessionId: "s-zcode-project",
            workspaceId: zcodeProjectIdentity,
            lastActivityAt: 40,
          }),
        ],
      },
      subscribeGate: zcodeAck.promise,
    });
    const macScope: WorkspaceSessionsIndexScope = {
      endpointKey: "remote-mac",
      workspacePath: "/Users/dev",
      workspaceIdentity: macIdentity,
      agentService: mac.services.zcodeAgentService,
    };
    const macProjectScope: WorkspaceSessionsIndexScope = {
      endpointKey: "remote-mac",
      workspacePath: "/Users/dev/ZCodeProject",
      workspaceIdentity: macProjectIdentity,
      agentService: mac.services.zcodeAgentService,
    };
    const zcodeScope: WorkspaceSessionsIndexScope = {
      endpointKey: "remote-zcode",
      workspacePath: "/root",
      workspaceIdentity: zcodeIdentity,
      agentService: zcode.services.zcodeAgentService,
    };
    const zcodeProjectScope: WorkspaceSessionsIndexScope = {
      endpointKey: "remote-zcode",
      workspacePath: "/root/demo-project",
      workspaceIdentity: zcodeProjectIdentity,
      agentService: zcode.services.zcodeAgentService,
    };
    let scopes: WorkspaceSessionsIndexScope[] = [macScope, macProjectScope];
    let latest: ReturnType<typeof useWorkspaceSessionsIndexItems> | null = null;

    function Probe() {
      latest = useWorkspaceSessionsIndexItems(scopes);
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: base.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    expect(mac.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-mac-project",
      "s-mac",
    ]);

    const macSourceKey = buildWorkspaceSessionsIndexSourceKey(macScope);
    const macProjectSourceKey =
      buildWorkspaceSessionsIndexSourceKey(macProjectScope);
    const macRevisionBefore = latest?.sourceRevisionByScopeKey[macSourceKey];
    const macProjectRevisionBefore =
      latest?.sourceRevisionByScopeKey[macProjectSourceKey];
    await act(async () => {
      const macDelta: SessionsIndexTopicFrame = {
        topic: `sessions-index/${macIdentity}`,
        subscriptionId: `sub-${macIdentity}`,
        fromSeq: 1,
        toSeq: 2,
        sentAt: 2,
        payload: {
          kind: "deltas",
          deltas: [
            {
              op: "session.upserted",
              session: createSession({
                sessionId: "s-mac",
                workspaceId: macIdentity,
                lastActivityAt: 15,
              }),
            },
          ],
        },
      };
      for (const listener of mac.frameListeners)
        listener(physicalFrame(macDelta));
      await flushMicrotasks();
    });
    expect(latest?.sourceRevisionByScopeKey[macSourceKey]).not.toBe(
      macRevisionBefore,
    );
    expect(latest?.sourceRevisionByScopeKey[macProjectSourceKey]).toBe(
      macProjectRevisionBefore,
    );

    scopes = [macScope, macProjectScope, zcodeScope];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: base.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });

    expect(mac.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(mac.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(zcode.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(latest?.hydratingEndpointKeys).toEqual(["remote-zcode"]);
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-mac-project",
      "s-mac",
    ]);

    scopes = [macScope, macProjectScope, zcodeScope, zcodeProjectScope];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: base.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    expect(mac.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(mac.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(zcode.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);

    await act(async () => {
      zcodeAck.resolve();
      await flushMicrotasks();
    });
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-zcode-project",
      "s-zcode",
      "s-mac-project",
      "s-mac",
    ]);

    scopes = [macScope, macProjectScope];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: base.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    expect(zcode.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(mac.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-mac-project",
      "s-mac",
    ]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    expect(mac.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
  });

  it("local __base__ 与 remote 集合增删时只 acquire/release 变化的 remote scope", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local-stable",
      sessions: [
        createSession({
          sessionId: "s-local-stable",
          workspaceId: "ws-local-stable",
          lastActivityAt: 10,
        }),
      ],
    });
    const remote = createEndpointServices({
      workspaceId: "ws-remote-added",
      sessions: [
        createSession({
          sessionId: "s-remote-added",
          workspaceId: "ws-remote-added",
          lastActivityAt: 20,
        }),
      ],
    });
    const localScope: WorkspaceSessionsIndexScope = {
      workspacePath: "/workspace",
      agentService: local.services.zcodeAgentService,
    };
    const remoteScope: WorkspaceSessionsIndexScope = {
      endpointKey: "remote-added",
      workspacePath: "/remote-added",
      workspaceIdentity: "remote:ssh:added:/remote-added",
      agentService: remote.services.zcodeAgentService,
    };
    let scopes: WorkspaceSessionsIndexScope[] = [localScope];
    let latest: ReturnType<typeof useWorkspaceSessionsIndexItems> | null = null;

    function Probe() {
      latest = useWorkspaceSessionsIndexItems(scopes);
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });

    scopes = [localScope, remoteScope];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-remote-added",
      "s-local-stable",
    ]);

    scopes = [localScope];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    expect(remote.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-local-stable",
    ]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    expect(local.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
  });

  it("local pinned 新增 workspace scope 时保留已有任务，不发布空中间帧", async () => {
    const addedWorkspaceAck = createDeferred();
    const local = createEndpointServices({
      workspaceId: "ws-local-pinned-scope",
      sessions: [],
      sessionsByWorkspaceKey: {
        "/workspace-a": [
          createSession({
            sessionId: "s-pinned-a",
            workspaceId: "/workspace-a",
            lastActivityAt: 10,
          }),
        ],
        "/workspace-b": [
          createSession({
            sessionId: "s-pinned-b",
            workspaceId: "/workspace-b",
            lastActivityAt: 20,
          }),
        ],
      },
      pinnedTaskIds: ["s-pinned-a", "s-pinned-b"],
      subscribeGatesByWorkspaceKey: {
        "/workspace-b": addedWorkspaceAck.promise,
      },
    });
    const workspaceA: WorkspaceTabState = {
      id: "workspace-a",
      kind: "workspace",
      label: "workspace-a",
      workspacePath: "/workspace-a",
    };
    const workspaceB: WorkspaceTabState = {
      id: "workspace-b",
      kind: "workspace",
      label: "workspace-b",
      workspacePath: "/workspace-b",
    };
    let workspaceTabs = [workspaceA];
    let latest: ReturnType<typeof useGlobalTaskList> | null = null;
    const renderStates: string[][] = [];

    function Probe() {
      latest = useGlobalTaskList({
        collapsedLimit: 20,
        expanded: true,
        kind: "pinned",
        searchQuery: "",
        sortBy: "updated",
        workspaceTabs,
      });
      renderStates.push((latest?.items ?? []).map((item) => item.taskId));
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-pinned-a",
    ]);

    const renderCountBeforeScopeAdd = renderStates.length;
    workspaceTabs = [workspaceA, workspaceB];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });

    const scopeAddStates = renderStates.slice(renderCountBeforeScopeAdd);
    expect(scopeAddStates.length).toBeGreaterThan(0);
    expect(
      scopeAddStates.every((taskIds) => taskIds.includes("s-pinned-a")),
    ).toBe(true);

    await act(async () => {
      addedWorkspaceAck.resolve();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-pinned-b",
      "s-pinned-a",
    ]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it("remote service generation 换代只替换目标 scope，local __base__ 保持订阅", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local-generation",
      sessions: [
        createSession({
          sessionId: "s-local-generation",
          workspaceId: "ws-local-generation",
          lastActivityAt: 10,
        }),
      ],
    });
    const remoteOld = createEndpointServices({
      workspaceId: "ws-remote-old",
      sessions: [
        createSession({
          sessionId: "s-remote-old",
          workspaceId: "ws-remote-old",
          lastActivityAt: 20,
        }),
      ],
    });
    const remoteNew = createEndpointServices({
      workspaceId: "ws-remote-new",
      sessions: [
        createSession({
          sessionId: "s-remote-new",
          workspaceId: "ws-remote-new",
          lastActivityAt: 30,
        }),
      ],
    });
    const localScope: WorkspaceSessionsIndexScope = {
      workspacePath: "/workspace-generation",
      agentService: local.services.zcodeAgentService,
    };
    const remoteScopeBase = {
      endpointKey: "remote-generation",
      workspacePath: "/remote-generation",
      workspaceIdentity: "remote:ssh:generation:/remote-generation",
    };
    let scopes: WorkspaceSessionsIndexScope[] = [
      localScope,
      {
        ...remoteScopeBase,
        agentService: remoteOld.services.zcodeAgentService,
      },
    ];
    let latest: ReturnType<typeof useWorkspaceSessionsIndexItems> | null = null;

    function Probe() {
      latest = useWorkspaceSessionsIndexItems(scopes);
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });

    scopes = [
      localScope,
      {
        ...remoteScopeBase,
        agentService: remoteNew.services.zcodeAgentService,
      },
    ];
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });

    expect(remoteOld.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(remoteNew.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.unsubscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect((latest?.items ?? []).map((item) => item.taskId)).toEqual([
      "s-remote-new",
      "s-local-generation",
    ]);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
    expect(remoteNew.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.unsubscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
  });

  it("窗口 Controller 一次聚合 local/remote scope，不再由 Renderer 订阅 endpoint shard", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local",
      sessions: [createSession({ sessionId: "s-local-1", lastActivityAt: 10 })],
      activeTaskMetas: [createTaskMeta("s-local-1", { unreadAt: 111 })],
    });
    const remote = createEndpointServices({
      workspaceId: "ws-remote",
      sessions: [
        createSession({
          sessionId: "s-remote-1",
          workspaceId: "ws-remote",
          lastActivityAt: 20,
        }),
      ],
      activeTaskMetas: [
        createTaskMeta("s-remote-1", {
          workspacePath: "/remote-ws",
          workspaceIdentity: REMOTE_IDENTITY,
          unreadAt: 222,
        }),
      ],
    });
    let remoteTitle = "s-remote-1";
    local.controllerListTaskList.mockImplementation(async () => ({
      items: [
        {
          ...createTaskMeta("s-remote-1", {
            title: remoteTitle,
            workspacePath: "/remote-ws",
            workspaceIdentity: REMOTE_IDENTITY,
            unreadAt: 222,
            updatedAt: 20,
          }),
          remoteSessionId: REMOTE_SESSION_ID,
          sourceAvailability: "online" as const,
        },
        {
          ...createTaskMeta("s-local-1", { unreadAt: 111, updatedAt: 10 }),
          sourceAvailability: "online" as const,
        },
      ],
      total: 2,
      hasMore: false,
    }));
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        [REMOTE_SESSION_ID]: {
          sessionId: REMOTE_SESSION_ID,
          services: remote.services,
        },
      },
      sessionIdByWorkspaceIdentity: { [REMOTE_IDENTITY]: REMOTE_SESSION_ID },
      sessionIdByWorkspacePath: { "/remote-ws": REMOTE_SESSION_ID },
    });
    const workspaceTabs = createWorkspaceTabs();
    let latest: ReturnType<typeof useGlobalTaskList> | null = null;

    function Probe() {
      latest = useGlobalTaskList({
        collapsedLimit: 10,
        expanded: false,
        kind: "timeline",
        searchQuery: "",
        sortBy: "updated",
        workspaceTabs,
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(Probe),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(local.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(remote.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(local.controllerListTaskList).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceScopes: expect.arrayContaining([
          expect.objectContaining({ workspacePath: "/workspace" }),
          expect.objectContaining({
            workspacePath: "/remote-ws",
            workspaceIdentity: REMOTE_IDENTITY,
          }),
        ]),
      }),
    );

    // 聚合列表：remote(20) 在 local(10) 之前；Renderer 不再调用 endpoint task service。
    const items = latest?.items ?? [];
    expect(items.map((task) => task.taskId)).toEqual([
      "s-remote-1",
      "s-local-1",
    ]);
    expect(local.listTaskList).not.toHaveBeenCalled();
    expect(remote.listTaskList).not.toHaveBeenCalled();

    // remote meta 归属正确（workspaceIdentity 维度）+ unread 双端 join。
    const remoteItem = items.find((task) => task.taskId === "s-remote-1");
    expect(remoteItem?.workspaceIdentity).toBe(REMOTE_IDENTITY);
    expect(remoteItem?.unreadAt).toBe(222);
    const localItem = items.find((task) => task.taskId === "s-local-1");
    expect(localItem?.unreadAt).toBe(111);

    // Controller 刷新后收敛远端 rename。
    await act(async () => {
      remoteTitle = "Renamed remote";
      await latest?.refresh();
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(
      (latest?.items ?? []).find((task) => task.taskId === "s-remote-1")?.title,
    ).toBe("Renamed remote");

    act(() => {
      root.unmount();
    });
  });

  it("远端 workspace 的 # 会话候选只订阅对应 remote endpoint", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local",
      sessions: [],
    });
    const remote = createEndpointServices({
      workspaceId: "ws-remote",
      sessions: [],
    });
    useRemoteWorkspaceSessionStore.setState({
      baseServices: local.services,
      sessionsById: {
        [REMOTE_SESSION_ID]: {
          sessionId: REMOTE_SESSION_ID,
          services: remote.services,
        },
      },
      sessionIdByWorkspaceIdentity: { [REMOTE_IDENTITY]: REMOTE_SESSION_ID },
      sessionIdByWorkspacePath: { "/remote-ws": REMOTE_SESSION_ID },
    });

    function Probe() {
      useSessionsMentionProvider(
        "glm",
        "/remote-ws",
        REMOTE_IDENTITY,
        "",
        true,
        "current-workspace",
        "empty",
        "sessions",
      );
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(TabStoreProvider, null, createElement(Probe)),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(local.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(remote.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(remote.subscribeSessionsIndexV4).toHaveBeenCalledWith({
      runtimePolicy: "existing-only",
      workspacePath: "/remote-ws",
      workspaceIdentity: REMOTE_IDENTITY,
    });

    act(() => {
      root.unmount();
    });
  });

  it("@ 保持当前 workspace，# 聚合同一 Host 并按 workspace 各限制 20 条", async () => {
    const buildWorkspaceSessions = (workspaceId: string, prefix: string) => [
      ...Array.from({ length: 20 }, (_, index) =>
        createSession({
          sessionId: `${prefix}-recent-${index}`,
          workspaceId,
          title: `${prefix} recent ${index}`,
          lastActivityAt: 100 - index,
          createdAt: 100 - index,
        }),
      ),
      createSession({
        sessionId: `${prefix}-old-target`,
        workspaceId,
        title: `${prefix} archived target`,
        lastActivityAt: 1,
        createdAt: 1,
      }),
    ];
    const local = createEndpointServices({
      workspaceId: "ws-local",
      sessions: [],
      sessionsByWorkspaceKey: {
        "/workspace-a": buildWorkspaceSessions("/workspace-a", "alpha"),
        "/workspace-b": buildWorkspaceSessions("/workspace-b", "beta"),
      },
    });
    useRemoteWorkspaceSessionStore.setState({ baseServices: local.services });
    const workspaceTabs: WorkspaceTabState[] = [
      {
        id: "workspace-a",
        kind: "workspace",
        label: "workspace-a",
        workspacePath: "/workspace-a",
      },
      {
        id: "workspace-b",
        kind: "workspace",
        label: "workspace-b",
        workspacePath: "/workspace-b",
      },
    ];
    let latest: ReturnType<typeof useSessionsMentionProvider> | null = null;

    function Probe({
      query = "",
      workspaceScope,
    }: {
      query?: string;
      workspaceScope: "current-workspace" | "same-authority-workspaces";
    }) {
      latest = useSessionsMentionProvider(
        "glm",
        "/workspace-a",
        undefined,
        query,
        true,
        workspaceScope,
        "empty",
        "sessions",
      );
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    const renderProbe = (
      workspaceScope: "current-workspace" | "same-authority-workspaces",
      query = "",
    ) =>
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(
            TabStoreProvider,
            null,
            createElement(
              WorkspaceTabsSeed,
              { activeWorkspacePath: "/workspace-a", tabs: workspaceTabs },
              createElement(Probe, { query, workspaceScope }),
            ),
          ),
        ),
      );
    await act(async () => {
      renderProbe("current-workspace");
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledTimes(1);
    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/workspace-a" }),
    );
    expect(latest?.items).toHaveLength(21);
    expect((latest?.items ?? []).map((item) => item.value)).toContain(
      "alpha-old-target",
    );

    await act(async () => {
      renderProbe("same-authority-workspaces");
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(local.subscribeSessionsIndexV4).toHaveBeenCalledWith(
      expect.objectContaining({ workspacePath: "/workspace-b" }),
    );
    expect(latest?.items).toHaveLength(40);
    expect(
      (latest?.items ?? []).filter((item) => item.description === "workspace-a"),
    ).toHaveLength(20);
    expect(
      (latest?.items ?? []).filter((item) => item.description === "workspace-b"),
    ).toHaveLength(20);
    expect((latest?.items ?? []).map((item) => item.value)).not.toContain(
      "beta-old-target",
    );

    await act(async () => {
      renderProbe("same-authority-workspaces", "beta archived target");
      await flushMicrotasks();
    });
    expect((latest?.items ?? []).map((item) => item.value)).toEqual([
      "beta-old-target",
    ]);

    act(() => {
      root.unmount();
    });
  });

  it("远端 # 会话候选只聚合同一 remote authority 的 workspace", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local",
      sessions: [],
    });
    const remoteAId = "remote-session-a";
    const remoteBId = "remote-session-b";
    const remoteAIdentity = "remote:ssh:a:/repo-a";
    const remoteAProjectIdentity = "remote:ssh:a:/repo-b";
    const remoteBIdentity = "remote:ssh:b:/repo-a";
    const remoteA = createEndpointServices({
      workspaceId: "ws-remote-a",
      sessions: [],
      sessionsByWorkspaceKey: {
        [remoteAIdentity]: [
          createSession({
            sessionId: "s-remote-a-current",
            workspaceId: remoteAIdentity,
            title: "Remote A current",
            lastActivityAt: 10,
          }),
        ],
        [remoteAProjectIdentity]: [
          createSession({
            sessionId: "s-remote-a-project",
            workspaceId: remoteAProjectIdentity,
            title: "Remote A project",
            lastActivityAt: 20,
          }),
        ],
      },
    });
    const remoteB = createEndpointServices({
      workspaceId: "ws-remote-b",
      sessions: [
        createSession({
          sessionId: "s-remote-b",
          workspaceId: remoteBIdentity,
          title: "Foreign remote",
          lastActivityAt: 30,
        }),
      ],
    });
    useRemoteWorkspaceSessionStore.setState({
      baseServices: local.services,
      sessionsById: {
        [remoteAId]: { sessionId: remoteAId, services: remoteA.services },
        [remoteBId]: { sessionId: remoteBId, services: remoteB.services },
      },
      sessionIdByWorkspaceIdentity: {
        [remoteAIdentity]: remoteAId,
        [remoteAProjectIdentity]: remoteAId,
        [remoteBIdentity]: remoteBId,
      },
      sessionIdByWorkspacePath: {},
    });
    const workspaceTabs: WorkspaceTabState[] = [
      {
        id: "remote-a-root",
        kind: "workspace",
        label: "repo-a",
        workspacePath: "/repo-a",
        workspaceIdentity: remoteAIdentity,
        remoteSessionId: remoteAId,
      },
      {
        id: "remote-a-project",
        kind: "workspace",
        label: "repo-b",
        workspacePath: "/repo-b",
        workspaceIdentity: remoteAProjectIdentity,
        remoteSessionId: remoteAId,
      },
      {
        id: "remote-b-root",
        kind: "workspace",
        label: "repo-a",
        workspacePath: "/repo-a",
        workspaceIdentity: remoteBIdentity,
        remoteSessionId: remoteBId,
      },
      {
        id: "local-root",
        kind: "workspace",
        label: "local",
        workspacePath: "/local",
      },
    ];
    let latest: ReturnType<typeof useSessionsMentionProvider> | null = null;

    function Probe() {
      latest = useSessionsMentionProvider(
        "glm",
        "/repo-a",
        remoteAIdentity,
        "",
        true,
        "same-authority-workspaces",
        "empty",
        "sessions",
      );
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(
            TabStoreProvider,
            null,
            createElement(
              WorkspaceTabsSeed,
              {
                activeWorkspaceIdentity: remoteAIdentity,
                activeWorkspacePath: "/repo-a",
                tabs: workspaceTabs,
              },
              createElement(Probe),
            ),
          ),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(remoteA.subscribeSessionsIndexV4).toHaveBeenCalledTimes(2);
    expect(remoteB.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect(local.subscribeSessionsIndexV4).not.toHaveBeenCalled();
    expect((latest?.items ?? []).map((item) => item.value)).toEqual([
      "s-remote-a-current",
      "s-remote-a-project",
    ]);

    act(() => {
      root.unmount();
    });
  });

  it("# 面板未启用时不预订阅 sessions-index", async () => {
    const local = createEndpointServices({
      workspaceId: "ws-local",
      sessions: [],
    });

    function Probe() {
      useSessionsMentionProvider(
        "glm",
        "/workspace",
        undefined,
        "",
        false,
        "same-authority-workspaces",
        "empty",
        "sessions",
      );
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services: local.services },
          createElement(TabStoreProvider, null, createElement(Probe)),
        ),
      );
      await flushMicrotasks();
    });

    expect(local.subscribeSessionsIndexV4).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });
});
