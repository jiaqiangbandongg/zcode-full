// @vitest-environment jsdom
import type { ModelConfigResolution } from "@zcode/provider";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderModelDraft } from "@/settings/model-provider-section/useProviderModelDraft.js";
import { smartDraftModel } from "./providerModelSmartDraftFixture.js";

afterEach(() => vi.useRealTimers());
describe("Todo90 shared draft lifecycle", () => {
  it("关闭模式拒绝在途推荐；重新开启不复用旧模式的回包", async () => {
    const model = smartDraftModel();
    const pending: ((value: ModelConfigResolution) => void)[] = [];
    const resolve = vi.fn(
      () => new Promise<ModelConfigResolution>((finish) => pending.push(finish)),
    );
    const { result } = renderHook(() =>
      useProviderModelDraft({ model, open: true, scopeKey: "p", resolve }),
    );
    const value = { inheritedConfig: model.config, effectiveConfig: model.config, issues: [] };
    act(() => result.current.change({ idValue: "b" }));
    act(() => {
      void result.current.flush();
    });
    await act(async () => pending[0]!(value));
    act(() => {
      void result.current.flush();
    });
    act(() => result.current.change({ useRecommendedConfigValue: false }));
    const fixed = result.current.draft;
    await act(async () => pending[1]!({ ...value, inheritedConfig: {} }));
    expect(result.current.draft).toEqual(fixed);
    act(() => result.current.change({ useRecommendedConfigValue: true }));
    expect(result.current.inheritedConfig).toBeUndefined();
    act(() => {
      void result.current.flush();
    });
    await act(async () => pending[2]!(value));
    expect(result.current.inheritedConfig).toEqual(model.config);
  });
  it("does not resolve by ID while fixed, including save; re-enable resolves current ID", async () => {
    const model = smartDraftModel();
    const resolve = vi.fn(async () => ({
      inheritedConfig: model.config,
      effectiveConfig: model.config,
      issues: [],
    }));
    const { result } = renderHook(() =>
      useProviderModelDraft({ model, open: true, scopeKey: "p", resolve }),
    );
    act(() => result.current.change({ useRecommendedConfigValue: false }));
    act(() => result.current.change({ idValue: "b" }));
    await act(async () => {
      expect((await result.current.commit()).status).toBe("commit");
    });
    expect(resolve).not.toHaveBeenCalled();
    act(() => result.current.change({ useRecommendedConfigValue: true }));
    await act(async () => {
      await result.current.flush();
    });
    expect(resolve).toHaveBeenCalledWith("b", {});
  });

  it("discards A→B→A late responses, close and scope changes", async () => {
    const model = { ...smartDraftModel(), modelId: "initial" };
    const pending: { id: string; finish: (value: ModelConfigResolution) => void }[] = [];
    const resolve = vi.fn(
      (id: string) => new Promise<ModelConfigResolution>((finish) => pending.push({ id, finish })),
    );
    const { result, rerender } = renderHook(
      ({ open, scope }) => useProviderModelDraft({ model, open, scopeKey: scope, resolve }),
      { initialProps: { open: true, scope: "p" } },
    );
    const request = async (id: string) => {
      act(() => result.current.change({ idValue: id }));
      act(() => {
        void result.current.flush();
      });
    };
    await request("a");
    await request("b");
    await request("a");
    const finish = (index: number, contextWindow: number) => {
      const config = structuredClone(model.config);
      config.properties!.contextWindow = contextWindow;
      pending[index]!.finish({ inheritedConfig: config, effectiveConfig: config, issues: [] });
    };
    await act(async () => finish(2, 333333));
    expect(result.current.inheritedConfig?.properties?.contextWindow).toBe(333333);
    await act(async () => {
      finish(0, 111111);
      finish(1, 222222);
    });
    expect(result.current.inheritedConfig?.properties?.contextWindow).toBe(333333);
    await request("c");
    rerender({ open: false, scope: "p" });
    await act(async () => finish(3, 444444));
    rerender({ open: true, scope: "other" });
    expect(result.current.inheritedConfig?.properties?.contextWindow).not.toBe(444444);
    expect(result.current.draft.idValue).toBe("initial");
  });

  it("failed recommendation never commits stale old-model values", async () => {
    const model = smartDraftModel();
    const resolve = vi.fn(async () => {
      throw new Error("recommendations offline");
    });
    const { result } = renderHook(() =>
      useProviderModelDraft({ model, open: true, scopeKey: "p", resolve }),
    );
    act(() => result.current.change({ idValue: "b", contextWindowValue: "123456" }));
    await act(async () => {
      await expect(result.current.commit()).rejects.toThrow("recommendations offline");
    });
    expect(result.current.draft.contextWindowValue).toBe("123456");
  });
});
