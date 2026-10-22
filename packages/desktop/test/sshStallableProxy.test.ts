import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createStallableTcpProxy } from "./e2e/helpers/ssh-stallable-proxy.js";

it("后端端口变化时保留外部端口，既有连接不改路由", async () => {
  const accepted = [0, 0];
  const servers = ["A", "B"].map((label, index) =>
    createServer((socket) => {
      accepted[index] = (accepted[index] ?? 0) + 1;
      socket.on("data", (chunk) => socket.write(`${label}:${chunk.toString()}`));
    }),
  );
  for (const server of servers)
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (index: number) => {
    const address = servers[index]!.address();
    if (!address || typeof address === "string") throw new Error("缺少端口");
    return address.port;
  };
  const target = { host: "127.0.0.1", port: port(0) };
  const proxy = await createStallableTcpProxy(target);
  const clients: Socket[] = [];
  const openClient = async () => {
    const client = createConnection({ host: "127.0.0.1", port: proxy.port });
    clients.push(client);
    await new Promise<void>((done, reject) => {
      client.once("connect", done);
      client.once("error", reject);
    });
    return client;
  };
  const exchange = (client: Socket, value: string) =>
    new Promise<string>((done, reject) => {
      let response = "";
      const timeout = setTimeout(() => reject(new Error("未收到上游响应")), 3000);
      const read = (chunk: Buffer) => {
        response += chunk.toString();
        if (!response.endsWith("\n")) return;
        clearTimeout(timeout);
        client.off("data", read);
        done(response.trim());
      };
      client.on("data", read);
      client.write(`${value}\n`);
    });
  try {
    const first = await openClient();
    expect(await exchange(first, "first")).toBe("A:first");
    target.port = port(1);
    const second = await openClient();
    expect(await exchange(second, "second")).toBe("B:second");
    proxy.setRejectNewConnections(true);
    const rejected = createConnection({ host: "127.0.0.1", port: proxy.port });
    clients.push(rejected);
    rejected.on("error", () => undefined);
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error("代理没有拒绝新连接")), 3000);
      rejected.once("close", () => {
        clearTimeout(timeout);
        done();
      });
    });
    expect(accepted).toEqual([1, 1]);
    proxy.setRejectNewConnections(false);
    expect(await exchange(await openClient(), "resumed")).toBe("B:resumed");
    expect(await exchange(first, "retained")).toBe("A:retained");
  } finally {
    for (const client of clients) client.destroy();
    await proxy.close();
    await Promise.all(
      servers.map((server) => new Promise<void>((done) => server.close(() => done()))),
    );
  }
});

it("停摆期间已读的 SSH banner 在释放后仍先于后续数据到达真实上游", async () => {
  const server = createServer((socket) => {
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString();
      if (received.endsWith("END\n")) socket.end(JSON.stringify(received));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const proxy = await createStallableTcpProxy({
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
  });
  let client: Socket | undefined;
  try {
    proxy.setStall(true);
    client = createConnection({ host: "127.0.0.1", port: proxy.port });
    await new Promise<void>((done, reject) => {
      client!.once("connect", done);
      client!.once("error", reject);
    });
    const banner = "SSH-2.0-regression-client\r\n";
    client.write(banner);
    // 使用真实 socket.bytesRead 作事件屏障，保证释放前 banner 已被代理读取。
    const deadline = Date.now() + 3000;
    while (proxy.pendingByteCount() < Buffer.byteLength(banner) && Date.now() < deadline)
      await delay(5);
    expect(proxy.pendingByteCount()).toBe(Buffer.byteLength(banner));
    const reply = new Promise<string>((done, reject) => {
      let value = "";
      client!.on("data", (chunk) => {
        value += chunk.toString();
      });
      client!.once("end", () => done(value));
      client!.once("error", reject);
    });
    expect(proxy.release()).toBe(1);
    client.write("AFTER-RELEASE\nEND\n");
    const received = await Promise.race([
      reply,
      delay(3000, undefined, { ref: false }).then(() => {
        throw new Error("上游未收到释放的数据");
      }),
    ]);
    expect(JSON.parse(received)).toBe(`${banner}AFTER-RELEASE\nEND\n`);
  } finally {
    client?.destroy();
    await proxy.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
