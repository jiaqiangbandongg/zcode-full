import { expect, it, vi } from "vitest";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createWindowHostControllerRuntime } from "../src/host/windowHostControllerService.js";

const workspacePath = "/repo";
const workspaceIdentity = "remote:server:source:/repo";
const task: ZCodeTaskMeta = {
  taskId: "task",
  traceId: "trace",
  title: "Task",
  workspacePath,
  workspaceIdentity,
  createdAt: 1,
  updatedAt: 2,
  mode: "default",
  unreadAt: 10,
};
const attachment = (remoteSessionId: string) => ({
  kind: "remote" as const,
  remoteSessionId,
  workspacePath,
  workspaceIdentity,
});

it("clears unread through the first attachment after a Source-only sidebar query", async () => {
  let remoteSessionId: string | undefined;
  const service = {
    listTasks: async () => [task],
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
    setTaskUnread: vi.fn(async () => ({ ...task, unreadAt: undefined })),
  } as unknown as IZCodeTaskService;
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: () => ({
      scope: {
        kind: "remote",
        sourceServerId: "source",
        remoteSessionId,
        workspacePath,
        workspaceIdentity,
      },
      taskService: service,
      sourceAvailability: "online",
    }),
  });
  try {
    // 真实侧栏在打开项目以前就查询 Source；投影行还没有 logical attachment ID。
    await runtime.service.listTaskList({
      kind: "timeline",
      workspaceScopes: [{ workspacePath, workspaceIdentity }],
      sortBy: "updated",
    });
    remoteSessionId = "first-attachment";
    const address = await runtime.resolveTaskAddress({
      taskId: task.taskId,
      workspacePath,
      workspaceIdentity,
      attachmentScope: attachment(remoteSessionId),
    });
    await runtime.service.mutateTask({
      address,
      mutation: { kind: "mark-read", expectedUnreadAt: 10 },
    });
    expect(service.setTaskUnread).toHaveBeenCalledWith({
      taskId: task.taskId,
      workspacePath,
      workspaceIdentity,
      unread: false,
      expectedUnreadAt: 10,
    });
    await expect(
      runtime.resolveTaskAddress({
        taskId: task.taskId,
        workspacePath,
        workspaceIdentity,
        attachmentScope: attachment("stale-attachment"),
      }),
    ).rejects.toThrow("remote attachment source 不匹配");
  } finally {
    runtime.dispose();
  }
});

it("does not admit an attachment that changed while its first task snapshot was loading", async () => {
  let remoteSessionId = "first-attachment";
  const loading = Promise.withResolvers<ZCodeTaskMeta[]>();
  const service = {
    listTasks: vi.fn(() => loading.promise),
    listPinnedTasks: async () => [],
    listArchivedTasks: async () => [],
  } as unknown as IZCodeTaskService;
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: () => ({
      scope: {
        kind: "remote",
        sourceServerId: "source",
        remoteSessionId,
        workspacePath,
        workspaceIdentity,
      },
      taskService: service,
      sourceAvailability: "online",
    }),
  });
  try {
    const resolving = runtime.resolveTaskAddress({
      taskId: task.taskId,
      workspacePath,
      workspaceIdentity,
      attachmentScope: attachment(remoteSessionId),
    });
    const rejected = expect(resolving).rejects.toThrow("remote attachment source 不匹配");
    await vi.waitFor(() => expect(service.listTasks).toHaveBeenCalled());
    remoteSessionId = "next-attachment";
    loading.resolve([task]);
    await rejected;
  } finally {
    loading.resolve([]);
    runtime.dispose();
  }
});
