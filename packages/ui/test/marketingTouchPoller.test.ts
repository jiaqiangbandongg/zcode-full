import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMarketingTouchPoller,
  resolveMarketingTouchPollIntervalMs,
} from "@/components/marketing-touch/marketingTouchPoller.js";
afterEach(() => vi.useRealTimers());
describe("marketing poll lifecycle", () => {
  it.each([
    [true, "production", 600_000],
    [true, "test", 30_000],
    [false, "production", 30_000],
    [false, "test", 30_000],
  ] as const)("uses the environment interval for build=%s env=%s", async (build, env, interval) => {
    vi.useFakeTimers();
    const intervalMs = resolveMarketingTouchPollIntervalMs(build, env);
    expect(intervalMs).toBe(interval);
    const query = vi.fn(async () => {});
    const poller = createMarketingTouchPoller({ query, visible: () => true, intervalMs });
    poller.refresh();
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    poller.dispose();
  });
  it("coalesces refreshes and does not overlap slow requests", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const query = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const poller = createMarketingTouchPoller({ query, visible: () => true, intervalMs: 600_000 });
    poller.refresh();
    poller.refresh();
    poller.refresh();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(query).toHaveBeenCalledTimes(1);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(2);
    poller.dispose();
    resolve();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("pauses while hidden and refreshes on visibility recovery", async () => {
    vi.useFakeTimers();
    let visible = true;
    const query = vi.fn(async () => {});
    const poller = createMarketingTouchPoller({
      query,
      visible: () => visible,
      intervalMs: 600_000,
    });
    poller.refresh();
    await vi.advanceTimersByTimeAsync(0);
    visible = false;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(query).toHaveBeenCalledTimes(1);
    visible = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(query).toHaveBeenCalledTimes(2);
    poller.dispose();
  });
  it("backs off failures and returns to regular scheduling after success", async () => {
    vi.useFakeTimers();
    const query = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const poller = createMarketingTouchPoller({ query, visible: () => true, intervalMs: 600_000 });
    poller.refresh();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(query).toHaveBeenCalledTimes(3);
    poller.dispose();
  });
});
