import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHeldResponseProxy } from "./e2e/helpers/ssh-held-response-proxy.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const peers: Socket[] = [];
  const target = createServer((peer) => {
    peers.push(peer);
    peer.on("error", () => {});
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");
  cleanup.push(async () => {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
  const proxy = await createHeldResponseProxy({
    host: "127.0.0.1",
    port: (target.address() as AddressInfo).port,
  });
  cleanup.push(() => proxy.close());
  const connect = async () => {
    const socket = createConnection({ host: "127.0.0.1", port: proxy.port });
    const chunks: string[] = [];
    socket.on("data", (data) => chunks.push(data.toString()));
    socket.on("error", () => {});
    cleanup.push(async () => {
      socket.destroy();
    });
    await once(socket, "connect");
    return { socket, chunks };
  };
  return { peers, proxy, connect };
}

describe("旧 SSH 回包代理的真实字节对账", () => {
  it("存活旧链路在释放后收到原字节，后建链路始终放行", async () => {
    const { peers, proxy, connect } = await setup();
    const old = await connect();
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    expect(proxy.holdCurrent()).toBe(1);
    peers[0]!.write("OLD_DATA");
    await vi.waitFor(() => expect(proxy.stats().heldBytes).toBe(8));
    expect(old.chunks).toEqual([]);
    const fresh = await connect();
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    peers[1]!.write("NEW_DATA");
    await vi.waitFor(() => expect(fresh.chunks.join("")).toBe("NEW_DATA"));
    const released = await proxy.release();
    await vi.waitFor(() => expect(old.chunks.join("")).toBe("OLD_DATA"));
    expect(released).toMatchObject({ forwardedBytes: 8, discardedBytes: 0, heldPairs: 1 });
    expect(fresh.chunks.join("")).toBe("NEW_DATA");
  });

  it("旧 client 已关闭时保留丢弃证据，不能丢账或冒充已转发", async () => {
    const { peers, proxy, connect } = await setup();
    const old = await connect();
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    proxy.holdCurrent();
    peers[0]!.write("LATE_REPLY");
    await vi.waitFor(() => expect(proxy.stats().heldBytes).toBe(10));
    old.socket.destroy();
    await vi.waitFor(() => expect(proxy.stats().retiredBytes).toBe(10));
    const fresh = await connect();
    await vi.waitFor(() => expect(peers).toHaveLength(2));
    peers[1]!.write("CURRENT");
    await vi.waitFor(() => expect(fresh.chunks.join("")).toBe("CURRENT"));
    expect(await proxy.release()).toMatchObject({
      forwardedBytes: 0,
      discardedBytes: 10,
      retiredPairs: 1,
    });
    expect(fresh.chunks.join("")).toBe("CURRENT");
  });

  it("上游先结束时，旧字节和 FIN 都保留到显式释放", async () => {
    const { peers, proxy, connect } = await setup();
    const old = await connect();
    let ended = false;
    old.socket.on("end", () => {
      ended = true;
    });
    await vi.waitFor(() => expect(peers).toHaveLength(1));
    proxy.holdCurrent();
    peers[0]!.end("OLD_FIN");
    await vi.waitFor(() => expect(proxy.stats().heldBytes).toBe(7));
    expect(ended).toBe(false);
    expect(old.chunks).toEqual([]);
    expect(await proxy.release()).toMatchObject({ forwardedBytes: 7, discardedBytes: 0 });
    await vi.waitFor(() => expect(ended).toBe(true));
    expect(old.chunks.join("")).toBe("OLD_FIN");
  });
});
