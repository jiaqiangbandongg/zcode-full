import { describe, it, expect } from "vitest";
import { IPCServer, IPCClient, StaticRouter } from "../src/ipc.js";
import { IServerChannel } from "../src/channels.js";
import { createQueuePair } from "../src/protocol.js";
import { Emitter, Event } from "../src/foundation.js";

function connectClient(
  onConnect: Emitter<{ protocol: any; onDidClientDisconnect: Event<void> }>,
  ctx: string,
) {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const disconnectEmitter = new Emitter<void>();

  onConnect.fire({
    protocol: serverProtocol,
    onDidClientDisconnect: disconnectEmitter.event,
  });

  const client = new IPCClient(clientProtocol, ctx);
  return { client, disconnect: () => disconnectEmitter.fire() };
}

describe("IPCServer + IPCClient", () => {
  it("should allow client to call server channel", async () => {
    const onConnect = new Emitter<{ protocol: any; onDidClientDisconnect: Event<void> }>();
    const server = new IPCServer(onConnect.event);

    const channel: IServerChannel = {
      call(_ctx, command, arg) {
        if (command === "echo") return Promise.resolve(arg);
        return Promise.reject(new Error("Unknown"));
      },
      listen() {
        return Event.None;
      },
    };
    server.registerChannel("echo", channel);

    const { client } = connectClient(onConnect, "client-1");

    // Wait for handshake
    await new Promise((r) => setTimeout(r, 50));

    const ch = client.getChannel("echo");
    const result = await ch.call("echo", "hello");
    expect(result).toBe("hello");

    client.dispose();
    server.dispose();
  });

  it("should track connections", async () => {
    const onConnect = new Emitter<{ protocol: any; onDidClientDisconnect: Event<void> }>();
    const server = new IPCServer(onConnect.event);

    expect(server.connections).toHaveLength(0);

    const { client: c1, disconnect: d1 } = connectClient(onConnect, "c1");
    // Wait for initial message
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connections).toHaveLength(1);

    const { client: c2 } = connectClient(onConnect, "c2");
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connections).toHaveLength(2);

    d1();
    await new Promise((r) => setTimeout(r, 10));
    expect(server.connections).toHaveLength(1);

    c1.dispose();
    c2.dispose();
    server.dispose();
  });

  it("should support client registering channels for server reverse call", async () => {
    const onConnect = new Emitter<{ protocol: any; onDidClientDisconnect: Event<void> }>();
    const server = new IPCServer(onConnect.event);

    const { client } = connectClient(onConnect, "worker");

    // Client registers a channel
    const clientChannel: IServerChannel = {
      call(_ctx, command) {
        if (command === "getStatus") return Promise.resolve("busy");
        return Promise.reject(new Error("Unknown"));
      },
      listen() {
        return Event.None;
      },
    };
    client.registerChannel("worker-status", clientChannel);

    await new Promise((r) => setTimeout(r, 50));

    // Server calls client's channel via filter
    const ch = server.getChannel("worker-status", (c) => c.ctx === "worker");
    const status = await ch.call("getStatus");
    expect(status).toBe("busy");

    client.dispose();
    server.dispose();
  });
});

describe("StaticRouter", () => {
  it("should route to matching client", async () => {
    const onConnect = new Emitter<{ protocol: any; onDidClientDisconnect: Event<void> }>();
    const server = new IPCServer(onConnect.event);

    const router = new StaticRouter((ctx: string) => ctx === "target");

    const { client: c1 } = connectClient(onConnect, "other");
    const { client: c2 } = connectClient(onConnect, "target");

    const targetChannel: IServerChannel = {
      call(_ctx, command) {
        if (command === "whoami") return Promise.resolve("I am target");
        return Promise.reject(new Error("Unknown"));
      },
      listen() {
        return Event.None;
      },
    };
    c2.registerChannel("identity", targetChannel);

    await new Promise((r) => setTimeout(r, 50));

    const ch = server.getChannel("identity", router);
    const result = await ch.call("whoami");
    expect(result).toBe("I am target");

    c1.dispose();
    c2.dispose();
    server.dispose();
  });
});
