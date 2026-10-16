import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_COMMAND_SUPERSEDED,
  createConfigCommandBarrier,
  createLatestConfigCommandScheduler,
} from "@/v4/configCommandBarrier.js";

describe("createConfigCommandBarrier", () => {
  it("serializes config → send → later config without allowing either side to overtake", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let markSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolve) => {
      markSendStarted = resolve;
    });
    const order: string[] = [];
    const barrier = createConfigCommandBarrier();

    void barrier.enqueue(async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    void barrier.enqueue(async () => {
      order.push("send:start");
      markSendStarted();
      await sendGate;
      order.push("send:end");
    });
    void barrier.enqueue(async () => {
      order.push("config:after-send");
    });
    const settled = vi.fn();
    void barrier.wait().then(settled);

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    expect(settled).not.toHaveBeenCalled();

    releaseFirst();
    await sendStarted;
    expect(order).toEqual(["first:start", "first:end", "send:start"]);
    expect(settled).not.toHaveBeenCalled();

    releaseSend();
    await barrier.wait();
    expect(order).toEqual([
      "first:start",
      "first:end",
      "send:start",
      "send:end",
      "config:after-send",
    ]);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("does not deadlock later commands after one config command rejects", async () => {
    const barrier = createConfigCommandBarrier();
    await expect(
      barrier.enqueue(async () => {
        throw new Error("stale config");
      }),
    ).rejects.toThrow("stale config");

    await expect(barrier.enqueue(async () => "recovered")).resolves.toBe("recovered");
    await expect(barrier.wait()).resolves.toBeUndefined();
  });
});

describe("createLatestConfigCommandScheduler", () => {
  it("keeps only the latest same-domain command that has not started", async () => {
    const barrier = createConfigCommandBarrier();
    const scheduler = createLatestConfigCommandScheduler<string>(barrier);
    const executed: string[] = [];

    const first = scheduler.schedule(async () => {
      executed.push("first");
      return "first";
    });
    const latest = scheduler.schedule(async () => {
      executed.push("latest");
      return "latest";
    });

    await expect(first).resolves.toBe(CONFIG_COMMAND_SUPERSEDED);
    await expect(latest).resolves.toBe("latest");
    expect(executed).toEqual(["latest"]);
  });

  it("seal preserves config → send → later config ordering", async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const barrier = createConfigCommandBarrier();
    const scheduler = createLatestConfigCommandScheduler<string>(barrier);
    const order: string[] = [];

    void barrier.enqueue(async () => blocker);
    const beforeSend = scheduler.schedule(async () => {
      order.push("config:before-send");
      return "before";
    });
    scheduler.seal();
    const send = barrier.enqueue(async () => {
      order.push("send");
    });
    const afterSend = scheduler.schedule(async () => {
      order.push("config:after-send");
      return "after";
    });

    releaseBlocker();
    await Promise.all([beforeSend, send, afterSend]);
    expect(order).toEqual([
      "config:before-send",
      "send",
      "config:after-send",
    ]);
  });

  it("does not merge model and mode domains that share one barrier", async () => {
    const barrier = createConfigCommandBarrier();
    const modelScheduler = createLatestConfigCommandScheduler<string>(barrier);
    const modeScheduler = createLatestConfigCommandScheduler<string>(barrier);
    const order: string[] = [];

    const model = modelScheduler.schedule(async () => {
      order.push("model");
      return "model";
    });
    const mode = modeScheduler.schedule(async () => {
      order.push("mode");
      return "mode";
    });

    await Promise.all([model, mode]);
    expect(order).toEqual(["model", "mode"]);
  });
});
