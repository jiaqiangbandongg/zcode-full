import { describe, expect, it, vi } from "vitest";
import type { DynamicWorkflowMode, WindowHostAttachmentScope } from "@zcode/shared";
import type { IServerChannel } from "@zcode/rpc";
import { ServiceCollection, IZCodeAgentService, type IBotsService } from "@zcode/services";
import type {
  ServerRemoteConnection,
  ServerRemoteDuplexConnectionOptions,
} from "../src/host/serverRemoteConnection.js";
import { connectDesktopSourceServer } from "../src/host/connectDesktopSourceServer.js";

function setup() {
  const sync = vi.fn(async (): Promise<void> => undefined);
  const agent = { syncDynamicWorkflowUserMode: sync } as unknown as IZCodeAgentService;
  const logicalA = new ServiceCollection().register(IZCodeAgentService, agent);
  const logicalB = new ServiceCollection().register(IZCodeAgentService, agent);
  const scopes = new Map([
    ["a", logicalA],
    ["b", logicalB],
  ]);
  const validate = vi.fn(async () => undefined);
  const dispose = vi.fn();
  let captured: ServerRemoteDuplexConnectionOptions | undefined;
  const connection = {
    services: { zcodeAgentService: agent },
    dispose,
  } as unknown as ServerRemoteConnection;
  const connectServer = vi.fn(async (options: ServerRemoteDuplexConnectionOptions) => {
    captured = options;
    return connection;
  });
  const onClose = vi.fn();
  const dependencies = {
    connectServer,
    resolveServices: (scope: WindowHostAttachmentScope) => {
      if (scope.kind !== "remote") throw new Error("Expected remote");
      return scopes.get(scope.remoteSessionId)!;
    },
    getBots: vi.fn(
      () =>
        ({
          validateTopicResource: validate,
          readTopicResource: vi.fn(),
        }) as unknown as IBotsService,
    ),
    readDynamicWorkflowMode: vi.fn(
      async (): Promise<DynamicWorkflowMode | undefined> => "alwaysOn",
    ),
    onModeSyncError: vi.fn(),
  };
  const options = { ingressToken: "test", createConnection: vi.fn(), onClose };
  return {
    sync,
    scopes,
    validate,
    dispose,
    onClose,
    dependencies,
    options,
    channel: () => captured!.topicResourceChannel as IServerChannel,
    close: () => captured!.onClose!({ code: 1006, reason: "closed" }),
  };
}

function request(remoteSessionId: string) {
  return {
    requestId: "r",
    taskId: "t",
    inputId: "i",
    authorizationId: "a",
    messageId: "m",
    resourceIndex: 0,
    workspacePath: "/work",
    workspaceIdentity: "source:host:/work",
    remoteSessionId,
  };
}

describe("Desktop Source physical connection capabilities", () => {
  it("uses one reverse channel for all logical wrappers of the same physical Agent", async () => {
    const state = setup();
    const connection = await connectDesktopSourceServer(state.options, state.dependencies);
    expect(state.dependencies.connectServer).toHaveBeenCalledOnce();
    expect(await state.channel().call("host", "validate", request("a"))).toEqual({ valid: true });
    expect(await state.channel().call("host", "validate", request("b"))).toEqual({ valid: true });
    state.scopes.set("b", new ServiceCollection().register(IZCodeAgentService, {} as never));
    await expect(state.channel().call("host", "validate", request("b"))).rejects.toThrow(
      "connection mismatch",
    );
    expect(state.validate).toHaveBeenCalledTimes(2);
    connection.dispose();
  });

  it("closes the old reverse channel before reconnecting with a new mode", async () => {
    const first = setup();
    const oldConnection = await connectDesktopSourceServer(first.options, first.dependencies);
    first.close();
    expect(first.onClose).toHaveBeenCalledOnce();
    await expect(first.channel().call("host", "validate", request("a"))).rejects.toThrow("closed");
    const second = setup();
    second.dependencies.readDynamicWorkflowMode.mockResolvedValue("disabled");
    const newConnection = await connectDesktopSourceServer(second.options, second.dependencies);
    expect(second.sync).toHaveBeenCalledWith({ mode: "disabled" });
    expect(await second.channel().call("host", "validate", request("a"))).toEqual({ valid: true });
    oldConnection.dispose();
    newConnection.dispose();
    await expect(second.channel().call("host", "validate", request("a"))).rejects.toThrow("closed");
  });

  it("aborts an in-flight resource read when its physical connection closes", async () => {
    const state = setup();
    let readingSignal: AbortSignal | undefined;
    state.dependencies.getBots.mockReturnValue({
      validateTopicResource: state.validate,
      readTopicResource: async (value: { signal: AbortSignal }) => {
        readingSignal = value.signal;
        await new Promise<void>((_resolve, reject) => {
          value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true });
        });
        throw new Error("Unreachable after cancellation");
      },
    } as unknown as IBotsService);
    const connection = await connectDesktopSourceServer(state.options, state.dependencies);
    const pending = state.channel().call("host", "begin", request("a"));
    const rejected = expect(pending).rejects.toThrow("closed");
    await vi.waitFor(() => expect(readingSignal).toBeDefined());
    state.close();
    expect(readingSignal!.aborted).toBe(true);
    await rejected;
    connection.dispose();
  });

  it("publishes the connection only after the Desktop mode reaches the Source", async () => {
    const state = setup();
    let finish: () => void = () => undefined;
    state.sync.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    let published = false;
    const pending = connectDesktopSourceServer(state.options, state.dependencies).then(
      (connection) => {
        published = true;
        return connection;
      },
    );
    await vi.waitFor(() => expect(state.sync).toHaveBeenCalledWith({ mode: "alwaysOn" }));
    expect(published).toBe(false);
    finish();
    (await pending).dispose();
  });

  it("keeps old Sources usable when they do not support mode sync", async () => {
    const state = setup();
    state.sync.mockRejectedValue(new Error("Unknown method"));
    const connection = await connectDesktopSourceServer(state.options, state.dependencies);
    expect(state.dependencies.onModeSyncError).toHaveBeenCalledOnce();
    expect(await state.channel().call("host", "validate", request("a"))).toEqual({ valid: true });
    connection.dispose();
  });
});
