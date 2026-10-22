// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CONTROLLER_TASKS_INDEX_TOPIC } from "@zcode/shared/zcode-protocol-v4";
import type {
  WindowHostControllerFrame,
  IWindowControllerService,
} from "@/project-sidebar/contract.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [],
  readTree: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: () => mocks.tabs,
  useTabStoreApi: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(() => 0, { subscribe: () => () => {} }),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.readTree(...args),
}));
afterEach(cleanup);

it("未打开 tab 的远端 scope 接入同一个观察器，运行态不改变 SQLite 行且不会循环刷新", async () => {
  let receiveFrame!: (frame: WindowHostControllerFrame) => void;
  const listTaskList = vi.fn(async (_query: unknown) => ({ items: [], total: 0, hasMore: false }));
  const controller = {
    listTaskList,
    onDynamicTaskUnreadSignal: () => () => ({ dispose() {} }),
    onDynamicControllerFrame: () => (listener: typeof receiveFrame) => {
      receiveFrame = listener;
      return { dispose() {} };
    },
    subscribeControllerV4: async ({ topic }: { topic: string }) => ({
      ack: { subscriptionId: topic, mode: "snapshot", logEpoch: "e" },
    }),
    unsubscribeControllerV4: async () => undefined,
  } as unknown as IWindowControllerService;
  const task = {
    taskId: "r",
    hostId: "remote:server:s",
    projectId: "p",
    workspacePath: "/repo",
    workspaceIdentity: "remote:server:s:/repo",
    title: "custom",
    traceId: "r",
    createdAt: 1,
    updatedAt: 2,
    mode: "default" as const,
    pinned: false,
    archived: false,
  };
  mocks.readTree.mockResolvedValue({
    tree: { projects: [], tasks: [task] },
    availability: new Map(),
    directory: { hosts: [], entries: [] },
  });
  mocks.services = {
    projectService: {},
    windowControllerService: controller,
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  };
  const { result } = renderHook(() => useProjectTree());
  await waitFor(() => expect(listTaskList).toHaveBeenCalledOnce());
  expect(listTaskList.mock.calls[0]?.[0]).toMatchObject({
    limit: 0,
    workspaceScopes: [{ workspacePath: "/repo", workspaceIdentity: "remote:server:s:/repo" }],
  });
  await act(async () => {
    receiveFrame({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      subscriptionId: CONTROLLER_TASKS_INDEX_TOPIC,
      logEpoch: "e",
      fromSeq: 0,
      toSeq: 0,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          logEpoch: "e",
          tasks: [
            {
              address: {
                taskId: "r",
                workspacePath: task.workspacePath,
                workspaceIdentity: task.workspaceIdentity,
                sourceServerId: "s",
              },
              meta: task,
              membership: { pinned: false, archived: false, active: true },
              sourceAvailability: "online",
              liveStatus: "running",
              activity: { phase: "running", lastActivityAt: 10, hasBackgroundWork: false },
            },
          ],
        },
      },
    });
  });
  await waitFor(() =>
    expect(getTaskListRowActivity(result.current.tree.tasks[0]!)).toMatchObject({
      phase: "running",
    }),
  );
  expect(result.current.tree.tasks[0]).toMatchObject({
    title: "custom",
    updatedAt: 2,
    projectId: "p",
  });
  expect(result.current.tree.tasks).toHaveLength(1);
  expect(listTaskList).toHaveBeenCalledTimes(2);
  expect(mocks.readTree.mock.calls.length).toBeLessThanOrEqual(3);
});
