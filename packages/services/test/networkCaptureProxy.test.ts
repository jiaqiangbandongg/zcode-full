import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import type { NetworkCaptureBatch } from "@zcode/shared";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";

it("Host 原 dispatcher 的 CONNECT 和 noProxy 均正常，只记录目标 HTTP 一次", async () => {
  const upstream = createServer((_req, res) => res.end("unchanged"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const proxy = createServer();
  let tunnels = 0;
  proxy.on("connect", (req, client, head) => {
    tunnels++;
    const target = new URL(`http://${req.url}`);
    const socket = connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    client.on("error", () => socket.destroy());
    socket.on("error", () => client.destroy());
    client.on("close", () => socket.destroy());
    socket.on("close", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const httpProxy = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const transport = createHostApiNetworkTransport(async () => ({ httpProxy }));
  const bypass = createHostApiNetworkTransport(async () => ({ httpProxy, noProxy: "127.0.0.1" }));
  const batches: NetworkCaptureBatch[] = [];
  const original = globalThis.fetch;
  const capture = createNodeNetworkCapture("host", (batch) => batches.push(batch));
  capture.setCaptureId("host");
  try {
    expect(await (await transport.fetch(`${origin}/proxy`)).text()).toBe("unchanged");
    expect(tunnels).toBe(1);
    expect(await (await bypass.fetch(`${origin}/bypass`)).text()).toBe("unchanged");
    expect(tunnels).toBe(1);
    await vi.waitFor(() => expect(batches.flatMap((batch) => batch.records)).toHaveLength(2));
    expect(batches.flatMap((batch) => batch.records).map((record) => record.url)).toEqual([
      `${origin}/proxy`,
      `${origin}/bypass`,
    ]);
    expect(globalThis.fetch).toBe(original);
  } finally {
    capture.setCaptureId(null);
    await Promise.all([transport.disposeAndWait(), bypass.disposeAndWait()]);
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
