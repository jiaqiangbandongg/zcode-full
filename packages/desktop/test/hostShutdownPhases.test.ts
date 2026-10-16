import { describe, expect, it, vi } from "vitest";
import { runHostShutdownPhases } from "../src/host/hostShutdownPhases.js";

describe("host shutdown phases", () => {
  it("service 清理失败后仍继续关闭远程连接", async () => {
    const order: string[] = [];
    const log = vi.fn();

    const result = await runHostShutdownPhases(
      [
        {
          name: "service-dispose",
          run: async () => {
            order.push("service");
            throw new Error("service failed");
          },
        },
        {
          name: "remote-connection-dispose",
          run: async () => {
            order.push("remote");
          },
        },
      ],
      { phaseTimeoutMs: 1_000, log },
    );

    expect(order).toEqual(["service", "remote"]);
    expect(result.exitCode).toBe(1);
    expect(result.failedPhases).toEqual(["service-dispose"]);
    expect(log).toHaveBeenCalledWith(
      "host shutdown phase failed",
      expect.objectContaining({ phase: "service-dispose" }),
    );
  });

  it("单个阶段 pending 时在 deadline 后继续下一阶段", async () => {
    vi.useFakeTimers();
    try {
      const nextPhase = vi.fn().mockResolvedValue(undefined);
      const shutdown = runHostShutdownPhases(
        [
          { name: "service-dispose", run: () => new Promise<void>(() => {}) },
          { name: "remote-connection-dispose", run: nextPhase },
        ],
        { phaseTimeoutMs: 500, log: vi.fn() },
      );

      await vi.advanceTimersByTimeAsync(500);
      await expect(shutdown).resolves.toMatchObject({
        exitCode: 1,
        timedOutPhases: ["service-dispose"],
      });
      expect(nextPhase).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
