import { ChannelClient, ChannelServer, createQueuePair, Emitter } from "@zcode/rpc";
import {
  IBroadcastService,
  IProjectService,
  IRemoteProjectService,
  ServiceCollection,
} from "@zcode/services";
import { RemoteServiceAccess } from "@zcode/client";
import { exposeWindowHostAttachmentServices } from "@desktop/host/windowHostAttachmentRpcPolicy.js";
import { expect, it, vi } from "vitest";

it("MRO02：窗口目录 RPC 与原工作区读写和广播隔离", async () => {
  const messages = new Emitter<{ channel: string; payload: unknown }>();
  const save = vi.fn(async () => ({ id: "saved" }));
  const remove = vi.fn(async () => {});
  const windowServices = new ServiceCollection()
    .register(IProjectService, {
      readTree: async () => ({ projects: [{ id: "local" }, { id: "pinned" }], tasks: [] }),
      saveProject: save,
    } as never)
    .register(IRemoteProjectService, {
      readDirectory: async () => ({ hosts: [], entries: [{ id: "retained" }] }),
      removeEntry: remove,
    } as never)
    .register(IBroadcastService, { onMessage: messages.event } as never);
  const services = new ServiceCollection()
    .register(IProjectService, {
      readTree: async () => ({ projects: [{ id: "source-only" }], tasks: [] }),
    } as never)
    .register(IRemoteProjectService, {
      readDirectory: async () => ({ hosts: [], entries: [] }),
    } as never);
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "host", 20);
  const client = new ChannelClient(clientProtocol);
  try {
    exposeWindowHostAttachmentServices({
      server,
      services,
      clientMode: "web-remote-replayable",
      attachmentScope: { kind: "remote" },
      windowServices,
    });
    const access = new RemoteServiceAccess(client, { windowProjectDirectory: true });
    expect(access.windowProjectDirectory).toBeDefined();
    const directory = access.windowProjectDirectory!;
    expect(await directory.changesService.getCapabilities()).toEqual({ version: 1 });
    expect((await directory.projectService.readTree()).projects.map((p) => p.id)).toEqual([
      "local",
      "pinned",
    ]);
    expect((await access.projectService.readTree()).projects.map((p) => p.id)).toEqual([
      "source-only",
    ]);
    expect(await access.remoteProjectService.readDirectory()).toEqual({ hosts: [], entries: [] });
    await directory.projectService.saveProject({ roots: [] });
    await directory.remoteProjectService.removeEntry("retained");
    expect(save).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("retained");
    const changed = vi.fn();
    const subscription = directory.changesService.onDidChange(changed);
    // 同一 RPC 队列中的读回包证明前面的订阅已到 Host，不用定时等待制造顺序。
    await directory.changesService.getCapabilities();
    messages.fire({ channel: "state:theme", payload: {} });
    await directory.changesService.getCapabilities();
    expect(changed).not.toHaveBeenCalled();
    messages.fire({ channel: "state:projects", payload: {} });
    await directory.changesService.getCapabilities();
    expect(changed).toHaveBeenCalledOnce();
    subscription.dispose();
    await directory.changesService.getCapabilities();
    messages.fire({ channel: "state:projects", payload: {} });
    await directory.changesService.getCapabilities();
    expect(changed).toHaveBeenCalledOnce();
    expect(services.getOptional({ channelName: "window-project" })).toBeUndefined();
  } finally {
    client.dispose();
    server.dispose();
    messages.dispose();
  }
});

it.each(["desktop-continuous", "web-remote-replayable"] as const)(
  "MRO02：非手机远端 attachment 不暴露窗口目录：%s",
  async (clientMode) => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "host", 20);
    const client = new ChannelClient(clientProtocol);
    try {
      exposeWindowHostAttachmentServices({
        server,
        services: new ServiceCollection(),
        clientMode,
        attachmentScope: { kind: clientMode === "desktop-continuous" ? "remote" : "local" },
        windowServices: new ServiceCollection(),
      });
      const access = new RemoteServiceAccess(client, { windowProjectDirectory: true });
      await expect(access.windowProjectDirectory!.changesService.getCapabilities()).rejects.toThrow(
        "window-project-changes",
      );
    } finally {
      client.dispose();
      server.dispose();
    }
  },
);

it("MRO02：窗口服务不完整时原子拒绝，不发布部分窗口频道", async () => {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "host", 20);
  const client = new ChannelClient(clientProtocol);
  try {
    const windowServices = new ServiceCollection().register(IProjectService, {} as never);
    expect(() =>
      exposeWindowHostAttachmentServices({
        server,
        services: new ServiceCollection(),
        clientMode: "web-remote-replayable",
        attachmentScope: { kind: "remote" },
        windowServices,
      }),
    ).toThrow("remote-projects");
    await expect(client.getChannel("window-project").call("readTree", [])).rejects.toThrow(
      "window-project",
    );
  } finally {
    client.dispose();
    server.dispose();
  }
});
