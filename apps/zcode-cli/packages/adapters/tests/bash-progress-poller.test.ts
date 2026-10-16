import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeBashOutputProgress } from "../src/exec/bash-progress-poller.js";

const subscriptions: Array<() => void> = [];
function subscribe(poll: (isActive: () => boolean) => Promise<void>, intervalMs = 1000) {
  const stop = subscribeBashOutputProgress(intervalMs, poll);
  subscriptions.push(stop);
  return stop;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const stop of subscriptions.splice(0)) stop();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe("shared Bash progress polling", () => {
  it("shares one interval and adding a subscriber does not reset its tick", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    subscribe(first);
    await vi.advanceTimersByTimeAsync(500);
    subscribe(second);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps other subscribers running and releases the interval after the last unsubscribe", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const stopFirst = subscribe(first);
    const stopSecond = subscribe(second);
    stopFirst();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not overlap a slow read or block another subscriber", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async () => {
      await barrier;
    });
    const fast = vi.fn(async () => {});
    subscribe(slow);
    subscribe(fast);
    await vi.advanceTimersByTimeAsync(3000);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(3);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(slow).toHaveBeenCalledTimes(2);
    expect(fast).toHaveBeenCalledTimes(4);
  });

  it("isolates failing reads and callbacks and retries on the next tick", async () => {
    const failure = vi
      .fn()
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValue(undefined);
    const throws = vi.fn(() => {
      throw new Error("callback failed");
    });
    const healthy = vi.fn(async () => {});
    subscribe(failure);
    const stopThrowing = subscribe(throws);
    subscribe(healthy);
    await vi.advanceTimersByTimeAsync(2000);
    expect(failure).toHaveBeenCalledTimes(2);
    expect(healthy).toHaveBeenCalledTimes(2);
    stopThrowing();
  });

  it("rejects late results and an old unsubscribe cannot remove a restarted subscription", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRead = vi.fn();
    const stopOld = subscribe(async (isActive) => {
      await barrier;
      if (isActive()) onRead();
    });
    await vi.advanceTimersByTimeAsync(1000);
    stopOld();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = vi.fn(async () => {});
    subscribe(fresh);
    stopOld();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onRead).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("keeps different internal intervals independent", async () => {
    const short = vi.fn(async () => {});
    const normal = vi.fn(async () => {});
    subscribe(short, 100);
    subscribe(normal);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(short).toHaveBeenCalledTimes(10);
    expect(normal).toHaveBeenCalledTimes(1);
  });
});
