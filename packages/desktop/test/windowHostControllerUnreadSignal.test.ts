import { expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { ZCodeTaskMeta, ZCodeWorkspaceEvent } from "@zcode/shared";
import type { IZCodeTaskService, WindowHostTaskUnreadSignal } from "@zcode/services";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

async function fixture() {
  const events = new Emitter<ZCodeWorkspaceEvent>();
  const scope = {
    kind: "remote" as const,
    sourceServerId: "source",
    workspacePath: "/repo",
    workspaceIdentity: "remote:server:source:/repo",
  };
  const meta: ZCodeTaskMeta = {
    taskId: "task",
    traceId: "trace",
    title: "task",
    workspacePath: "/repo",
    workspaceIdentity: scope.workspaceIdentity,
    mode: "default",
    createdAt: 1,
    updatedAt: 2,
    status: "completed",
  };
  const taskService = {
    listTasks: async () => [{ ...meta }],
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    onDynamicWorkspaceEvent: () => events.event,
    setTaskUnread: vi.fn(async () => ({ ...meta, unreadAt: 10 })),
  } as unknown as IZCodeTaskService;
  const source = { scope, taskService, sourceAvailability: "online" as "online" | "offline" };
  const onSourceError = vi.fn();
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: () => source,
    onSourceError,
  });
  const query = { kind: "timeline" as const, workspaceScopes: [scope], sortBy: "updated" as const };
  await runtime.service.listTaskList(query);
  const emit = () =>
    events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      workspaceIdentity: "source-internal-identity",
      taskId: meta.taskId,
      reason: "task_status_changed",
      unreadSignal: "background_terminal",
      taskMeta: meta,
    });
  return { events, scope, meta, taskService, source, runtime, query, emit, onSourceError };
}

it("forwards only explicit live completions to the base writer with the registered source address", async () => {
  const f = await fixture();
  const base = vi.fn();
  const passive = vi.fn();
  const attachment = f.runtime.createAttachmentService(false);
  f.runtime.service.onDynamicTaskUnreadSignal()(base);
  attachment.onDynamicTaskUnreadSignal()(passive);
  try {
    await f.runtime.service.listTaskList(f.query);
    f.events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      taskId: "task",
      reason: "task_status_changed",
      taskMeta: f.meta,
    });
    expect(base).not.toHaveBeenCalled();
    f.emit();
    await vi.waitFor(() =>
      expect(base).toHaveBeenCalledExactlyOnceWith({
        address: {
          taskId: "task",
          workspacePath: "/repo",
          workspaceIdentity: f.scope.workspaceIdentity,
          sourceServerId: "source",
        },
        updatedAt: 2,
        status: "completed",
      }),
    );
    expect(passive).not.toHaveBeenCalled();
  } finally {
    attachment.dispose();
    f.runtime.dispose();
  }
});

it.each(["disconnect", "replace", "dispose"])(
  "rejects stale live completion after source %s",
  async (action) => {
    const f = await fixture();
    const receive = vi.fn();
    f.runtime.service.onDynamicTaskUnreadSignal()(receive);
    try {
      if (action === "disconnect") f.runtime.disconnectSource(f.scope);
      if (action === "replace") f.source.taskService = { ...f.taskService };
      if (action === "dispose") f.runtime.service.dispose();
      f.emit();
      expect(receive).not.toHaveBeenCalled();
    } finally {
      f.runtime.dispose();
    }
  },
);

it("does not return an old unread write as current after the source service changes", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<ZCodeTaskMeta>();
  vi.mocked(f.taskService.setTaskUnread).mockReturnValue(pending.promise);
  try {
    const write = f.runtime.service.mutateTask({
      address: { ...f.scope, taskId: "task" },
      mutation: { kind: "mark-unread" },
    });
    await vi.waitFor(() => expect(f.taskService.setTaskUnread).toHaveBeenCalled());
    f.source.taskService = { ...f.taskService };
    pending.resolve({ ...f.meta, unreadAt: 10 });
    await expect(write).rejects.toThrow("未读写入期间 source 已失效");
  } finally {
    f.runtime.dispose();
  }
});

it("admits a newly completed task before writing its unread marker", async () => {
  const f = await fixture();
  const result = Promise.withResolvers<ZCodeTaskMeta | null>();
  f.runtime.service.onDynamicTaskUnreadSignal()((signal) => {
    void f.runtime.service
      .mutateTask({ address: signal.address, mutation: { kind: "mark-unread" } })
      .then(result.resolve, result.reject);
  });
  try {
    f.meta.taskId = "new-task";
    f.emit();
    await expect(result.promise).resolves.toMatchObject({ taskId: "new-task", unreadAt: 10 });
  } finally {
    f.runtime.dispose();
  }
});

it("rejects an early completion write when its source changes during admission", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<ZCodeTaskMeta[]>();
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<ZCodeTaskMeta | null>();
  const receive = vi.fn((signal: WindowHostTaskUnreadSignal) => {
    void f.runtime.service
      .mutateTask({ address: signal.address, mutation: { kind: "mark-unread" } })
      .then(result.resolve, result.reject);
  });
  f.runtime.service.onDynamicTaskUnreadSignal()(receive);
  f.taskService.listTasks = vi.fn(() => {
    started.resolve();
    return pending.promise;
  });
  try {
    f.events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      reason: "task_meta_changed",
    });
    await started.promise;
    f.emit();
    // 信号及时送达 UI；源换代保护必须落在写入准入边界，不能靠延后信号保证。
    expect(receive).toHaveBeenCalledOnce();
    f.source.taskService = { ...f.taskService };
    pending.resolve([f.meta]);
    await expect(result.promise).rejects.toThrow("未读写入期间 source 已失效");
    expect(f.taskService.setTaskUnread).not.toHaveBeenCalled();
  } finally {
    pending.resolve([]);
    f.runtime.dispose();
  }
});

it("admits a newly completed task after an older in-flight snapshot finishes", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<ZCodeTaskMeta[]>();
  const started = Promise.withResolvers<void>();
  const previousMeta = { ...f.meta };
  const result = Promise.withResolvers<ZCodeTaskMeta | null>();
  f.taskService.listTasks = vi
    .fn(async () => [{ ...f.meta }])
    .mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
  f.runtime.service.onDynamicTaskUnreadSignal()((signal) => {
    void f.runtime.service
      .mutateTask({ address: signal.address, mutation: { kind: "mark-unread" } })
      .then(result.resolve, result.reject);
  });
  try {
    f.events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      reason: "task_meta_changed",
    });
    await started.promise;
    f.meta.taskId = "new-task";
    f.emit();
    // 在途读取捕获的是旧快照；不能复用它后直接判定新任务不存在。
    pending.resolve([previousMeta]);
    await expect(result.promise).resolves.toMatchObject({ taskId: "new-task", unreadAt: 10 });
    expect(f.taskService.setTaskUnread).toHaveBeenCalledOnce();
  } finally {
    pending.resolve([]);
    f.runtime.dispose();
  }
});

it("keeps a known live completion writable when an earlier refresh fails", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<ZCodeTaskMeta[]>();
  const started = Promise.withResolvers<void>();
  const failure = new Error("refresh failed");
  const result = Promise.withResolvers<ZCodeTaskMeta | null>();
  f.taskService.listTasks = vi
    .fn(async () => [{ ...f.meta }])
    .mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
  f.runtime.service.onDynamicTaskUnreadSignal()((signal) => {
    void f.runtime.service
      .mutateTask({ address: signal.address, mutation: { kind: "mark-unread" } })
      .then(result.resolve, result.reject);
  });
  try {
    f.events.fire({
      type: "workspace_task_list_changed",
      workspacePath: "/repo",
      reason: "task_meta_changed",
    });
    await started.promise;
    f.emit();
    pending.reject(failure);
    await expect(result.promise).resolves.toMatchObject({ taskId: "task", unreadAt: 10 });
    expect(f.onSourceError).toHaveBeenCalledWith(f.scope, "refresh", failure);
    expect(f.taskService.setTaskUnread).toHaveBeenCalledOnce();
  } finally {
    pending.resolve([]);
    f.runtime.dispose();
  }
});

it("rejects the exact write marker if its source changes while the post-write refresh is pending", async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<ZCodeTaskMeta[]>();
  f.taskService.listTasks = vi.fn(() => pending.promise);
  try {
    const write = f.runtime.service.mutateTask({
      address: { ...f.scope, taskId: "task" },
      mutation: { kind: "mark-unread" },
    });
    await vi.waitFor(() => expect(f.taskService.listTasks).toHaveBeenCalled());
    f.source.taskService = { ...f.taskService };
    pending.resolve([f.meta]);
    await expect(write).rejects.toThrow("未读写入期间 source 已失效");
  } finally {
    pending.resolve([]);
    f.runtime.dispose();
  }
});

it("returns the committed unread marker when only the projection refresh fails", async () => {
  const f = await fixture();
  f.taskService.listTasks = vi.fn(async () => {
    throw new Error("refresh failed");
  });
  try {
    await expect(
      f.runtime.service.mutateTask({
        address: { ...f.scope, taskId: "task" },
        mutation: { kind: "mark-unread" },
      }),
    ).resolves.toMatchObject({ taskId: "task", unreadAt: 10 });
  } finally {
    f.runtime.dispose();
  }
});

it.each(["mark-read", "mark-unread"] as const)(
  "does not execute %s against a replacement source after the admission refresh",
  async (kind) => {
    const f = await fixture();
    const pending = Promise.withResolvers<ZCodeTaskMeta[]>();
    const old = {
      ...f.taskService,
      listTasks: vi.fn(() => pending.promise),
      setTaskUnread: vi.fn(async () => ({ ...f.meta, unreadAt: 10 })),
    };
    const next = {
      ...old,
      listTasks: vi.fn(async () => [f.meta]),
      setTaskUnread: vi.fn(async () => ({ ...f.meta, unreadAt: 20 })),
    };
    f.source.taskService = old;
    try {
      const write = f.runtime.service.mutateTask({
        address: { ...f.scope, taskId: "task" },
        mutation: { kind },
      });
      await vi.waitFor(() => expect(old.listTasks).toHaveBeenCalled());
      f.source.taskService = next;
      pending.resolve([f.meta]);
      await expect(write).rejects.toThrow("未读写入期间 source 已失效");
      expect(old.setTaskUnread).not.toHaveBeenCalled();
      expect(next.setTaskUnread).not.toHaveBeenCalled();
    } finally {
      pending.resolve([]);
      f.runtime.dispose();
    }
  },
);

it("delivers the explicit completion of a known task even when its projection refresh fails", async () => {
  const f = await fixture();
  const failure = new Error("transient refresh failure");
  f.taskService.listTasks = vi.fn(async () => [f.meta]).mockRejectedValueOnce(failure);
  const result = Promise.withResolvers<ZCodeTaskMeta | null>();
  const receive = vi.fn((signal: WindowHostTaskUnreadSignal) => {
    void f.runtime.service
      .mutateTask({ address: signal.address, mutation: { kind: "mark-unread" } })
      .then(result.resolve, result.reject);
  });
  f.runtime.service.onDynamicTaskUnreadSignal()(receive);
  try {
    f.emit();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    await expect(result.promise).resolves.toMatchObject({ taskId: "task", unreadAt: 10 });
    expect(f.onSourceError).toHaveBeenCalledExactlyOnceWith(f.scope, "refresh", failure);
    expect(f.taskService.setTaskUnread).toHaveBeenCalledOnce();
  } finally {
    f.runtime.dispose();
  }
});
