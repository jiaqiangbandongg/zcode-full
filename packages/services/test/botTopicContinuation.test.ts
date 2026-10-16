import { describe, expect, it, vi } from "vitest";
import { createTopicContinuation } from "../src/bots/topicContinuation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function fixture() {
  const stopped = deferred<void>();
  const submit = vi.fn(async (_messages: string[]) => undefined);
  const stopAndWait = vi.fn(async (_runId: string) => stopped.promise);
  const readRunningRun = vi.fn(async (): Promise<string | undefined> => "old-run");
  const failed = vi.fn();
  const controller = createTopicContinuation({ readRunningRun, stopAndWait, submit, failed });
  return { controller, submit, stopped, stopAndWait, readRunningRun, failed };
}

describe("topic stop before continuation", () => {
  it("requests stop before attachments finish and waits for authoritative completion", async () => {
    const f = fixture();
    const material = deferred<string>();
    f.controller.receive("b", () => material.promise);
    await flush();
    expect(f.stopAndWait).toHaveBeenCalledWith("old-run");
    material.resolve("B");
    await flush();
    expect(f.submit).not.toHaveBeenCalled();
    f.stopped.resolve();
    await f.controller.settled();
    expect(f.submit).toHaveBeenCalledWith(["B"]);
  });

  it("combines all arrivals during stop in arrival order even when preparation completes backwards", async () => {
    const f = fixture();
    const b = deferred<string>();
    f.controller.receive("b", () => b.promise);
    f.controller.receive("c", async () => "C");
    await flush();
    f.stopped.resolve();
    await flush();
    expect(f.submit).not.toHaveBeenCalled();
    b.resolve("B");
    await f.controller.settled();
    expect(f.stopAndWait).toHaveBeenCalledTimes(1);
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(["B", "C"]);
  });

  it("cancel discards pending material and cannot submit after its late completion", async () => {
    const f = fixture();
    const b = deferred<string>();
    f.controller.receive("b", () => b.promise);
    await flush();
    f.controller.cancel();
    f.stopped.resolve();
    b.resolve("B");
    await f.controller.settled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("can accept a fresh message after cancelling a still-pending attachment", async () => {
    const f = fixture();
    f.readRunningRun.mockResolvedValue(undefined);
    const old = deferred<string>();
    f.controller.receive("old", () => old.promise);
    await flush();
    f.controller.cancel();
    f.controller.receive("fresh", async () => "fresh");
    await flush();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(["fresh"]);
    old.resolve("old");
    await f.controller.settled();
    expect(f.submit).toHaveBeenCalledTimes(1);
  });

  it("does not execute an incomplete batch when one required material fails", async () => {
    const f = fixture();
    f.controller.receive("b", async () => {
      throw new Error("download failed");
    });
    f.controller.receive("c", async () => "C");
    f.stopped.resolve();
    await f.controller.settled();
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.failed).toHaveBeenCalledWith(["b", "c"], expect.any(Error));
  });

  it("deduplicates delivery and admits idle input without stopping", async () => {
    const f = fixture();
    f.readRunningRun.mockResolvedValue(undefined);
    f.controller.receive("b", async () => "B");
    f.controller.receive("b", async () => "duplicate");
    await f.controller.settled();
    expect(f.stopAndWait).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledExactlyOnceWith(["B"]);
  });
  it("reports admission failure against the submitted batch, not later arrivals", async () => {
    const f = fixture();
    f.readRunningRun.mockResolvedValue(undefined);
    f.submit.mockRejectedValueOnce(new Error("admission failed"));
    f.controller.receive("b", async () => "B");
    await f.controller.settled();
    expect(f.failed).toHaveBeenCalledWith(["b"], expect.any(Error));
  });

  it("stops the new authoritative run when a message arrives during admission", async () => {
    const f = fixture();
    const accepted = deferred<void>();
    f.readRunningRun.mockResolvedValueOnce(undefined).mockResolvedValue("new-run");
    f.submit.mockImplementationOnce(async () => accepted.promise);
    f.controller.receive("b", async () => "B");
    await flush();
    f.controller.receive("c", async () => "C");
    accepted.resolve();
    await flush();
    expect(f.stopAndWait).toHaveBeenCalledWith("new-run");
    f.stopped.resolve();
    await f.controller.settled();
    expect(f.submit.mock.calls).toEqual([[["B"]], [["C"]]]);
  });
});
