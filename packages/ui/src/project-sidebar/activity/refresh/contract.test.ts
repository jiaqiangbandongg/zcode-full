// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  type WindowHostControllerTaskRow,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  WindowHostControllerFrame,
  ProjectTree,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [],
  readTree: vi.fn(),
  groupTaskRef: vi.fn(),
  removeTaskState: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => mocks.tabs,
  useTabStoreApi: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ workspaces: {}, removeTaskState: mocks.removeTaskState }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.readTree(...args),
}));
vi.mock("@/project-sidebar/grouped-view.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/project-sidebar/grouped-view.js")>();
  return {
    ...actual,
    groupTaskRef: (...args: Parameters<typeof actual.groupTaskRef>) => {
      mocks.groupTaskRef();
      return actual.groupTaskRef(...args);
    },
  };
});
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function activityFixture() {
  let receive!: (frame: WindowHostControllerFrame) => void;
  let seq = 0;
  const task: ProjectTree["tasks"][number] = {
    taskId: "task",
    hostId: "local",
    projectId: null,
    workspacePath: "/repo",
    title: "original",
    traceId: "task",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    pinned: false,
    archived: false,
  };
  let tree: ProjectTree = { projects: [], tasks: [task] };
  const list = vi.fn(async () => ({ items: [], total: 1, hasMore: false }));
  const admit = vi.fn(async () => undefined);
  mocks.readTree.mockImplementation(async () => ({
    tree,
    availability: new Map(),
    directory: { hosts: [], entries: [] },
  }));
  mocks.services = {
    projectService: {},
    windowControllerService: {
      listTaskList: list,
      onDynamicTaskUnreadSignal: () => () => ({ dispose() {} }),
      onDynamicControllerFrame: () => (listener: typeof receive) => {
        receive = listener;
        return { dispose() {} };
      },
      subscribeControllerV4: async ({ topic }: { topic: string }) => ({
        ack: { subscriptionId: topic, mode: "snapshot", logEpoch: "e" },
      }),
      unsubscribeControllerV4: async () => undefined,
    },
    taskGroupService: { read: async () => ({ groups: [], members: [], order: [] }), admit },
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  };
  const row = (time = 10): WindowHostControllerTaskRow => ({
    address: { taskId: task.taskId, workspacePath: task.workspacePath },
    meta: { ...task, updatedAt: time, status: "running" as const },
    membership: { pinned: false, archived: false, active: true },
    sourceAvailability: "online" as const,
    liveStatus: "running" as const,
    activity: { phase: "running" as const, lastActivityAt: time, hasBackgroundWork: false },
  });
  const send = async (next: ReturnType<typeof row>, snapshot = false) =>
    act(async () => {
      const fromSeq = seq;
      if (!snapshot) seq++;
      receive({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
        logEpoch: "e",
        fromSeq,
        toSeq: seq,
        sentAt: seq,
        payload: snapshot
          ? { kind: "snapshot", snapshot: { protocolVersion: 1, logEpoch: "e", tasks: [next] } }
          : { kind: "deltas", deltas: [{ op: "task.upserted", task: next }] },
      });
    });
  const remove = async () =>
    act(async () => {
      const fromSeq = seq++;
      receive({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
        logEpoch: "e",
        fromSeq,
        toSeq: seq,
        sentAt: seq,
        payload: { kind: "deltas", deltas: [{ op: "task.removed", address: row().address }] },
      });
    });
  const reconnect = async () =>
    act(async () => {
      receive({
        topic: CONTROLLER_WORKSPACES_TOPIC,
        subscriptionId: CONTROLLER_WORKSPACES_TOPIC,
        logEpoch: "new-source",
        fromSeq: 0,
        toSeq: 0,
        sentAt: seq,
        payload: {
          kind: "snapshot",
          snapshot: {
            protocolVersion: 1,
            logEpoch: "new-source",
            workspaces: [
              { workspacePath: "/repo", sourceAvailability: "online", connectionState: "online" },
            ],
          },
        },
      });
    });
  return {
    task,
    row,
    send,
    remove,
    reconnect,
    list,
    admit,
    setTree(next: ProjectTree) {
      tree = next;
    },
  };
}

it("1000 次纯活动不重读目录、不重建观察、不重算分组，仍更新最终活动", async () => {
  const f = activityFixture();
  const { result } = renderHook(() => {
    const value = useProjectTree();
    useTaskGroups(value.factTree);
    return value;
  });
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await f.send(f.row(), true);
  await waitFor(() => expect(result.current.loading).toBe(false));
  mocks.readTree.mockClear();
  f.list.mockClear();
  f.admit.mockClear();
  mocks.groupTaskRef.mockClear();
  for (let i = 0; i < 1000; i++) await f.send(f.row(11 + i));
  expect(mocks.readTree.mock.calls.length).toBe(0);
  expect(f.list.mock.calls.length).toBe(0);
  expect(mocks.groupTaskRef.mock.calls.length).toBe(0);
  expect(f.admit).not.toHaveBeenCalled();
  expect(getTaskListRowActivity(result.current.tree.tasks[0]!)).toMatchObject({
    lastActivityAt: 1010,
  });
});

it("等价目录刷新复用连接与入口引用，连接变化仍发布", async () => {
  activityFixture();
  const first = {
    tree: { projects: [], tasks: [] },
    availability: new Map([["local:p", { online: true }]]),
    directory: {
      hosts: [{ id: "remote:s", membershipId: "m1", kind: "ssh", target: null, position: 0 }],
      entries: [],
    } as RemoteProjectDirectory,
  };
  mocks.readTree.mockImplementation(async () => structuredClone(first));
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(result.current.loading).toBe(false));
  const availability = result.current.availability;
  const directory = result.current.directory;
  await act(async () => result.current.refresh());
  expect(result.current.availability).toBe(availability);
  expect(result.current.directory).toBe(directory);
  first.availability.set("local:p", { online: false });
  await act(async () => result.current.refresh());
  expect(result.current.availability.get("local:p")?.online).toBe(false);
  expect(result.current.availability).not.toBe(availability);
  expect(result.current.directory).toBe(directory);
  first.directory.hosts[0]!.membershipId = "m2";
  await act(async () => result.current.refresh());
  expect(result.current.directory.hosts[0]?.membershipId).toBe("m2");
  expect(result.current.directory).not.toBe(directory);
  first.directory.hosts = [];
  await act(async () => result.current.refresh());
  expect(result.current.directory.hosts).toEqual([]);
});

it.each([
  { title: "renamed" },
  { unreadAt: 123 },
  { cronAutomationId: "cron" },
  { offPeakTaskId: "offpeak" },
  { pinned: true },
  { archived: true },
])("事实变化仍刷新目录：%j", async (patch) => {
  const f = activityFixture();
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await f.send(f.row(), true);
  const nextTask = { ...f.task, ...patch };
  f.setTree({ projects: [], tasks: [nextTask] });
  const next = f.row(20);
  next.meta = { ...next.meta, ...patch };
  next.membership = {
    pinned: nextTask.pinned,
    archived: nextTask.archived,
    active: !nextTask.archived,
  };
  await f.send(next);
  await waitFor(() => expect(result.current.tree.tasks[0]).toMatchObject(patch));
});

it("观察注册失败后，显式刷新会重试，owner 重挂载仍建立观察", async () => {
  const f = activityFixture();
  f.list.mockRejectedValueOnce(new Error("source unavailable"));
  const first = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(1));
  await act(async () => first.result.current.refresh());
  expect(f.list).toHaveBeenCalledTimes(2);
  first.unmount();
  renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalledTimes(3));
});

it("同 scope 来源重连恢复观察，离线撤销活动；恢复快照仍刷新事实", async () => {
  const f = activityFixture();
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await f.send(f.row(), true);
  f.list.mockClear();
  mocks.readTree.mockClear();
  await f.reconnect();
  expect(f.list).toHaveBeenCalledOnce();
  expect(mocks.readTree).toHaveBeenCalled();
  f.list.mockClear();
  await f.send({ ...f.row(), sourceAvailability: "offline" });
  expect(getTaskListRowActivity(result.current.tree.tasks[0]!)).toBeNull();
  expect(f.list).toHaveBeenCalledOnce();
  f.setTree({ projects: [], tasks: [{ ...f.task, title: "recovered" }] });
  await f.send({ ...f.row(), meta: { ...f.row().meta, title: "recovered" } }, true);
  await waitFor(() => expect(result.current.tree.tasks[0]?.title).toBe("recovered"));
});

it("新增与明确删除仍刷新权威行集合，活动自身不补行", async () => {
  const f = activityFixture();
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(f.list).toHaveBeenCalled());
  await f.send(f.row(), true);
  const second = { ...f.task, taskId: "second", traceId: "second" };
  f.setTree({ projects: [], tasks: [f.task, second] });
  await f.send({ ...f.row(), address: { ...f.row().address, taskId: "second" }, meta: second });
  await waitFor(() =>
    expect(result.current.tree.tasks.map((t) => t.taskId)).toEqual(["task", "second"]),
  );
  f.setTree({ projects: [], tasks: [second] });
  await f.remove();
  await waitFor(() => expect(result.current.tree.tasks.map((t) => t.taskId)).toEqual(["second"]));
});
