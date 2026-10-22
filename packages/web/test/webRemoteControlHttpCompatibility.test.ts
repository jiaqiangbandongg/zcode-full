import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebRemoteControlDeviceClient,
  createWebRemoteControlV2TokenClient,
} from "#src/web-remote-control/index.js";

const apiDescriptors = Object.getOwnPropertyDescriptors(AbortSignal);
const token = "AAAAAAAAAAAAAAAAAAAAAA";
const devices = [{ device_sid: "sid", device_mid: "mid", online: true, created_at: 1, meta: {} }];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  Object.defineProperties(AbortSignal, apiDescriptors);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each([
  {
    name: "terminal token",
    createClient: createWebRemoteControlV2TokenClient,
    data: { token, expires_in: 60 },
    expected: token,
    retryable: true,
  },
  {
    name: "device list",
    createClient: createWebRemoteControlDeviceClient,
    data: devices,
    expected: devices,
    retryable: false,
  },
])("$name HTTP 兼容与请求作用域", ({ createClient, data, expected, retryable }) => {
  it.each([["any"], ["timeout"], ["any", "timeout"]])(
    "缺少静态 API %j 时真正请求并返回完整结果",
    async (...missing) => {
      for (const name of missing)
        Object.defineProperty(AbortSignal, name, { configurable: true, value: undefined });
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: 0, msg: "", data }));
      const client = createClient("https://relay.example", fetcher);
      await expect(client("jwt", new AbortController().signal)).resolves.toEqual(expected);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("已取消的调用方不启动 HTTP 请求或遗留资源", async () => {
    const controller = new AbortController();
    controller.abort();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: 0, msg: "", data }));
    await expect(
      createClient("https://relay.example", fetcher)("jwt", controller.signal),
    ).rejects.toMatchObject({ reason: "relay-unavailable", retryable });
    expect(fetcher).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("提前拒绝 HTTP 状态时终止尚未结束的正文", async () => {
    const interrupted = vi.fn();
    const fetcher: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(body) {
            init?.signal?.addEventListener(
              "abort",
              () => {
                interrupted();
                body.error(init.signal?.reason);
              },
              { once: true },
            );
          },
        }),
        { status: 401 },
      );
    await expect(
      createClient("https://relay.example", fetcher)("jwt", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "auth-required", retryable: false });
    expect(interrupted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "http", "business", "invalid-json", "network"])(
    "%s 结束后清理期限和调用方监听，不改变错误分类",
    async (outcome) => {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, "addEventListener");
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      let requestSignal: AbortSignal | null | undefined;
      const fetcher: typeof fetch = async (_url, init) => {
        requestSignal = init?.signal;
        if (outcome === "network") throw new TypeError("private network detail");
        if (outcome === "http") return new Response("private response", { status: 401 });
        if (outcome === "invalid-json") return new Response("not-json");
        return Response.json({ code: outcome === "business" ? 1006 : 0, msg: "", data });
      };
      const result = createClient("https://relay.example", fetcher)("jwt", controller.signal);
      if (outcome === "success") await expect(result).resolves.toEqual(expected);
      else {
        const reason = outcome === "http" ? "auth-required" : "relay-unavailable";
        await expect(result).rejects.toMatchObject({
          reason,
          message: reason,
          retryable: outcome === "network" && retryable,
        });
      }
      expect(add).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
      expect(vi.getTimerCount()).toBe(0);
      // 已完成请求不再受导航取消影响，也不能遗留一个稍后触发的超时。
      controller.abort();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(requestSignal?.aborted).toBe(outcome !== "success");
    },
  );

  it.each([
    ["headers", "cancel"],
    ["headers", "timeout"],
    ["body", "cancel"],
    ["body", "timeout"],
  ])("%s 阶段的 %s 中断实际请求并清理资源", async (phase, action) => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    let requestSignal: AbortSignal | null | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing request signal");
      requestSignal = signal;
      if (phase === "headers")
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      return new Response(
        new ReadableStream({
          start(body) {
            body.enqueue(new TextEncoder().encode('{"code":0,"data":'));
            signal.addEventListener("abort", () => body.error(signal.reason), { once: true });
          },
        }),
      );
    };
    const result = createClient("https://relay.example", fetcher)("jwt", controller.signal);
    const rejected = expect(result).rejects.toMatchObject({
      reason: "relay-unavailable",
      message: "relay-unavailable",
      retryable,
    });
    // 收到头部后正文仍在读取：原来的 15 秒期限不能被提前清理或重新计时。
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requestSignal?.aborted).toBe(false);
    if (action === "cancel") controller.abort(new DOMException("navigation ended", "AbortError"));
    else await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason.name).toBe(action === "cancel" ? "AbortError" : "TimeoutError");
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
