import { describe, expect, it, vi } from "vitest";
import { createBotTopicAdmission } from "#src/zcode-agent/botTopicAdmission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Bot topic admission ordering", () => {
  it("invalidates waiting sends and confirms cancellation after the active send settles", async () => {
    const gate = createBotTopicAdmission();
    const entered = deferred();
    const release = deferred();
    const events: string[] = [];
    const version = gate.capture("task");
    const first = gate.run("task", version, async () => {
      entered.resolve();
      await release.promise;
      events.push("accepted");
    });
    await entered.promise;
    const staleSend = vi.fn(async () => {});
    const queued = gate.run("task", version, staleSend);
    const rejected = expect(queued).rejects.toThrow("cancelled");
    const cancelled = gate.invalidate("task").then(() => {
      events.push("cancelled");
    });
    release.resolve();
    await Promise.all([first, rejected, cancelled]);
    expect(staleSend).not.toHaveBeenCalled();
    expect(events).toEqual(["accepted", "cancelled"]);
    await gate.run("task", gate.capture("task"), async () => {
      events.push("new input");
    });
    expect(events.at(-1)).toBe("new input");
  });

  it("releases the barrier after failed dispatch and keeps command id deduplication in CLI", async () => {
    const gate = createBotTopicAdmission();
    await expect(
      gate.run("task", 0, async () => {
        throw new Error("transport failed");
      }),
    ).rejects.toThrow("transport failed");
    await gate.invalidate("task");
    const command = { commandId: "same-command" };
    const send = vi.fn(async () => command);
    expect(await gate.run("task", 1, send)).toBe(command);
    expect(await gate.run("task", 1, send)).toBe(command);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not invalidate another remote session or task", async () => {
    const gate = createBotTopicAdmission();
    const keys = ["task/workspace/remote-a", "task/workspace/remote-b", "other/workspace/remote-a"];
    const staleVersion = gate.capture(keys[0]);
    await gate.invalidate(keys[0]);
    const staleSend = vi.fn(async () => {});
    await expect(gate.run(keys[0], staleVersion, staleSend)).rejects.toThrow("cancelled");
    expect(staleSend).not.toHaveBeenCalled();
    for (const key of keys.slice(1)) {
      expect(await gate.run(key, 0, async () => key)).toBe(key);
    }
  });
});
