import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ZCodeGroupedTaskView } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  clearCachedGroupedViewsForTest,
  GroupedRemoteDataSingleFlight,
  isGroupedTaskViewInitialized,
  mergeGroupedTaskViewWithOptimistic,
  prependTaskGroupToView,
  reconcileGroupedOptimisticTaskKeys,
  shouldHideGroupedTaskContent,
  useGroupedTaskView,
} from "@/hooks/useGroupedTaskView.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  filterGroupedViewByTaskKeys,
  moveGroupAroundTopLevelNode,
  moveTaskByMenu,
  moveTaskOverTask,
  moveTaskToGroupEnd,
  moveTaskToGroupStart,
  moveTaskToRootAroundGroup,
  resolveGroupedDraftTaskPlacementForTask,
} from "@/workspace-grouped-tasks/view.js";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

function cleanupHookTestGlobals(): void {
  useRemoteWorkspaceSessionStore.setState({
    baseServices: null,
    sessionsById: {},
    sessionIdByWorkspaceIdentity: {},
    sessionIdByWorkspacePath: {},
  });
  useZCodeSessionStore.setState({ workspaces: {} });
  clearCachedGroupedViewsForTest();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
}

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-default",
    traceId: "trace-default",
    title: "默认任务",
    workspacePath: "/repo/default",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "glm",
    ...overrides,
  };
}

function createGroupNode(
  id: string,
  tasks: ZCodeTaskMeta[],
): Extract<ZCodeGroupedTaskView["nodes"][number], { type: "group" }> {
  return {
    type: "group",
    group: {
      id,
      title: id,
      color: "gray",
      createdAt: 1,
      updatedAt: 1,
    },
    tasks,
  };
}

function describeGroupedView(view: ZCodeGroupedTaskView): Array<string | string[]> {
  return view.nodes.map((node) =>
    node.type === "task"
      ? node.task.taskId
      : [node.group.id, ...node.tasks.map((task) => task.taskId)],
  );
}

describe("filterGroupedViewByTaskKeys", () => {
  it("keeps archiving tasks hidden when a stale authoritative view restores them", () => {
    const rootTask = createTaskMeta({ taskId: "root-task" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const staleView: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootTask },
        createGroupNode("group-a", [groupTask]),
      ],
    };

    const filteredView = filterGroupedViewByTaskKeys(
      staleView,
      new Set([taskKey(rootTask), taskKey(groupTask)]),
    );

    expect(describeGroupedView(filteredView)).toEqual([["group-a"]]);
    expect(filterGroupedViewByTaskKeys(staleView, new Set())).toBe(staleView);
  });

  it("keeps the authoritative view as the baseline for grouped structure writes", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceGroupedTasksSection.tsx"),
      "utf8",
    );

    expect(source).toContain("moveTaskByMenu(authoritativeView, task, groupId)");
    expect(source).toContain("moveTaskToTopByMenu(authoritativeView, task)");
    expect(source).toContain("dragOriginViewRef.current = authoritativeView");
    expect(source).not.toContain("dragOriginViewRef.current = view");
  });

  it("preserves an archiving task when another task changes group", () => {
    const archivingTask = createTaskMeta({ taskId: "archiving-task" });
    const movingTask = createTaskMeta({ taskId: "moving-task" });
    const authoritativeView: ZCodeGroupedTaskView = {
      nodes: [
        createGroupNode("group-a", [archivingTask, movingTask]),
        createGroupNode("group-b", []),
      ],
    };

    const nextView = moveTaskByMenu(
      authoritativeView,
      movingTask,
      "group-b",
    );

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a", "archiving-task"],
      ["group-b", "moving-task"],
    ]);
  });
});

describe("moveTaskOverTask", () => {
  it("reorders root task over root task by direction", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const rootB = createTaskMeta({ taskId: "root-b" });
    const rootC = createTaskMeta({ taskId: "root-c" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootA },
        { type: "task", task: rootB },
        { type: "task", task: rootC },
      ],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(rootA),
      overTaskKey: taskKey(rootC),
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual(["root-b", "root-c", "root-a"]);
  });

  it("moves root task into target group when over a group task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const groupTaskA = createTaskMeta({ taskId: "group-a-task-a" });
    const groupTaskB = createTaskMeta({ taskId: "group-a-task-b" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [groupTaskA, groupTaskB])],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(rootA),
      overTaskKey: taskKey(groupTaskB),
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a", "group-a-task-a", "root-a", "group-a-task-b"],
    ]);
  });

  it("moves a group task across groups when over another group task", () => {
    const groupATask = createTaskMeta({ taskId: "group-a-task" });
    const groupBTask = createTaskMeta({ taskId: "group-b-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupATask]), createGroupNode("group-b", [groupBTask])],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(groupATask),
      overTaskKey: taskKey(groupBTask),
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-a"],
      ["group-b", "group-b-task", "group-a-task"],
    ]);
  });

  it("moves a group task to root when over a root task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const rootB = createTaskMeta({ taskId: "root-b" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootA },
        createGroupNode("group-a", [groupTask]),
        { type: "task", task: rootB },
      ],
    };

    const nextView = moveTaskOverTask(view, {
      activeTaskKey: taskKey(groupTask),
      overTaskKey: taskKey(rootA),
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual(["group-task", "root-a", ["group-a"], "root-b"]);
  });
});

describe("prependTaskGroupToView", () => {
  it("places a root-created group before every existing top-level node", () => {
    const rootTask = createTaskMeta({ taskId: "root-task" });
    const existingGroup = createGroupNode("group-existing", []);
    existingGroup.sortOrder = -2000;
    const view: ZCodeGroupedTaskView = {
      nodes: [existingGroup, { type: "task", task: rootTask, sortOrder: -1000 }],
    };
    const next = prependTaskGroupToView(view, {
      id: "group-new",
      title: "New Group",
      color: "gray",
      createdAt: 2,
      updatedAt: 2,
    });

    expect(describeGroupedView(next)).toEqual([["group-new"], ["group-existing"], "root-task"]);
    expect(next.nodes[0]?.sortOrder).toBe(-3000);
  });
});

describe("shouldHideGroupedTaskContent", () => {
  it("keeps the initial content gated before refresh sets loading=true", () => {
    expect(
      shouldHideGroupedTaskContent({ initialized: false, loading: false, hasNodes: false }),
    ).toBe(true);
  });

  it("keeps existing content visible during a background refresh", () => {
    expect(shouldHideGroupedTaskContent({ initialized: true, loading: true, hasNodes: true })).toBe(
      false,
    );
  });

  it("画过一次列表之后门禁永不回关（grouped 整块闪一下的回归防线）", () => {
    expect(
      shouldHideGroupedTaskContent({
        initialized: false,
        loading: true,
        hasNodes: false,
        hasPaintedOnce: true,
      }),
    ).toBe(false);
  });

  it("首次门禁期间隐藏 grouped 主体且不渲染任务加载文案", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceGroupedTasksSection.tsx"),
      "utf8",
    );

    expect(source).not.toContain("TaskListLoadingHint");
    expect(source).toMatch(
      /if \(\s*shouldHideGroupedTaskContent\([\s\S]*?\)\s*\) \{\s*return null;\s*\}/,
    );
    // 门禁必须带上「已经画过」的短路条件，否则流式帧又会让整块闪。
    expect(source).toContain("hasPaintedOnce: hasPaintedGroupedListRef.current");
  });
});

describe("isGroupedTaskViewInitialized", () => {
  it("waits for the sessions-index snapshot after grouped structure is ready", () => {
    expect(
      isGroupedTaskViewInitialized({
        remoteDataInitialized: true,
        hydratingEndpointKeys: ["__base__"],
      }),
    ).toBe(false);
  });

  it("becomes ready after both grouped remote data and sessions-index hydration finish", () => {
    expect(
      isGroupedTaskViewInitialized({
        remoteDataInitialized: true,
        hydratingEndpointKeys: [],
      }),
    ).toBe(true);
  });

  it("就绪一次后不再因后台刷新回到首屏门禁", () => {
    // Bug 场景：运行中任务每输出一次 tool 结果，Controller 列表都会重查一轮（loading=true）。
    // 门禁若跟着关门，grouped 主体会整棵卸载再重挂载，表现为左侧分组列表抖动。
    expect(
      isGroupedTaskViewInitialized({
        remoteDataInitialized: true,
        hydratingEndpointKeys: ["window-controller"],
        previouslyInitialized: true,
      }),
    ).toBe(true);
  });
});

describe("GroupedRemoteDataSingleFlight", () => {
  it("同一个 key 的并发 refresh 共享一份在途请求和完成缓存", async () => {
    const loader = new GroupedRemoteDataSingleFlight<string>();
    const deferred = createDeferred<string>();
    const fetchValue = vi.fn(() => deferred.promise);

    const first = loader.load("membership-v1", fetchValue);
    const second = loader.load("membership-v1", fetchValue);

    expect(first).toBe(second);
    expect(fetchValue).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(fetchValue).toHaveBeenCalledTimes(1);

    deferred.resolve("remote-v1");
    await expect(Promise.all([first, second])).resolves.toEqual(["remote-v1", "remote-v1"]);
    await expect(loader.load("membership-v1", fetchValue)).resolves.toBe("remote-v1");
    expect(fetchValue).toHaveBeenCalledTimes(1);
  });

  it("失效后允许新一代请求，旧代迟到结果不能覆盖完成缓存", async () => {
    const loader = new GroupedRemoteDataSingleFlight<string>();
    const stale = createDeferred<string>();
    const fresh = createDeferred<string>();
    const fetchValue = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    const staleLoad = loader.load("membership-v1", fetchValue);
    await Promise.resolve();
    loader.invalidate();
    const freshLoad = loader.load("membership-v1", fetchValue);
    await Promise.resolve();
    expect(fetchValue).toHaveBeenCalledTimes(2);

    fresh.resolve("fresh-v2");
    await expect(freshLoad).resolves.toBe("fresh-v2");
    stale.resolve("stale-v1");
    await expect(staleLoad).resolves.toBe("stale-v1");
    expect(loader.isCurrent("membership-v1", "fresh-v2")).toBe(true);
    expect(loader.isCurrent("membership-v1", "stale-v1")).toBe(false);

    const unexpectedFetch = vi.fn(async () => "unexpected-v3");
    await expect(loader.load("membership-v1", unexpectedFetch)).resolves.toBe("fresh-v2");
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("旧 key 的迟到结果不能覆盖更新 key 的缓存", async () => {
    const loader = new GroupedRemoteDataSingleFlight<string>();
    const oldKey = createDeferred<string>();
    const newKey = createDeferred<string>();

    const oldLoad = loader.load("membership-v1", () => oldKey.promise);
    const newLoad = loader.load("membership-v2", () => newKey.promise);
    await Promise.resolve();
    newKey.resolve("remote-v2");
    await expect(newLoad).resolves.toBe("remote-v2");
    oldKey.resolve("remote-v1");
    await expect(oldLoad).resolves.toBe("remote-v1");

    const unexpectedFetch = vi.fn(async () => "unexpected-v3");
    await expect(loader.load("membership-v2", unexpectedFetch)).resolves.toBe("remote-v2");
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it("key 在并发中切回时以最后一次请求的 key 为缓存权威", async () => {
    const loader = new GroupedRemoteDataSingleFlight<string>();
    const keyA = createDeferred<string>();
    const keyB = createDeferred<string>();
    const fetchA = vi.fn(() => keyA.promise);

    const firstA = loader.load("membership-a", fetchA);
    const loadB = loader.load("membership-b", () => keyB.promise);
    const latestA = loader.load("membership-a", fetchA);
    expect(latestA).toBe(firstA);
    await Promise.resolve();
    expect(fetchA).toHaveBeenCalledTimes(1);

    keyA.resolve("remote-a");
    await expect(Promise.all([firstA, latestA])).resolves.toEqual(["remote-a", "remote-a"]);
    keyB.resolve("remote-b");
    await expect(loadB).resolves.toBe("remote-b");
    expect(loader.isCurrent("membership-a", "remote-a")).toBe(true);
    expect(loader.isCurrent("membership-b", "remote-b")).toBe(false);

    const unexpectedFetch = vi.fn(async () => "unexpected");
    await expect(loader.load("membership-a", unexpectedFetch)).resolves.toBe("remote-a");
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });
});

describe("useGroupedTaskView remote data refresh", () => {
  it("多个 workspace 的重叠 refresh 只发一轮 RPC，并在最新请求完成后关闭 loading", async () => {
    const structure = createDeferred<{
      groups: [];
      members: [];
      topLevelOrders: [];
    }>();
    const listGroupedTaskViewStructure = vi.fn(() => structure.promise);
    const listPinnedTaskIds = vi.fn(async (): Promise<string[]> => []);
    const listArchivedTasks = vi.fn(async (): Promise<ZCodeTaskMeta[]> => []);
    const listTasks = vi.fn(async (): Promise<ZCodeTaskMeta[]> => []);
    const listPinnedTasks = vi.fn(async (): Promise<ZCodeTaskMeta[]> => []);
    const listDeletedTaskIds = vi.fn(async (): Promise<string[]> => []);
    const services = {
      zcodeTaskService: {
        listGroupedTaskViewStructure,
        listPinnedTaskIds,
        listArchivedTasks,
        listTasks,
        listPinnedTasks,
        listDeletedTaskIds,
        onDynamicWorkspaceEvent: () => () => ({ dispose() {} }),
      },
    } as unknown as IServiceAccessor;
    const workspaceTabs: WorkspaceTabState[] = [
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `workspace-${index}`,
        kind: "workspace" as const,
        label: `workspace-${index}`,
        workspacePath: `/workspace-${index}`,
      })),
      {
        id: "remote-workspace",
        kind: "workspace",
        label: "remote-workspace",
        workspacePath: "/workspace-remote",
        workspaceIdentity: "remote:ssh:test:/workspace-remote",
        remoteSessionId: "remote-session",
      },
    ];
    let latestResult: ReturnType<typeof useGroupedTaskView> | null = null;

    function Probe() {
      latestResult = useGroupedTaskView({ workspaceTabs });
      return null;
    }

    const root: Root = createRoot(installMinimalDom());
    try {
      await act(async () => {
        root.render(createElement(ServiceProvider, { services }, createElement(Probe)));
        await flushMicrotasks();
      });
      expect(latestResult?.loading).toBe(true);

      await act(async () => {
        void latestResult?.refresh();
        void latestResult?.refresh();
        await flushMicrotasks();
      });
      expect(listGroupedTaskViewStructure).toHaveBeenCalledTimes(1);
      expect(listGroupedTaskViewStructure).toHaveBeenCalledWith({
        workspaceScopes: Array.from({ length: 8 }, (_, index) => ({
          workspacePath: `/workspace-${index}`,
          workspaceIdentity: undefined,
          workspacePurpose: undefined,
        })),
      });
      expect(listPinnedTaskIds).toHaveBeenCalledTimes(1);
      expect(listArchivedTasks).toHaveBeenCalledTimes(8);
      expect(listTasks).toHaveBeenCalledTimes(8);
      expect(listPinnedTasks).toHaveBeenCalledTimes(8);
      expect(listDeletedTaskIds).toHaveBeenCalledTimes(8);

      await act(async () => {
        structure.resolve({ groups: [], members: [], topLevelOrders: [] });
        await flushMicrotasks();
      });
      expect(latestResult?.loading).toBe(false);
      expect(latestResult?.initialized).toBe(true);

      await act(async () => {
        await latestResult?.refresh();
      });
      expect(listGroupedTaskViewStructure).toHaveBeenCalledTimes(1);
      expect(listTasks).toHaveBeenCalledTimes(8);
    } finally {
      act(() => root.unmount());
      cleanupHookTestGlobals();
    }
  });
});

describe("moveTaskToRootAroundGroup", () => {
  it("moves a root task before a group", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupTask]), { type: "task", task: rootA }],
    };

    const nextView = moveTaskToRootAroundGroup(view, {
      activeTaskKey: taskKey(rootA),
      groupId: "group-a",
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual(["root-a", ["group-a", "group-task"]]);
  });

  it("moves a group task after its group", () => {
    const groupTaskA = createTaskMeta({ taskId: "group-task-a" });
    const groupTaskB = createTaskMeta({ taskId: "group-task-b" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupTaskA, groupTaskB])],
    };

    const nextView = moveTaskToRootAroundGroup(view, {
      activeTaskKey: taskKey(groupTaskB),
      groupId: "group-a",
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual([["group-a", "group-task-a"], "group-task-b"]);
  });
});

describe("moveTaskToGroupStart", () => {
  it("moves a root task before the first group task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [groupTask])],
    };

    const nextView = moveTaskToGroupStart(view, {
      activeTaskKey: taskKey(rootA),
      groupId: "group-a",
    });

    expect(describeGroupedView(nextView)).toEqual([["group-a", "root-a", "group-task"]]);
  });

  it("moves a root task into an empty group", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [])],
    };

    const nextView = moveTaskToGroupStart(view, {
      activeTaskKey: taskKey(rootA),
      groupId: "group-a",
    });

    expect(describeGroupedView(nextView)).toEqual([["group-a", "root-a"]]);
  });
});

describe("moveTaskToGroupEnd", () => {
  it("moves a root task after the last group task", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const groupTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [groupTask])],
    };

    const nextView = moveTaskToGroupEnd(view, {
      activeTaskKey: taskKey(rootA),
      groupId: "group-a",
    });

    expect(describeGroupedView(nextView)).toEqual([["group-a", "group-task", "root-a"]]);
  });

  it("moves a root task into an empty group", () => {
    const rootA = createTaskMeta({ taskId: "root-a" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootA }, createGroupNode("group-a", [])],
    };

    const nextView = moveTaskToGroupEnd(view, {
      activeTaskKey: taskKey(rootA),
      groupId: "group-a",
    });

    expect(describeGroupedView(nextView)).toEqual([["group-a", "root-a"]]);
  });
});

describe("moveGroupAroundTopLevelNode", () => {
  it("moves a group before another group", () => {
    const groupATask = createTaskMeta({ taskId: "group-a-task" });
    const groupBTask = createTaskMeta({ taskId: "group-b-task" });
    const rootA = createTaskMeta({ taskId: "root-a" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        createGroupNode("group-a", [groupATask]),
        { type: "task", task: rootA },
        createGroupNode("group-b", [groupBTask]),
      ],
    };

    const nextView = moveGroupAroundTopLevelNode(view, {
      activeGroupId: "group-b",
      over: { type: "group", groupId: "group-a" },
      position: "before",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-b", "group-b-task"],
      ["group-a", "group-a-task"],
      "root-a",
    ]);
  });

  it("moves a group after a root task", () => {
    const groupATask = createTaskMeta({ taskId: "group-a-task" });
    const rootA = createTaskMeta({ taskId: "root-a" });
    const rootB = createTaskMeta({ taskId: "root-b" });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        createGroupNode("group-a", [groupATask]),
        { type: "task", task: rootA },
        { type: "task", task: rootB },
      ],
    };

    const nextView = moveGroupAroundTopLevelNode(view, {
      activeGroupId: "group-a",
      over: { type: "task", taskKey: taskKey(rootB) },
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual([
      "root-a",
      "root-b",
      ["group-a", "group-a-task"],
    ]);
  });

  it("treats group over group task as over that group", () => {
    const groupATask = createTaskMeta({ taskId: "group-a-task" });
    const groupBTask = createTaskMeta({ taskId: "group-b-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupATask]), createGroupNode("group-b", [groupBTask])],
    };

    const nextView = moveGroupAroundTopLevelNode(view, {
      activeGroupId: "group-a",
      over: { type: "task", taskKey: taskKey(groupBTask) },
      position: "after",
    });

    expect(describeGroupedView(nextView)).toEqual([
      ["group-b", "group-b-task"],
      ["group-a", "group-a-task"],
    ]);
  });
});

describe("resolveGroupedDraftTaskPlacementForTask", () => {
  it("uses the active task group as grouped draft placement", () => {
    const rootTaskWithSameId = createTaskMeta({
      taskId: "task-same",
      workspacePath: "/repo/root",
    });
    const groupedActiveTask = createTaskMeta({
      taskId: "task-same",
      workspaceIdentity: "ssh://host/repo/grouped",
      workspacePath: "/repo/grouped",
    });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: rootTaskWithSameId },
        createGroupNode("group-a", [groupedActiveTask]),
      ],
    };

    expect(resolveGroupedDraftTaskPlacementForTask(view, taskKey(groupedActiveTask))).toEqual({
      type: "group",
      groupId: "group-a",
    });
  });

  it("uses top placement when the active task is ungrouped", () => {
    const rootTask = createTaskMeta({ taskId: "root-task" });
    const groupedTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: rootTask }, createGroupNode("group-a", [groupedTask])],
    };

    expect(resolveGroupedDraftTaskPlacementForTask(view, taskKey(rootTask))).toEqual({
      type: "top",
    });
  });

  it("falls back to top placement when the active task is missing", () => {
    const groupedTask = createTaskMeta({ taskId: "group-task" });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [groupedTask])],
    };

    expect(resolveGroupedDraftTaskPlacementForTask(view, "missing-task-key")).toEqual({
      type: "top",
    });
  });
});

describe("mergeGroupedTaskViewWithOptimistic", () => {
  it("keeps a root draft promotion at the top while grouped structure is stale", () => {
    const existingTask = createTaskMeta({ taskId: "task-existing", updatedAt: 10 });
    const promotedTask = createTaskMeta({ taskId: "task-promoted", updatedAt: 20 });
    const view: ZCodeGroupedTaskView = {
      // 模拟 sessions-index 已出现新 task，但 structure 尚未带回它的顶部 sort_order。
      nodes: [
        { type: "task", task: existingTask, sortOrder: 1000 },
        { type: "task", task: promotedTask, sortOrder: 2000 },
      ],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-promoted",
          tasks: [promotedTask],
          promotedGroupedDraftTaskByTaskId: {
            "task-promoted": {
              draftId: "draft-promoted",
              workspacePath: promotedTask.workspacePath,
              placement: { type: "top" },
              createdAt: 20,
            },
          },
        },
      ],
      visibleMissingTaskKeys: new Set(),
    });

    expect(describeGroupedView(merged)).toEqual(["task-promoted", "task-existing"]);
  });

  it("applies promoted group placement to an authoritative task without optimistic meta", () => {
    const existingTask = createTaskMeta({ taskId: "task-existing", updatedAt: 10 });
    const promotedTask = createTaskMeta({ taskId: "task-promoted", updatedAt: 20 });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: promotedTask }, createGroupNode("group-a", [existingTask])],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-promoted",
          tasks: [],
          promotedGroupedDraftTaskByTaskId: {
            "task-promoted": {
              workspacePath: promotedTask.workspacePath,
              placement: { type: "group", groupId: "group-a" },
              createdAt: 20,
            },
          },
        },
      ],
      visibleMissingTaskKeys: new Set(),
    });

    expect(describeGroupedView(merged)).toEqual([["group-a", "task-promoted", "task-existing"]]);
  });

  it("moves an already-authoritative root task back to its promoted draft group", () => {
    const existingTask = createTaskMeta({ taskId: "task-existing", updatedAt: 10 });
    const promotedTask = createTaskMeta({ taskId: "task-promoted", updatedAt: 20 });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: promotedTask }, createGroupNode("group-a", [existingTask])],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-promoted",
          tasks: [promotedTask],
          promotedGroupedDraftTaskByTaskId: {
            "task-promoted": {
              workspacePath: promotedTask.workspacePath,
              placement: { type: "group", groupId: "group-a" },
              createdAt: 20,
            },
          },
        },
      ],
      visibleMissingTaskKeys: new Set(),
    });

    expect(describeGroupedView(merged)).toEqual([["group-a", "task-promoted", "task-existing"]]);
  });

  it("keeps a task promoted from a group draft at the first position in that group", () => {
    const existingTask = createTaskMeta({ taskId: "task-existing", updatedAt: 10 });
    const promotedTask = createTaskMeta({ taskId: "task-promoted", updatedAt: 20 });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [existingTask])],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-promoted",
          tasks: [promotedTask],
          promotedGroupedDraftTaskByTaskId: {
            "task-promoted": {
              workspacePath: promotedTask.workspacePath,
              placement: { type: "group", groupId: "group-a" },
              createdAt: 20,
            },
          },
        },
      ],
      visibleMissingTaskKeys: new Set([buildTaskEntityKey(promotedTask)]),
    });

    expect(describeGroupedView(merged)).toEqual([["group-a", "task-promoted", "task-existing"]]);
  });

  it("把缺失的当前 active optimistic task 补到 grouped 顶部", () => {
    const existingTask = createTaskMeta({
      taskId: "task-existing",
      title: "已有任务",
      updatedAt: 10,
    });
    const activeTask = createTaskMeta({
      taskId: "task-new",
      title: "首发 prompt",
      updatedAt: 20,
    });
    const unrelatedTask = createTaskMeta({
      taskId: "task-unrelated",
      title: "不该被补进来",
      updatedAt: 30,
    });
    const view: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: existingTask }],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-new",
          tasks: [activeTask, unrelatedTask],
        },
      ],
      visibleMissingTaskKeys: new Set([buildTaskEntityKey(activeTask)]),
    });

    expect(
      merged.nodes.map((node) =>
        node.type === "task"
          ? [node.task.taskId, node.task.title]
          : [node.group.id, node.group.title],
      ),
    ).toEqual([
      ["task-new", "首发 prompt"],
      ["task-existing", "已有任务"],
    ]);
  });

  it("只合并已经在 group 内的 optimistic meta，不改变 group 位置", () => {
    const groupedTask = attachTaskListRowActivity(
      createTaskMeta({
        taskId: "task-in-group",
        title: "New session",
        updatedAt: 10,
      }),
      {
        phase: "running",
        lastActivityAt: 10,
        hasBackgroundWork: false,
      },
    );
    const optimisticTask = createTaskMeta({
      taskId: "task-in-group",
      title: "真实首条消息",
      updatedAt: 20,
    });
    const view: ZCodeGroupedTaskView = {
      nodes: [
        {
          type: "group",
          group: {
            id: "group-1",
            title: "分组",
            color: "gray",
            createdAt: 1,
            updatedAt: 1,
          },
          tasks: [groupedTask],
        },
      ],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: "task-in-group",
          tasks: [optimisticTask],
        },
      ],
      visibleMissingTaskKeys: new Set([buildTaskEntityKey(optimisticTask)]),
    });

    expect(merged.nodes).toHaveLength(1);
    const [groupNode] = merged.nodes;
    expect(groupNode?.type).toBe("group");
    expect(groupNode?.type === "group" ? groupNode.tasks[0]?.title : null).toBe("真实首条消息");
    const mergedTask = groupNode?.type === "group" ? groupNode.tasks[0] : null;
    expect(mergedTask?.updatedAt).toBe(10);
    expect(mergedTask ? getTaskListRowActivity(mergedTask)?.phase : null).toBe("running");
  });

  it("sessions-index 权威元数据会全面替换 grouped 提升占位字段", () => {
    const authoritativeTask = createTaskMeta({
      taskId: "task-promoted-title",
      title: "权威任务名称",
      mode: "plan",
      provider: "codex",
      status: "completed",
      updatedAt: 10,
    });
    const minimalOptimisticTask = createTaskMeta({
      taskId: "task-promoted-title",
      title: "",
      mode: "default",
      provider: "glm",
      status: undefined,
      updatedAt: 0,
    });
    const view: ZCodeGroupedTaskView = {
      nodes: [createGroupNode("group-a", [authoritativeTask])],
    };

    const merged = mergeGroupedTaskViewWithOptimistic({
      view,
      optimisticOverlays: [
        {
          activeTaskId: authoritativeTask.taskId,
          tasks: [minimalOptimisticTask],
          promotedGroupedDraftTaskByTaskId: {},
        },
      ],
      visibleMissingTaskKeys: new Set(),
    });

    const [groupNode] = merged.nodes;
    expect(groupNode?.type === "group" ? groupNode.tasks[0] : null).toMatchObject({
      title: "权威任务名称",
      mode: "plan",
      provider: "codex",
      status: "completed",
      updatedAt: 10,
    });
  });

  it("active 切换后仍保留已临时显示的新 task，直到服务端 view 收敛", () => {
    const existingTask = createTaskMeta({
      taskId: "task-existing",
      title: "已有任务",
      updatedAt: 10,
    });
    const newTask = createTaskMeta({
      taskId: "task-new",
      title: "首发 prompt",
      updatedAt: 20,
    });
    const emptyView: ZCodeGroupedTaskView = {
      nodes: [{ type: "task", task: existingTask }],
    };
    const newTaskKey = buildTaskEntityKey(newTask);

    const firstVisibleKeys = reconcileGroupedOptimisticTaskKeys({
      view: emptyView,
      optimisticOverlays: [
        {
          activeTaskId: "task-new",
          tasks: [newTask],
        },
      ],
      previousVisibleMissingTaskKeys: new Set(),
    });
    expect(firstVisibleKeys).toEqual(new Set([newTaskKey]));

    const afterActiveSwitchKeys = reconcileGroupedOptimisticTaskKeys({
      view: emptyView,
      optimisticOverlays: [
        {
          activeTaskId: "task-existing",
          tasks: [newTask, existingTask],
        },
      ],
      previousVisibleMissingTaskKeys: firstVisibleKeys,
    });
    expect(afterActiveSwitchKeys).toEqual(new Set([newTaskKey]));

    const settledView: ZCodeGroupedTaskView = {
      nodes: [
        { type: "task", task: newTask },
        { type: "task", task: existingTask },
      ],
    };
    expect(
      reconcileGroupedOptimisticTaskKeys({
        view: settledView,
        optimisticOverlays: [
          {
            activeTaskId: "task-existing",
            tasks: [newTask, existingTask],
          },
        ],
        previousVisibleMissingTaskKeys: afterActiveSwitchKeys,
      }),
    ).toEqual(new Set());
  });
});
