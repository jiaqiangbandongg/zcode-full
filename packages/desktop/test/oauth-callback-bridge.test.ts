import { describe, expect, it, vi } from "vitest";

describe("oauth callback bridge", () => {
  it("notifies main process after async callback resolves", async () => {
    const { createOAuthCallbackHandler } = await import("../src/preload/oauthCallbackBridge.js");
    const notifyHandled = vi.fn();
    const callback = vi.fn(async (_url: string) => {});
    const handler = createOAuthCallbackHandler(callback, notifyHandled);

    await handler({}, "zcode://oauth/callback?code=123");

    expect(callback).toHaveBeenCalledWith("zcode://oauth/callback?code=123");
    expect(notifyHandled).toHaveBeenCalledTimes(1);
  });

  it("still notifies main process when callback rejects", async () => {
    const { createOAuthCallbackHandler } = await import("../src/preload/oauthCallbackBridge.js");
    const notifyHandled = vi.fn();
    const callback = vi.fn(async () => {
      throw new Error("callback failed");
    });
    const handler = createOAuthCallbackHandler(callback, notifyHandled);

    await expect(handler({}, "zcode://oauth/callback?code=123")).resolves.toBeUndefined();
    expect(notifyHandled).toHaveBeenCalledTimes(1);
  });
});
