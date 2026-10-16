import { describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  DEFAULT_TASK_RUNTIME_STATE,
  getDefaultWorkspaceState,
} from "@/store/zcodeSessionStore.js";
import { markRemoteWorkspaceRunningTasksFailed } from "@/lib/remoteWorkspaceSessionRuntime.js";

function createTask(taskId: string, status: ZCodeTaskMeta["status"]): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/workspace/demo",
    workspaceIdentity: "ssh://root@example.com/workspace/demo",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    status,
  };
}

describe("markRemoteWorkspaceRunningTasksFailed", () => {
  it("远程断连时应把运行中和持久化 running 的任务收口为 failed", () => {
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      activeTaskId: "active-task",
      taskRuntimeByTaskId: {
        "active-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "streaming" as const,
        },
        "restoring-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "restoring" as const,
        },
        "ready-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "ready" as const,
        },
      },
      taskListCache: [
        createTask("persisted-running-task", "running"),
        createTask("persisted-completed-task", "completed"),
      ],
      optimisticTaskListByTaskId: {
        "optimistic-running-task": createTask("optimistic-running-task", "running"),
        "active-task": createTask("active-task", "running"),
      },
    };
    const setTaskRuntimeState = vi.fn();

    const count = markRemoteWorkspaceRunningTasksFailed({
      tabs: [
        {
          workspacePath: "/workspace/demo",
          workspaceIdentity: "ssh://root@example.com/workspace/demo",
        },
      ],
      getWorkspaceState: () => workspaceState,
      setTaskRuntimeState,
      reason: "远程连接已断开",
    });

    expect(count).toBe(4);
    expect(setTaskRuntimeState.mock.calls).toEqual([
      [
        "/workspace/demo",
        "active-task",
        "failed",
        "远程连接已断开",
        "ssh://root@example.com/workspace/demo",
      ],
      [
        "/workspace/demo",
        "restoring-task",
        "failed",
        "远程连接已断开",
        "ssh://root@example.com/workspace/demo",
      ],
      [
        "/workspace/demo",
        "persisted-running-task",
        "failed",
        "远程连接已断开",
        "ssh://root@example.com/workspace/demo",
      ],
      [
        "/workspace/demo",
        "optimistic-running-task",
        "failed",
        "远程连接已断开",
        "ssh://root@example.com/workspace/demo",
      ],
    ]);
  });

  it("远程断连时不应改写已经终态或 ready 的任务", () => {
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      activeTaskId: "ready-task",
      taskRuntimeByTaskId: {
        "ready-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "ready" as const,
        },
      },
      taskListCache: [createTask("completed-task", "completed")],
      optimisticTaskListByTaskId: {
        "error-task": createTask("error-task", "error"),
      },
    };
    const setTaskRuntimeState = vi.fn();

    const count = markRemoteWorkspaceRunningTasksFailed({
      tabs: [
        {
          workspacePath: "/workspace/demo",
          workspaceIdentity: "ssh://root@example.com/workspace/demo",
        },
      ],
      getWorkspaceState: () => workspaceState,
      setTaskRuntimeState,
      reason: "远程连接已断开",
    });

    expect(count).toBe(0);
    expect(setTaskRuntimeState).not.toHaveBeenCalled();
  });

  it("远程断连时不应被滞后的 running task meta 覆盖本地终态 runtime", () => {
    const workspaceState = {
      ...getDefaultWorkspaceState(),
      taskRuntimeByTaskId: {
        "completed-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "completed" as const,
        },
        "failed-task": {
          ...DEFAULT_TASK_RUNTIME_STATE,
          status: "failed" as const,
        },
      },
      taskListCache: [
        createTask("completed-task", "running"),
        createTask("failed-task", "running"),
      ],
      optimisticTaskListByTaskId: {},
    };
    const setTaskRuntimeState = vi.fn();

    const count = markRemoteWorkspaceRunningTasksFailed({
      tabs: [
        {
          workspacePath: "/workspace/demo",
          workspaceIdentity: "ssh://root@example.com/workspace/demo",
        },
      ],
      getWorkspaceState: () => workspaceState,
      setTaskRuntimeState,
      reason: "远程连接已断开",
    });

    expect(count).toBe(0);
    expect(setTaskRuntimeState).not.toHaveBeenCalled();
  });
});
