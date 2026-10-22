import { afterEach, describe, expect, it, vi } from "vitest";
import { AddressInfo, Socket } from "node:net";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import { Emitter, Event, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import {
  ServiceCollection,
  ISystemService,
  IZCodeAgentService,
  IFileService,
} from "@zcode/services";
import { createFileService } from "../../services/src/file/fileService.js";
import { prepareRemoteWorkspaceIdentity } from "../src/host/remoteWorkspacePreparation.js";
import { createHttpServer } from "@zcode/server";
import { createTopicResourcePeers, createTopicResourceRelayChannel } from "@zcode/services/node";
import { connectViaProtocol, connectViaWebSocket } from "@zcode/client";
import {
  connectServerRemote,
  connectServerRemoteOverDuplex,
  resolveServerRemoteEndpoints,
} from "../src/host/serverRemoteConnection.js";
import { registerHostServiceResourceTelemetry } from "../src/host/hostServiceResourceTelemetry.js";
import { serverRemoteInfoSchema, type AgentLaneResourceSample } from "@zcode/shared";

function wrapNodeWebSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("message", (raw: RawData) => {
    const data = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(raw);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  socket.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      if (socket.readyState === WebSocket.OPEN) socket.send(buffer.buffer);
    },
    end() {
      socket.close();
    },
    drain: async () => {},
    dispose() {
      socket.close();
    },
  };
}

function connectNodeRpc(
  url: string,
  headers: Record<string, string>,
): Promise<{ socket: WebSocket; services: ReturnType<typeof connectViaProtocol> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("error", reject);
    socket.once("open", () => {
      resolve({
        socket,
        services: connectViaProtocol(new SocketProtocol(wrapNodeWebSocket(socket))),
      });
    });
  });
}

function rejectedWebSocketStatus(
  url: string,
  headers: Record<string, string> = {},
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once("open", () => {
      socket.close();
      reject(new Error("WebSocket unexpectedly opened"));
    });
    socket.once("error", () => {});
  });
}

async function connectOpaqueDuplex(port: number): Promise<Duplex> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = new Socket();
    connection.once("error", reject);
    connection.connect(port, "127.0.0.1", () => {
      connection.off("error", reject);
      resolve(connection);
    });
  });
  const duplex = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      if (socket.write(chunk, encoding)) callback();
      else socket.once("drain", callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  socket.pause();
  socket.on("data", (chunk) => {
    if (!duplex.push(chunk)) socket.pause();
  });
  socket.once("end", () => duplex.push(null));
  socket.once("error", (error) => duplex.destroy(error));
  return duplex;
}

describe("server remote connection", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const disposables: Array<{ dispose(): void }> = [];

  async function startLoopbackServer(...args: Parameters<typeof createHttpServer>) {
    const [services, port, options] = args;
    // 默认 IPv6 监听却请求 IPv4 时，同端口的其他 IPv4 服务可能返回 HTML；夹具两端必须同址。
    const server = createHttpServer(services, port, { ...options, host: "127.0.0.1" });
    servers.push(server);
    // 显式 host 的监听在异步完成后才有地址，不能提前读取随机端口。
    await once(server, "listening");
    return server;
  }

  // 远端 Server 支持 POSIX；Windows 运行器通过结构化错误单测覆盖 ELOOP 映射。
  it.each(process.platform === "win32" ? ["ENOENT"] : ["ENOENT", "ELOOP"])(
    "真实远端 File RPC 保留 %s，目录校验失败不关闭共享连接",
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-remote-stat-"));
      const deleted = join(root, "deleted");
      const surviving = join(root, "surviving");
      try {
        await mkdir(deleted);
        await mkdir(surviving);
        const services = new ServiceCollection().register(IFileService, createFileService());
        const server = await startLoopbackServer(services, 0, { serverId: "directory-fixture" });
        const address = server.address() as AddressInfo;
        expect(address.address).toBe("127.0.0.1");
        const connection = await connectServerRemote({
          kind: "server",
          url: `http://127.0.0.1:${address.port}`,
        });
        disposables.push(connection);
        await rm(deleted, { recursive: true });
        if (code === "ELOOP") await symlink(deleted, deleted, "dir");
        await expect(connection.services.fileService.stat({ path: deleted })).rejects.toMatchObject(
          {
            code,
          },
        );
        const bindIdentity = vi.fn();
        await expect(
          prepareRemoteWorkspaceIdentity(
            connection.services.fileService,
            {
              workspacePath: deleted,
              stableWorkspaceIdentity: `remote:server:directory-fixture:${deleted}`,
            },
            bindIdentity,
          ),
        ).rejects.toMatchObject({
          code: "remote-workspace-directory-unavailable",
          retryable: false,
        });
        expect(bindIdentity).not.toHaveBeenCalled();
        await expect(
          prepareRemoteWorkspaceIdentity(
            connection.services.fileService,
            {
              workspacePath: surviving,
              stableWorkspaceIdentity: `remote:server:directory-fixture:${surviving}`,
            },
            bindIdentity,
          ),
        ).resolves.toBeUndefined();
        expect(bindIdentity).toHaveBeenCalledTimes(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([0o000, 0o400, 0o100])(
    "真实 File RPC 拒绝权限 %s 的叶目录，同设备其他项目与修复重试仍可用",
    async (permissions) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-remote-permission-"));
      const denied = join(root, "denied");
      const surviving = join(root, "surviving");
      try {
        await mkdir(denied);
        await mkdir(surviving);
        const server = createHttpServer(
          new ServiceCollection().register(IFileService, createFileService()),
          0,
          { serverId: "permission-fixture" },
        );
        servers.push(server);
        const address = server.address() as AddressInfo;
        const connection = await connectServerRemote({
          kind: "server",
          url: `http://127.0.0.1:${address.port}`,
        });
        disposables.push(connection);
        await chmod(denied, permissions);
        await expect(connection.services.fileService.stat({ path: denied })).resolves.toMatchObject(
          {
            type: "directory",
          },
        );
        const bindIdentity = vi.fn();
        const prepare = (workspacePath: string) =>
          prepareRemoteWorkspaceIdentity(
            connection.services.fileService,
            {
              workspacePath,
              stableWorkspaceIdentity: `remote:server:permission-fixture:${workspacePath}`,
            },
            bindIdentity,
          );
        await expect(prepare(denied)).rejects.toMatchObject({
          code: "remote-workspace-directory-unavailable",
          retryable: false,
        });
        expect(bindIdentity).not.toHaveBeenCalled();
        await expect(prepare(surviving)).resolves.toBeUndefined();
        await chmod(denied, 0o500);
        await expect(prepare(denied)).resolves.toBeUndefined();
        expect(bindIdentity).toHaveBeenCalledTimes(2);
      } finally {
        await chmod(denied, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  afterEach(async () => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
  });

  it("URL 握手必须等待成员提交，成员已移除时释放未发布 socket", async () => {
    const server = await startLoopbackServer(new ServiceCollection(), 0, {
      serverId: "membership-server",
      authRequired: true,
      authToken: "token",
    });
    const address = server.address() as AddressInfo;
    const commit = vi.fn(async (sourceServerId: string) => {
      expect(sourceServerId).toBe("membership-server");
      throw new Error("remote-project.host-removed");
    });
    await expect(
      connectServerRemote(
        { kind: "server", url: `http://127.0.0.1:${address.port}`, token: "token" },
        { commitMembership: commit },
      ).then((connection) => {
        disposables.push(connection);
        return connection;
      }),
    ).rejects.toThrow("remote-project.host-removed");
    expect(commit).toHaveBeenCalledOnce();
  });
  it("URL 握手中止后不提交成员", async () => {
    const commitMembership = vi.fn(async () => undefined);
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      connectServerRemote(
        { kind: "server", url: "http://127.0.0.1:1" },
        { signal: controller.signal, commitMembership, fetchImpl },
      ),
    ).rejects.toThrow();
    expect(commitMembership).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("resolves info and websocket endpoints from an HTTP server URL", () => {
    expect(resolveServerRemoteEndpoints("https://studio.example.com/zcode/")).toEqual({
      infoUrl: "https://studio.example.com/zcode/api/server-info",
      wsUrl: "wss://studio.example.com/zcode/ws",
      hostCapabilityUrl: "https://studio.example.com/zcode/api/rpc-host-capability",
      hostWsUrl: "wss://studio.example.com/zcode/ws/host",
    });
    expect(resolveServerRemoteEndpoints("ws://127.0.0.1:3030/ws")).toEqual({
      infoUrl: "http://127.0.0.1:3030/api/server-info",
      wsUrl: "ws://127.0.0.1:3030/ws",
      hostCapabilityUrl: "http://127.0.0.1:3030/api/rpc-host-capability",
      hostWsUrl: "ws://127.0.0.1:3030/ws/host",
    });
  });

  it("routes reverse resource RPC to the exact authenticated Desktop peer and removes it on close", async () => {
    const peers = createTopicResourcePeers();
    const services = new ServiceCollection().register(IZCodeAgentService, {
      queryConversationCommandsV4: async () => ({ results: [] }),
    } as never);
    const server = await startLoopbackServer(services, 0, { topicResourcePeers: peers });
    const address = server.address() as AddressInfo;
    const validate = vi.fn(async () => undefined);
    const relay = createTopicResourceRelayChannel({
      validate,
      read: async () => {
        throw new Error("Not requested");
      },
    });
    const connection = await connectServerRemote(
      { kind: "server", url: `http://127.0.0.1:${address.port}` },
      { topicResourceChannel: relay.channel },
    );
    disposables.push(connection, relay);
    const request = {
      requestId: "r",
      taskId: "t",
      inputId: "i",
      authorizationId: "a",
      messageId: "m",
      resourceIndex: 0,
      workspacePath: "/work",
      workspaceIdentity: "server://host/work",
      remoteSessionId: "remote-a",
    };
    await connection.services.zcodeAgentService.queryConversationCommandsV4({
      ...request,
      commands: [],
    });
    expect(await peers.getChannel(request).call("validate", request)).toEqual({ valid: true });
    expect(validate).toHaveBeenCalledOnce();
    expect(() => peers.getChannel({ ...request, remoteSessionId: "other" })).toThrow();
    connection.dispose();
    await vi.waitFor(() => expect(() => peers.getChannel(request)).toThrow());
  });

  it("connects to a running zcode server over websocket RPC", async () => {
    const info = vi.fn(async () => ({
      homedir: "/home/dev",
      platform: "linux",
    }));
    const services = new ServiceCollection()
      .register(ISystemService, {
        info,
        listIntegratedTerminalShells: vi.fn(async () => []),
        probeIntranet: vi.fn(async () => ({
          checkedAt: 1,
          isIntranet: false,
          reachedTargetCount: 0,
          requiredSuccessCount: 1,
          results: [],
          strategy: "tcp-connect",
          totalTargets: 0,
        })),
      })
      .register(IZCodeAgentService, {
        helloConversationV4: vi.fn(),
        initializeConversationV4: vi.fn(),
      } as never);
    const server = await startLoopbackServer(services, 0, {
      serverId: "studio",
      workspaces: [{ path: "/home/dev/project" }],
    });
    const address = server.address() as AddressInfo;

    const requestedPaths: string[] = [];
    const connection = await connectServerRemote(
      {
        kind: "server",
        url: `http://127.0.0.1:${address.port}`,
      },
      {
        fetchImpl: async (input, init) => {
          requestedPaths.push(new URL(String(input)).pathname);
          return fetch(input, init);
        },
      },
    );
    disposables.push(connection);

    await expect(connection.services.systemService.info()).resolves.toEqual({
      homedir: "/home/dev",
      platform: "linux",
    });
    expect(connection.serverInfo).toMatchObject({
      serverId: "studio",
      workspaces: [{ path: "/home/dev/project" }],
    });
    await expect(
      connection.services.zcodeAgentService.helloConversationV4(),
    ).resolves.toMatchObject({
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
    });
    expect(requestedPaths).toEqual(["/api/server-info", "/api/rpc-host-capability"]);
    let browserSocket: WebSocket | undefined;
    const browserServices = await connectViaWebSocket(`ws://127.0.0.1:${address.port}/ws`, {
      onOpenSocket: (socket) => (browserSocket = socket),
    });
    await expect(browserServices.zcodeAgentService.helloConversationV4()).resolves.toMatchObject({
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
    });
    browserSocket?.close();

    const legacyHeaderConnection = await connectNodeRpc(`ws://127.0.0.1:${address.port}/ws`, {
      "x-zcode-rpc-client-mode": "desktop-continuous",
    });
    await expect(
      legacyHeaderConnection.services.zcodeAgentService.helloConversationV4(),
    ).resolves.toMatchObject({
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
    });
    legacyHeaderConnection.socket.close();
    expect(info).toHaveBeenCalledOnce();
  });

  it("runs the typed RPC handshake over one reusable Duplex channel", async () => {
    const services = new ServiceCollection().register(ISystemService, {
      info: vi.fn(async () => ({ homedir: "/home/alice", platform: "linux" })),
      listIntegratedTerminalShells: vi.fn(async () => []),
      probeIntranet: vi.fn(async () => ({
        checkedAt: 1,
        isIntranet: false,
        reachedTargetCount: 0,
        requiredSuccessCount: 1,
        results: [],
        strategy: "tcp-connect",
        totalTargets: 0,
      })),
    });
    const server = await startLoopbackServer(services, 0, {
      serverId: "duplex-server",
      authRequired: true,
      authToken: "ingress-token",
    });
    const address = server.address() as AddressInfo;
    let channelCount = 0;
    const connection = await connectServerRemoteOverDuplex({
      ingressToken: "ingress-token",
      createConnection: async () => {
        channelCount += 1;
        return await connectOpaqueDuplex(address.port);
      },
    });
    disposables.push(connection);
    await expect(connection.services.systemService.info()).resolves.toMatchObject({
      homedir: "/home/alice",
    });
    expect(connection.serverInfo.serverId).toBe("duplex-server");
    expect(channelCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("connector 使用 token 贯穿受保护的 capability endpoint 与 /ws/host", async () => {
    const services = new ServiceCollection().register(IZCodeAgentService, {
      helloConversationV4: vi.fn(),
      initializeConversationV4: vi.fn(),
    } as never);
    const server = await startLoopbackServer(services, 0, {
      authRequired: true,
      authToken: "secret-token",
    });
    const address = server.address() as AddressInfo;
    const requestedUrls: URL[] = [];

    const connection = await connectServerRemote(
      {
        kind: "server",
        url: `http://127.0.0.1:${address.port}`,
        token: "secret-token",
      },
      {
        fetchImpl: async (input, init) => {
          requestedUrls.push(new URL(String(input)));
          return fetch(input, init);
        },
      },
    );
    disposables.push(connection);

    await expect(
      connection.services.zcodeAgentService.helloConversationV4(),
    ).resolves.toMatchObject({
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
    });
    expect(requestedUrls.map((url) => url.pathname)).toEqual([
      "/api/server-info",
      "/api/rpc-host-capability",
    ]);
    expect(requestedUrls.every((url) => url.searchParams.get("token") === "secret-token")).toBe(
      true,
    );
  });

  it.each([false, true])(
    "真实 WebSocket 按 Server 资源能力 %s 订阅，旧端业务 RPC 保持可用",
    async (supported) => {
      const samples = new Emitter<AgentLaneResourceSample>();
      const onResourceSample = vi.fn(() => samples.event);
      const service = {
        onDynamicProcessResourceSample: onResourceSample,
        onDynamicMcpTelemetry: () => Event.None,
        // 模拟旧服务只有旧两项事件；误订阅新事件会沿真实 WebSocket/RPC 路径抛错。
        ...(supported
          ? {
              onDynamicMcpResourceSamples: () => Event.None,
              onDynamicToolExecResource: () => Event.None,
            }
          : {}),
      };
      const server = await startLoopbackServer(
        new ServiceCollection().register(IZCodeAgentService, service as never),
        0,
      );
      const address = server.address() as AddressInfo;
      const connection = await connectServerRemote(
        { kind: "server", url: `http://127.0.0.1:${address.port}` },
        {
          fetchImpl: async (input, init) => {
            const response = await fetch(input, init);
            if (supported || !String(input).endsWith("/api/server-info")) return response;
            const info = serverRemoteInfoSchema.parse(await response.json());
            delete info.capabilities.processResourceTelemetry;
            return Response.json(info);
          },
        },
      );
      disposables.push(connection);
      const postMessage = vi.fn();
      const telemetry = registerHostServiceResourceTelemetry({
        services: new ServiceCollection().register(
          IZCodeAgentService,
          connection.services.zcodeAgentService,
        ),
        runtimeSurface: "remote",
        telemetrySupported: connection.serverInfo.capabilities.processResourceTelemetry === true,
        postMessage,
      });
      disposables.push(telemetry);

      // 同一连接的 RPC 应答是前面 EventListen 已处理的屏障，无需 sleep 猜测订阅时序。
      await expect(
        connection.services.zcodeAgentService.helloConversationV4(),
      ).resolves.toMatchObject({
        deliveryProfile: "continuous",
      });
      expect(onResourceSample).toHaveBeenCalledTimes(supported ? 1 : 0);
      samples.fire({
        platform: "linux",
        arch: "x64",
        logicalCpuCount: 8,
        intervalMs: 60_000,
        cpuCores: 1,
        cpuPercent: 12.5,
        rssKb: 128_000,
      });
      if (supported) {
        await expect.poll(() => postMessage.mock.calls.length).toBe(1);
      } else {
        expect(postMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("/ws/host 只接受已申请的一次性 capability，重放被拒绝", async () => {
    const services = new ServiceCollection().register(IZCodeAgentService, {
      helloConversationV4: vi.fn(),
      initializeConversationV4: vi.fn(),
    } as never);
    const server = await startLoopbackServer(services, 0);
    const address = server.address() as AddressInfo;
    const httpBase = `http://127.0.0.1:${address.port}`;
    const wsHost = `ws://127.0.0.1:${address.port}/ws/host`;

    expect(await rejectedWebSocketStatus(wsHost)).toBe(401);
    expect(
      await rejectedWebSocketStatus(wsHost, {
        "x-zcode-rpc-host-capability": "forged",
      }),
    ).toBe(401);

    const ticketResponse = await fetch(`${httpBase}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(ticketResponse.status).toBe(200);
    const ticket = (await ticketResponse.json()) as {
      capability: string;
      expiresAt: number;
    };
    expect(ticket.capability).toEqual(expect.any(String));
    expect(ticket.expiresAt).toBeGreaterThan(Date.now());

    const trusted = await connectNodeRpc(wsHost, {
      "x-zcode-rpc-host-capability": ticket.capability,
    });
    await expect(trusted.services.zcodeAgentService.helloConversationV4()).resolves.toMatchObject({
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
    });
    expect(
      await rejectedWebSocketStatus(wsHost, {
        "x-zcode-rpc-host-capability": ticket.capability,
      }),
    ).toBe(401);
    trusted.socket.close();
  });
});
