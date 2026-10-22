import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";

interface Pair {
  client: Socket;
  upstream: Socket;
  held: Buffer[];
  holding: boolean;
  closed: boolean;
  upstreamEnded: boolean;
  generation: number;
}

/** 延迟真实 SSH 回包；旧 socket 已退役时保留丢弃账目，绝不将丢弃算作转发。 */
export async function createHeldResponseProxy(target: { host: string; port: number }) {
  const pairs = new Set<Pair>();
  const retired: Array<{ generation: number; bytes: number }> = [];
  let generation = 0;
  let closePromise: Promise<void> | undefined;
  const server = createServer((client) => {
    const upstream = createConnection(target);
    const pair: Pair = {
      client,
      upstream,
      held: [],
      holding: false,
      closed: false,
      upstreamEnded: false,
      generation: ++generation,
    };
    pairs.add(pair);
    const cleanup = () => {
      if (pair.closed) return;
      pair.closed = true;
      if (pair.holding) {
        retired.push({
          generation: pair.generation,
          bytes: pair.held.reduce((sum, chunk) => sum + chunk.length, 0),
        });
        pair.held = [];
      }
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk: Buffer) => {
      if (!upstream.destroyed) upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (pair.holding) pair.held.push(Buffer.from(chunk));
      else if (!client.destroyed) client.write(chunk);
    });
    const endUpstream = () => {
      pair.upstreamEnded = true;
      if (!pair.holding && !client.destroyed) client.end();
    };
    client.once("error", cleanup);
    client.once("close", cleanup);
    upstream.once("error", endUpstream);
    upstream.once("end", endUpstream);
    upstream.once("close", endUpstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    holdCurrent() {
      for (const pair of pairs) pair.holding = true;
      return pairs.size;
    },
    stats() {
      return {
        pairs: pairs.size,
        heldBytes: [...pairs].reduce(
          (total, pair) => total + pair.held.reduce((sum, chunk) => sum + chunk.length, 0),
          0,
        ),
        retiredBytes: retired.reduce((sum, item) => sum + item.bytes, 0),
        retiredPairs: retired.length,
      };
    },
    async release() {
      const closed = retired.splice(0);
      // 先同步摘下全部 buffer，再等待写入；close 回调不能重复对账同一批字节。
      const batches = [...pairs]
        .filter((pair) => pair.holding)
        .map((pair) => {
          pair.holding = false;
          return { pair, chunks: pair.held.splice(0) };
        });
      const result = {
        heldPairs: batches.length + closed.length,
        retiredPairs: closed.length,
        forwardedBytes: 0,
        discardedBytes: closed.reduce((sum, item) => sum + item.bytes, 0),
      };
      for (const { pair, chunks } of batches) {
        let connectionRetired = false;
        for (const chunk of chunks) {
          if (connectionRetired || pair.client.destroyed || !pair.client.writable) {
            connectionRetired = true;
            result.discardedBytes += chunk.length;
            continue;
          }
          try {
            await new Promise<void>((resolve, reject) =>
              pair.client.write(chunk, (error) => (error ? reject(error) : resolve())),
            );
            result.forwardedBytes += chunk.length;
          } catch {
            connectionRetired = true;
            result.discardedBytes += chunk.length;
          }
        }
        if (connectionRetired) result.retiredPairs += 1;
        if (pair.upstreamEnded && !pair.client.destroyed) pair.client.end();
      }
      return result;
    },
    close() {
      closePromise ??= new Promise<void>((resolve) => {
        for (const pair of pairs) {
          pair.client.destroy();
          pair.upstream.destroy();
        }
        server.close(() => resolve());
      });
      return closePromise;
    },
  };
}
