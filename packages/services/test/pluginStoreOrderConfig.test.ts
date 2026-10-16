import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientConfigService } from "../src/client-config/clientConfigService.js";
import type { ApiClient } from "@zcode/shared";

const order = {
  code: { categoryOrder: ["developer-tools"] },
  work: { categoryOrder: ["finance"] },
};
const body = (value: unknown = order) => ({
  code: 0,
  data: { configs: { pluginStoreOrder: value, privateField: "must not escape" } },
});
const response = (value: unknown = order) => new Response(JSON.stringify(body(value)));
const initialContext = {
  endpointOrigin: "https://config.example.test",
  appVersion: "3.12.1",
  platform: "darwin-arm64",
};
function setup(request: ApiClient["request"]) {
  let context = { ...initialContext };
  return {
    service: createClientConfigService({
      apiClient: { request },
      resolveRequestContext: async () => ({ ...context }),
    }),
    setContext: (next: Partial<typeof context>) => {
      context = { ...context, ...next };
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("ClientConfigService", () => {
  it("同上下文请求合并与缓存，只返回公开字段且不携带账户鉴权", async () => {
    const request = vi.fn<ApiClient["request"]>(async () => response());
    const { service } = setup(request);
    expect(await Promise.all([service.getSnapshot(), service.getSnapshot()])).toEqual([
      { pluginStoreOrder: order, zsrcUrl: null },
      { pluginStoreOrder: order, zsrcUrl: null },
    ]);
    const snapshot = await service.getSnapshot();
    snapshot.pluginStoreOrder!.code!.categoryOrder!.push("other");
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      method: "GET",
    });
    expect(request.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("强刷期间和失败后保留有效快照，成功撤销才替换", async () => {
    const pending = Promise.withResolvers<Response>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(response())
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(response(null));
    const { service } = setup(request);
    await service.getSnapshot();
    const refresh = service.getSnapshot({ forceRefresh: true });
    await Promise.resolve();
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
    const failed = expect(refresh).rejects.toThrow();
    pending.reject(new Error("offline"));
    await failed;
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
    expect(await service.getSnapshot({ forceRefresh: true })).toEqual({
      pluginStoreOrder: null,
      zsrcUrl: null,
    });
  });

  it.each(["endpointOrigin", "appVersion", "platform"] as const)(
    "%s 变化隔离缓存和在飞响应",
    async (field) => {
      const old = Promise.withResolvers<Response>();
      const request = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(response(null));
      const { service, setContext } = setup(request);
      const first = service.getSnapshot();
      await Promise.resolve();
      setContext({
        [field]: field === "endpointOrigin" ? "https://other.example.test" : "changed",
      });
      expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: null, zsrcUrl: null });
      old.resolve(response());
      await first;
      expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: null, zsrcUrl: null });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("TTL 到期后重新读取", async () => {
    vi.useFakeTimers();
    const request = vi.fn<ApiClient["request"]>(async () => response());
    const { service } = setup(request);
    await service.getSnapshot();
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1);
    await service.getSnapshot();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    new Response("bad", { status: 503 }),
    new Response(JSON.stringify({ code: 1001, data: body().data })),
    new Response("not json"),
  ])("错误响应不缓存且可以重试", async (bad) => {
    const request = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(response());
    const { service } = setup(request);
    await expect(service.getSnapshot()).rejects.toThrow();
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
  });

  it("正文挂起也受总请求预算约束，超时后可重试", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const request = vi.fn<ApiClient["request"]>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { ok: true, url: "", json: () => new Promise(() => {}) } as Response;
    });
    const { service } = setup(request);
    const result = expect(service.getSnapshot()).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(signal?.aborted).toBe(true);
    request.mockResolvedValueOnce(response());
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
  });

  it("传输中 endpoint 被改写的响应不得缓存到旧上下文", async () => {
    const changed = response();
    Object.defineProperty(changed, "url", {
      value: "https://other.example.test/api/v1/client/configs",
    });
    const request = vi.fn().mockResolvedValueOnce(changed).mockResolvedValueOnce(response());
    const { service } = setup(request);
    await expect(service.getSnapshot()).rejects.toThrow();
    expect(await service.getSnapshot()).toEqual({ pluginStoreOrder: order, zsrcUrl: null });
  });
});
