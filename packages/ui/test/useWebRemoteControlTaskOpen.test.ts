import { describe, expect, it, vi } from "vitest";
import type { WebRemoteControlTaskTarget } from "@zcode/shared";
import { openWebRemoteControlTask } from "@/hooks/useWebRemoteControlTaskOpen.js";

function createTask(overrides: Partial<WebRemoteControlTaskTarget>): WebRemoteControlTaskTarget {
  return {
    taskId: overrides.taskId ?? "task-1",
    title: overrides.title ?? "Task 1",
    workspacePath: overrides.workspacePath ?? "/workspace/app",
    workspaceIdentity: overrides.workspaceIdentity,
    workspaceLabel: overrides.workspaceLabel ?? "App",
    workspaceKind: overrides.workspaceKind ?? "local",
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 2,
    unreadAt: overrides.unreadAt,
  };
}

describe("openWebRemoteControlTask", () => {
  it("marks a same-workspace unread task as read before selecting it", async () => {
    const task = createTask({ taskId: "task-unread", unreadAt: 123 });
    const events: string[] = [];
    const markTaskRead = vi.fn(async () => {
      events.push("mark-read");
    });
    const onSelectTask = vi.fn(() => {
      events.push("select");
    });

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/app",
      activeTaskId: null,
      markTaskReadOnOpen: true,
      onSelectTask,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        markTaskRead,
        switchWorkspace: vi.fn(async () => {}),
      },
      task,
    });

    expect(markTaskRead).toHaveBeenCalledWith(task);
    expect(events).toEqual(["mark-read", "select"]);
  });

  it("keeps non-mobile task-open callers on their existing unread path", async () => {
    const markTaskRead = vi.fn(async () => {});
    const onSelectTask = vi.fn();

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/app",
      activeTaskId: null,
      onSelectTask,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        markTaskRead,
        switchWorkspace: vi.fn(async () => {}),
      },
      task: createTask({ taskId: "task-unread", unreadAt: 123 }),
    });

    expect(markTaskRead).not.toHaveBeenCalled();
    expect(onSelectTask).toHaveBeenCalledWith("/workspace/app", "task-unread", undefined);
  });

  it("does not wait for the mobile read mutation before opening the task", async () => {
    let finishMarkingRead!: () => void;
    const markTaskRead = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishMarkingRead = resolve;
        }),
    );
    const onSelectTask = vi.fn();

    const opening = openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/app",
      activeTaskId: null,
      markTaskReadOnOpen: true,
      onSelectTask,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        markTaskRead,
        switchWorkspace: vi.fn(async () => {}),
      },
      task: createTask({ taskId: "task-unread", unreadAt: 123 }),
    });

    expect(onSelectTask).toHaveBeenCalledWith("/workspace/app", "task-unread", undefined);

    finishMarkingRead();
    await opening;
  });

  it("selects same-workspace tasks, updates mobile view state, and navigates to chat", async () => {
    const onSelectTask = vi.fn();
    const onNavigateToChat = vi.fn();
    const updateMobileViewState = vi.fn(async () => {});

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/app",
      activeTaskId: null,
      onNavigateToChat,
      onSelectTask,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
        updateMobileViewState,
      },
      task: createTask({ taskId: "task-1" }),
    });

    expect(onSelectTask).toHaveBeenCalledWith("/workspace/app", "task-1", undefined);
    expect(updateMobileViewState).toHaveBeenCalledWith("/workspace/app", "task-1");
    expect(onNavigateToChat).toHaveBeenCalledTimes(1);
  });

  it("switches cross-workspace tasks with a mobile chat navigation intent", async () => {
    const switchWorkspace = vi.fn(async () => {});
    const onSwitchingChange = vi.fn();

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/current",
      activeTaskId: null,
      markTaskReadOnOpen: true,
      mobileNavigationIntent: "chat",
      onSelectTask: vi.fn(),
      onSwitchingChange,
      setSwitchingTaskKey: vi.fn(),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace,
      },
      task: createTask({
        taskId: "remote-task",
        workspacePath: "/workspace/remote",
        workspaceIdentity: "ssh://host/workspace/remote",
        workspaceKind: "remote",
      }),
    });

    expect(onSwitchingChange).toHaveBeenCalledWith(true);
    expect(switchWorkspace).toHaveBeenCalledWith("ssh://host/workspace/remote", {
      taskId: "remote-task",
      mobileNavigationIntent: "chat",
    });
  });

  it("carries an unread-clear intent to the target bridge even from a home-only root", async () => {
    const switchWorkspace = vi.fn(async () => {});

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/current",
      activeTaskId: null,
      markTaskReadOnOpen: true,
      mobileNavigationIntent: "chat",
      onSelectTask: vi.fn(),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace,
      },
      task: createTask({
        taskId: "remote-unread-task",
        unreadAt: 123,
        workspacePath: "/workspace/remote",
        workspaceIdentity: "ssh://host/workspace/remote",
        workspaceKind: "remote",
      }),
    });

    expect(switchWorkspace).toHaveBeenCalledWith("ssh://host/workspace/remote", {
      taskId: "remote-unread-task",
      mobileNavigationIntent: "chat",
      markTaskReadExpectedUnreadAt: 123,
    });
  });

  it("navigates home when a remote workspace bridge fails because it is disconnected", async () => {
    const setError = vi.fn();
    const onNavigateHome = vi.fn();

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/current",
      activeTaskId: null,
      mobileNavigationIntent: "chat",
      onNavigateHome,
      onSelectTask: vi.fn(),
      setError,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {
          throw new Error("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
        }),
      },
      task: createTask({
        taskId: "remote-task",
        workspacePath: "/workspace/remote",
        workspaceIdentity: "ssh://host/workspace/remote",
        workspaceKind: "remote",
      }),
    });

    expect(onNavigateHome).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalledWith("目标远程工作区尚未连接，无法创建 bridge，请先重连。");
  });

  it("clears switching state and stores the error when cross-workspace switching fails", async () => {
    const setError = vi.fn();
    const setSwitchingTaskKey = vi.fn();
    const onSwitchingChange = vi.fn();

    await openWebRemoteControlTask({
      activeWorkspacePath: "/workspace/current",
      activeTaskId: null,
      mobileNavigationIntent: "chat",
      onSelectTask: vi.fn(),
      onSwitchingChange,
      setError,
      setSwitchingTaskKey,
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {
          throw new Error("bridge failed");
        }),
      },
      task: createTask({
        taskId: "remote-task",
        workspacePath: "/workspace/remote",
      }),
    });

    expect(setSwitchingTaskKey).toHaveBeenNthCalledWith(1, "/workspace/remote:remote-task");
    expect(setSwitchingTaskKey).toHaveBeenNthCalledWith(2, null);
    expect(setError).toHaveBeenCalledWith("bridge failed");
    expect(onSwitchingChange).toHaveBeenNthCalledWith(1, true);
    expect(onSwitchingChange).toHaveBeenNthCalledWith(2, false);
  });
});
