// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IServiceAccessor, IZCodeTaskService, ProjectTask } from "@zcode/services";
import type {
  IPlatformService,
  WebRemoteControlMobileTaskView,
  WebRemoteControlStatus,
  ZCodeTaskMeta,
  ZCodeWorkspaceEvent,
} from "@zcode/shared";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { createTabStore, type TabStore } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { createWindowHostControllerRuntime } from "@desktop/host/windowHostControllerService.js";

const mocks = vi.hoisted(() => ({
  services: {} as IServiceAccessor,
  tabs: null as TabStore | null,
  readTree: vi.fn(),
  status: { status: "active" } as WebRemoteControlStatus,
  statusListeners: new Set<(status: WebRemoteControlStatus) => void>(),
  statusRead: null as Promise<WebRemoteControlStatus> | null,
  platform: null as Pick<
    IPlatformService,
    "getWebRemoteControlStatus" | "onWebRemoteControlStatusChanged"
  > | null,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ useOptionalPlatform: () => mocks.platform }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (select: (state: ReturnType<TabStore["getState"]>) => unknown) =>
    select(mocks.tabs!.getState()),
  useTabStoreApi: () => mocks.tabs,
}));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.readTree(...args),
}));

beforeEach(() => {
  mocks.status = { status: "active" };
  mocks.statusRead = null;
  mocks.statusListeners.clear();
  mocks.platform = {
    getWebRemoteControlStatus: vi.fn(() => mocks.statusRead ?? Promise.resolve(mocks.status)),
    onWebRemoteControlStatusChanged: (callback: (status: WebRemoteControlStatus) => void) => {
      mocks.statusListeners.add(callback);
      return () => mocks.statusListeners.delete(callback);
    },
  };
  mocks.tabs = createTabStore(null);
  useZCodeSessionStore.setState({ workspaces: {}, taskNavHistory: { entries: [], cursor: -1 } });
});
afterEach(cleanup);

async function fixture(
  controller = true,
  desktop = true,
  source?: {
    identity?: string;
    remoteSessionId?: string;
    sourceServerId?: string | null;
  },
) {
  const identity = source?.identity ?? "remote:server:source:/repo";
  const task: ProjectTask = {
    taskId: "task",
    traceId: "trace",
    title: "Task",
    workspacePath: "/repo",
    workspaceIdentity: identity,
    hostId: "remote:server:source",
    projectId: "project",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    pinned: false,
    archived: false,
  };
  const events = new Emitter<ZCodeWorkspaceEvent>();
  let marker = 10;
  let delay: Promise<void> | undefined;
  const setTaskUnread = vi.fn(async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
    if (params.unread) task.unreadAt = ++marker;
    else if (params.expectedUnreadAt == null || task.unreadAt === params.expectedUnreadAt)
      delete task.unreadAt;
    const response = { ...task };
    if (params.unread) await delay;
    events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      workspaceIdentity: identity,
      taskId: task.taskId,
      reason: "task_meta_changed",
      taskMeta: { ...task },
    });
    return response;
  });
  const getTaskMeta = vi.fn(async (): Promise<ZCodeTaskMeta | null> => ({ ...task }));
  const service = {
    getTaskMeta,
    listTasks: vi.fn(async () => [{ ...task }]),
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    onDynamicWorkspaceEvent: () => events.event,
    setTaskUnread,
  } as unknown as IZCodeTaskService;
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: () => ({
      scope: {
        kind: "remote",
        sourceServerId:
          source?.sourceServerId === null ? undefined : (source?.sourceServerId ?? "source"),
        remoteSessionId: source?.remoteSessionId,
        workspacePath: "/repo",
        workspaceIdentity: identity,
      },
      sourceAvailability: "online",
      taskService: service,
    }),
  });
  mocks.readTree.mockImplementation(async () => ({
    tree: { projects: [], tasks: [{ ...task }] },
    availability: new Map(),
    directory: { hosts: [], entries: [] },
  }));
  mocks.services = {
    projectService: {},
    ...(controller ? { windowControllerService: runtime.service } : {}),
    zcodeTaskService: service,
    broadcastService: { onMessage: () => ({ dispose() {} }) },
  } as unknown as IServiceAccessor;
  const hook = renderHook(() => useProjectTree(desktop));
  await waitFor(() => expect(hook.result.current.tree.tasks).toHaveLength(1));
  if (controller) await waitFor(() => expect(service.listTasks).toHaveBeenCalled());
  const complete = async (options: { signal?: boolean; updatedAt?: number } = {}) => {
    await act(async () =>
      events.fire({
        type: "workspace_task_list_changed",
        workspacePath: "/repo",
        workspaceIdentity: identity,
        taskId: task.taskId,
        reason: "task_status_changed",
        ...(options.signal === false ? {} : { unreadSignal: "background_terminal" }),
        taskMeta: { ...task, updatedAt: options.updatedAt ?? 2, status: "completed" },
      }),
    );
  };
  const focus = (workspaceIdentity = identity) => {
    mocks.tabs!.getState().addTab("/repo", { workspaceIdentity });
    useZCodeSessionStore.getState().setActiveTaskId("/repo", "task", workspaceIdentity);
  };
  return {
    ...hook,
    runtime,
    task,
    setTaskUnread,
    getTaskMeta,
    listTasks: vi.mocked(service.listTasks),
    complete,
    focus,
    delay: (promise: Promise<void>) => {
      delay = promise;
    },
  };
}

describe("project directory background unread", () => {
  it.each([
    { controller: true, draft: false },
    { controller: false, draft: false },
    { controller: true, draft: true },
    { controller: false, draft: true },
  ])(
    "does not read a cached task across workspaces (Controller=$controller, draft=$draft)",
    async ({ controller, draft }) => {
      const identity = "remote:server:source:/repo";
      mocks.tabs!.getState().addTab("/repo", { workspaceIdentity: identity });
      useZCodeSessionStore.getState().setActiveTaskId("/repo", "task", identity);
      mocks.tabs!.getState().addTab("/workspace-a");
      // 同名 task ID 也必须按完整 workspace 地址隔离；先建齐 scope，避免测试中途换代 owner。
      if (draft) useZCodeSessionStore.getState().startDraft("/workspace-a");
      else useZCodeSessionStore.getState().setActiveTaskId("/workspace-a", "task");
      const f = await fixture(controller);
      const blocked = Promise.withResolvers<void>();
      const navigation = renderHook(() =>
        useWorkspaceTaskNavigation({
          intl: { formatMessage: ({ id }) => id },
          workspaceAbsPath: "/workspace-a",
          activateTabByPath: mocks.tabs!.getState().activateTabByPath,
        }),
      );
      try {
        f.delay(blocked.promise);
        await f.complete();
        await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
        act(() => {
          // 真实 Shell 会在导航 hook 之前先确保 tab；只交换 hook 内更新顺序不足以修复。
          expect(
            ensureTaskNavigationWorkspace({
              workspacePath: f.task.workspacePath,
              workspaceIdentity: f.task.workspaceIdentity,
              activateTabByPath: mocks.tabs!.getState().activateTabByPath,
              addLocalWorkspaceTab: (path) => mocks.tabs!.getState().addTab(path),
            }).accepted,
          ).toBe(true);
          navigation.result.current.handleSelectTask(
            f.task.workspacePath,
            "task-2",
            f.task.workspaceIdentity,
          );
        });
        await act(async () => blocked.resolve());
        expect(
          useZCodeSessionStore
            .getState()
            .getWorkspaceState(f.task.workspacePath, f.task.workspaceIdentity).activeTaskId,
        ).toBe("task-2");
        expect(f.setTaskUnread).toHaveBeenCalledTimes(1);
        expect(f.task.unreadAt).toBe(11);
      } finally {
        blocked.resolve();
        navigation.unmount();
        f.unmount();
        f.runtime.dispose();
      }
    },
  );
  it.each(["other-task", "other-identity", "missing", "automations"])(
    "does not infer a viewed task from an incomplete navigation target (%s)",
    async (route) => {
      const f = await fixture();
      try {
        act(() => {
          f.focus();
          useZCodeSessionStore.setState({
            taskNavHistory:
              route === "missing"
                ? { entries: [], cursor: -1 }
                : {
                    entries: [
                      route === "automations"
                        ? {
                            kind: "automations",
                            workspacePath: "/repo",
                            workspaceIdentity: f.task.workspaceIdentity,
                          }
                        : {
                            kind: "task",
                            workspacePath: "/repo",
                            workspaceIdentity:
                              route === "other-identity"
                                ? "remote:server:other:/repo"
                                : f.task.workspaceIdentity,
                            taskId: route === "other-task" ? "task-2" : f.task.taskId,
                          },
                    ],
                    cursor: 0,
                  },
          });
        });
        await f.complete();
        await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
        expect(f.task.unreadAt).toBe(11);
      } finally {
        f.unmount();
        f.runtime.dispose();
      }
    },
  );
  it.each([true, false])(
    "persists one unread for a live completion (Controller=%s) and displays the owner row",
    async (controller) => {
      const f = await fixture(controller);
      try {
        await f.complete();
        await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(f.result.current.tree.tasks[0]?.unreadAt).toBe(11));
        await f.complete();
        expect(f.setTaskUnread).toHaveBeenCalledTimes(1);
        expect(f.result.current.tree.tasks[0]?.updatedAt).toBe(2);
      } finally {
        f.unmount();
        f.runtime.dispose();
      }
    },
  );
  it("does not infer a completion from ordinary status refresh or the selected task", async () => {
    const f = await fixture();
    try {
      await f.complete({ signal: false });
      expect(f.setTaskUnread).not.toHaveBeenCalled();
      act(() => f.focus());
      await f.complete();
      expect(f.setTaskUnread).not.toHaveBeenCalled();
    } finally {
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("keeps a completion read when the task was viewed during the projection refresh", async () => {
    const f = await fixture();
    const blockedRead = Promise.withResolvers<void>();
    const beganRead = Promise.withResolvers<void>();
    try {
      f.listTasks.mockImplementationOnce(async () => {
        beganRead.resolve();
        await blockedRead.promise;
        return [{ ...f.task }];
      });
      await f.complete();
      await beganRead.promise;
      // 列表 IO 尚未完成时用户已看过又切走，必须保留这次查看并清除本轮 marker。
      act(() => f.focus());
      act(() => f.focus("remote:server:other:/repo"));
      await act(async () => blockedRead.resolve());
      expect(f.setTaskUnread).toHaveBeenCalledWith(
        expect.objectContaining({ unread: false, expectedUnreadAt: 11 }),
      );
      expect(f.task.unreadAt).toBeUndefined();
    } finally {
      blockedRead.resolve();
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("keeps a foreground completion read after switching away during the projection refresh", async () => {
    const f = await fixture();
    const blockedRead = Promise.withResolvers<void>();
    const beganRead = Promise.withResolvers<void>();
    try {
      act(() => f.focus());
      f.listTasks.mockImplementationOnce(async () => {
        beganRead.resolve();
        await blockedRead.promise;
        return [{ ...f.task }];
      });
      await f.complete();
      await beganRead.promise;
      // 完成时任务仍在前台，之后切走不能让迟到的列表读取制造未读。
      act(() => f.focus("remote:server:other:/repo"));
      await act(async () => blockedRead.resolve());
      expect(f.setTaskUnread).not.toHaveBeenCalled();
      expect(f.task.unreadAt).toBeUndefined();
    } finally {
      blockedRead.resolve();
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("isolates identical task IDs on the same path across remote identities", async () => {
    const f = await fixture();
    try {
      act(() => f.focus("remote:server:other:/repo"));
      await f.complete();
      await waitFor(() =>
        expect(f.setTaskUnread).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceIdentity: f.task.workspaceIdentity, unread: true }),
        ),
      );
    } finally {
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("compare-clears only its own unread marker when the task was viewed before the write reply", async () => {
    const f = await fixture();
    const pending = Promise.withResolvers<void>();
    try {
      f.delay(pending.promise);
      await f.complete();
      await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
      act(() => f.focus());
      act(() => f.focus("remote:server:other:/repo"));
      f.task.unreadAt = 99;
      await act(async () => pending.resolve());
      await waitFor(() =>
        expect(f.setTaskUnread).toHaveBeenCalledWith(
          expect.objectContaining({ unread: false, expectedUnreadAt: 11 }),
        ),
      );
      expect(f.task.unreadAt).toBe(99);
    } finally {
      pending.resolve();
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("does not start a late compare-clear after the directory writer was disposed", async () => {
    const f = await fixture();
    const pending = Promise.withResolvers<void>();
    try {
      f.delay(pending.promise);
      await f.complete();
      await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
      act(() => f.focus());
      f.unmount();
      await act(async () => pending.resolve());
      expect(f.setTaskUnread).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve();
      f.runtime.dispose();
    }
  });
  it("allocates a new marker for a newer completion while the previous row is unread", async () => {
    const f = await fixture();
    try {
      await f.complete();
      await waitFor(() => expect(f.result.current.tree.tasks[0]?.unreadAt).toBe(11));
      await f.complete({ updatedAt: 3 });
      await waitFor(() => expect(f.result.current.tree.tasks[0]?.unreadAt).toBe(12));
      expect(f.setTaskUnread).toHaveBeenCalledTimes(2);
    } finally {
      f.unmount();
      f.runtime.dispose();
    }
  });
  it("allows a failed live signal to be retried without creating renderer-only unread state", async () => {
    const f = await fixture();
    try {
      f.setTaskUnread.mockRejectedValueOnce(new Error("write failed"));
      await f.complete();
      await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
      expect(f.result.current.tree.tasks[0]?.unreadAt).toBeUndefined();
      await f.complete();
      await waitFor(() => expect(f.result.current.tree.tasks[0]?.unreadAt).toBe(11));
      expect(f.setTaskUnread).toHaveBeenCalledTimes(2);
    } finally {
      f.unmount();
      f.runtime.dispose();
    }
  });
});

function status(view: WebRemoteControlStatus["mobileTaskView"] = null) {
  mocks.status = { status: "active", mobileTaskView: view };
  for (const listener of mocks.statusListeners) listener(mocks.status);
}
const targetView: WebRemoteControlMobileTaskView = {
  workspacePath: "/repo",
  workspaceIdentity: "remote:server:source:/repo",
  taskId: "task",
};
it("foreground mobile completion stays read", async () => {
  const f = await fixture();
  try {
    act(() => status(targetView));
    await f.complete();
    expect(f.setTaskUnread).not.toHaveBeenCalled();
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
it("direct events preserve viewed then left while unread response is in flight", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  try {
    f.delay(blocked.promise);
    await f.complete();
    await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
    act(() => {
      status(targetView);
      status();
    });
    await act(async () => blocked.resolve());
    expect(f.setTaskUnread).toHaveBeenCalledWith(
      expect.objectContaining({ unread: false, expectedUnreadAt: 11 }),
    );
    expect(f.task.unreadAt).toBeUndefined();
  } finally {
    blocked.resolve();
    f.unmount();
    f.runtime.dispose();
  }
});
it("late CAS does not clear a newer completion after mobile leaves", async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  try {
    f.delay(blocked.promise);
    await f.complete();
    await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
    act(() => {
      status(targetView);
      status();
    });
    f.task.unreadAt = 99;
    await act(async () => blocked.resolve());
    expect(f.task.unreadAt).toBe(99);
    expect(f.setTaskUnread).toHaveBeenCalledWith(
      expect.objectContaining({ unread: false, expectedUnreadAt: 11 }),
    );
  } finally {
    blocked.resolve();
    f.unmount();
    f.runtime.dispose();
  }
});
it("cleared remote view does not suppress completion", async () => {
  const f = await fixture();
  try {
    act(() => {
      status(targetView);
      status();
    });
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
it("same task/path on another remote identity is not viewed", async () => {
  const f = await fixture();
  try {
    act(() => status({ ...targetView, workspaceIdentity: "remote:server:other:/repo" }));
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
it("stale initial status response cannot override newer live disconnect", async () => {
  const pending = Promise.withResolvers<WebRemoteControlStatus>();
  mocks.statusRead = pending.promise;
  const f = await fixture();
  try {
    act(() => status());
    await act(async () => pending.resolve({ status: "active", mobileTaskView: targetView }));
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
  } finally {
    pending.resolve({ status: "idle" });
    f.unmount();
    f.runtime.dispose();
  }
});
it("completion waits for initial view snapshot without a timeout", async () => {
  const pending = Promise.withResolvers<WebRemoteControlStatus>();
  mocks.statusRead = pending.promise;
  const f = await fixture();
  try {
    await f.complete();
    expect(f.setTaskUnread).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ status: "active", mobileTaskView: targetView }));
    expect(f.setTaskUnread).not.toHaveBeenCalled();
  } finally {
    pending.resolve({ status: "idle" });
    f.unmount();
    f.runtime.dispose();
  }
});

it("already committed completion is cleared by a later view even after pending was removed", async () => {
  const f = await fixture();
  try {
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
    await act(async () => {});
    act(() => status(targetView));
    await waitFor(() => expect(f.task.unreadAt).toBeUndefined());
    expect(f.getTaskMeta).toHaveBeenCalled();
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
it("slow view lookup cannot consume a completion accepted after leaving", async () => {
  const f = await fixture();
  const read = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
    await act(async () => {});
    f.getTaskMeta.mockImplementationOnce(async () => {
      started.resolve();
      await read.promise;
      return { ...f.task };
    });
    act(() => status(targetView));
    await started.promise;
    act(() => status());
    await f.complete({ updatedAt: 3 });
    expect(f.setTaskUnread.mock.calls.filter(([p]) => p.unread)).toHaveLength(1);
    await act(async () => read.resolve());
    await waitFor(() => expect(f.task.unreadAt).toBe(12));
    expect(f.setTaskUnread.mock.calls.map(([p]) => [p.unread, p.expectedUnreadAt])).toEqual([
      [true, undefined],
      [false, 11],
      [true, undefined],
    ]);
  } finally {
    read.resolve();
    f.unmount();
    f.runtime.dispose();
  }
});
it("slow unread response, view enter/leave and next completion preserve the next marker", async () => {
  const f = await fixture();
  const write = Promise.withResolvers<void>();
  try {
    f.delay(write.promise);
    await f.complete();
    await waitFor(() => expect(f.setTaskUnread).toHaveBeenCalledTimes(1));
    act(() => {
      status(targetView);
      status();
    });
    await f.complete({ updatedAt: 3 });
    expect(f.setTaskUnread).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve());
    await waitFor(() => expect(f.task.unreadAt).toBe(12));
    expect(f.setTaskUnread.mock.calls.map(([p]) => [p.unread, p.expectedUnreadAt])).toEqual([
      [true, undefined],
      [false, 11],
      [true, undefined],
    ]);
  } finally {
    write.resolve();
    f.unmount();
    f.runtime.dispose();
  }
});
it("repeated same-task status does not erase a manual unread marker", async () => {
  const f = await fixture();
  try {
    act(() => status(targetView));
    await waitFor(() => expect(f.getTaskMeta).toHaveBeenCalledTimes(1));
    await act(async () => {});
    f.task.unreadAt = 99;
    act(() => {
      status({ ...targetView });
      status({ ...targetView });
    });
    await act(async () => {});
    expect(f.getTaskMeta).toHaveBeenCalledTimes(1);
    expect(f.task.unreadAt).toBe(99);
    act(() => {
      status();
      status(targetView);
    });
    await waitFor(() => expect(f.task.unreadAt).toBeUndefined());
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});

it("Web tree never becomes a second remote-view reader/writer", async () => {
  const f = await fixture(true, false);
  try {
    f.task.unreadAt = 99;
    act(() => status(targetView));
    await act(async () => {});
    expect(mocks.platform!.getWebRemoteControlStatus).not.toHaveBeenCalled();
    expect(mocks.statusListeners.size).toBe(0);
    expect(f.getTaskMeta).not.toHaveBeenCalled();
    expect(f.setTaskUnread).not.toHaveBeenCalled();
    expect(f.task.unreadAt).toBe(99);
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});

it("reconnecting the same visible task clears a completion from the disconnected interval", async () => {
  const f = await fixture();
  try {
    act(() => status(targetView));
    await waitFor(() => expect(f.getTaskMeta).toHaveBeenCalledTimes(1));
    act(() => status());
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
    await act(async () => {});
    act(() => status({ ...targetView }));
    await waitFor(() => expect(f.task.unreadAt).toBeUndefined());
    expect(f.getTaskMeta).toHaveBeenCalledTimes(2);
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});

it("reads and clears a legacy remote marker through the trusted viewing attachment", async () => {
  const identity = "remote:ssh:example.test:22:dev:/repo";
  const f = await fixture(true, true, {
    identity,
    sourceServerId: null,
    remoteSessionId: "legacy-attachment",
  });
  try {
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
    await act(async () => {});
    act(() =>
      status({
        workspacePath: "/repo",
        workspaceIdentity: identity,
        taskId: "task",
        remoteSessionId: "legacy-attachment",
      }),
    );
    await waitFor(() => expect(f.task.unreadAt).toBeUndefined());
    expect(f.getTaskMeta).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: identity,
      taskId: "task",
    });
    expect(f.setTaskUnread).toHaveBeenLastCalledWith(
      expect.objectContaining({ unread: false, expectedUnreadAt: 11 }),
    );
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
it("does not suppress a new attachment completion using the old attachment viewing status", async () => {
  const f = await fixture(true, true, { remoteSessionId: "current-attachment" });
  try {
    act(() => status({ ...targetView, remoteSessionId: "stale-attachment" }));
    await f.complete();
    await waitFor(() => expect(f.task.unreadAt).toBe(11));
  } finally {
    f.unmount();
    f.runtime.dispose();
  }
});
