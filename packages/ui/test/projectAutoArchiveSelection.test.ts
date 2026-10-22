// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  remove: vi.fn(),
  tabs: [],
  activity: { items: [] },
}));
const services = {
  projectService: {},
  remoteProjectService: {},
  broadcastService: { onMessage: () => ({ dispose() {} }) },
  zcodeTaskService: { onDynamicWorkspaceEvent: () => () => ({ dispose() {} }) },
};
vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useBaseWorkspaceServices: () => services }));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: unknown) => unknown) => select({ tabs: fixture.tabs }),
  useTabStoreApi: () => ({ subscribe: () => () => {} }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ workspaces: {}, removeTaskState: fixture.remove }),
    { subscribe: () => () => {} },
  ),
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => fixture.activity,
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: fixture.read,
}));
const task = (overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: "same",
  hostId: "local",
  workspacePath: "/repo",
  title: "1111",
  projectId: null,
  archived: false,
  pinned: false,
  createdAt: 1,
  updatedAt: 2,
  traceId: "s",
  mode: "default",
  ...overrides,
});
const result = (tasks: ProjectTask[]) => ({
  tree: { projects: [], tasks } as ProjectTree,
  availability: new Map(),
  directory: { hosts: [], entries: [] },
});
beforeEach(() => {
  vi.clearAllMocks();
  services.projectService = {};
  fixture.read.mockResolvedValue(result([task(), task({ taskId: "next", unreadAt: 20 })]));
});
afterEach(cleanup);
it("接受自动归档结果时复用 UI 清理，保留另一条同名未读任务；重复读取不重复清理", async () => {
  const hook = renderHook(useProjectTree);
  await act(async () => {});
  fixture.read.mockResolvedValue(
    result([task({ archived: true }), task({ taskId: "next", unreadAt: 20 })]),
  );
  await act(() => hook.result.current.refresh());
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith("/repo", "same", undefined);
  expect(hook.result.current.tree.tasks[1]?.unreadAt).toBe(20);
  await act(() => hook.result.current.refresh());
  expect(fixture.remove).toHaveBeenCalledOnce();
});
it("初次读取已归档历史和离线缺行均不清理显式打开的任务", async () => {
  fixture.read.mockResolvedValue(result([task({ archived: true })]));
  const hook = renderHook(useProjectTree);
  await act(async () => {});
  fixture.read.mockResolvedValue(result([]));
  await act(() => hook.result.current.refresh());
  expect(fixture.remove).not.toHaveBeenCalled();
});
it("相同路径/任务 ID 的不同 Host 按完整身份清理", async () => {
  const a = task({ hostId: "remote:server:a", workspaceIdentity: "remote:server:a:/repo" });
  const b = task({ hostId: "remote:server:b", workspaceIdentity: "remote:server:b:/repo" });
  fixture.read.mockResolvedValue(result([a, b]));
  const hook = renderHook(useProjectTree);
  await act(async () => {});
  fixture.read.mockResolvedValue(result([a, { ...b, archived: true }]));
  await act(() => hook.result.current.refresh());
  expect(fixture.remove).toHaveBeenCalledExactlyOnceWith("/repo", "same", b.workspaceIdentity);
});
it("服务换代后的迟到归档响应不能清理新树保留的当前任务", async () => {
  const hook = renderHook(useProjectTree);
  await act(async () => {});
  let resolve!: (value: ReturnType<typeof result>) => void;
  fixture.read.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  let first!: Promise<void>;
  act(() => {
    first = hook.result.current.refresh();
  });
  // 修复原因：重叠 refresh 现在共享 flight，先等待第二次再释放第一次会让测试自锁。
  // 迟到结果失效的真实边界是 service 换代；新 owner 接受树后，旧 owner 不能清理展示。
  act(() => {
    services.projectService = {};
    hook.rerender();
  });
  await act(async () => {});
  expect(fixture.read).toHaveBeenCalledTimes(3);
  expect(hook.result.current.tree.tasks[0]?.archived).toBe(false);
  await act(async () => {
    resolve(result([task({ archived: true })]));
    await first;
  });
  expect(fixture.remove).not.toHaveBeenCalled();
  expect(hook.result.current.tree.tasks[0]?.archived).toBe(false);
});
