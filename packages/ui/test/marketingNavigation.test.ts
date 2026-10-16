import { afterEach, describe, expect, it, vi } from "vitest";
import {
  marketingNavigation,
  requestMarketingNavigation,
  finishMarketingNavigation,
  waitForMarketingCapability,
} from "@/lib/marketingNavigation.js";

afterEach(() => {
  vi.useRealTimers();
});
describe("navigation completion correlation", () => {
  it("does not turn clipboard failure into success and cleans up timers", async () => {
    vi.useFakeTimers();
    await expect(
      waitForMarketingCapability(
        Promise.reject(new Error("denied")),
        new AbortController().signal,
        10_000,
      ),
    ).rejects.toThrow("denied");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a stuck clipboard operation and ignores late resolution", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waiting = waitForMarketingCapability(operation, new AbortController().signal, 10_000);
    const assertion = expect(waiting).rejects.toThrow("marketing_capability_timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    finish();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for the destination and ignores stale acknowledgements", async () => {
    const signal = new AbortController();
    const dispatch = vi.fn();
    const promise = requestMarketingNavigation({ page: "settings" }, signal.signal, dispatch);
    const request = marketingNavigation.getState().request!;
    expect(dispatch).toHaveBeenCalledOnce();
    finishMarketingNavigation(request.id + 1);
    expect(marketingNavigation.getState().request).toBe(request);
    finishMarketingNavigation(request.id);
    await expect(promise).resolves.toBeUndefined();
    expect(marketingNavigation.getState().request).toBeNull();
  });
  it("cancels on unmount/account change", async () => {
    const signal = new AbortController();
    const promise = requestMarketingNavigation({ page: "settings" }, signal.signal, () => {});
    signal.abort();
    await expect(promise).rejects.toThrow();
    expect(marketingNavigation.getState().request).toBeNull();
  });
  it("times out without dispatching twice", async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    const promise = requestMarketingNavigation(
      { page: "plugin_marketplace" },
      new AbortController().signal,
      dispatch,
    );
    const assertion = expect(promise).rejects.toThrow("marketing_capability_timeout");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(marketingNavigation.getState().request).toBeNull();
  });
});
