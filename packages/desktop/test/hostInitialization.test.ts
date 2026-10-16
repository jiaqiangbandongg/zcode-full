import { describe, expect, it, vi } from "vitest";
import { initializeHostApiNetworkTransportOwner } from "../src/host/hostInitialization.js";

describe("Host initialization", () => {
  it("初始化失败时先释放尚未移交所有权的网络 transport，再保留原始错误", async () => {
    const initializationError = new Error("local services failed");
    const transport = {
      disposeAndWait: vi.fn(() => {
        throw new Error("transport dispose failed");
      }),
    };
    const log = vi.fn();

    await expect(
      initializeHostApiNetworkTransportOwner({
        establishOwner: () => {
          throw initializationError;
        },
        log,
        transport,
      }),
    ).rejects.toBe(initializationError);

    expect(transport.disposeAndWait).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      "host shutdown phase failed",
      expect.objectContaining({ phase: "unowned-host-api-network-transport-dispose" }),
    );
  });

  it("transport 释放未完成时在 deadline 后继续抛出原始初始化错误", async () => {
    vi.useFakeTimers();
    try {
      const initializationError = new Error("local services failed");
      const log = vi.fn();
      const initialization = initializeHostApiNetworkTransportOwner({
        disposeTimeoutMs: 100,
        establishOwner: () => {
          throw initializationError;
        },
        log,
        transport: {
          disposeAndWait: () => new Promise<void>(() => {}),
        },
      });
      const rejection = expect(initialization).rejects.toBe(initializationError);

      await vi.advanceTimersByTimeAsync(100);

      await rejection;
      expect(log).toHaveBeenCalledWith(
        "host shutdown phase timed out",
        expect.objectContaining({
          phase: "unowned-host-api-network-transport-dispose",
          timeoutMs: 100,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("初始化成功并移交所有权后不提前释放 transport", async () => {
    const transport = {
      disposeAndWait: vi.fn(async () => {}),
    };

    await expect(
      initializeHostApiNetworkTransportOwner({
        establishOwner: () => "ready",
        log: vi.fn(),
        transport,
      }),
    ).resolves.toBe("ready");

    expect(transport.disposeAndWait).not.toHaveBeenCalled();
  });
});
