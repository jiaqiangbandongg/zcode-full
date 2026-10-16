// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";

function view(revision: number, providerId: string): ModelSelectionView {
  return {
    revision,
    providers: [{ providerId, config: {}, models: [] }],
  };
}

describe("useModelSelectionServiceView", () => {
  it("重新进入设置读取当前连接；已挂载时通过同一订阅更新，不需额外 Provider 强刷", async () => {
    let latest = view(1, "account:bigmodel-start-plan");
    const listeners = new Set<(value: ModelSelectionView) => void>();
    const getView = vi.fn(async () => latest);
    const service: IModelSelectionService = {
      getView,
      onDidChange: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    };
    const first = renderHook(() => useModelSelectionServiceView(service));
    await waitFor(() =>
      expect(first.result.current.state).toEqual({ status: "ready", view: latest }),
    );
    first.unmount();
    expect(listeners.size).toBe(0);
    latest = view(2, "account:bigmodel-individual-coding-plan");
    const second = renderHook(() => useModelSelectionServiceView(service));
    await waitFor(() =>
      expect(second.result.current.state).toEqual({ status: "ready", view: latest }),
    );
    latest = view(3, "account:bigmodel-team-coding-plan");
    act(() => listeners.forEach((listener) => listener(latest)));
    expect(second.result.current.state).toEqual({ status: "ready", view: latest });
    expect(getView).toHaveBeenCalledTimes(2);
    second.unmount();
  });

  it("首读临时 IO 失败无后续事件时有限重读，成功后同 revision 也能恢复", async () => {
    vi.useFakeTimers();
    try {
      const getView = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))
        .mockResolvedValueOnce(view(1, "recovered"));
      const service: IModelSelectionService = {
        getView,
        onDidChange: () => ({ dispose: vi.fn() }),
      };
      const hook = renderHook(() => useModelSelectionServiceView(service));
      await act(async () => Promise.resolve());
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(getView).toHaveBeenCalledTimes(2);
      expect(hook.result.current.state).toMatchObject({ status: "ready", view: { revision: 1 } });
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("首读重试有上限且卸载取消计时，不重试已释放服务", async () => {
    vi.useFakeTimers();
    try {
      const getView = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
      const service: IModelSelectionService = {
        getView,
        onDidChange: () => ({ dispose: vi.fn() }),
      };
      const hook = renderHook(() => useModelSelectionServiceView(service));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(getView).toHaveBeenCalledTimes(3);
      expect(hook.result.current.state.status).toBe("error");
      act(() => hook.result.current.reload());
      await act(async () => Promise.resolve());
      hook.unmount();
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(getView).toHaveBeenCalledTimes(4);
      getView.mockRejectedValue(new Error("ModelSelectionService 已 dispose"));
      const disposedHook = renderHook(() => useModelSelectionServiceView(service));
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(getView).toHaveBeenCalledTimes(5);
      disposedHook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("同 revision 的不同原意图各自解析，旧输入回包不能覆盖新输入", async () => {
    const reads: Array<{ selection: unknown; resolve(value: ModelSelectionView): void }> = [];
    const service: IModelSelectionService = {
      getView: (input) =>
        new Promise((resolve) => reads.push({ selection: input?.selection, resolve })),
      onDidChange: () => ({ dispose: vi.fn() }),
    };
    const first = { providerId: "account-old", modelId: "m1" };
    const second = { providerId: "personal", modelId: "m2" };
    const hook = renderHook(
      ({ selection }) =>
        useModelSelectionServiceView(service, true, "remote-waiting", { selection }),
      { initialProps: { selection: first } },
    );
    hook.rerender({ selection: second });
    expect(reads.map((read) => read.selection)).toEqual([first, second]);
    await act(async () =>
      reads[1]!.resolve({ ...view(3, "personal"), effectiveSelection: second }),
    );
    await act(async () =>
      reads[0]!.resolve({ ...view(3, "account-new"), effectiveSelection: first }),
    );
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      view: { effectiveSelection: second },
    });
  });

  it("公共事件只触发重读，不把别的调用者结果或空候选广播当自己的解析结果", async () => {
    let listener: ((next: ModelSelectionView) => void) | undefined;
    const selection = { providerId: "account-old", modelId: "m1" };
    const getView = vi.fn(async () => ({
      ...view(3, "account-new"),
      effectiveSelection: { ...selection, providerId: "account-new" },
    }));
    const service: IModelSelectionService = {
      getView,
      onDidChange: (callback) => {
        listener = callback;
        return { dispose: vi.fn() };
      },
    };
    const hook = renderHook(() =>
      useModelSelectionServiceView(service, true, "remote-waiting", { selection }),
    );
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    act(() => listener?.({ revision: 3, providers: [] }));
    await waitFor(() => expect(getView).toHaveBeenCalledTimes(2));
    expect(getView).toHaveBeenLastCalledWith({ selection });
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      view: { effectiveSelection: { providerId: "account-new" } },
    });
  });

  it("切换目标 Host 后立即清空旧 View，并丢弃旧 Host 迟到结果", async () => {
    let resolveOld: ((value: ModelSelectionView) => void) | undefined;
    const oldService = {
      getView: () =>
        new Promise<ModelSelectionView>((resolve) => {
          resolveOld = resolve;
        }),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as IModelSelectionService;
    const nextService = {
      getView: async () => view(1, "remote-provider"),
      onDidChange: () => ({ dispose: vi.fn() }),
    } as IModelSelectionService;
    const hook = renderHook(({ service }) => useModelSelectionServiceView(service), {
      initialProps: { service: oldService },
    });

    expect(hook.result.current.state).toEqual({ status: "loading" });
    hook.rerender({ service: nextService });
    expect(hook.result.current.state).toEqual({ status: "loading" });
    await waitFor(() =>
      expect(
        hook.result.current.state.status === "ready"
          ? hook.result.current.state.view.providers[0]?.providerId
          : null,
      ).toBe("remote-provider"),
    );
    await act(async () => resolveOld?.(view(99, "local-provider")));
    expect(hook.result.current.state).toMatchObject({ status: "ready" });
  });

  it("remote-waiting 禁用读取时保持 unavailable", async () => {
    const getView = vi.fn(async () => view(1, "local-provider"));
    const service = {
      getView,
      onDidChange: () => ({ dispose: vi.fn() }),
    } as IModelSelectionService;
    const hook = renderHook(() => useModelSelectionServiceView(service, false));

    await act(async () => Promise.resolve());
    expect(hook.result.current.state).toEqual({
      status: "unavailable",
      reason: "remote-waiting",
    });
    expect(getView).not.toHaveBeenCalled();
  });

  it("首次读取失败进入 error，reload 后可恢复 ready", async () => {
    const getView = vi
      .fn<() => Promise<ModelSelectionView>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(view(2, "provider-after-reload"));
    const service = {
      getView,
      onDidChange: () => ({ dispose: vi.fn() }),
    } as IModelSelectionService;
    const hook = renderHook(() => useModelSelectionServiceView(service));

    await waitFor(() => expect(hook.result.current.state.status).toBe("error"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    expect(getView).toHaveBeenCalledTimes(2);
  });

  it("事件先于首次读取返回时保持较新的 revision", async () => {
    let listener: ((next: ModelSelectionView) => void) | undefined;
    let resolveInitial: ((next: ModelSelectionView) => void) | undefined;
    const service = {
      getView: () =>
        new Promise<ModelSelectionView>((resolve) => {
          resolveInitial = resolve;
        }),
      onDidChange: (next: (view: ModelSelectionView) => void) => {
        listener = next;
        return { dispose: vi.fn() };
      },
    } as IModelSelectionService;
    const hook = renderHook(() => useModelSelectionServiceView(service));

    act(() => listener?.(view(3, "newer")));
    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    await act(async () => resolveInitial?.(view(2, "older")));
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      view: { revision: 3 },
    });
  });

  it("已有 Ready View 时 reload 失败保留 Last Known Good", async () => {
    let listener: ((next: ModelSelectionView) => void) | undefined;
    const getView = vi
      .fn<() => Promise<ModelSelectionView>>()
      .mockResolvedValueOnce(view(5, "stable"))
      .mockRejectedValueOnce(new Error("refresh failed"));
    const service = {
      getView,
      onDidChange: (next: (view: ModelSelectionView) => void) => {
        listener = next;
        return { dispose: vi.fn() };
      },
    } as IModelSelectionService;
    const hook = renderHook(() => useModelSelectionServiceView(service));

    await waitFor(() => expect(hook.result.current.state.status).toBe("ready"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(getView).toHaveBeenCalledTimes(2));
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      view: { revision: 5 },
    });
    act(() => listener?.(view(6, "recovered-by-event")));
    expect(hook.result.current.state).toMatchObject({
      status: "ready",
      view: { revision: 6 },
    });
  });
});
