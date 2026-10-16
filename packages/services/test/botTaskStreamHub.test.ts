import { describe, expect, it, vi } from "vitest";
import { createBotTaskStreamHub } from "../src/bots/taskStreamHub.js";

describe("Bot task stream hub", () => {
  it("shares one upstream while isolating slow and failing recipients", async () => {
    const hub = createBotTaskStreamHub<number>();
    let emit!: (event: number) => Promise<void>;
    const stop = vi.fn();
    const subscribe = vi.fn((listener: typeof emit) => {
      emit = listener;
      return { dispose: stop };
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = hub.add("workspace/task", "a", subscribe, async () => {
      await pending;
      throw new Error("failed");
    });
    const delivered: number[] = [];
    const second = hub.add("workspace/task", "b", subscribe, async (event) => {
      delivered.push(event);
    });
    const delivery = emit(1);
    await vi.waitFor(() => expect(delivered).toEqual([1]));
    expect(subscribe).toHaveBeenCalledOnce();
    release();
    await delivery;
    first.dispose();
    expect(stop).not.toHaveBeenCalled();
    second.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("isolates workspace identities and skips removed targets in queued deliveries", async () => {
    const hub = createBotTaskStreamHub<number>();
    const listeners: Array<(event: number) => Promise<void>> = [];
    const subscribe = (listener: (event: number) => Promise<void>) => {
      listeners.push(listener);
      return { dispose: vi.fn() };
    };
    const a = vi.fn();
    const b = vi.fn();
    const first = hub.add("ssh:a/task", "bot", subscribe, a);
    hub.add("ssh:b/task", "bot", subscribe, b);
    first.dispose();
    await listeners[0]!(1);
    await listeners[1]!(2);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(2);
    hub.dispose();
  });
});
