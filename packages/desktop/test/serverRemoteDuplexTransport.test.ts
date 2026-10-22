import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { createServer, Socket } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  connectWebSocketOverDuplex,
  requestJsonOverDuplex,
} from "../src/host/serverRemoteDuplexTransport.js";

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function connectOpaqueDuplex(port: number): Promise<Duplex> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = new Socket();
    connection.once("error", reject);
    connection.connect(port, "127.0.0.1", () => {
      connection.off("error", reject);
      resolve(connection);
    });
  });
  // Spike 重点：上层只拿到 Duplex，不可依赖 net.Socket / TCP 专属 API。
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

describe("server remote HTTP/WS over an opaque Duplex", () => {
  it("performs an HTTP request through a custom createConnection stream", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: 17\r\n\r\n{"serverId":"s1"}',
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    disposals.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");

    let channels = 0;
    const response = await requestJsonOverDuplex<{ serverId: string }>({
      url: "http://127.0.0.1:1/api/server-info",
      createConnection: async () => {
        channels += 1;
        return await connectOpaqueDuplex(address.port);
      },
    });

    expect(response).toEqual({ status: 200, body: { serverId: "s1" } });
    expect(channels).toBe(1);
  });

  it("upgrades WebSocket and exchanges binary data through a custom createConnection stream", async () => {
    const server = createHttpServer();
    const serverSockets = new Set<Socket>();
    let requestBytes = 0;
    server.on("connection", (socket) => {
      serverSockets.add(socket);
      socket.on("data", (chunk) => {
        requestBytes += chunk.length;
      });
      socket.once("close", () => serverSockets.delete(socket));
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (data, isBinary) => webSocket.send(data, { binary: isBinary }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    disposals.push(async () => {
      for (const client of webSocketServer.clients) client.terminate();
      for (const socket of serverSockets) socket.destroy();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test server port");

    let channels = 0;
    let channel: Duplex | undefined;
    const webSocket = await Promise.race([
      connectWebSocketOverDuplex({
        url: "ws://127.0.0.1:1/ws/host",
        createConnection: async () => {
          channels += 1;
          channel = await connectOpaqueDuplex(address.port);
          return channel;
        },
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          channel?.destroy();
          reject(new Error(`WebSocket over Duplex spike timed out (requestBytes=${requestBytes})`));
        }, 1_000).unref();
      }),
    ]);
    const echoed = new Promise<Buffer>((resolve) => {
      webSocket.once("message", (data) => resolve(Buffer.from(data as ArrayBuffer)));
    });
    webSocket.send(Buffer.from([0, 1, 2, 255]));

    expect(await echoed).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(channels).toBe(1);
    const closed = once(webSocket, "close");
    webSocket.close();
    await closed;
  });
});
