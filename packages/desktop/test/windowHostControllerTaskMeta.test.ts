import { expect, it, vi } from "vitest";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostTaskAddress } from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerRuntime } from "@desktop/host/windowHostControllerService.js";

const local: WindowHostTaskAddress = { taskId: "same", workspacePath: "/repo" };
const remote: WindowHostTaskAddress = {
  ...local,
  workspaceIdentity: "remote:server:source:/repo",
  sourceServerId: "source",
  remoteSessionId: "attachment-1",
};

function fixture() {
  let session = "attachment-1";
  let availability: "online" | "offline" = "online";
  const meta = (unreadAt: number): ZCodeTaskMeta => ({
    taskId: "same",
    workspacePath: "/repo",
    title: "Task",
    traceId: "t",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    unreadAt,
  });
  const createService = (marker: number) => ({
    getTaskMeta: vi.fn<IZCodeTaskService["getTaskMeta"]>().mockResolvedValue(meta(marker)),
    listTasks: vi
      .fn<IZCodeTaskService["listTasks"]>()
      .mockRejectedValue(new Error("must not hydrate list")),
  });
  const localService = createService(11);
  let remoteService = createService(22);
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: (scope) =>
      scope.workspaceIdentity
        ? {
            scope: {
              kind: "remote",
              sourceServerId: "source",
              remoteSessionId: session,
              workspacePath: "/repo",
              workspaceIdentity: remote.workspaceIdentity,
            },
            sourceAvailability: availability,
            taskService: remoteService as unknown as IZCodeTaskService,
          }
        : {
            scope: { kind: "local", workspacePath: "/repo" },
            sourceAvailability: "online",
            taskService: localService as unknown as IZCodeTaskService,
          },
  });
  return {
    runtime,
    localService,
    get remoteService() {
      return remoteService;
    },
    replaceService() {
      remoteService = createService(33);
    },
    replaceSession() {
      session = "attachment-2";
    },
    offline() {
      availability = "offline";
    },
  };
}

it("reads the precise local or remote task owner without list hydration", async () => {
  const f = fixture();
  try {
    expect(await f.runtime.service.getTaskMeta({ address: local })).toMatchObject({
      unreadAt: 11,
      workspaceIdentity: undefined,
    });
    expect(await f.runtime.service.getTaskMeta({ address: remote })).toMatchObject({
      unreadAt: 22,
      workspaceIdentity: remote.workspaceIdentity,
    });
    expect(f.localService.getTaskMeta).toHaveBeenCalledWith(local);
    expect(f.remoteService.getTaskMeta).toHaveBeenCalledWith({
      taskId: "same",
      workspacePath: "/repo",
      workspaceIdentity: remote.workspaceIdentity,
    });
    expect(f.localService.listTasks).not.toHaveBeenCalled();
    expect(f.remoteService.listTasks).not.toHaveBeenCalled();
  } finally {
    f.runtime.dispose();
  }
});

it.each([
  { ...remote, sourceServerId: "other" },
  { ...remote, remoteSessionId: "old" },
  { ...remote, workspaceIdentity: "remote:server:other:/repo" },
  { ...local, sourceServerId: "source" },
])("rejects a mismatched address before source IO %#", async (address) => {
  const f = fixture();
  try {
    await expect(f.runtime.service.getTaskMeta({ address })).rejects.toThrow();
    expect(f.remoteService.getTaskMeta).not.toHaveBeenCalled();
    expect(f.localService.getTaskMeta).not.toHaveBeenCalled();
  } finally {
    f.runtime.dispose();
  }
});

it.each(["service", "session", "offline", "disposed"])(
  "rejects a changed owner during the read (%s)",
  async (kind) => {
    const f = fixture();
    const read = Promise.withResolvers<ZCodeTaskMeta | null>();
    f.remoteService.getTaskMeta.mockImplementationOnce(() => read.promise);
    try {
      const reading = f.runtime.service.getTaskMeta({ address: remote });
      const rejected = expect(reading).rejects.toThrow("source 已失效");
      if (kind === "service") f.replaceService();
      if (kind === "session") f.replaceSession();
      if (kind === "offline") f.offline();
      if (kind === "disposed") f.runtime.service.dispose();
      read.resolve({
        taskId: "same",
        workspacePath: "/repo",
        title: "Task",
        traceId: "t",
        createdAt: 1,
        updatedAt: 2,
        mode: "default",
        unreadAt: 22,
      });
      await rejected;
    } finally {
      read.resolve(null);
      f.runtime.dispose();
    }
  },
);

it("propagates owner IO failures and distinguishes a missing task", async () => {
  const f = fixture();
  try {
    f.remoteService.getTaskMeta.mockRejectedValueOnce(new Error("sqlite read failure"));
    await expect(f.runtime.service.getTaskMeta({ address: remote })).rejects.toThrow(
      "sqlite read failure",
    );
    f.remoteService.getTaskMeta.mockResolvedValueOnce(null);
    expect(await f.runtime.service.getTaskMeta({ address: remote })).toBeNull();
  } finally {
    f.runtime.dispose();
  }
});

it("reads a legacy remote workspace only with its trusted current attachment ID", async () => {
  const workspaceIdentity = "remote:ssh:example.test:22:dev:/repo";
  const getTaskMeta = vi.fn<IZCodeTaskService["getTaskMeta"]>().mockResolvedValue(null);
  const taskService = { getTaskMeta } as unknown as IZCodeTaskService;
  const runtime = createWindowHostControllerRuntime({
    createId: () => crypto.randomUUID(),
    resolveSource: () => ({
      scope: {
        kind: "remote",
        workspacePath: "/repo",
        workspaceIdentity,
        remoteSessionId: "current-attachment",
      },
      sourceAvailability: "online",
      taskService,
    }),
  });
  try {
    await expect(
      runtime.service.getTaskMeta({ address: { ...local, workspaceIdentity } }),
    ).rejects.toThrow();
    await expect(
      runtime.service.getTaskMeta({
        address: { ...local, workspaceIdentity, remoteSessionId: "current-attachment" },
      }),
    ).resolves.toBeNull();
    expect(getTaskMeta).toHaveBeenCalledWith({ ...local, workspaceIdentity });
    await expect(
      runtime.service.getTaskMeta({
        address: { ...local, workspaceIdentity, remoteSessionId: "stale" },
      }),
    ).rejects.toThrow();
  } finally {
    runtime.dispose();
  }
});
