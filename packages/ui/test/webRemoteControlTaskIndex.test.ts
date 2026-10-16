import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import * as webRemoteControlTaskIndexModule from "@/lib/webRemoteControlTaskIndex.js";
import {
  applyWebRemoteControlTaskMembershipUpdate,
  buildWebRemoteControlTaskIndexModel,
  buildWebRemoteControlTaskTargets,
  getWebRemoteControlTaskMutationWorkspaceTargets,
  groupWebRemoteControlTasksByWorkspace,
} from "@/lib/webRemoteControlTaskIndex.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

function createTab(overrides: Partial<WorkspaceTabState>): WorkspaceTabState {
  return {
    id: overrides.id ?? "tab-default",
    kind: "workspace",
    label: overrides.label ?? "Default",
    workspacePath: overrides.workspacePath ?? "/repo/default",
    workspaceIdentity: overrides.workspaceIdentity,
    remoteSessionId: overrides.remoteSessionId,
    remoteTarget: overrides.remoteTarget,
  };
}

function createTask(overrides: Partial<ZCodeTaskMeta>): ZCodeTaskMeta {
  return {
    taskId: overrides.taskId ?? "task-default",
    traceId: "trace-default",
    title: overrides.title ?? "Default task",
    workspacePath: overrides.workspacePath ?? "/repo/default",
    workspaceIdentity: overrides.workspaceIdentity,
    createdAt: overrides.createdAt ?? 1,
    updatedAt: overrides.updatedAt ?? 1,
    mode: "default",
    provider: overrides.provider ?? "codex",
    unreadAt: overrides.unreadAt,
    status: overrides.status,
  };
}

describe("buildWebRemoteControlTaskTargets", () => {
  it("maps task metadata to mobile-readable targets and keeps remote workspace identity", () => {
    const localTab = createTab({
      id: "local-tab",
      label: "Local App",
      workspacePath: "/workspace/local-app",
    });
    const remoteTab = createTab({
      id: "remote-tab",
      label: "Remote App",
      workspacePath: "/workspace/app",
      workspaceIdentity: "ssh://dev.example.com/workspace/app",
      remoteSessionId: "remote-session-1",
    });

    const tasks = [
      createTask({
        taskId: "older-local",
        title: "Older local",
        workspacePath: localTab.workspacePath,
        updatedAt: 10,
      }),
      createTask({
        taskId: "newer-remote",
        title: "Newer remote",
        workspacePath: remoteTab.workspacePath,
        workspaceIdentity: remoteTab.workspaceIdentity,
        updatedAt: 20,
        unreadAt: 21,
      }),
    ];

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [localTab, remoteTab],
      tasks,
    });

    expect(targets.map((target) => target.taskId)).toEqual(["newer-remote", "older-local"]);
    expect(targets[0]).toMatchObject({
      workspaceIdentity: "ssh://dev.example.com/workspace/app",
      remoteSessionId: "remote-session-1",
      workspaceLabel: "Remote App",
      workspaceKind: "remote",
      unreadAt: 21,
    });
  });

  it("drops tasks whose workspace is not currently open in the desktop window", () => {
    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [
        createTab({
          label: "Visible",
          workspacePath: "/workspace/visible",
        }),
      ],
      tasks: [
        createTask({
          taskId: "visible-task",
          workspacePath: "/workspace/visible",
        }),
        createTask({
          taskId: "hidden-task",
          workspacePath: "/workspace/hidden",
        }),
      ],
    });

    expect(targets.map((target) => target.taskId)).toEqual(["visible-task"]);
  });

  it("falls back to runtime before persisted status when live activity is absent", () => {
    const tab = createTab({
      label: "Visible",
      workspacePath: "/workspace/visible",
    });

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: [
        createTask({
          taskId: "running-task",
          workspacePath: tab.workspacePath,
          status: "completed",
        }),
        createTask({
          taskId: "failed-runtime-task",
          workspacePath: tab.workspacePath,
          status: "running",
        }),
        createTask({
          taskId: "persisted-error-task",
          workspacePath: tab.workspacePath,
          status: "error",
        }),
        createTask({
          taskId: "stale-running-task",
          workspacePath: tab.workspacePath,
          status: "running",
        }),
        createTask({
          taskId: "creating-task",
          workspacePath: tab.workspacePath,
          status: "completed",
        }),
      ],
      taskRuntimeByWorkspaceKey: {
        [tab.workspacePath]: {
          "running-task": { status: "streaming" },
          "failed-runtime-task": { status: "failed" },
          "creating-task": { status: "creating" },
        },
      },
    });

    expect(
      Object.fromEntries(targets.map((target) => [target.taskId, target.displayStatus])),
    ).toEqual({
      "creating-task": "running",
      "failed-runtime-task": "error",
      "persisted-error-task": "error",
      "running-task": "running",
      "stale-running-task": "idle",
    });
  });

  it("carries the sidecar workflowActivity onto the target so the phone draws the same run line", () => {
    const tab = createTab({ label: "Visible", workspacePath: "/workspace/visible" });
    const workflowActivity = {
      runs: [
        {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "Deep research",
          status: "running",
          phases: [
            { name: "Research", status: "running" },
            { name: "Write", status: "pending" },
          ],
          currentPhase: "Research",
          agentsWorking: 2,
        },
      ],
    };
    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: [
        attachTaskListRowActivity(
          createTask({ taskId: "with-run", workspacePath: tab.workspacePath, status: "completed" }),
          {
            phase: "completedSuccess",
            lastActivityAt: 100,
            hasBackgroundWork: true,
            workflowActivity,
          },
        ),
        attachTaskListRowActivity(
          createTask({ taskId: "no-run", workspacePath: tab.workspacePath, status: "completed" }),
          { phase: "completedSuccess", lastActivityAt: 100, hasBackgroundWork: false },
        ),
      ],
    });
    expect(targets.find((target) => target.taskId === "with-run")?.workflowActivity).toEqual(
      workflowActivity,
    );
    expect(targets.find((target) => target.taskId === "no-run")).not.toHaveProperty(
      "workflowActivity",
    );
  });

  it("carries sessions-index hasBackgroundWork onto the target without changing displayStatus", () => {
    const tab = createTab({
      label: "Visible",
      workspacePath: "/workspace/visible",
    });

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: [
        attachTaskListRowActivity(
          createTask({ taskId: "with-run", workspacePath: tab.workspacePath, status: "completed" }),
          { phase: "completedSuccess", lastActivityAt: 100, hasBackgroundWork: true },
        ),
        attachTaskListRowActivity(
          createTask({
            taskId: "without-run",
            workspacePath: tab.workspacePath,
            status: "completed",
          }),
          { phase: "completedSuccess", lastActivityAt: 100, hasBackgroundWork: false },
        ),
        createTask({
          taskId: "no-activity",
          workspacePath: tab.workspacePath,
          status: "completed",
        }),
      ],
    });

    expect(
      Object.fromEntries(
        targets.map((target) => [target.taskId, [target.displayStatus, target.hasBackgroundWork]]),
      ),
    ).toEqual({
      "with-run": ["completed", true],
      "without-run": ["completed", undefined],
      "no-activity": ["completed", undefined],
    });
  });

  it("uses live sessions-index activity for every display status despite stale caches", () => {
    const tab = createTab({
      label: "Visible",
      workspacePath: "/workspace/visible",
    });
    const cases = [
      {
        taskId: "running-over-completed",
        phase: "running" as const,
        persistedStatus: "completed" as const,
        runtimeStatus: "completed" as const,
        expected: "running",
      },
      {
        taskId: "prewarming-over-error",
        phase: "prewarming" as const,
        persistedStatus: "error" as const,
        runtimeStatus: "failed" as const,
        expected: "running",
      },
      {
        taskId: "completed-over-streaming",
        phase: "completedSuccess" as const,
        persistedStatus: "running" as const,
        runtimeStatus: "streaming" as const,
        expected: "completed",
      },
      {
        taskId: "interrupted-over-failed",
        phase: "completedInterrupted" as const,
        persistedStatus: "error" as const,
        runtimeStatus: "failed" as const,
        expected: "completed",
      },
      {
        taskId: "error-over-streaming",
        phase: "error" as const,
        persistedStatus: "completed" as const,
        runtimeStatus: "streaming" as const,
        expected: "error",
      },
      {
        taskId: "draft-keeps-runtime-fallback",
        phase: "draft" as const,
        persistedStatus: "completed" as const,
        runtimeStatus: "creating" as const,
        expected: "running",
      },
    ];

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: cases.map(({ taskId, phase, persistedStatus }) =>
        attachTaskListRowActivity(
          createTask({
            taskId,
            workspacePath: tab.workspacePath,
            status: persistedStatus,
          }),
          {
            phase,
            lastActivityAt: 100,
            hasBackgroundWork: false,
          },
        ),
      ),
      taskRuntimeByWorkspaceKey: {
        [tab.workspacePath]: Object.fromEntries(
          cases.map(({ taskId, runtimeStatus }) => [
            taskId,
            { status: runtimeStatus },
          ]),
        ),
      },
    });

    expect(
      Object.fromEntries(targets.map((target) => [target.taskId, target.displayStatus])),
    ).toEqual(Object.fromEntries(cases.map(({ taskId, expected }) => [taskId, expected])));
  });

  it("marks pinned task targets for mobile remote lists", () => {
    const tab = createTab({
      label: "Visible",
      workspacePath: "/workspace/visible",
    });

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: [
        createTask({
          taskId: "pinned-task",
          workspacePath: tab.workspacePath,
        }),
      ],
      pinned: true,
    });

    expect(targets).toMatchObject([
      {
        taskId: "pinned-task",
        pinned: true,
      },
    ]);
  });

  it("marks archived task targets for remote archived lists", () => {
    const tab = createTab({
      label: "Visible",
      workspacePath: "/workspace/visible",
    });

    const targets = buildWebRemoteControlTaskTargets({
      workspaceTabs: [tab],
      tasks: [
        createTask({
          taskId: "archived-task",
          workspacePath: tab.workspacePath,
        }),
      ],
      archived: true,
    });

    expect(targets).toMatchObject([
      {
        taskId: "archived-task",
        archived: true,
      },
    ]);
  });

  it("groups mobile task targets by workspace order with tasks nested under each workspace", () => {
    const firstWorkspace = {
      workspacePath: "/workspace/a",
      label: "Workspace A",
      kind: "local" as const,
    };
    const secondWorkspace = {
      workspacePath: "/workspace/b",
      workspaceIdentity: "ssh://dev.example.com/workspace/b",
      remoteSessionId: "remote-session-1",
      label: "Workspace B",
      kind: "remote" as const,
    };

    const groups = groupWebRemoteControlTasksByWorkspace({
      workspaces: [firstWorkspace, secondWorkspace],
      tasks: [
        {
          taskId: "b-older",
          title: "B older",
          workspacePath: secondWorkspace.workspacePath,
          workspaceIdentity: secondWorkspace.workspaceIdentity,
          remoteSessionId: secondWorkspace.remoteSessionId,
          workspaceLabel: secondWorkspace.label,
          workspaceKind: "remote",
          createdAt: 1,
          updatedAt: 10,
        },
        {
          taskId: "a-task",
          title: "A task",
          workspacePath: firstWorkspace.workspacePath,
          workspaceLabel: firstWorkspace.label,
          workspaceKind: "local",
          createdAt: 1,
          updatedAt: 30,
        },
        {
          taskId: "b-newer",
          title: "B newer",
          workspacePath: secondWorkspace.workspacePath,
          workspaceIdentity: secondWorkspace.workspaceIdentity,
          remoteSessionId: secondWorkspace.remoteSessionId,
          workspaceLabel: secondWorkspace.label,
          workspaceKind: "remote",
          createdAt: 1,
          updatedAt: 20,
        },
      ],
    });

    expect(groups.map((group) => group.workspace.label)).toEqual(["Workspace A", "Workspace B"]);
    expect(groups[0]?.tasks.map((task) => task.taskId)).toEqual(["a-task"]);
    expect(groups[1]?.tasks.map((task) => task.taskId)).toEqual(["b-newer", "b-older"]);
  });

  it("sorts grouped remote tasks by the selected time field", () => {
    const workspace = {
      workspacePath: "/workspace/a",
      label: "Workspace A",
      kind: "local" as const,
    };

    const groups = groupWebRemoteControlTasksByWorkspace({
      workspaces: [workspace],
      sortBy: "created",
      tasks: [
        {
          taskId: "newer-updated",
          title: "Newer updated",
          workspacePath: workspace.workspacePath,
          workspaceLabel: workspace.label,
          workspaceKind: "local",
          createdAt: 10,
          updatedAt: 30,
        },
        {
          taskId: "newer-created",
          title: "Newer created",
          workspacePath: workspace.workspacePath,
          workspaceLabel: workspace.label,
          workspaceKind: "local",
          createdAt: 20,
          updatedAt: 1,
        },
      ],
    });

    expect(groups[0]?.tasks.map((task) => task.taskId)).toEqual([
      "newer-created",
      "newer-updated",
    ]);
  });

  it("远控把有后台工作的会话并入运行层，updatedAt 交替时不换位", () => {
    const workspace = {
      workspacePath: "/workspace/a",
      label: "Workspace A",
      kind: "local" as const,
    };
    const task = (taskId: string, createdAt: number, updatedAt: number) => ({
      taskId,
      title: taskId,
      workspacePath: workspace.workspacePath,
      workspaceLabel: workspace.label,
      workspaceKind: workspace.kind,
      createdAt,
      updatedAt,
      displayStatus: "completed" as const,
      hasBackgroundWork: true,
    });
    const idle = {
      ...task("idle", 30, 5_000),
      hasBackgroundWork: false,
    };

    const order = (tasks: ReturnType<typeof task>[]) =>
      groupWebRemoteControlTasksByWorkspace({
        workspaces: [workspace],
        sortBy: "updated",
        tasks,
      })[0]?.tasks.map((item) => item.taskId);

    expect(order([task("run-a", 10, 900), task("run-b", 20, 100), idle])).toEqual([
      "run-b",
      "run-a",
      "idle",
    ]);
    expect(order([task("run-a", 10, 100), task("run-b", 20, 900), idle])).toEqual([
      "run-b",
      "run-a",
      "idle",
    ]);
  });

  it("远控 running 置顶并按 createdAt 稳定排序", () => {
    const workspace = {
      workspacePath: "/workspace/a",
      label: "Workspace A",
      kind: "local" as const,
    };
    const task = (
      taskId: string,
      createdAt: number,
      updatedAt: number,
      displayStatus: "running" | "completed",
    ) => ({
      taskId,
      title: taskId,
      workspacePath: workspace.workspacePath,
      workspaceLabel: workspace.label,
      workspaceKind: workspace.kind,
      createdAt,
      updatedAt,
      displayStatus,
    });

    const groups = groupWebRemoteControlTasksByWorkspace({
      workspaces: [workspace],
      sortBy: "updated",
      tasks: [
        task("parent", 10, 1_000, "running"),
        task("fork", 20, 1, "running"),
        task("completed", 30, 2_000, "completed"),
      ],
    });

    expect(groups[0]?.tasks.map((item) => item.taskId)).toEqual([
      "fork",
      "parent",
      "completed",
    ]);
  });
});

describe("buildWebRemoteControlTaskIndexModel", () => {
  const localWorkspace = {
    workspacePath: "/workspace/local",
    label: "Local App",
    kind: "local" as const,
  };
  const remoteWorkspace = {
    workspacePath: "/workspace/remote",
    workspaceIdentity: "ssh://dev/workspace/remote",
    remoteSessionId: "remote-session",
    label: "Remote App",
    kind: "remote" as const,
  };
  const result = {
    workspaces: [localWorkspace, remoteWorkspace],
    tasks: [
      {
        taskId: "pinned-local",
        title: "Pinned local",
        workspacePath: localWorkspace.workspacePath,
        workspaceLabel: localWorkspace.label,
        workspaceKind: "local" as const,
        createdAt: 100,
        updatedAt: 100,
        pinned: true,
      },
      {
        taskId: "regular-local",
        title: "Regular local",
        workspacePath: localWorkspace.workspacePath,
        workspaceLabel: localWorkspace.label,
        workspaceKind: "local" as const,
        createdAt: 10,
        updatedAt: 50,
      },
      {
        taskId: "regular-remote",
        title: "Remote search hit",
        workspacePath: remoteWorkspace.workspacePath,
        workspaceIdentity: remoteWorkspace.workspaceIdentity,
        remoteSessionId: remoteWorkspace.remoteSessionId,
        workspaceLabel: remoteWorkspace.label,
        workspaceKind: "remote" as const,
        createdAt: 20,
        updatedAt: 40,
      },
      {
        taskId: "archived-remote",
        title: "Archived remote",
        workspacePath: remoteWorkspace.workspacePath,
        workspaceIdentity: remoteWorkspace.workspaceIdentity,
        remoteSessionId: remoteWorkspace.remoteSessionId,
        workspaceLabel: remoteWorkspace.label,
        workspaceKind: "remote" as const,
        createdAt: 30,
        updatedAt: 30,
        archived: true,
      },
    ],
  };

  it("builds workspace groups from regular tasks without duplicating pinned or archived tasks", () => {
    const model = buildWebRemoteControlTaskIndexModel({
      result,
      viewMode: "workspace",
      sortBy: "updated",
    });

    expect(model.pinnedTasks.map((task) => task.taskId)).toEqual(["pinned-local"]);
    expect(model.groups.map((group) => group.workspace.label)).toEqual([
      "Local App",
      "Remote App",
    ]);
    expect(model.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-local",
      "regular-remote",
    ]);
    expect(model.totalTaskCount).toBe(2);
  });

  it("builds a cross-workspace timeline using the selected sort field", () => {
    const model = buildWebRemoteControlTaskIndexModel({
      result,
      viewMode: "timeline",
      sortBy: "created",
    });

    expect(model.timelineTasks.map((task) => task.taskId)).toEqual([
      "regular-remote",
      "regular-local",
    ]);
  });

  it("builds a cross-workspace archived list from archived task targets", () => {
    const model = buildWebRemoteControlTaskIndexModel({
      result,
      viewMode: "archived",
      sortBy: "updated",
    });

    expect(model.archivedTasks.map((task) => task.taskId)).toEqual(["archived-remote"]);
    expect(model.totalTaskCount).toBe(1);
  });

  it("filters remote tasks by title and workspace label", () => {
    const titleModel = buildWebRemoteControlTaskIndexModel({
      result,
      viewMode: "workspace",
      sortBy: "updated",
      searchQuery: "search hit",
    });
    const workspaceModel = buildWebRemoteControlTaskIndexModel({
      result,
      viewMode: "workspace",
      sortBy: "updated",
      searchQuery: "local app",
    });

    expect(titleModel.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-remote",
    ]);
    expect(workspaceModel.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-local",
    ]);
  });

  it("keeps collapsed workspace groups visible while hiding their tasks", () => {
    const model = buildWebRemoteControlTaskIndexModel({
      result: {
        ...result,
        tasks: result.tasks.map((task) =>
          task.taskId === "regular-local" ? { ...task, unreadAt: 123 } : task,
        ),
      },
      viewMode: "workspace",
      sortBy: "updated",
      collapsedWorkspaceKeys: new Set([localWorkspace.workspacePath]),
    });

    expect(model.groups.map((group) => [group.workspace.label, group.collapsed])).toEqual([
      ["Local App", true],
      ["Remote App", false],
    ]);
    expect(model.groups.flatMap((group) => group.tasks.map((task) => task.taskId))).toEqual([
      "regular-remote",
    ]);
    expect(model.groups.find((group) => group.workspace.label === "Local App")?.hasUnread).toBe(
      true,
    );
  });

  it("does not aggregate pinned or archived unread tasks into workspace groups", () => {
    const model = buildWebRemoteControlTaskIndexModel({
      result: {
        ...result,
        tasks: result.tasks.map((task) =>
          task.pinned || task.archived ? { ...task, unreadAt: 123 } : task,
        ),
      },
      viewMode: "workspace",
    });

    expect(model.groups.every((group) => group.hasUnread === false)).toBe(true);
  });
});

describe("applyWebRemoteControlTaskMembershipUpdate", () => {
  const workspace = {
    workspacePath: "/workspace/local",
    label: "Local App",
    kind: "local" as const,
  };

  const baseResult = {
    workspaces: [workspace],
    tasks: [
      {
        taskId: "regular-local",
        title: "Regular local",
        workspacePath: workspace.workspacePath,
        workspaceLabel: workspace.label,
        workspaceKind: "local" as const,
        createdAt: 10,
        updatedAt: 50,
      },
    ],
  };

  it("moves a regular task into the pinned section without archiving it", () => {
    const next = applyWebRemoteControlTaskMembershipUpdate({
      result: baseResult,
      target: baseResult.tasks[0],
      membership: { pinned: true, archived: false },
    });

    expect(next.tasks?.[0]).toMatchObject({
      taskId: "regular-local",
      pinned: true,
    });
    expect(next.tasks?.[0]?.archived).toBeUndefined();
  });

  it("moves a task into the archived section and clears pinned membership", () => {
    const next = applyWebRemoteControlTaskMembershipUpdate({
      result: {
        ...baseResult,
        tasks: [{ ...baseResult.tasks[0], pinned: true }],
      },
      target: { ...baseResult.tasks[0], pinned: true },
      membership: { pinned: false, archived: true },
    });

    expect(next.tasks?.[0]).toMatchObject({
      taskId: "regular-local",
      archived: true,
    });
    expect(next.tasks?.[0]?.pinned).toBeUndefined();
  });
});

describe("getWebRemoteControlTaskMutationWorkspaceTargets", () => {
  it("does not treat local workspaces as mutable through a remote bridge host", () => {
    const localWorkspace = {
      workspacePath: "/Users/me/local-app",
      label: "local-app",
      kind: "local" as const,
    };
    const remoteWorkspace = {
      workspacePath: "/srv/app",
      workspaceIdentity: "ssh://box/srv/app",
      remoteSessionId: "remote-session-1",
      label: "remote-app",
      kind: "remote" as const,
    };

    const mutationTargets = getWebRemoteControlTaskMutationWorkspaceTargets({
      activeWorkspaceIdentity: "ssh://box/srv/app",
      workspaces: [localWorkspace, remoteWorkspace],
    });

    expect(mutationTargets).toEqual([remoteWorkspace]);
  });

  it("keeps local workspaces mutable when the current bridge host is local", () => {
    const localWorkspace = {
      workspacePath: "/Users/me/local-app",
      label: "local-app",
      kind: "local" as const,
    };

    expect(
      getWebRemoteControlTaskMutationWorkspaceTargets({
        workspaces: [localWorkspace],
      }),
    ).toEqual([localWorkspace]);
  });
});

describe("shouldRetryWebRemoteControlTaskIndexLoad", () => {
  const shouldRetryWebRemoteControlTaskIndexLoad = (
    webRemoteControlTaskIndexModule as {
      shouldRetryWebRemoteControlTaskIndexLoad?: (options: {
        activeTaskId: string | null;
        attempt: number;
        maxAttempts: number;
        taskCount: number;
      }) => boolean;
    }
  ).shouldRetryWebRemoteControlTaskIndexLoad;

  it("retries a transient empty index while a remote task is active", () => {
    expect(shouldRetryWebRemoteControlTaskIndexLoad).toBeTypeOf("function");
    expect(
      shouldRetryWebRemoteControlTaskIndexLoad?.({
        activeTaskId: "remote-task",
        attempt: 0,
        maxAttempts: 3,
        taskCount: 0,
      }),
    ).toBe(true);
  });

  it("does not retry when there is no active task, tasks are present, or attempts are exhausted", () => {
    expect(shouldRetryWebRemoteControlTaskIndexLoad).toBeTypeOf("function");
    expect(
      shouldRetryWebRemoteControlTaskIndexLoad?.({
        activeTaskId: null,
        attempt: 0,
        maxAttempts: 3,
        taskCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldRetryWebRemoteControlTaskIndexLoad?.({
        activeTaskId: "remote-task",
        attempt: 0,
        maxAttempts: 3,
        taskCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldRetryWebRemoteControlTaskIndexLoad?.({
        activeTaskId: "remote-task",
        attempt: 3,
        maxAttempts: 3,
        taskCount: 0,
      }),
    ).toBe(false);
  });
});
