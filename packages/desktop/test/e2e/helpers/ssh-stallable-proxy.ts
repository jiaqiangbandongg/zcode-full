import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";

/** 可切换新连接停摆的 SSH TCP 代理。调用方可更新 target 端口；仅后续连接采用新地址，已有连接不改路由。 */
export async function createStallableTcpProxy(target: { host: string; port: number }) {
  const pending = new Map<
    Socket,
    { chunks: Buffer[]; capture: (chunk: Buffer) => void; cleanup: () => void }
  >();
  const live = new Set<Socket>();
  let mode: "forward" | "stall" | "reject" = "forward";
  let accepted = 0;
  const attach = (client: Socket, initial: readonly Buffer[] = []) => {
    // 建立上游前必须暂停下游；否则 release 后、connect 回调前的新数据仍会被丢弃。
    client.pause();
    const upstream = createConnection({ host: target.host, port: target.port });
    live.add(client);
    live.add(upstream);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
      live.delete(client);
      live.delete(upstream);
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    upstream.once("connect", () => {
      for (const chunk of initial) upstream.write(chunk);
      client.pipe(upstream).pipe(client);
    });
    client.once("close", closeBoth);
    upstream.once("close", closeBoth);
  };
  const server = createServer((client) => {
    accepted += 1;
    if (mode === "reject") {
      client.destroy();
      return;
    }
    if (mode === "stall") {
      const chunks: Buffer[] = [];
      const capture = (chunk: Buffer) => chunks.push(Buffer.from(chunk));
      const cleanup = () => {
        pending.delete(client);
        client.destroy();
      };
      pending.set(client, { chunks, capture, cleanup });
      // SSH Client 在等待期间已发送 banner。原来的 resume() 没有 data 消费者，
      // 会丢掉握手字节，导致每次 release 都失败，再被 case 的手动重试掩盖。
      client.on("data", capture);
      client.once("error", cleanup);
      client.once("close", cleanup);
      return;
    }
    attach(client);
  });
  await new Promise<void>((ok, bad) => {
    server.once("error", bad);
    server.listen(0, "127.0.0.1", () => ok());
  });
  return {
    port: (server.address() as AddressInfo).port,
    setStall(value: boolean) {
      mode = value ? "stall" : "forward";
    },
    setRejectNewConnections(value: boolean) {
      // 容器停机时不得尝试已释放、可能被另一夹具复用的旧端口；既有连接仍由真实远端关闭。
      mode = value ? "reject" : "forward";
    },
    pendingCount: () =>
      [...pending.keys()].filter((client) => !client.destroyed && !client.readableEnded).length,
    pendingByteCount: () => [...pending.keys()].reduce((sum, socket) => sum + socket.bytesRead, 0),
    acceptedCount: () => accepted,
    release() {
      let count = 0;
      for (const [client, held] of pending) {
        client.pause();
        client.off("data", held.capture);
        client.off("error", held.cleanup);
        client.off("close", held.cleanup);
        pending.delete(client);
        if (client.destroyed || client.readableEnded) {
          client.destroy();
          continue;
        }
        attach(client, held.chunks);
        count += 1;
      }
      return count;
    },
    async close() {
      for (const client of pending.keys()) client.destroy();
      pending.clear();
      for (const socket of live) socket.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
