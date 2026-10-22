// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useUiPluginRecommendations } from "@/plugin-ui/adapters/useUiPluginRecommendations.js";

const context = vi.hoisted(() => ({ service: { getSnapshot: vi.fn() } }));
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => ({ clientConfigService: context.service }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn() } }));
afterEach(cleanup);
const recommendations = [{ pluginId: "panel@example", surfaceId: "main" }];

it("禁用不请求，启用读取，关闭后忽略迟到结果", async () => {
  const pending = Promise.withResolvers<{ uiPluginRecommendations: typeof recommendations }>();
  context.service = { getSnapshot: vi.fn().mockReturnValue(pending.promise) };
  const { result, rerender } = renderHook(({ enabled }) => useUiPluginRecommendations(enabled), {
    initialProps: { enabled: false },
  });
  expect(context.service.getSnapshot).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
  rerender({ enabled: true });
  expect(result.current.loading).toBe(true);
  expect(context.service.getSnapshot).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  await act(async () => pending.resolve({ uiPluginRecommendations: recommendations }));
  expect(result.current.recommendations).toEqual([]);
});

it("切换服务立即清空投影，丢弃旧服务迟到结果，失败为空", async () => {
  const pending = Promise.withResolvers<{ uiPluginRecommendations: typeof recommendations }>();
  context.service = { getSnapshot: vi.fn().mockReturnValue(pending.promise) };
  const { result, rerender } = renderHook(() => useUiPluginRecommendations(true));
  expect(result.current.loading).toBe(true);
  context.service = {
    getSnapshot: vi.fn().mockResolvedValue({ uiPluginRecommendations: recommendations }),
  };
  rerender();
  await act(async () => {});
  expect(result.current.recommendations).toEqual(recommendations);
  expect(result.current.loading).toBe(false);
  await act(async () => pending.resolve({ uiPluginRecommendations: [] }));
  expect(result.current.recommendations).toEqual(recommendations);
  expect(result.current.loading).toBe(false);
  context.service = { getSnapshot: vi.fn().mockRejectedValue(new Error("offline")) };
  rerender();
  expect(result.current.recommendations).toEqual([]);
  await act(async () => {});
  expect(result.current.recommendations).toEqual([]);
  expect(result.current.loading).toBe(false);
});
