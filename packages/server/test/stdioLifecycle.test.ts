import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { registerStdioProcessLifecycle } from "../src/stdio-lifecycle.js";

class FakeStdin extends Readable {
  _read(): void {}
}

describe("stdio process lifecycle", () => {
  it("stdin 未关闭时不应因为空闲时间退出", () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const exit = vi.fn();

      registerStdioProcessLifecycle({
        stdin,
        signalSource: new EventEmitter(),
        log: vi.fn(),
        stopRpc: vi.fn().mockResolvedValue(undefined),
        dispose: vi.fn().mockResolvedValue(undefined),
        exit,
      });

      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(exit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stdin 关闭时应等待资源清理完成后再正常退出", async () => {
    const stdin = new FakeStdin();
    let finishDispose: (() => void) | undefined;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        }),
    );
    const exit = vi.fn();
    const log = vi.fn();

    registerStdioProcessLifecycle({
      stdin,
      signalSource: new EventEmitter(),
      log,
      stopRpc: vi.fn().mockResolvedValue(undefined),
      dispose,
      exit,
    });

    stdin.emit("end");

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();

    finishDispose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(log).toHaveBeenCalledWith("stdio shutdown completed", { exitCode: 0 });
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("cleanup 期间发生 stdin error 时只清理一次并升级退出码", async () => {
    const stdin = new FakeStdin();
    let finishDispose: (() => void) | undefined;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        }),
    );
    const exit = vi.fn();

    registerStdioProcessLifecycle({
      stdin,
      signalSource: new EventEmitter(),
      log: vi.fn(),
      stopRpc: vi.fn().mockResolvedValue(undefined),
      dispose,
      exit,
    });

    stdin.emit("end");
    stdin.emit("error", new Error("broken pipe"));
    stdin.emit("end");

    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(exit).not.toHaveBeenCalled();

    finishDispose?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("termination signal 应进入同一异步清理链路", async () => {
    const stdin = new FakeStdin();
    const signalSource = new EventEmitter();
    const order: string[] = [];
    const stopRpc = vi.fn(async () => {
      order.push("stop-rpc");
    });
    const dispose = vi.fn(async () => {
      order.push("dispose-services");
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });

    registerStdioProcessLifecycle({
      stdin,
      signalSource,
      log: vi.fn(),
      stopRpc,
      dispose,
      exit,
    });

    signalSource.emit("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stopRpc).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["stop-rpc", "dispose-services", "exit"]);
  });

  it("资源清理失败时应记录错误并以错误码退出", async () => {
    const stdin = new FakeStdin();
    const cleanupError = new Error("cleanup failed");
    const log = vi.fn();
    const exit = vi.fn();

    registerStdioProcessLifecycle({
      stdin,
      signalSource: new EventEmitter(),
      log,
      stopRpc: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockRejectedValue(cleanupError),
      exit,
    });

    stdin.emit("end");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log).toHaveBeenCalledWith("stdio shutdown cleanup failed", cleanupError);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("RPC stop 失败时仍应继续清理 services 并记录完成轨迹", async () => {
    const stdin = new FakeStdin();
    const stopError = new Error("stop failed");
    const log = vi.fn();
    const dispose = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    registerStdioProcessLifecycle({
      stdin,
      signalSource: new EventEmitter(),
      log,
      stopRpc: vi.fn().mockRejectedValue(stopError),
      dispose,
      exit,
    });

    stdin.emit("end");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(log).toHaveBeenCalledWith("stdio shutdown RPC stop failed", stopError);
    expect(log).toHaveBeenCalledWith("stdio shutdown completed", { exitCode: 1 });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("RPC stop 永久 pending 时应在阶段 deadline 后继续清理 services", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const dispose = vi.fn().mockResolvedValue(undefined);
      const exit = vi.fn();
      const log = vi.fn();

      registerStdioProcessLifecycle({
        stdin,
        signalSource: new EventEmitter(),
        log,
        stopRpc: () => new Promise<void>(() => {}),
        dispose,
        exit,
      });

      stdin.emit("end");
      await vi.advanceTimersByTimeAsync(999);
      expect(exit).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(log).toHaveBeenCalledWith("stdio shutdown timed out", {
        phase: "rpc-stop",
        timeoutMs: 1_000,
      });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("stdio shutdown completed", { exitCode: 1 });
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("service dispose 永久 pending 时应记录阶段并在 deadline 后强制退出", async () => {
    vi.useFakeTimers();
    try {
      const stdin = new FakeStdin();
      const dispose = vi.fn(() => new Promise<void>(() => {}));
      const exit = vi.fn();
      const log = vi.fn();

      registerStdioProcessLifecycle({
        stdin,
        signalSource: new EventEmitter(),
        log,
        stopRpc: vi.fn().mockResolvedValue(undefined),
        dispose,
        exit,
        shutdownTimeoutMs: 1_000,
      });

      stdin.emit("end");
      await vi.advanceTimersByTimeAsync(0);
      expect(dispose).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(log).toHaveBeenCalledWith("stdio shutdown timed out", {
        phase: "service-dispose",
        timeoutMs: 1_000,
      });
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
