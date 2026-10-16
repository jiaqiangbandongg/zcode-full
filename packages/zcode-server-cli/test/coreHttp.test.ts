import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ServiceCollection, IZCodeAgentService } from "@zcode/services";
import { createHostCapabilityStore } from "../src/server-core/hostCapability.js";
import { createCoreHttpServer } from "../src/server-core/http.js";

import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  type ISocket,
} from "@zcode/rpc";
import { createTopicResourcePeers } from "@zcode/services/node";
import { TOPIC_RESOURCE_RELAY_CHANNEL } from "@zcode/shared";

async function connectResourcePeer(base: string, onValidate: () => void) {
  const response = await fetch(`${base}/api/rpc-host-capability`, { method: "POST" });
  const { capability } = (await response.json()) as { capability: string };
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/ws/host`, {
    headers: { "x-zcode-rpc-host-capability": capability },
  });
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  socket.on("message", (raw) =>
    data.fire(
      VSBuffer.wrap(
        Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
      ),
    ),
  );
  socket.on("close", () => close.fire());
  const transport: ISocket = {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write: (buffer) => {
      socket.send(buffer.buffer);
    },
    end: () => socket.close(),
    drain: async () => {},
    dispose: () => socket.close(),
  };
  // WebSocket 可在 open 同一轮分发初始化帧；连接内同步安装 RPC listener，不能先 await open。
  return new Promise<{ services: { zcodeAgentService: IZCodeAgentService }; dispose(): void }>(
    (resolve, reject) => {
      socket.once("error", reject);
      socket.once("open", () => {
        const protocol = new SocketProtocol(transport);
        const server = new ChannelServer(protocol, "test-desktop");
        server.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, {
          async call<T>(_context: string, command: string): Promise<T> {
            if (command !== "validate") throw new Error("Unexpected resource command");
            onValidate();
            return { valid: true } as T;
          },
          listen() {
            throw new Error("No events");
          },
        });
        const client = new ChannelClient(protocol);
        const services = {
          zcodeAgentService: ProxyChannel.toService<IZCodeAgentService>(
            client.getChannel(IZCodeAgentService.channelName),
          ),
        };
        resolve({
          services,
          dispose() {
            server.dispose();
            client.dispose();
            protocol.dispose();
            socket.close();
            data.dispose();
            close.dispose();
          },
        });
      });
    },
  );
}

async function expectWebSocketOpens(url: string): Promise<void> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("unexpected-response", (_request, response) =>
      reject(new Error(`unexpected ${response.statusCode}`)),
    );
    socket.once("error", reject);
  });
  return socket;
}

describe("standalone Server Core ingress", () => {
  const servers: Array<{ close: () => Promise<void>; port: number }> = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers.length = 0;
  });

  it("isolates reverse resource requests between Desktop peers and excludes normal WebSocket clients", async () => {
    const peers = createTopicResourcePeers();
    const attached = vi.spyOn(peers, "attach");
    const services = new ServiceCollection().register(IZCodeAgentService, {
      queryConversationCommandsV4: async () => ({ results: [] }),
    } as never);
    const server = await createCoreHttpServer(services, { topicResourcePeers: peers });
    servers.push(server);
    const base = `http://${server.host}:${server.port}`;
    await expectWebSocketOpens(`${base.replace("http:", "ws:")}/ws`);
    expect(attached).not.toHaveBeenCalled();
    const firstRead = vi.fn();
    const secondRead = vi.fn();
    const first = await connectResourcePeer(base, firstRead);
    const second = await connectResourcePeer(base, secondRead);
    const request = {
      requestId: "request-a",
      taskId: "task-a",
      inputId: "input-a",
      authorizationId: "auth-a",
      messageId: "message-a",
      resourceIndex: 0,
      workspacePath: "/work",
      workspaceIdentity: "server://same/work",
      remoteSessionId: "remote-a",
    };
    const other = { ...request, remoteSessionId: "remote-b" };
    try {
      await first.services.zcodeAgentService.queryConversationCommandsV4({
        ...request,
        commands: [],
      });
      await second.services.zcodeAgentService.queryConversationCommandsV4({
        ...other,
        commands: [],
      });
      expect(attached).toHaveBeenCalledTimes(2);
      await expect(peers.getChannel(request).call("validate", request)).resolves.toEqual({
        valid: true,
      });
      expect(firstRead).toHaveBeenCalledOnce();
      expect(secondRead).not.toHaveBeenCalled();
      first.dispose();
      await vi.waitFor(() => expect(() => peers.getChannel(request)).toThrow(/unavailable/));
      await expect(peers.getChannel(other).call("validate", other)).resolves.toEqual({
        valid: true,
      });
      expect(secondRead).toHaveBeenCalledOnce();
      expect(() =>
        peers.getChannel({ ...other, workspaceIdentity: "server://different/work" }),
      ).toThrow();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("serves server-info on loopback and gates desktop continuous WS", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    const info = await fetch(`http://${server.host}:${server.port}/api/server-info`);
    expect(info.status).toBe(200);
    await expect(info.json()).resolves.toMatchObject({
      protocolVersion: 1,
      authRequired: false,
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });

    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`);
    expect(rejected.status).toBe(401);

    const capabilityResponse = await fetch(
      `http://${server.host}:${server.port}/api/rpc-host-capability`,
      { method: "POST" },
    );
    const capability = (await capabilityResponse.json()) as { capability: string };
    const socket = new WebSocket(`ws://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability.capability },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        socket.close();
        resolve();
      });
      socket.once("unexpected-response", (_request, response) =>
        reject(new Error(`unexpected ${response.statusCode}`)),
      );
      socket.once("error", reject);
    });

    // 一次性 ticket：同一 capability 重放必须被拒绝。
    const replayed = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability.capability },
    });
    expect(replayed.status).toBe(401);
  });

  it("publishes the installation-scoped server identity supplied by Supervisor", async () => {
    const server = await createCoreHttpServer(new ServiceCollection(), {
      serverId: "server-installation-id",
    });
    servers.push(server);

    await expect(
      fetch(`http://${server.host}:${server.port}/api/server-info`).then((response) =>
        response.json(),
      ),
    ).resolves.toMatchObject({ serverId: "server-installation-id" });
  });

  it("accepts web replayable clients on /ws without a capability", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    servers.push(server);
    await expectWebSocketOpens(`ws://${server.host}:${server.port}/ws`);
  });

  it("closes the HTTP server while an upgraded WebSocket remains open", async () => {
    const server = await createCoreHttpServer(new ServiceCollection());
    const socket = await openWebSocket(`ws://${server.host}:${server.port}/ws`);
    servers.push(server);

    const completed = await Promise.race([
      server.close().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
    ]);

    socket.terminate();
    servers.splice(servers.indexOf(server), 1);
    expect(completed).toBe(true);
  });

  it("rejects expired host capabilities", async () => {
    let now = 0;
    const server = await createCoreHttpServer(new ServiceCollection(), {
      hostCapabilityStore: createHostCapabilityStore({ ttlMs: 100, now: () => now }),
    });
    servers.push(server);
    const issued = await fetch(`http://${server.host}:${server.port}/api/rpc-host-capability`, {
      method: "POST",
    });
    const { capability, expiresAt } = (await issued.json()) as {
      capability: string;
      expiresAt: number;
    };
    expect(expiresAt).toBe(100);
    now = 101;
    const rejected = await fetch(`http://${server.host}:${server.port}/ws/host`, {
      headers: { "x-zcode-rpc-host-capability": capability },
    });
    expect(rejected.status).toBe(401);
  });

  it("rejects non-loopback listeners until authenticated ingress is implemented", async () => {
    await expect(
      createCoreHttpServer(new ServiceCollection(), { host: "0.0.0.0" }),
    ).rejects.toThrow(/non-loopback.*authentication|loopback/i);
  });
});
