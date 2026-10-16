import { channel } from "node:diagnostics_channel";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeNetworkCapture, withoutNetworkCapture } from "../src/node/networkCapture.js";

afterEach(() => vi.useRealTimers());

it("高密度请求批次有界，溢出仅累计数量", async () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  const capture = createNodeNetworkCapture("main", sink);
  capture.setCaptureId("burst");
  try {
    for (let i = 0; i < 5000; i++)
      channel("undici:request:create").publish({
        request: { method: "GET", origin: "https://example.test", path: "/request" },
      });
    await vi.advanceTimersByTimeAsync(250);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]![0].records).toHaveLength(100);
    expect(sink.mock.calls[0]![0].dropped).toBe(4900);
  } finally {
    capture.setCaptureId(null);
  }
});

it("SSE 只记一次 HTTP，原生和 ws 库握手只记连接且不记录消息", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end("data: SECRET_STREAM\n\n");
  });
  const wsServer = new WebSocketServer({ server });
  wsServer.on("connection", (socket) => socket.send("SECRET_MESSAGE"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const batches: Array<{ records: Array<{ url: string }> }> = [];
  const capture = createNodeNetworkCapture("main", (batch) => batches.push(batch));
  capture.setCaptureId("stream");
  try {
    await (await fetch(`http://${origin}/sse`)).text();
    const native = new WebSocket(`ws://${origin}/native`);
    await new Promise<void>((resolve, reject) => {
      native.addEventListener("open", () => resolve(), { once: true });
      native.addEventListener("error", reject, { once: true });
    });
    const closed = new Promise<void>((resolve) =>
      native.addEventListener("close", () => resolve(), { once: true }),
    );
    native.close();
    await closed;
    const ws = new WsWebSocket(`ws://${origin}/ws-library`);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    await vi.waitFor(() => expect(batches.flatMap((batch) => batch.records)).toHaveLength(3));
    expect(batches.flatMap((batch) => batch.records).map((record) => record.url)).toEqual([
      `http://${origin}/sse`,
      `ws://${origin}/native`,
      `ws://${origin}/ws-library`,
    ]);
    expect(JSON.stringify(batches)).not.toContain("SECRET");
  } finally {
    capture.setCaptureId(null);
    for (const client of wsServer.clients) client.terminate();
    wsServer.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("默认无监听，启用后只读记录真实 fetch/http，停止后不接收且不改 fetch", async () => {
  const originalFetch = globalThis.fetch;
  const batches: unknown[] = [];
  const before = channel("undici:request:create").hasSubscribers;
  const capture = createNodeNetworkCapture("main", (batch) => batches.push(batch));
  expect(channel("undici:request:create").hasSubscribers).toBe(before);
  const server = createServer((_req, res) => res.end("original"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/test?token=secret`;
  try {
    capture.setCaptureId("one");
    expect(await (await fetch(url)).text()).toBe("original");
    await new Promise<void>((resolve, reject) =>
      get(url, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject),
    );
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect((batches[0] as { records: unknown[] }).records).toHaveLength(2);
    expect(JSON.stringify(batches)).not.toContain("secret");
    expect(globalThis.fetch).toBe(originalFetch);
    capture.setCaptureId(null);
    await fetch(url).then((res) => res.text());
    expect(batches).toHaveLength(1);
  } finally {
    capture.setCaptureId(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("排除 MCP 异步上下文和 CONNECT；关闭丢弃在途批次，发送失败不影响请求", async () => {
  vi.useFakeTimers();
  const sink = vi.fn();
  const capture = createNodeNetworkCapture("cli", sink);
  const emit = (method = "GET") =>
    channel("undici:request:create").publish({
      request: { method, origin: "https://example.test", path: "/messages" },
    });
  try {
    capture.setCaptureId("one");
    await withoutNetworkCapture(async () => {
      await Promise.resolve();
      emit();
    });
    emit("CONNECT");
    await vi.advanceTimersByTimeAsync(300);
    expect(sink).not.toHaveBeenCalled();
    emit();
    capture.setCaptureId(null);
    capture.setCaptureId("two");
    emit();
    await vi.advanceTimersByTimeAsync(300);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]![0]).toMatchObject({
      captureId: "two",
      records: [expect.any(Object)],
    });
    sink.mockImplementation(() => {
      throw new Error("closed");
    });
    emit();
    await vi.advanceTimersByTimeAsync(300);
  } finally {
    capture.setCaptureId(null);
  }
});
