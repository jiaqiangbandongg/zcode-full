// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StorageManagementBridge, StorageUsageSnapshot } from "@zcode/shared";

const { storageService, listeners, jobState } = vi.hoisted(() => {
  const listeners = new Set<(snapshot: unknown) => void>();
  const jobState = { counter: 0 };
  const storageService = {
    startScan: vi.fn(async () => ({ jobId: `scan-${++jobState.counter}` })),
    cancelScan: vi.fn(async () => {}),
    getSnapshot: vi.fn(async () => null as unknown),
    subscribeScanProgress: vi.fn((listener: (snapshot: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    clean: vi.fn(async () => ({ freedBytes: 3, deletedCount: 1, skippedCount: 0, failures: [] })),
    revealPath: vi.fn(async () => {}),
  };
  return { storageService, listeners, jobState };
});

import {
  STORAGE_SCAN_BLUR_CANCEL_MS,
  useStorageUsage,
} from "@/resource-manager/storage/useStorageUsage.js";

const bridge = storageService as unknown as StorageManagementBridge;

function snapshot(jobId: string, status: StorageUsageSnapshot["status"]): StorageUsageSnapshot {
  return { jobId, status, startedAt: 0, roots: [], errors: [] };
}

function emit(value: StorageUsageSnapshot) {
  for (const listener of listeners) listener(value);
}

describe("useStorageUsage (resource manager storage tab)", () => {
  beforeEach(() => {
    listeners.clear();
    jobState.counter = 0;
    storageService.startScan.mockClear();
    storageService.cancelScan.mockClear();
    storageService.getSnapshot.mockReset();
    storageService.getSnapshot.mockResolvedValue(null);
    storageService.clean.mockClear();
  });

  it("starts scanning on mount, only accepts the current job's snapshots and cancels on unmount", async () => {
    const { result, unmount } = renderHook(() => useStorageUsage({ bridge, enabled: true }));
    await waitFor(() => expect(storageService.startScan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.scanning).toBe(true));

    act(() => emit(snapshot("scan-0", "scanning")));
    expect(result.current.snapshot).toBeNull();
    act(() => emit(snapshot("scan-1", "scanning")));
    expect(result.current.snapshot?.jobId).toBe("scan-1");
    expect(result.current.scanning).toBe(true);
    act(() => emit(snapshot("scan-1", "complete")));
    expect(result.current.scanning).toBe(false);

    unmount();
    // 已完成的 job 不再取消；只有进行中的才会
    expect(storageService.cancelScan).not.toHaveBeenCalled();
  });

  it("cancels an in-flight job on unmount and shows the previous snapshot while rescanning", async () => {
    storageService.getSnapshot.mockResolvedValue(snapshot("scan-old", "complete"));
    const { result, unmount } = renderHook(() => useStorageUsage({ bridge, enabled: true }));
    await waitFor(() => expect(result.current.snapshot?.jobId).toBe("scan-old"));
    await waitFor(() => expect(result.current.scanning).toBe(true));
    unmount();
    await waitFor(() => expect(storageService.cancelScan).toHaveBeenCalledWith("scan-1"));
  });

  it("cancels after the window stays blurred and restarts on focus", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useStorageUsage({ bridge, enabled: true }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.scanning).toBe(true);
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      await act(async () => {
        vi.advanceTimersByTime(STORAGE_SCAN_BLUR_CANCEL_MS);
        await Promise.resolve();
      });
      expect(storageService.cancelScan).toHaveBeenCalledWith("scan-1");
      expect(result.current.scanning).toBe(false);
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await Promise.resolve();
      });
      expect(storageService.startScan).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing without a bridge", async () => {
    const { result } = renderHook(() => useStorageUsage({ bridge: undefined, enabled: true }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.scanning).toBe(false);
    expect(storageService.startScan).not.toHaveBeenCalled();
  });

  it("cleans then rescans", async () => {
    const { result } = renderHook(() => useStorageUsage({ bridge, enabled: true }));
    await waitFor(() => expect(storageService.startScan).toHaveBeenCalledTimes(1));
    let cleaned: Awaited<ReturnType<typeof result.current.clean>> | undefined;
    await act(async () => {
      cleaned = await result.current.clean({ rootId: "home", categoryId: "logs" });
    });
    expect(cleaned?.freedBytes).toBe(3);
    expect(storageService.clean).toHaveBeenCalledWith({ rootId: "home", categoryId: "logs" });
    expect(storageService.startScan).toHaveBeenCalledTimes(2);
  });
});
