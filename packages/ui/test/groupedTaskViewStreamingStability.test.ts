// 取证/回归：Group 视图在会话流式更新（prompt 发送、首个 token、思考→正文、tool 结果）
// 期间不得出现空白帧。这些事件在真实链路里表现为 Controller tasks-index 的 activity-only
// delta 帧 + tasks-index membership version bump；本测试用同形 mock 驱动 useGroupedTaskView，
// 断言首屏之后门禁永不回关、权威列表永不变空。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type {
  IServiceAccessor,
  WindowHostControllerTaskListResult,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskListQuery,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeGroupedTaskView } from "@zcode/services";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  type WindowHostControllerFrame,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  clearCachedGroupedViewsForTest,
  shouldHideGroupedTaskContent,
  useGroupedTaskView,
} from "@/hooks/useGroupedTaskView.js";
import { clearTaskListMembershipCache } from "@/lib/taskListMembershipSets.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

const WORKSPACE_PATH = "/repo/weather";
const GROUP_ID = "group-weather";
const TASK_ID = "task-nanjing";

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
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

/**
 * 渲染次数护栏：grouped hook 里任何「render → setState → 新身份 → 再 refresh」的自激环
 * 都会让 act() 永不收敛，表现成 30s 超时而不是断言失败。超过上限直接抛出，把死循环变成可读失败。
 */
function createRenderGuard(limit = 200) {
  let renders = 0;
  return {
    tick() {
      renders += 1;
      if (renders > limit) {
        throw new Error(`grouped hook 渲染次数超过 ${limit} 次，疑似自激刷新环`);
      }
    },
    get count() {
      return renders;
    },
  };
}

function cleanupHookTestGlobals(): void {
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
    sessionIdByWorkspacePath: {},
  });
  useZCodeSessionStore.setState({ workspaces: {} });
  clearCachedGroupedViewsForTest();
  clearTaskListMembershipCache();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
}

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: TASK_ID,
    traceId: "trace-nanjing",
    title: "查询下今天南京的天气",
    workspacePath: WORKSPACE_PATH,
    createdAt: 1_000,
    updatedAt: 2_000,
    mode: "default",
    provider: "glm",
    status: "running",
    ...overrides,
  };
}

function createControllerRow(lastActivityAt: number): WindowHostControllerTaskRow {
  return {
    address: { taskId: TASK_ID, workspacePath: WORKSPACE_PATH },
    meta: createTaskMeta({ updatedAt: lastActivityAt }),
    membership: { pinned: false, archived: false, active: true },
    sourceAvailability: "online",
    liveStatus: "running",
    activity: {
      phase: "running",
      lastActivityAt,
      hasBackgroundWork: false,
    },
  };
}

function createStructure(): ZCodeGroupedTaskViewStructure {
  return {
    groups: [
      {
        id: GROUP_ID,
        title: "天气",
        color: "gray",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    members: [
      {
        groupId: GROUP_ID,
        workspaceKey: WORKSPACE_PATH,
        workspacePath: WORKSPACE_PATH,
        taskId: TASK_ID,
        sortOrder: 1_000,
        addedAt: 1_000,
      },
    ],
    topLevelOrders: [{ type: "group", groupId: GROUP_ID, sortOrder: 1_000 }],
  };
}

/** Controller mock：按真实 Host 投影的形状发 snapshot 与 activity-only delta 帧。 */
function createControllerHarness() {
  const listeners = new Set<(frame: WindowHostControllerFrame) => void>();
  let seq = 0;
  let lastActivityAt = 2_000;
  const listTaskList = vi.fn(
    async (_params: ZCodeTaskListQuery): Promise<WindowHostControllerTaskListResult> => ({
      items: [
        {
          ...createTaskMeta({ updatedAt: lastActivityAt }),
          sourceAvailability: "online",
          liveStatus: "running",
          activity: {
            phase: "running",
            lastActivityAt,
            hasBackgroundWork: false,
          },
        },
      ],
      total: 1,
      hasMore: false,
    }),
  );
  const windowControllerService = {
    listTaskList,
    mutateTask: vi.fn(async () => null),
    subscribeControllerV4: vi.fn(async () => ({
      ack: { subscriptionId: "sub-1", topic: CONTROLLER_TASKS_INDEX_TOPIC },
    })),
    resyncControllerV4: vi.fn(async () => ({})),
    unsubscribeControllerV4: vi.fn(async () => {}),
    onDynamicControllerFrame: () => (listener: (frame: WindowHostControllerFrame) => void) => {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
  };

  function emitSnapshot(): void {
    const fromSeq = seq;
    seq += 1;
    for (const listener of listeners) {
      listener({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: "sub-1",
        logEpoch: "epoch-1",
        fromSeq,
        toSeq: seq,
        sentAt: 0,
        payload: {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            logEpoch: "epoch-1",
            tasks: [createControllerRow(lastActivityAt)],
          },
        },
      } as WindowHostControllerFrame);
    }
  }

  /** 一次会话流式节点：activity 时间戳前进，membership 归属不变。 */
  function emitActivityFrame(): void {
    lastActivityAt += 1_000;
    const fromSeq = seq;
    seq += 1;
    for (const listener of listeners) {
      listener({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: "sub-1",
        logEpoch: "epoch-1",
        fromSeq,
        toSeq: seq,
        sentAt: 0,
        payload: {
          kind: "delta",
          deltas: [{ op: "task.upserted", task: createControllerRow(lastActivityAt) }],
        },
      } as WindowHostControllerFrame);
    }
  }

  return { windowControllerService, emitSnapshot, emitActivityFrame, listTaskList };
}

function createServices(windowControllerService: unknown): IServiceAccessor {
  const structure = createStructure();
  const activeTasks = [createTaskMeta()];
  return {
    windowControllerService,
    zcodeTaskService: {
      listGroupedTaskViewStructure: vi.fn(async () => structure),
      listPinnedTaskIds: vi.fn(async (): Promise<string[]> => []),
      listArchivedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
      listTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => activeTasks),
      listPinnedTasks: vi.fn(async (): Promise<ZCodeTaskMeta[]> => []),
      listDeletedTaskIds: vi.fn(async (): Promise<string[]> => []),
      applyGroupedTaskViewOrder: vi.fn(async () => ({ nodes: [] })),
      onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
    },
  } as unknown as IServiceAccessor;
}

interface GateSample {
  hidden: boolean;
  initialized: boolean;
  loading: boolean;
  nodeCount: number;
  /** grouped 里真正可见的任务行数；行整批消失也算空白帧。 */
  taskRowCount: number;
}

function countTaskRows(view: { nodes: ZCodeGroupedTaskView["nodes"] }): number {
  return view.nodes.reduce(
    (total, node) => total + (node.type === "group" ? node.tasks.length : 1),
    0,
  );
}

const workspaceTabs: WorkspaceTabState[] = [
  {
    id: "workspace-weather",
    kind: "workspace",
    label: "weather",
    workspacePath: WORKSPACE_PATH,
  },
];

describe("grouped 视图流式稳定性", () => {
  it("activity-only 帧与 membership bump 都不得让 grouped 出现空白帧", async () => {
    const controller = createControllerHarness();
    const services = createServices(controller.windowControllerService);
    const gateSamples: GateSample[] = [];
    const guard = createRenderGuard();
    let renderCount = 0;

    function Probe() {
      const grouped = useGroupedTaskView({ workspaceTabs });
      guard.tick();
      renderCount += 1;
      gateSamples.push({
        hidden: shouldHideGroupedTaskContent({
          initialized: grouped.initialized,
          loading: grouped.loading,
          hasNodes: grouped.view.nodes.length > 0,
        }),
        initialized: grouped.initialized,
        loading: grouped.loading,
        nodeCount: grouped.view.nodes.length,
        taskRowCount: countTaskRows(grouped.view),
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
        await flushMicrotasks();
      });
      await act(async () => {
        controller.emitSnapshot();
        await flushMicrotasks();
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const firstVisibleIndex = gateSamples.findIndex(
        (sample) => !sample.hidden && sample.taskRowCount > 0,
      );
      expect(firstVisibleIndex).toBeGreaterThanOrEqual(0);

      // 模拟四个会话流式节点：每个都是一帧 activity + 一次 membership 版本 bump。
      for (let index = 0; index < 4; index += 1) {
        await act(async () => {
          controller.emitActivityFrame();
          bumpTaskListMembershipVersion();
          await flushMicrotasks();
        });
      }

      const samplesAfterFirstPaint = gateSamples.slice(firstVisibleIndex);
      // 诊断输出：失败时直接看到是 initialized、nodeCount 还是 taskRowCount 掉的。
      expect({
        blankFrames: samplesAfterFirstPaint.filter((sample) => sample.hidden),
        emptyRowFrames: samplesAfterFirstPaint.filter((sample) => sample.taskRowCount === 0),
        rendered: renderCount > 0,
      }).toEqual({ blankFrames: [], emptyRowFrames: [], rendered: true });
    } finally {
      act(() => root.unmount());
      cleanupHookTestGlobals();
    }
  });

  it("父级每次渲染重建 workspaceTabs 数组时 grouped 也不得空白", async () => {
    const controller = createControllerHarness();
    const services = createServices(controller.windowControllerService);
    const gateSamples: GateSample[] = [];
    const guard = createRenderGuard();

    function Probe({ tick }: { tick: number }) {
      // 真实侧栏每个 chat 流式帧都会重渲染；这里模拟父级重建 tabs 数组（值相同、身份不同）。
      const tabs: WorkspaceTabState[] = [
        {
          id: "workspace-weather",
          kind: "workspace",
          label: "weather",
          workspacePath: WORKSPACE_PATH,
        },
      ];
      void tick;
      const grouped = useGroupedTaskView({ workspaceTabs: tabs });
      guard.tick();
      gateSamples.push({
        hidden: shouldHideGroupedTaskContent({
          initialized: grouped.initialized,
          loading: grouped.loading,
          hasNodes: grouped.view.nodes.length > 0,
        }),
        initialized: grouped.initialized,
        loading: grouped.loading,
        nodeCount: grouped.view.nodes.length,
        taskRowCount: countTaskRows(grouped.view),
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(
          createElement(ServiceProvider, { services }, createElement(Probe, { tick: 0 })),
        );
        await flushMicrotasks();
      });
      await act(async () => {
        controller.emitSnapshot();
        await flushMicrotasks();
      });
      const firstVisibleIndex = gateSamples.findIndex(
        (sample) => !sample.hidden && sample.taskRowCount > 0,
      );
      expect(firstVisibleIndex).toBeGreaterThanOrEqual(0);

      for (let tick = 1; tick <= 4; tick += 1) {
        await act(async () => {
          root.render(
            createElement(ServiceProvider, { services }, createElement(Probe, { tick })),
          );
          controller.emitActivityFrame();
          await flushMicrotasks();
        });
      }

      const samplesAfterFirstPaint = gateSamples.slice(firstVisibleIndex);
      expect({
        blankFrames: samplesAfterFirstPaint.filter((sample) => sample.hidden),
        emptyRowFrames: samplesAfterFirstPaint.filter((sample) => sample.taskRowCount === 0),
      }).toEqual({ blankFrames: [], emptyRowFrames: [] });
    } finally {
      act(() => root.unmount());
      cleanupHookTestGlobals();
    }
  });

  it("重挂载后必须立刻恢复已知列表，而不是回到首屏空白门禁", async () => {
    const controller = createControllerHarness();
    const services = createServices(controller.windowControllerService);
    const gateSamples: GateSample[] = [];
    const guard = createRenderGuard();

    function Probe() {
      const grouped = useGroupedTaskView({ workspaceTabs });
      guard.tick();
      gateSamples.push({
        hidden: shouldHideGroupedTaskContent({
          initialized: grouped.initialized,
          loading: grouped.loading,
          hasNodes: grouped.view.nodes.length > 0,
        }),
        initialized: grouped.initialized,
        loading: grouped.loading,
        nodeCount: grouped.view.nodes.length,
        taskRowCount: countTaskRows(grouped.view),
      });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
        await flushMicrotasks();
      });
      await act(async () => {
        controller.emitSnapshot();
        await flushMicrotasks();
      });
      expect(gateSamples.some((sample) => !sample.hidden && sample.taskRowCount > 0)).toBe(true);

      // 卸载 + 重挂载（等价于祖先重挂载 / HMR）。
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, null));
        await flushMicrotasks();
      });
      const remountSampleIndex = gateSamples.length;
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
        await flushMicrotasks();
      });

      const remountSamples = gateSamples.slice(remountSampleIndex);
      expect({
        blankFrames: remountSamples.filter((sample) => sample.hidden),
        emptyRowFrames: remountSamples.filter((sample) => sample.taskRowCount === 0),
      }).toEqual({ blankFrames: [], emptyRowFrames: [] });
    } finally {
      act(() => root.unmount());
      cleanupHookTestGlobals();
    }
  });
});
