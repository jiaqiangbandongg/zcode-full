// workspace 视图以 tasks-index 行为左表，sessions-index snapshot/delta 补充
// activity/detail，membership 事件驱动 pin/archive 归属 re-filter。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceEvent } from "@zcode/shared";
import type {
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireFrame,
  SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceTaskLists } from "@/hooks/useWorkspaceTaskLists.js";
import { clearTaskListWorkspaceEventCoordinatorForTest } from "@/lib/taskListWorkspaceEventCoordinator.js";
import { clearTaskListMembershipCache } from "@/lib/taskListMembershipSets.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { resetTaskStatusUnreadSyncForTest } from "@/lib/taskStatusUnreadSync.js";

function createSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "task-1",
    workspaceId: "ws-1",
    title: "Task 1",
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
    taskId: "task-1",
    title: "Task 1",
    traceId: "trace-task-1",
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    logicalFrameId: `logical-membership-${logicalFrameSerial}`,
    logicalFrameOrdinal: logicalFrameSerial,
    topic: frame.topic,
    subscriptionId: frame.subscriptionId,
    frame,
  };
}

describe("useWorkspaceTaskLists membership events (tasks-index 行 + session detail)", () => {
  afterEach(() => {
    resetTaskStatusUnreadSyncForTest();
    clearTaskListWorkspaceEventCoordinatorForTest();
    clearTaskListMembershipCache();
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

  it("workspace 切换后仍按当前全局焦点处理旧 workspace 的终态未读", async () => {
    const task = createTaskMeta({ status: "completed" });
    const workspaceEventListeners = new Map<string, (event: ZCodeWorkspaceEvent) => void>();
    const setTaskUnread = vi.fn(async () => ({ ...task, unreadAt: 123 }));
    const services = {
      zcodeTaskService: {
        listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
        listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        listTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => [task]),
        listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        setTaskUnread,
        onDynamicWorkspaceEvent:
          ({ workspacePath }: { workspacePath: string }) =>
          (listener: (event: ZCodeWorkspaceEvent) => void) => {
            workspaceEventListeners.set(workspacePath, listener);
            return { dispose() {} };
          },
      },
      zcodeAgentService: {
        ...v4Handshake("connection-cross-workspace-unread"),
        subscribeSessionsIndexV4: vi.fn(async ({ workspacePath }: { workspacePath: string }) => ({
          ack: {
            subscriptionId: `sub-${workspacePath}`,
            mode: "snapshot" as const,
            logEpoch: "e1",
          },
        })),
        unsubscribeSessionsIndexV4: vi.fn(async () => {}),
        onDynamicSessionsIndexFrame: () => () => ({ dispose() {} }),
      },
    } as unknown as IServiceAccessor;
    const workspaceTabs: WorkspaceTabState[] = [
      createWorkspaceTab(),
      {
        id: "workspace-2",
        kind: "workspace",
        label: "workspace-2",
        workspacePath: "/workspace-2",
      },
    ];
    useZCodeSessionStore.getState().setActiveTaskId("/workspace", task.taskId);

    function Probe({ activeWorkspacePath }: { activeWorkspacePath: string }) {
      useWorkspaceTaskLists({
        activeWorkspacePath,
        defaultVisibleLimit: 5,
        visibleLimitByWorkspaceKey: {},
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
          { services },
          createElement(Probe, { activeWorkspacePath: "/workspace" }),
        ),
      );
      await flushMicrotasks();
    });
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(Probe, { activeWorkspacePath: "/workspace-2" }),
        ),
      );
      await flushMicrotasks();
    });

    await act(async () => {
      workspaceEventListeners.get("/workspace")?.({
        type: "workspace_task_list_changed",
        workspacePath: "/workspace",
        taskId: task.taskId,
        reason: "task_status_changed",
        unreadSignal: "background_terminal",
        taskMeta: task,
      });
      await flushMicrotasks();
    });

    expect(setTaskUnread).toHaveBeenCalledWith({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      unread: true,
    });

    act(() => root.unmount());
  });

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
      resyncSessionsIndexV4: vi.fn(async (params: { subscriptionId: string }) => ({
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot" as const,
          logEpoch: "e1",
        },
      })),
      onAgentRuntimeRestarted: runtimeRestarts.event,
    };
  }

  it("tasks-index 供行；session delta 补 detail；membership 事件触发 pin/archive re-filter", async () => {
    const workspaceEventListeners: Array<(event: ZCodeWorkspaceEvent) => void> = [];
    const frameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> = [];
    let archivedTasks: ZCodeTaskMeta[] = [];
    let activeTasks: ZCodeTaskMeta[] = [createTaskMeta()];
    const listWorkspaceTaskLists = vi.fn(async () => []);
    const listPinnedTaskIds = vi.fn(async (): Promise<string[]> => []);
    const listArchivedTasks = vi.fn(async (): Promise<ZCodeTaskMeta[]> => archivedTasks);
    let deletedIds: string[] = [];
    const listDeletedTaskIds = vi.fn(async () => deletedIds);
    const listTasks = vi.fn(async (): Promise<ZCodeTaskMeta[]> => activeTasks);
    const services = {
      zcodeTaskService: {
        listWorkspaceTaskLists,
        listPinnedTaskIds,
        listArchivedTasks,
        listDeletedTaskIds,
        listTasks,
        listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        onDynamicWorkspaceEvent: () => (listener: (event: ZCodeWorkspaceEvent) => void) => {
          workspaceEventListeners.push(listener);
          return {
            dispose() {},
          };
        },
      },
      zcodeAgentService: {
        ...v4Handshake("connection-local"),
        subscribeSessionsIndexV4: vi.fn(async () => {
          const initial = snapshotFrame([createSession()]);
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
    let latestGroups: ReturnType<typeof useWorkspaceTaskLists>["groups"] = [];
    const renderStates: Array<{ loading: boolean; taskIds: string[] }> = [];

    function Probe() {
      const result = useWorkspaceTaskLists({
        activeWorkspacePath: "/workspace",
        defaultVisibleLimit: 5,
        visibleLimitByWorkspaceKey: {},
        sortBy: "updated",
        workspaceTabs,
      });
      latestGroups = result.groups;
      renderStates.push({
        loading: result.loadingByWorkspaceKey["/workspace"] ?? false,
        taskIds: result.groups[0]?.items.map((task) => task.taskId) ?? [],
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
      await flushMicrotasks();
    });
    // snapshot 帧落地后再让 refresh/publish 收敛一轮。
    await act(async () => {
      await flushMicrotasks();
    });

    // 行来自 tasks-index，session 补充实时字段；旧 listWorkspaceTaskLists 零调用。
    expect(latestGroups[0]?.items.map((task) => task.taskId)).toEqual(["task-1"]);
    expect(renderStates.some((state) => state.loading)).toBe(true);
    expect(listWorkspaceTaskLists).not.toHaveBeenCalled();
    expect(workspaceEventListeners.length).toBeGreaterThan(0);

    // 会话重命名 = sessions-index delta（无需旧协议事件参与）。
    const renderCountBeforeRename = renderStates.length;
    await act(async () => {
      for (const listener of frameListeners) {
        const frame: SessionsIndexTopicFrame = {
          topic: "sessions-index//workspace",
          subscriptionId: "sub-1",
          fromSeq: 1,
          toSeq: 2,
          sentAt: 2,
          payload: {
            kind: "deltas",
            deltas: [
              {
                op: "session.upserted",
                session: createSession({ title: "Renamed", lastActivityAt: 3 }),
              },
            ],
          },
        };
        listener(physicalFrame(frame));
      }
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(latestGroups[0]?.items[0]?.title).toBe("Renamed");
    const renameRenderStates = renderStates.slice(renderCountBeforeRename);
    // 修复原因：历史任务恢复/状态收敛也会产生 sessions-index delta。已有列表缓存时若先清空
    // query 再进入 loading，用户看到的就是点击任务后整个侧边栏闪成加载态。后台刷新期间必须保留旧行。
    expect(renameRenderStates.length).toBeGreaterThan(0);
    expect(renameRenderStates.some((state) => state.loading)).toBe(false);
    expect(renameRenderStates.every((state) => state.taskIds.includes("task-1"))).toBe(true);

    // 修复原因：task row 改成 tasks-index 权威后，task_created 若只当作 session meta，
    // 共享 membership Promise 会继续返回创建前的旧集合。事件发生在新行落库后，必须换代重拉，
    // 即使 task-2 尚未出现在 sessions-index，也要先进入当前 workspace 的 Project 列表。
    const createdTask = createTaskMeta({
      taskId: "task-2",
      title: "New task",
      traceId: "trace-task-2",
      createdAt: 4,
      updatedAt: 4,
    });
    activeTasks = [createTaskMeta(), createdTask];
    const listTasksCallsBeforeCreate = listTasks.mock.calls.length;
    await act(async () => {
      workspaceEventListeners[0]?.({
        reason: "task_created",
        taskId: createdTask.taskId,
        taskMeta: createdTask,
        type: "workspace_task_list_changed",
        workspacePath: "/workspace",
      });
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(listTasks.mock.calls.length).toBeGreaterThan(listTasksCallsBeforeCreate);
    expect(latestGroups[0]?.items.map((task) => task.taskId)).toEqual(["task-2", "task-1"]);

    // 它端 archive → membership 事件 → 重新拉取归属并把 task 过滤出 workspace 行。
    archivedTasks = [
      {
        createdAt: 1,
        mode: "default",
        taskId: "task-1",
        title: "Task 1",
        traceId: "trace-1",
        updatedAt: 2,
        workspacePath: "/workspace",
      } as ZCodeTaskMeta,
    ];
    await act(async () => {
      workspaceEventListeners[0]?.({
        reason: "task_archived",
        taskId: "task-1",
        taskMeta: archivedTasks[0],
        type: "workspace_task_list_changed",
        workspacePath: "/workspace",
      });
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(latestGroups[0]?.items.map((task) => task.taskId)).toEqual(["task-2"]);
    expect(listWorkspaceTaskLists).not.toHaveBeenCalled();

    // 批次只广播 workspace，不逐条携带 taskId/meta；仍需换代 tombstone，
    // 不能把保留在 session detail 中的已删除任务重新解释成普通成员。
    archivedTasks = [];
    deletedIds = ["task-1"];
    const readsBeforeBatch = listDeletedTaskIds.mock.calls.length;
    await act(async () => {
      workspaceEventListeners[0]?.({
        type: "workspace_task_list_changed",
        workspacePath: "/workspace",
        reason: "task_deleted",
      });
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(listDeletedTaskIds).toHaveBeenCalledTimes(readsBeforeBatch + 1);
    expect(latestGroups[0]?.items.map((task) => task.taskId)).toEqual(["task-2"]);

    act(() => {
      root.unmount();
    });
  });

  it.each(["completedInterrupted", "completedSuccess", "error"] as const)(
    "membership 在途时 activity 收敛为 %s，旧 running 结果不提交并自动重算",
    async (terminalPhase) => {
      const workspaceEventListeners: Array<(event: ZCodeWorkspaceEvent) => void> = [];
      const frameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> = [];
      const deferredMembership = createDeferred<ZCodeTaskMeta[]>();
      let delayMembership = false;
      const listTasks = vi.fn(() =>
        delayMembership
          ? deferredMembership.promise
          : Promise.resolve([createTaskMeta()] as ZCodeTaskMeta[]),
      );
      const services = {
        zcodeTaskService: {
          listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
          listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
          listTasks,
          listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
          onDynamicWorkspaceEvent: () => (listener: (event: ZCodeWorkspaceEvent) => void) => {
            workspaceEventListeners.push(listener);
            return { dispose() {} };
          },
        },
        zcodeAgentService: {
          ...v4Handshake("connection-race"),
          subscribeSessionsIndexV4: vi.fn(async () => {
            const initial = snapshotFrame([
              createSession({ phase: "running", sessionEnded: false }),
            ]);
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
      let latestGroups: ReturnType<typeof useWorkspaceTaskLists>["groups"] = [];

      function Probe() {
        const result = useWorkspaceTaskLists({
          activeWorkspacePath: "/workspace",
          defaultVisibleLimit: 5,
          visibleLimitByWorkspaceKey: {},
          sortBy: "updated",
          workspaceTabs,
        });
        latestGroups = result.groups;
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
      await act(async () => {
        await flushMicrotasks();
      });
      expect(getTaskListRowActivity(latestGroups[0]?.items[0]!)?.phase).toBe("running");

      delayMembership = true;
      await act(async () => {
        workspaceEventListeners[0]?.({
          reason: "task_meta_changed",
          taskId: "task-1",
          type: "workspace_task_list_changed",
          workspacePath: "/workspace",
        });
        await flushMicrotasks();
      });
      expect(listTasks.mock.calls.length).toBeGreaterThanOrEqual(2);

      await act(async () => {
        const terminal: SessionsIndexTopicFrame = {
          topic: "sessions-index//workspace",
          subscriptionId: "sub-1",
          fromSeq: 1,
          toSeq: 2,
          sentAt: 2,
          payload: {
            kind: "deltas",
            deltas: [
              {
                op: "session.upserted",
                session: createSession({
                  phase: terminalPhase,
                  sessionEnded: terminalPhase === "completedSuccess",
                  lastActivityAt: 3,
                }),
              },
            ],
          },
        };
        for (const listener of frameListeners) listener(physicalFrame(terminal));
        await flushMicrotasks();
      });

      const publishedPhases: Array<SessionSummary["phase"] | undefined> = [];
      const unsubscribeCache = useTaskQueryCacheStore.subscribe((state) => {
        const taskMeta = state.taskMetaByEntityKey["/workspace::task-1"];
        publishedPhases.push(taskMeta ? getTaskListRowActivity(taskMeta)?.phase : undefined);
      });
      await act(async () => {
        deferredMembership.resolve([createTaskMeta()]);
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      unsubscribeCache();

      expect(publishedPhases).not.toContain("running");
      expect(getTaskListRowActivity(latestGroups[0]?.items[0]!)?.phase).toBe(terminalPhase);
      expect(
        Object.values(useTaskQueryCacheStore.getState().resultsByQueryKey).every(
          (result) => !result.stale,
        ),
      ).toBe(true);

      act(() => {
        root.unmount();
      });
    },
  );

  // remote shard 同样由 endpoint 自己的 tasks-index 供行，session proxy 补 detail。
  it("remote shard：workspace 行来自 remote tasks-index + sessions-index detail", async () => {
    const remoteIdentity = "host-a:/remote-ws";
    const remoteSessionId = "remote-session-1";
    const remoteFrameSessions: SessionSummary[] = [
      createSession({
        sessionId: "task-remote-1",
        workspaceId: "ws-remote",
        title: "Remote task",
        lastActivityAt: 9,
      }),
    ];
    const remoteFrameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> = [];
    const remoteSubscribe = vi.fn(async () => {
      const initial: SessionsIndexTopicFrame = {
        topic: "sessions-index/host-a:/remote-ws",
        subscriptionId: "sub-r",
        fromSeq: 0,
        toSeq: 1,
        sentAt: 1,
        payload: {
          kind: "snapshot" as const,
          snapshot: {
            protocolVersion: 1,
            workspaceId: "ws-remote",
            logEpoch: "e1",
            sessions: remoteFrameSessions,
          },
        },
      };
      for (const listener of remoteFrameListeners) listener(physicalFrame(initial, "initial"));
      return {
        ack: { subscriptionId: "sub-r", mode: "snapshot" as const, logEpoch: "e1" },
      };
    });
    const remoteListTasks = vi.fn(
      async (): Promise<ZCodeTaskMeta[]> => [
        {
          createdAt: 1,
          mode: "default",
          taskId: "task-remote-1",
          title: "Remote task",
          traceId: "trace-remote-1",
          updatedAt: 9,
          unreadAt: 777,
          workspacePath: "/remote-ws",
          workspaceIdentity: remoteIdentity,
        } as ZCodeTaskMeta,
      ],
    );
    const remoteServices = {
      zcodeTaskService: {
        listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
        listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        listTasks: remoteListTasks,
        listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
      },
      zcodeAgentService: {
        ...v4Handshake("connection-remote"),
        subscribeSessionsIndexV4: remoteSubscribe,
        unsubscribeSessionsIndexV4: vi.fn(async () => {}),
        onDynamicSessionsIndexFrame:
          () => (listener: (frame: SessionsIndexTopicWireFrame) => void) => {
            remoteFrameListeners.push(listener);
            return { dispose: () => {} };
          },
      },
    } as unknown as IServiceAccessor;
    const baseFrameListeners: Array<(frame: SessionsIndexTopicWireFrame) => void> = [];
    const baseServices = {
      zcodeTaskService: {
        listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
        listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        listTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => [createTaskMeta()]),
        listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
        onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
      },
      zcodeAgentService: {
        ...v4Handshake("connection-base"),
        subscribeSessionsIndexV4: vi.fn(async () => {
          const initial = snapshotFrame([createSession()]);
          for (const listener of baseFrameListeners) listener(physicalFrame(initial, "initial"));
          return {
            ack: { subscriptionId: "sub-1", mode: "snapshot" as const, logEpoch: "e1" },
          };
        }),
        unsubscribeSessionsIndexV4: vi.fn(async () => {}),
        onDynamicSessionsIndexFrame:
          () => (listener: (frame: SessionsIndexTopicWireFrame) => void) => {
            baseFrameListeners.push(listener);
            return { dispose: () => {} };
          },
      },
    } as unknown as IServiceAccessor;
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        [remoteSessionId]: { sessionId: remoteSessionId, services: remoteServices },
      },
      sessionIdByWorkspaceIdentity: { [remoteIdentity]: remoteSessionId },
      sessionIdByWorkspacePath: { "/remote-ws": remoteSessionId },
    });
    const workspaceTabs: WorkspaceTabState[] = [
      createWorkspaceTab(),
      {
        id: "workspace-remote",
        kind: "workspace",
        label: "remote",
        workspacePath: "/remote-ws",
        workspaceIdentity: remoteIdentity,
        remoteSessionId,
      } as WorkspaceTabState,
    ];
    let latestGroups: ReturnType<typeof useWorkspaceTaskLists>["groups"] = [];

    function Probe() {
      const result = useWorkspaceTaskLists({
        activeWorkspacePath: "/workspace",
        defaultVisibleLimit: 5,
        visibleLimitByWorkspaceKey: {},
        sortBy: "updated",
        workspaceTabs,
      });
      latestGroups = result.groups;
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    await act(async () => {
      root.render(createElement(ServiceProvider, { services: baseServices }, createElement(Probe)));
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });
    await act(async () => {
      await flushMicrotasks();
    });

    // remote endpoint 经自身 proxy 订阅（带 workspaceIdentity）。
    expect(remoteSubscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: "/remote-ws",
        workspaceIdentity: remoteIdentity,
      }),
    );
    const remoteGroup = latestGroups.find((group) => group.workspaceIdentity === remoteIdentity);
    expect(remoteGroup?.items.map((task) => task.taskId)).toEqual(["task-remote-1"]);
    // unread 从 remote endpoint 的 tasks-index join。
    expect(remoteGroup?.items[0]?.unreadAt).toBe(777);
    expect(remoteGroup?.hasUnread).toBe(true);
    // 本机行不受影响。
    const localGroup = latestGroups.find(
      (group) => group.workspacePath === "/workspace" && !group.workspaceIdentity,
    );
    expect(localGroup?.items.map((task) => task.taskId)).toEqual(["task-1"]);
    expect(localGroup?.hasUnread).toBe(false);

    act(() => {
      root.unmount();
    });
  });
});
