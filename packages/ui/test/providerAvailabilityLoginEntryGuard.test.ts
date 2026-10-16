// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useProviderAvailabilityLoginEntryGuard } from "@/root/useProviderAvailabilityLoginEntryGuard.js";

describe("useProviderAvailabilityLoginEntryGuard", () => {
  it("首次 Selection 读取失败结束启动等待且不伪装成无 Provider", async () => {
    const setLoginEntryOpen = vi.fn();
    const { result } = renderHook(() =>
      useProviderAvailabilityLoginEntryGuard({
        user: null,
        isRestoringOAuthSession: false,
        providerFamilyDomain: "zai",
        modelSelectionView: null,
        modelSelectionError: new Error("registry unavailable"),
        refreshProviderState: vi.fn(async () => {}),
        readModelSelectionView: vi.fn(),
        setLoginEntryOpen,
      }),
    );

    await waitFor(() => expect(result.current.startupCheckCompleted).toBe(true));
    expect(setLoginEntryOpen).not.toHaveBeenCalled();
  });

  it("等待 Selection View 水合后再判断启动可用性", async () => {
    const setLoginEntryOpen = vi.fn();
    const refreshProviderState = vi.fn(async () => {});
    const view = {
      revision: 1,
      providers: [
        {
          providerId: "registry-provider",
          config: { kind: "api" as const },
          models: [{ modelId: "registry-model", config: {} }],
        },
      ],
    };
    const { rerender } = renderHook(
      (props: { hydrated: boolean }) =>
        useProviderAvailabilityLoginEntryGuard({
          user: null,
          isRestoringOAuthSession: false,
          providerFamilyDomain: "zai",
          modelSelectionView: props.hydrated ? view : null,
          refreshProviderState,
          readModelSelectionView: async () => view,
          setLoginEntryOpen,
        }),
      { initialProps: { hydrated: false } },
    );

    await Promise.resolve();
    expect(setLoginEntryOpen).not.toHaveBeenCalled();

    rerender({ hydrated: true });

    await waitFor(() => expect(setLoginEntryOpen).toHaveBeenCalledWith(false));
    expect(refreshProviderState).not.toHaveBeenCalled();
  });
});
