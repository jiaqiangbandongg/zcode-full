import { setTimeout as delay } from "node:timers/promises";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeRelayV2 } from "@zcode/shared/testing/fake-relay-v2";
import {
  WebRemoteControlTerminalTransport,
  createWebRemoteControlV2TokenClient,
} from "#src/web-remote-control/index.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function fixture(
  options: Parameters<typeof createFakeRelayV2>[0] = { users: { jwt: "user-1" } },
  terminalJwt = "jwt",
  tokenFetcher = fetch,
) {
  const relay = await createFakeRelayV2(options);
  cleanup.push(() => relay.close());
  const request = async (path: string, body: unknown) =>
    (
      await (
        await fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
          method: "POST",
          headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()
    ).data;
  const { device_sid: sid } = await request("device", { device_mid: "desktop-mid" });
  const { token } = await request("token", { role: "device" });
  const device = new WebSocket(`${relay.wsUrl}?token=${token}`);
  cleanup.push(() => device.close());
  const received: unknown[] = [];
  device.addEventListener("message", (e) => received.push(JSON.parse(e.data)));
  await new Promise<void>((resolve) =>
    device.addEventListener("open", () => {
      device.send(JSON.stringify({ type: "auth_init", device_sid: sid }));
      resolve();
    }),
  );
  await vi.waitFor(() =>
    expect(received).toContainEqual(expect.objectContaining({ type: "auth_ack" })),
  );
  const states: string[] = [];
  const failures: unknown[] = [];
  const onSendReady = vi.fn();
  const terminal = new WebRemoteControlTerminalTransport({
    relayWsUrl: relay.wsUrl,
    deviceSid: sid,
    deviceMid: "desktop-mid",
    getToken: (signal) =>
      createWebRemoteControlV2TokenClient(relay.httpUrl, tokenFetcher)(terminalJwt, signal),
    onPayload: vi.fn(),
    onStateChange: (state) => states.push(state),
    onFailure: (failure) => failures.push(failure),
    onError: vi.fn(),
    onSendReady,
    reloadPage: vi.fn(),
  });
  cleanup.push(() => terminal.dispose());
  return { relay, terminal, states, failures, sid, received, onSendReady };
}

function controlledTransport() {
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    send = vi.fn();
    close() {
      this.readyState = 3;
    }
    constructor() {
      super();
      sockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }
    receive(value: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
    }
  }
  const states: string[] = [];
  const failures: unknown[] = [];
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: "wss://relay.example/api/v1/remote/ws2",
    deviceSid: "sid",
    getToken: async () => "one-use",
    WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
    heartbeatAckTimeoutMs: 60000,
    onPayload: vi.fn(),
    onStateChange: (state) => states.push(state),
    onFailure: (failure) => failures.push(failure),
    onError: vi.fn(),
    reloadPage: vi.fn(),
  });
  cleanup.push(() => transport.dispose());
  return { transport, sockets, states, failures };
}

describe("terminal 与 V2 假 relay 的线级契约", () => {
  it("缺少 AbortSignal 静态 API 仍只取一次 token 并实际配对、透传 bootstrap", async () => {
    const h = await fixture();
    const descriptors = Object.getOwnPropertyDescriptors(AbortSignal);
    cleanup.push(() => {
      Object.defineProperties(AbortSignal, descriptors);
    });
    for (const name of ["any", "timeout"])
      Object.defineProperty(AbortSignal, name, { configurable: true, value: undefined });
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
    expect(h.states).not.toContain("reconnecting");
    expect(
      h.relay.httpCalls.filter((call) => (call.body as { role?: string }).role === "terminal"),
    ).toHaveLength(1);
    expect(
      h.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "compat-bootstrap" }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(h.received).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: { zcode_type: "bootstrap-request", requestId: "compat-bootstrap" },
        }),
      ),
    );
    expect(h.failures).toEqual([]);
  });

  it("首次 token 正文中途断开后退避重试，取得新 token 并实际配对", async () => {
    let partialResponse: ServerResponse | undefined;
    const server = createServer((_request, response) => {
      partialResponse = response;
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": 300 });
      response.write('{"code":0,"msg":"","data":{"token":"');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP test address");
    const tokenFetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (tokenFetcher.mock.calls.length > 1) return fetch(input, init);
      const response = await fetch(`http://127.0.0.1:${address.port}/token`, init);
      // 确认 fetch 已交付 200 响应头，再断开正文，避免退化为已有的建连失败测试。
      partialResponse?.destroy();
      return response;
    });
    const h = await fixture(undefined, "jwt", tokenFetcher);
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"), { timeout: 3_000 });
    expect(tokenFetcher).toHaveBeenCalledTimes(2);
    expect(h.states).toContain("reconnecting");
    expect(h.failures).toEqual([]);
    expect(h.relay.messages).toContainEqual(
      expect.objectContaining({
        role: "terminal",
        message: expect.objectContaining({ type: "auth_init", device_sid: h.sid }),
      }),
    );
  });

  it("一次性 terminal token → 无 role/proof 的 auth_init → 配对后业务透传", async () => {
    const h = await fixture();
    h.terminal.start();
    await vi.waitFor(() => expect(h.states).toContain("paired"));
    expect(h.relay.httpCalls).toContainEqual(
      expect.objectContaining({ path: "/api/v1/remote/token", body: { role: "terminal" } }),
    );
    const auth = h.relay.messages.find((r) => r.role === "terminal")?.message;
    expect(auth).toEqual({
      type: "auth_init",
      device_sid: h.sid,
      meta: { platform: "web", version: "web", name: "mobile-browser" },
      client_ts: expect.any(Number),
    });
    expect((auth as { client_ts: number }).client_ts).toBeLessThan(253402300800);
    expect(
      h.terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "mobile-bootstrap" }),
    ).toBe(true);
    await vi.waitFor(() =>
      expect(h.received).toContainEqual(
        expect.objectContaining({
          type: "data",
          payload: { zcode_type: "bootstrap-request", requestId: "mobile-bootstrap" },
        }),
      ),
    );
    expect(h.failures).toEqual([]);
  });
  it("5秒心跳不带 SID；15秒无 ACK 关闭旧连接并申请新 token", async () => {
    let drop = false;
    const h = await fixture({
      users: { jwt: "user-1" },
      onMessage: (r) =>
        r.role === "terminal" &&
        (r.message as { type: string }).type === "pair_status_query" &&
        drop
          ? { drop: true }
          : undefined,
    });
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    // 恢复探测重新启动共享心跳，避免首次调度已经取样的随机偏移。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.terminal.suspend();
    const recovery = h.terminal.recoverConnection();
    await delay(60);
    await recovery;
    await vi.advanceTimersByTimeAsync(5000);
    await delay(60);
    const queries = h.relay.messages.filter(
      (r) => r.role === "terminal" && (r.message as { type: string }).type === "pair_status_query",
    );
    expect(queries.length).toBeGreaterThanOrEqual(2);
    expect(queries.at(-1)?.message).toEqual({
      type: "pair_status_query",
      client_ts: Math.floor(Date.now() / 1000),
    });
    drop = true;
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    await vi.advanceTimersByTimeAsync(14999);
    await delay(60);
    expect(tokens()).toBe(1);
    await vi.advanceTimersByTimeAsync(1501);
    await delay(100);
    expect(tokens()).toBe(2);
    expect(h.onSendReady).toHaveBeenLastCalledWith({ kind: "reconnected-socket" });
  });

  it("网络和5xx保持500ms指数退避，上限10秒", async () => {
    let fail: "server" | "network" | undefined = "server";
    const h = await fixture({
      users: { jwt: "user-1" },
      onHttp: (call) =>
        (call.body as { role?: string }).role === "terminal" && fail
          ? fail === "server"
            ? { status: 503 }
            : { networkError: true }
          : undefined,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.terminal.start();
    await delay(60);
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    let count = 1;
    for (const ms of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      await vi.advanceTimersByTimeAsync(ms - 1);
      await delay(30);
      expect(tokens()).toBe(count);
      await vi.advanceTimersByTimeAsync(1);
      await delay(60);
      expect(tokens()).toBe(++count);
      fail = "network";
    }
    fail = undefined;
    await vi.advanceTimersByTimeAsync(10000);
    await delay(100);
    expect(h.states.at(-1)).toBe("paired");
    expect(h.failures).toEqual([]);
  });

  it.each([401, 403])("token HTTP %s 停止重试，回前台不能复活终态", async (status) => {
    const h = await fixture({
      users: { jwt: "user-1" },
      onHttp: (call) =>
        (call.body as { role?: string }).role === "terminal" ? { status } : undefined,
    });
    h.terminal.start();
    await vi.waitFor(() =>
      expect(h.failures).toEqual([
        { reason: status === 401 ? "auth-required" : "relay-unavailable", message: undefined },
      ]),
    );
    await expect(h.terminal.recoverConnection()).rejects.toThrow();
    h.terminal.recoverInBackground();
    expect(h.states.at(-1)).toBe("error");
  });

  it("异账号归属错误不重试；WRONG_PARAM 保留参数错误分类", async () => {
    const h = await fixture({ users: { jwt: "owner", other: "other" } }, "other");
    h.terminal.start();
    await vi.waitFor(() =>
      expect(h.failures).toContainEqual({ reason: "device-not-owned", message: undefined }),
    );
    const f = await fixture({
      users: { jwt: "owner" },
      onMessage: (r) => (r.role === "terminal" ? { error: "WRONG_PARAM" } : undefined),
    });
    f.terminal.start();
    await vi.waitFor(() =>
      expect(f.failures).toContainEqual({
        reason: "invalid-mobile-connection",
        message: undefined,
      }),
    );
  });

  it("首次 KICKED 等待2~5秒重新申请 token，第二次终止为 session-conflict", async () => {
    const h = await fixture();
    h.terminal.start();
    await vi.waitFor(() => expect(h.states.at(-1)).toBe("paired"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    h.relay.sendError({ role: "terminal" }, "KICKED");
    await delay(60);
    const tokens = () =>
      h.relay.httpCalls.filter((r) => (r.body as { role?: string }).role === "terminal").length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(tokens()).toBe(1);
    await vi.advanceTimersByTimeAsync(3001);
    await delay(100);
    expect(h.states.at(-1)).toBe("paired");
    expect(tokens()).toBe(2);
    h.relay.sendError({ role: "terminal" }, "KICKED");
    await delay(60);
    expect(h.failures).toEqual([{ reason: "session-conflict", message: undefined }]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(tokens()).toBe(2);
  });

  it("dispose 后的迟到 token 不能创建 socket", async () => {
    let resolveToken!: (value: string) => void;
    const getToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const ctor = vi.fn();
    const terminal = new WebRemoteControlTerminalTransport({
      relayWsUrl: "wss://relay.example/api/v1/remote/ws2",
      deviceSid: "sid",
      getToken,
      WebSocketCtor: ctor as unknown as typeof WebSocket,
      onPayload: vi.fn(),
      onStateChange: vi.fn(),
      onFailure: vi.fn(),
      onError: vi.fn(),
      reloadPage: vi.fn(),
    });
    terminal.start();
    terminal.dispose();
    resolveToken("late-token");
    await Promise.resolve();
    expect(ctor).not.toHaveBeenCalled();
  });
  it("挂起未完成握手的 socket 后，迟到 open/ACK 不能在后台触发配对", async () => {
    const h = controlledTransport();
    h.transport.start();
    await Promise.resolve();
    const socket = h.sockets[0];
    h.transport.suspend();
    socket.open();
    socket.receive({ type: "auth_ack", device_sid: "sid", pair_status: "matched" });
    await Promise.resolve();
    expect(socket.send).not.toHaveBeenCalled();
    expect(h.states.at(-1)).toBe("suspended");
  });

  it("waiting临近超时被KICKED，新连接重新计时而不保留旧代定时器", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const h = controlledTransport();
    h.transport.start();
    await Promise.resolve();
    h.sockets[0].open();
    h.sockets[0].receive({ type: "auth_ack", device_sid: "sid", pair_status: "waiting" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29000);
    h.sockets[0].receive({ type: "error", code: "KICKED" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(3500);
    h.sockets[1].open();
    h.sockets[1].receive({ type: "auth_ack", device_sid: "sid", pair_status: "waiting" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(29999);
    expect(h.failures).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.failures).toContainEqual(expect.objectContaining({ reason: "desktop-disconnected" }));
  });
});
