import { afterEach, describe, expect, it, vi } from "vitest";
import { installBrowserRestoreBootstrapProtocol } from "../src/main/browserView/browserRestoreBootstrapProtocol.js";

describe("browserRestoreBootstrapProtocol", () => {
  afterEach(() => vi.useRealTimers());

  it("注册一次延迟响应，给 main 留出无 document commit 的 pageState 恢复窗口", async () => {
    vi.useFakeTimers();
    let handler: (() => Promise<Response>) | undefined;
    const protocol = {
      handle: vi.fn((scheme: string, next: () => Promise<Response>) => {
        expect(scheme).toBe("zcode-browser-restore");
        handler = next;
      }),
    };

    installBrowserRestoreBootstrapProtocol(protocol, 1_000);
    installBrowserRestoreBootstrapProtocol(protocol, 1_000);
    expect(protocol.handle).toHaveBeenCalledOnce();

    const response = handler?.();
    expect(response).toBeDefined();
    let settled = false;
    void response?.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(response).resolves.toBeInstanceOf(Response);
  });
});
