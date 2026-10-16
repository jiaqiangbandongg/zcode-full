// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginStoreOrder, ClientConfigSnapshot } from "@zcode/shared";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";

const context = vi.hoisted(() => ({ service: { getSnapshot: vi.fn() } }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ clientConfigService: context.service }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(cleanup);
const config: PluginStoreOrder = { work: { categoryOrder: ["finance"] } };

describe("usePluginStoreOrder", () => {
  it("请求未到达用默认，失败保留已显示配置，成功撤销清空配置", async () => {
    const pending = Promise.withResolvers<ClientConfigSnapshot>();
    context.service = { getSnapshot: vi.fn().mockReturnValueOnce(pending.promise) };
    const { result } = renderHook(usePluginStoreOrder);
    expect(result.current.order).toBeNull();
    await act(async () => {
      pending.resolve({ zsrcUrl: null, pluginStoreOrder: config });
    });
    expect(result.current.order).toEqual(config);
    context.service.getSnapshot.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await result.current.refresh(true);
    });
    expect(result.current.order).toEqual(config);
    context.service.getSnapshot.mockResolvedValueOnce({ pluginStoreOrder: null });
    await act(async () => {
      await result.current.refresh(true);
    });
    expect(result.current.order).toBeNull();
  });

  it("较旧请求完成不能覆盖较新的刷新", async () => {
    const pending = Promise.withResolvers<ClientConfigSnapshot>();
    context.service = {
      getSnapshot: vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ pluginStoreOrder: config }),
    };
    const { result } = renderHook(usePluginStoreOrder);
    await act(async () => {
      await result.current.refresh(true);
    });
    await act(async () => {
      pending.resolve({ zsrcUrl: null, pluginStoreOrder: { code: { categoryOrder: ["other"] } } });
    });
    expect(result.current.order).toEqual(config);
  });

  it("服务切换立即隔离旧配置，旧服务迟到结果被丢弃", async () => {
    const old = Promise.withResolvers<ClientConfigSnapshot>();
    context.service = {
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce({ pluginStoreOrder: config })
        .mockReturnValueOnce(old.promise),
    };
    const { result, rerender } = renderHook(usePluginStoreOrder);
    await act(async () => {});
    act(() => {
      void result.current.refresh(true);
    });
    const next = Promise.withResolvers<ClientConfigSnapshot>();
    context.service = { getSnapshot: vi.fn().mockReturnValueOnce(next.promise) };
    rerender();
    expect(result.current.order).toBeNull();
    await act(async () => {
      old.resolve({ zsrcUrl: null, pluginStoreOrder: config });
    });
    expect(result.current.order).toBeNull();
    await act(async () => {
      next.resolve({ zsrcUrl: null, pluginStoreOrder: { code: { categoryOrder: ["other"] } } });
    });
    expect(result.current.order).toEqual({ code: { categoryOrder: ["other"] } });
  });
});

it("关闭的 Picker 不读配置，关闭后的迟到请求不能发布，重开重新读取", async () => {
  const pending = Promise.withResolvers<ClientConfigSnapshot>();
  context.service = {
    getSnapshot: vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ pluginStoreOrder: config }),
  };
  const { result, rerender } = renderHook(({ enabled }) => usePluginStoreOrder(enabled), {
    initialProps: { enabled: false },
  });
  expect(context.service.getSnapshot).not.toHaveBeenCalled();
  rerender({ enabled: true });
  expect(context.service.getSnapshot).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  await act(async () => {
    pending.resolve({ zsrcUrl: null, pluginStoreOrder: { code: {} } });
  });
  expect(result.current.order).toBeNull();
  rerender({ enabled: true });
  await act(async () => {});
  expect(result.current.order).toEqual(config);
});
