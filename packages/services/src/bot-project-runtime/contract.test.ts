import { expect, it, vi } from "vitest";
import { createBotProjectRuntime } from "#src/bot-project-runtime/index.js";
import type {
  BotProjectConnection,
  BotProjectRuntimePort,
  IZCodeTaskService,
} from "#src/bot-project-runtime/contract.js";
const target = { workspacePath: "/same", workspaceIdentity: "remote:server:source:/same" };
function fixture() {
  let membership = "one";
  const listeners = new Set<() => void>();
  const eventListeners: Array<(event: unknown) => void> = [];
  const dispose = vi.fn();
  const taskService = {
    createTask: vi.fn(async () => ({ taskId: "new" })),
    onDynamicTaskEvent: vi.fn(() => (listener: (event: unknown) => void) => {
      eventListeners.push(listener);
      return { dispose };
    }),
  } as unknown as IZCodeTaskService;
  const connection: BotProjectConnection = {
    owner: {},
    taskService,
    modelSelectionService: { getView: vi.fn() },
    agentService: { syncAppRuntimePreferences: vi.fn(async () => undefined) },
    bindWorkspace: vi.fn(async () => undefined),
  };
  let online: BotProjectConnection | undefined = connection;
  const port: BotProjectRuntimePort = {
    remoteProjectService: {
      readDirectory: vi.fn(async () => ({
        hosts: membership
          ? [
              {
                id: "remote:server:source",
                membershipId: membership,
                kind: "server" as const,
                target: null,
                position: 0,
                connectionStatus: online ? ("online" as const) : ("offline" as const),
              },
            ]
          : [],
        entries: [],
      })),
      connectHost: vi.fn(async () => {
        online = connection;
        return {
          id: "remote:server:source",
          membershipId: membership,
          kind: "server" as const,
          target: null,
          position: 0,
        };
      }),
    },
    resolveOnline: () => online,
    onConnectionsChanged: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    readBoundTargets: async () => [target],
    readRuntimePreferences: async () => ({ askUserQuestionAutoResolutionEnabled: true }),
    warn: vi.fn(),
  };
  return {
    port,
    connection,
    eventListeners,
    dispose,
    setMember: (value: string) => {
      membership = value;
    },
    change: (value?: BotProjectConnection) => {
      online = value;
      for (const listener of listeners) listener();
    },
    service: createBotProjectRuntime(port),
  };
}
it("没有 tab 也可使用已在线 Source；查询不隐式连接，目录身份必须一致", async () => {
  const f = fixture();
  expect(await f.service.isConnected(target)).toBe(true);
  await f.service.getZCodeTaskService(target);
  expect(f.connection.bindWorkspace).toHaveBeenCalledWith(target);
  expect(f.port.remoteProjectService.connectHost).not.toHaveBeenCalled();
  await expect(
    f.service.getZCodeTaskService({ ...target, workspacePath: "/other" }),
  ).rejects.toThrow();
});
it("移除成员不能通过重连复活；admission 期间重加或连接换代拒绝迟到结果", async () => {
  const f = fixture();
  f.setMember("");
  expect((await f.service.ensureConnected(target)).ok).toBe(false);
  expect(f.port.remoteProjectService.connectHost).not.toHaveBeenCalled();
  f.setMember("one");
  vi.mocked(f.connection.bindWorkspace).mockImplementation(async () => {
    f.setMember("two");
  });
  await expect(f.service.getZCodeTaskService(target)).rejects.toThrow();
});
it("Bot 订阅随物理连接换代，仅接收 continuous 新事件，旧回调失效", async () => {
  const f = fixture();
  const service = await f.service.getZCodeTaskService(target);
  const receive = vi.fn();
  const subscription = service!.onDynamicTaskEvent({
    ...target,
    taskId: "task",
    deliveryKind: "bot-channel-continuous",
  })(receive);
  expect(f.connection.taskService.onDynamicTaskEvent).toHaveBeenCalledWith(
    expect.objectContaining({ deliveryKind: "bot-channel-continuous" }),
  );
  f.eventListeners[0]!({ type: "old-live" });
  const next = { ...f.connection, owner: {} };
  f.change(next);
  await vi.waitFor(() => expect(f.eventListeners).toHaveLength(2));
  f.eventListeners[0]!({ type: "old-late" });
  f.eventListeners[1]!({ type: "new-live" });
  expect(receive.mock.calls.map(([event]) => event.type)).toEqual(["old-live", "new-live"]);
  subscription.dispose();
  f.eventListeners[1]!({ type: "after-close" });
  expect(receive).toHaveBeenCalledTimes(2);
  expect(f.dispose).toHaveBeenCalledTimes(2);
});

it("旧 canonical 绑定按已固化 host 路由，不再依赖项目入口；稳定身份不得跨 host", async () => {
  const f = fixture();
  const legacy = {
    workspacePath: "/same",
    workspaceIdentity: "remote:ssh:old:22:user:/same",
    hostId: "remote:server:source",
  };
  expect(await f.service.isConnected(legacy)).toBe(true);
  await expect(
    f.service.getZCodeTaskService({ ...target, hostId: "remote:server:another" }),
  ).rejects.toThrow();
});
it("旧服务句柄不能在物理连接换代后执行命令，迟到绑定也不能恢复已关闭订阅", async () => {
  const f = fixture();
  const service = (await f.service.getZCodeTaskService(target))!;
  const subscription = service.onDynamicTaskEvent({
    ...target,
    taskId: "task",
    deliveryKind: "bot-channel-continuous",
  })(vi.fn());
  let finish!: () => void;
  const binding = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const next = { ...f.connection, owner: {}, bindWorkspace: async () => binding };
  f.change(next);
  subscription.dispose();
  finish();
  await expect(service.createTask({ workspacePath: "/same" } as never)).rejects.toThrow();
  expect(f.connection.taskService.createTask).not.toHaveBeenCalled();
  expect(f.eventListeners).toHaveLength(1);
});
