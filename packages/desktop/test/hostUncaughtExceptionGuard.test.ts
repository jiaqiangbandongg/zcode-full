import { describe, expect, it, vi } from "vitest";
import {
  createHostUncaughtExceptionHandler,
  isRecoverableHostAllocationError,
} from "../src/host/hostUncaughtExceptionGuard.js";

describe("host uncaught exception guard", () => {
  it("识别 TLS 证书投影期间的内存分配失败", () => {
    const error = new RangeError("Failed to allocate memory");
    error.stack = [
      "RangeError: Failed to allocate memory",
      "    at TLSSocket.getPeerCertificate (node:_tls_wrap:1115:35)",
    ].join("\n");

    expect(isRecoverableHostAllocationError(error)).toBe(true);
  });

  it("仅恢复明确的内存分配 RangeError", () => {
    expect(isRecoverableHostAllocationError(new Error("Failed to allocate memory"))).toBe(false);
    expect(isRecoverableHostAllocationError(new RangeError("Invalid array length"))).toBe(false);
  });

  it("内存分配异常只上报恢复事件，不进入 fatal 退出链路", () => {
    const onRecovered = vi.fn();
    const onFatal = vi.fn();
    const handler = createHostUncaughtExceptionHandler({ onRecovered, onFatal });
    const error = new RangeError("Failed to allocate memory");

    handler(error, "uncaughtException");

    expect(onRecovered).toHaveBeenCalledWith(error, "uncaughtException");
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("其他未捕获异常仍进入 fatal 退出链路", () => {
    const onRecovered = vi.fn();
    const onFatal = vi.fn();
    const handler = createHostUncaughtExceptionHandler({ onRecovered, onFatal });
    const error = new Error("unexpected");

    handler(error, "unhandledRejection");

    expect(onRecovered).not.toHaveBeenCalled();
    expect(onFatal).toHaveBeenCalledWith(error, "unhandledRejection");
  });

  it("恢复日志自身失败时不重新抛出进程级异常", () => {
    const handler = createHostUncaughtExceptionHandler({
      onRecovered: () => {
        throw new Error("logger unavailable");
      },
      onFatal: vi.fn(),
    });

    expect(() =>
      handler(new RangeError("Failed to allocate memory"), "uncaughtException"),
    ).not.toThrow();
  });
});
