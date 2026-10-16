import { afterEach, describe, expect, it, vi } from "vitest";
import { McpUiSamplingCalls } from "./samplingCalls.js";
const scope = (token: string, sessionId = "session") => ({
  token,
  sessionId,
  signal: new AbortController().signal,
});
afterEach(() => vi.useRealTimers());
describe("sampling admission and terminal ownership", () => {
  it("cancels before admission and rejects all duplicate completions", async () => {
    const calls = new McpUiSamplingCalls(),
      s = scope("one"),
      run = vi.fn(async () => 1);
    expect(calls.cancel(s, "early").cancelled).toBe(false);
    await expect(calls.execute(s, "early", run)).rejects.toThrow("Duplicate");
    expect(run).not.toHaveBeenCalled();
    expect(await calls.execute(s, "ok", run)).toBe(1);
    await expect(calls.execute(s, "ok", run)).rejects.toThrow("Duplicate");
    expect(calls.cancel(s, "ok").cancelled).toBe(false);
  });
  it("aborts execution immediately, drops late success and frees capacity", async () => {
    const calls = new McpUiSamplingCalls(),
      s = scope("one"),
      gate = Promise.withResolvers<number>();
    let signal!: AbortSignal;
    const first = calls.execute(s, "a", async (value) => {
      signal = value;
      return gate.promise;
    });
    const rejected = expect(first).rejects.toThrow("cancelled");
    calls.cancel(s, "a");
    gate.resolve(5);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(await calls.execute(s, "b", async () => 2)).toBe(2);
  });
  it("closes the original instance without touching its replacement", async () => {
    const calls = new McpUiSamplingCalls(),
      close = new AbortController();
    const old = { ...scope("old"), signal: close.signal };
    const first = calls.execute(old, "same", () => new Promise(() => {}));
    const rejected = expect(first).rejects.toThrow("cancelled");
    close.abort();
    expect(await calls.execute(scope("new"), "same", async () => 7)).toBe(7);
    await rejected;
    await expect(calls.execute(old, "later", async () => 8)).rejects.toThrow();
  });
  it("enforces instance/session/global caps and releases all timers on cancellation", async () => {
    vi.useFakeTimers();
    const calls = new McpUiSamplingCalls();
    const scopes = Array.from({ length: 8 }, (_, i) => scope(String(i), i < 4 ? "a" : "b"));
    const waiting = scopes.map((s) =>
      calls.execute(s, "x", () => new Promise(() => {})).catch(() => {}),
    );
    await expect(calls.execute(scopes[0]!, "y", async () => 0)).rejects.toThrow("busy");
    await expect(calls.execute(scope("session-full", "a"), "y", async () => 0)).rejects.toThrow(
      "busy",
    );
    await expect(calls.execute(scope("agent-full", "c"), "y", async () => 0)).rejects.toThrow(
      "busy",
    );
    scopes.forEach((s) => calls.cancel(s, "x"));
    await Promise.all(waiting);
    expect(vi.getTimerCount()).toBe(0);
    expect(await calls.execute(scope("next"), "y", async () => 4)).toBe(4);
  });
  it("has an absolute deadline even if the model never settles", async () => {
    vi.useFakeTimers();
    const calls = new McpUiSamplingCalls();
    let signal!: AbortSignal;
    const promise = calls.execute(scope("one"), "timeout", (s) => {
      signal = s;
      return new Promise(() => {});
    });
    const rejected = expect(promise).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds terminal history without forgetting cancelled IDs", async () => {
    const calls = new McpUiSamplingCalls(),
      s = scope("bounded");
    for (let i = 0; i < 4096; i++) calls.cancel(s, `op-${i}`);
    expect(() => calls.cancel(s, "overflow")).toThrow("limit");
    await expect(calls.execute(s, "op-0", async () => 1)).rejects.toThrow("Duplicate");
    await expect(calls.execute(s, "overflow", async () => 1)).rejects.toThrow("limit");
    expect(await calls.execute(scope("replacement"), "op-0", async () => 2)).toBe(2);
  });
});
