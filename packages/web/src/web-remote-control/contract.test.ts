import { describe, expect, it, vi } from "vitest";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";

describe("mobile entry public boundary", () => {
  it("ignores an old list response after disposal", async () => {
    let finish!: (devices: []) => void;
    const devices = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        }),
    );
    const onView = vi.fn();
    const connect = vi.fn();
    const unsubscribe = vi.fn();
    const entry = new WebRemoteControlEntry({
      auth: {
        getZCodeJwtToken: () => "jwt",
        getActiveAccount: () => null,
        startLogin: vi.fn(),
        logout: vi.fn(async () => {}),
      },
      getHref: () => "https://relay.example.com/remote/v4",
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: vi.fn() },
      locale: "en-US",
      devices,
      subscribeVisible: () => unsubscribe,
      token: vi.fn(),
      connect,
      onView,
    });
    const start = entry.start();
    expect(onView).toHaveBeenCalledOnce();
    entry.dispose();
    finish([]);
    await start;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onView).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});
