// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import type { IServiceAccessor } from "@zcode/services";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { createTaskNavigationHistory } from "@/lib/taskNavigationHistory.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { useTaskQueryCacheStore } from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

const tabStore = vi.hoisted(() => {
  let state: {
    activeTabId: string | null;
    tabs: Array<{
      id: string;
      kind: "workspace";
      label: string;
      workspacePath: string;
      workspaceIdentity?: string;
      remoteSessionId?: string;
    }>;
  } = { activeTabId: null, tabs: [] };
  return {
    api: { getState: () => state },
    setState: (next: typeof state) => {
      state = next;
    },
  };
});

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => tabStore.api,
}));

const localWorkspacePath = "/work/local";
const taskId = "task-local";

function taskMeta(params: { workspacePath?: string; workspaceIdentity?: string } = {}) {
  const workspacePath = params.workspacePath ?? localWorkspacePath;
  return {
    taskId,
    traceId: "trace-local",
    title: "local task",
    workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    createdAt: 1,
    updatedAt: 2,
    mode: "default" as const,
    unreadAt: 2,
  };
}

function servicesWithSetTaskUnread(setTaskUnread: ReturnType<typeof vi.fn>): IServiceAccessor {
  return { zcodeTaskService: { setTaskUnread } } as unknown as IServiceAccessor;
}

function renderNavigation(params: {
  ambientServices: IServiceAccessor;
  activateTabByPath: (
    workspacePath: string,
    options?: { workspaceIdentity?: string },
  ) => boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
  onNavigateToAutomations?: ReturnType<typeof vi.fn>;
}) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(ServiceProvider, { services: params.ambientServices }, children);
  return renderHook(
    () =>
      useWorkspaceTaskNavigation({
        intl: { formatMessage: ({ id }) => id },
        workspaceAbsPath: params.workspacePath ?? "/home/dev",
        workspaceIdentity:
          params.workspaceIdentity ?? "remote:ssh:dev:22:user:/home/dev",
        activateTabByPath: params.activateTabByPath,
        onNavigateToAutomations: params.onNavigateToAutomations,
      }),
    { wrapper },
  );
}

describe("useWorkspaceTaskNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabStore.setState({ activeTabId: null, tabs: [] });
    useTaskQueryCacheStore.getState().clearAll();
    useRemoteWorkspaceSessionStore.setState({
      baseServices: null,
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    });
    useZCodeSessionStore.setState({ taskNavHistory: createTaskNavigationHistory() });
  });

  it("把 Idle-time intent 写入 Automations 导航目标和历史", () => {
    const onNavigateToAutomations = vi.fn();
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath: vi.fn(() => true),
      onNavigateToAutomations,
    });

    act(() => {
      hook.result.current.handleOpenAutomations(undefined, "idle");
    });

    expect(onNavigateToAutomations).toHaveBeenCalledWith({
      workspacePath: "/home/dev",
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
      automationTab: "idle",
    });
    expect(useZCodeSessionStore.getState().taskNavHistory.entries).toEqual([
      {
        kind: "automations",
        workspacePath: "/home/dev",
        workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
        automationTab: "idle",
      },
    ]);
    hook.unmount();
  });

  it("前进回放时恢复 Idle-time Automations intent", () => {
    const onNavigateToAutomations = vi.fn();
    const activateTabByPath = vi.fn(() => true);
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          {
            kind: "task",
            workspacePath: "/home/dev",
            workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
            taskId: "task-before-automations",
          },
          {
            kind: "automations",
            workspacePath: "/home/dev",
            workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
            automationTab: "idle",
          },
        ],
        cursor: 0,
      },
    });
    const hook = renderNavigation({
      ambientServices: servicesWithSetTaskUnread(vi.fn()),
      activateTabByPath,
      onNavigateToAutomations,
    });

    act(() => {
      hook.result.current.handleTaskNavForward();
    });

    expect(activateTabByPath).toHaveBeenCalledWith("/home/dev", {
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
    });
    expect(onNavigateToAutomations).toHaveBeenCalledWith({
      workspacePath: "/home/dev",
      workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
      automationTab: "idle",
    });
    hook.unmount();
  });

  it("从 remote workspace 选择本地 task 时通过 window base services 清除未读", async () => {
    const baseSetTaskUnread = vi.fn(async () => taskMeta());
    const staleRemoteSetTaskUnread = vi.fn(async () => taskMeta());
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    useTaskQueryCacheStore.getState().upsertTaskMeta(taskMeta());
    tabStore.setState({
      activeTabId: "remote-a",
      tabs: [
        {
          id: "remote-a",
          kind: "workspace",
          label: "remote",
          workspacePath: "/home/dev",
          workspaceIdentity: "remote:ssh:dev:22:user:/home/dev",
          remoteSessionId: "remote-a",
        },
      ],
    });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "local",
        tabs: [
          {
            id: "local",
            kind: "workspace",
            label: "local",
            workspacePath: localWorkspacePath,
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
    });

    await act(async () => {
      hook.result.current.handleSelectTask(localWorkspacePath, taskId);
      await Promise.resolve();
    });

    expect(baseSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: localWorkspacePath,
      unread: false,
      expectedUnreadAt: 2,
    });
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("任务行未读但 query cache 尚未水合时仍按点击版本清除未读", async () => {
    const baseSetTaskUnread = vi.fn(async () => ({
      ...taskMeta(),
      unreadAt: undefined,
    }));
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    tabStore.setState({ activeTabId: null, tabs: [] });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "local",
        tabs: [
          {
            id: "local",
            kind: "workspace",
            label: "local",
            workspacePath: localWorkspacePath,
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: baseServices,
      activateTabByPath,
    });

    await act(async () => {
      hook.result.current.handleSelectTask(
        localWorkspacePath,
        taskId,
        undefined,
        321,
      );
      await Promise.resolve();
    });

    expect(useTaskQueryCacheStore.getState().taskMetaByEntityKey).toEqual({});
    expect(baseSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: localWorkspacePath,
      unread: false,
      expectedUnreadAt: 321,
    });
    hook.unmount();
  });

  it("选择 remote task 时只使用目标 tab 的精确 remoteSessionId attachment", async () => {
    const targetWorkspacePath = "/home/shared";
    const targetWorkspaceIdentity = "remote:ssh:host-b:22:user:/home/shared";
    const targetSetTaskUnread = vi.fn(async () =>
      taskMeta({ workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity }),
    );
    const baseSetTaskUnread = vi.fn();
    const staleRemoteSetTaskUnread = vi.fn();
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const targetServices = servicesWithSetTaskUnread(targetSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({
      baseServices,
      sessionsById: {
        "remote-b": { sessionId: "remote-b", services: targetServices },
      },
    });
    useTaskQueryCacheStore
      .getState()
      .upsertTaskMeta(
        taskMeta({ workspacePath: targetWorkspacePath, workspaceIdentity: targetWorkspaceIdentity }),
      );
    tabStore.setState({
      activeTabId: "remote-a",
      tabs: [
        {
          id: "remote-a",
          kind: "workspace",
          label: "remote-a",
          workspacePath: "/home/shared",
          workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
          remoteSessionId: "remote-a",
        },
      ],
    });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "remote-b",
        tabs: [
          {
            id: "remote-b",
            kind: "workspace",
            label: "remote-b",
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            remoteSessionId: "remote-b",
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
      workspacePath: "/home/shared",
      workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
    });

    await act(async () => {
      hook.result.current.handleSelectTask(
        targetWorkspacePath,
        taskId,
        targetWorkspaceIdentity,
      );
      await Promise.resolve();
    });

    expect(targetSetTaskUnread).toHaveBeenCalledWith({
      taskId,
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
      unread: false,
      expectedUnreadAt: 2,
    });
    expect(baseSetTaskUnread).not.toHaveBeenCalled();
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("目标 remote attachment 已断开时回滚未读且不回退到 base", async () => {
    const targetWorkspacePath = "/home/shared";
    const targetWorkspaceIdentity = "remote:ssh:host-b:22:user:/home/shared";
    const baseSetTaskUnread = vi.fn();
    const staleRemoteSetTaskUnread = vi.fn();
    const baseServices = servicesWithSetTaskUnread(baseSetTaskUnread);
    const staleRemoteServices = servicesWithSetTaskUnread(staleRemoteSetTaskUnread);
    useRemoteWorkspaceSessionStore.setState({ baseServices });
    const remoteTask = taskMeta({
      workspacePath: targetWorkspacePath,
      workspaceIdentity: targetWorkspaceIdentity,
    });
    useTaskQueryCacheStore.getState().upsertTaskMeta(remoteTask);
    tabStore.setState({ activeTabId: null, tabs: [] });
    const activateTabByPath = vi.fn(() => {
      tabStore.setState({
        activeTabId: "remote-b",
        tabs: [
          {
            id: "remote-b",
            kind: "workspace",
            label: "remote-b",
            workspacePath: targetWorkspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            remoteSessionId: "remote-b-disconnected",
          },
        ],
      });
      return true;
    });
    const hook = renderNavigation({
      ambientServices: staleRemoteServices,
      activateTabByPath,
      workspacePath: "/home/shared",
      workspaceIdentity: "remote:ssh:host-a:22:user:/home/shared",
    });

    act(() => {
      hook.result.current.handleSelectTask(
        targetWorkspacePath,
        taskId,
        targetWorkspaceIdentity,
      );
    });

    expect(baseSetTaskUnread).not.toHaveBeenCalled();
    expect(staleRemoteSetTaskUnread).not.toHaveBeenCalled();
    expect(
      useTaskQueryCacheStore.getState().taskMetaByEntityKey[buildTaskEntityKey(remoteTask)]?.unreadAt,
    ).toBe(2);
    hook.unmount();
  });
});
