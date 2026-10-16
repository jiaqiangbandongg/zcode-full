// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";

function view(revision: number, providerId: string): ProviderSettingsView {
  return {
    revision,
    addableProviders: [],
    providerOrder: [],
    providers: [
      {
        providerId,
        builtin: false,
        source: "personal",
        enabled: true,
        complete: true,
        effectiveConfig: {},
        effectiveModelIds: [],
        models: [],
      },
    ],
  };
}

describe("useProviderSettingsServiceView", () => {
  it("提交 mutation 返回的最新 View，即使 change event 丢失也不会保留旧 Provider", async () => {
    const service = {
      getView: vi.fn<() => Promise<ProviderSettingsView>>().mockResolvedValue(view(1, "deleted")),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const hook = renderHook(() => useProviderSettingsServiceView(service));

    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    expect(
      hook.result.current.state.status === "ready"
        ? hook.result.current.state.view.providers[0]?.providerId
        : null,
    ).toBe("deleted");

    act(() => {
      hook.result.current.commit(view(2, "remaining"));
    });

    expect(
      hook.result.current.state.status === "ready"
        ? hook.result.current.state.view.providers.map((provider) => provider.providerId)
        : [],
    ).toEqual(["remaining"]);
  });

  it("首次失败结束 loading，reload 后恢复", async () => {
    const service = {
      getView: vi
        .fn<() => Promise<ProviderSettingsView>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce(view(2, "provider-a")),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const hook = renderHook(() => useProviderSettingsServiceView(service));

    await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
  });

  it("切换 Service 的同次 render 不暴露旧 Environment", async () => {
    const oldService = {
      getView: async () => view(1, "old"),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const nextService = {
      getView: async () => view(1, "next"),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const hook = renderHook(({ service }) => useProviderSettingsServiceView(service), {
      initialProps: { service: oldService },
    });
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));

    hook.rerender({ service: nextService });
    expect(hook.result.current.state).toEqual({ status: "loading" });
    await waitFor(() =>
      expect(
        hook.result.current.state.status === "ready"
          ? hook.result.current.state.view.providers[0]?.providerId
          : null,
      ).toBe("next"),
    );
  });

  it("切换 Service 后拒绝旧 Service 的迟到 mutation View", async () => {
    const oldService = {
      getView: async () => view(1, "old"),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const nextService = {
      getView: async () => view(1, "next"),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as unknown as IProviderSettingsService;
    const hook = renderHook(({ service }) => useProviderSettingsServiceView(service), {
      initialProps: { service: oldService },
    });
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    const commitOldView = hook.result.current.commit;

    hook.rerender({ service: nextService });
    act(() => {
      commitOldView(view(2, "late-old"));
    });

    await waitFor(() =>
      expect(
        hook.result.current.state.status === "ready"
          ? hook.result.current.state.view.providers[0]?.providerId
          : null,
      ).toBe("next"),
    );
  });
});
