// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectFileTree } from "@/project-sidebar/useProjectFileTree.js";
import type {
  ProjectSidebarProps,
  SidebarFileTreeTarget,
  VirtualProject,
  ProjectTask,
} from "@/project-sidebar/contract.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
const onOpenFileManager = vi.fn();
afterEach(() => {
  onOpenFileManager.mockClear();
  useRemoteWorkspaceSessionStore.setState({ sessionsById: {}, sessionIdByWorkspaceIdentity: {} });
});
const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock("@/project-sidebar/project-file-navigation.js", () => ({
  resolveProjectFileTarget: resolveTarget,
}));
it("drops a late file target after another selection or unmount", async () => {
  const requests: ((value: SidebarFileTreeTarget) => void)[] = [];
  resolveTarget.mockImplementation(() => new Promise((done) => requests.push(done)));
  const { result, unmount } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  let first!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    first = result.current.openFiles({} as VirtualProject, "/one");
    second = result.current.openFiles({} as VirtualProject, "/two");
  });
  await act(async () => {
    requests[1]({ workspacePath: "/two", workspaceName: "Two" });
    await second;
  });
  await act(async () => {
    requests[0]({ workspacePath: "/one", workspaceName: "One" });
    await first;
  });
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith({
    workspacePath: "/two",
    workspaceName: "Two",
  });
  let third!: Promise<void>;
  act(() => {
    third = result.current.openFiles({} as VirtualProject, "/three");
    unmount();
  });
  await act(async () => {
    requests[2]({ workspacePath: "/three", workspaceName: "Three" });
    await third;
  });
  expect(onOpenFileManager).toHaveBeenCalledTimes(1);
});

it("consumes each open request once without reopening on rerender", () => {
  const target = { workspacePath: "/example", workspaceName: "Example" };
  const props = {
    onOpenFileManager,
    fileTreeOpenRequest: { id: 1, target },
  } as unknown as ProjectSidebarProps;
  const { rerender } = renderHook(
    (value) => useProjectFileTree(value, { hosts: [], entries: [] }),
    { initialProps: props },
  );
  rerender({ ...props });
  expect(onOpenFileManager).toHaveBeenCalledExactlyOnceWith(target);
  rerender({ ...props, fileTreeOpenRequest: { id: 2, target } });
  expect(onOpenFileManager).toHaveBeenCalledTimes(2);
});

it("opens pinned task cwd without a tab and never borrows a local remote session", async () => {
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  await act(async () => {
    await result.current.openTaskFiles(
      { workspacePath: "/task-cwd", hostId: "local" } as ProjectTask,
      "wrong-remote",
    );
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith({
    workspacePath: "/task-cwd",
    workspaceName: "task-cwd",
  });
  await act(async () => {
    await expect(
      result.current.openTaskFiles({
        workspacePath: "/task-cwd",
        workspaceIdentity: "remote:missing",
        hostId: "remote-host",
      } as ProjectTask),
    ).rejects.toThrow("project.connection-unavailable");
  });
  expect(onOpenFileManager).toHaveBeenCalledTimes(1);
});

it("a late mobile task switch cannot reopen an unmounted sidebar", async () => {
  let finish!: () => void;
  const switchWorkspace = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    onOpenFileManager,
    workspacePath: "/current",
    webRemoteControlWorkspaceSwitcher: { switchWorkspace },
  } as unknown as ProjectSidebarProps;
  const { result, unmount } = renderHook(() =>
    useProjectFileTree(props, { hosts: [], entries: [] }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.openTaskFiles({
      workspacePath: "/task-cwd",
      taskId: "task-cwd",
      hostId: "local",
    } as ProjectTask);
    unmount();
  });
  await act(async () => {
    finish();
    await pending;
  });
  expect(switchWorkspace).toHaveBeenCalledWith("/task-cwd", {
    taskHostId: "local",
    fileTreeTaskId: "task-cwd",
    mobileNavigationIntent: "chat",
  });
  expect(onOpenFileManager).not.toHaveBeenCalled();
});

it("opens only the remote session matching the pinned task identity", async () => {
  useRemoteWorkspaceSessionStore.setState({
    sessionsById: {
      matching: {
        sessionId: "matching",
        workspaceIdentity: "remote:task",
      } as RemoteWorkspaceSession,
      other: { sessionId: "other", workspaceIdentity: "remote:other" } as RemoteWorkspaceSession,
    },
  });
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  const task = {
    workspacePath: "/same-path",
    workspaceIdentity: "remote:task",
    hostId: "remote-host",
  } as ProjectTask;
  await act(async () => {
    await expect(result.current.openTaskFiles(task, "other")).rejects.toThrow(
      "project.connection-unavailable",
    );
  });
  expect(onOpenFileManager).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.openTaskFiles(task, "matching");
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith({
    workspacePath: "/same-path",
    workspaceName: "same-path",
    workspaceIdentity: "remote:task",
    workspaceRemoteSessionId: "matching",
  });
});

it("hands the file request to the new Root after a mobile workspace switch", async () => {
  const switchWorkspace = vi.fn(async () => {
    useRemoteWorkspaceSessionStore.setState({
      sessionsById: {
        fresh: { sessionId: "fresh", workspaceIdentity: "remote:task" } as RemoteWorkspaceSession,
      },
      sessionIdByWorkspaceIdentity: { "remote:task": "fresh" },
    });
  });
  const props = {
    onOpenFileManager,
    workspacePath: "/current",
    webRemoteControlWorkspaceSwitcher: { switchWorkspace },
  } as unknown as ProjectSidebarProps;
  const { result } = renderHook(() => useProjectFileTree(props, { hosts: [], entries: [] }));
  await act(async () => {
    await result.current.openTaskFiles(
      {
        workspacePath: "/task",
        workspaceIdentity: "remote:task",
        hostId: "remote-host",
      } as ProjectTask,
      "stale",
    );
  });
  expect(onOpenFileManager).not.toHaveBeenCalled();
  expect(switchWorkspace).toHaveBeenCalledWith(
    "remote:task",
    expect.objectContaining({ mobileNavigationIntent: "chat" }),
  );
});

it("accepts an identity-bound mobile session without duplicated session metadata", async () => {
  const state = useRemoteWorkspaceSessionStore.getState();
  state.registerSession({ sessionId: "mobile", services: {} } as RemoteWorkspaceSession);
  state.bindWorkspaceIdentity("remote:task", "mobile");
  const { result } = renderHook(() =>
    useProjectFileTree({ onOpenFileManager } as unknown as ProjectSidebarProps, {
      hosts: [],
      entries: [],
    }),
  );
  await act(async () => {
    await result.current.openTaskFiles({
      taskId: "task",
      hostId: "remote-host",
      workspacePath: "/same-path",
      workspaceIdentity: "remote:task",
    } as ProjectTask);
  });
  expect(onOpenFileManager).toHaveBeenLastCalledWith(
    expect.objectContaining({ workspaceRemoteSessionId: "mobile" }),
  );
});
