// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [],
  read: vi.fn(),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStore: () => mocks.tabs }));
vi.mock("@/store/zcodeSessionStore.js", () => ({ useZCodeSessionStore: () => 0 }));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/useProjectUnreadSignals.js", () => ({
  useProjectUnreadSignals: () => {},
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.read(...args),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("MRO02：目录读取、修改入口和变化订阅一起选择窗口 owner，换代释放旧订阅", async () => {
  let changed!: () => void;
  const dispose = vi.fn();
  const sourceBroadcast = vi.fn(() => ({ dispose: vi.fn() }));
  const windowProjectDirectory = {
    projectService: { owner: "window" },
    remoteProjectService: { owner: "window" },
    changesService: {
      onDidChange: (listener: () => void) => {
        changed = listener;
        return { dispose };
      },
    },
  };
  mocks.services = {
    projectService: { owner: "source" },
    remoteProjectService: { owner: "source" },
    windowProjectDirectory,
    broadcastService: { onMessage: sourceBroadcast },
  };
  mocks.read.mockResolvedValue({
    tree: { projects: [], tasks: [] },
    directory: { hosts: [], entries: [] },
    availability: new Map(),
  });
  const { result, rerender, unmount } = renderHook(() => useProjectTree());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(mocks.read).toHaveBeenLastCalledWith({
    projectService: windowProjectDirectory.projectService,
    remoteProjectService: windowProjectDirectory.remoteProjectService,
  });
  expect(result.current.service).toBe(windowProjectDirectory.projectService);
  expect(result.current.remoteService).toBe(windowProjectDirectory.remoteProjectService);
  expect(sourceBroadcast).not.toHaveBeenCalled();
  const before = mocks.read.mock.calls.length;
  await act(async () => changed());
  expect(mocks.read.mock.calls.length).toBe(before + 1);
  mocks.services = { ...mocks.services, windowProjectDirectory: undefined };
  rerender();
  await waitFor(() => expect(result.current.service).toBe(mocks.services.projectService));
  expect(dispose).toHaveBeenCalledOnce();
  expect(sourceBroadcast).toHaveBeenCalledOnce();
  unmount();
});
