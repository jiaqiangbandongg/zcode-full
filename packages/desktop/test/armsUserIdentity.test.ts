import { describe, expect, it, vi } from "vitest";
import { createArmsUserIdentitySync } from "../src/main/armsUserIdentity.js";

const DEVICE_MID = "device-mid-abc";

describe("armsUserIdentity", () => {
  it("始终以 deviceMid 作为 user.name 写入 ARMS", () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      deviceMid: DEVICE_MID,
      setUser,
    });
    sync.refresh();
    expect(setUser).toHaveBeenCalledTimes(1);
    expect(setUser).toHaveBeenCalledWith({ name: DEVICE_MID });
  });

  it("去重：同 deviceMid 不重复 setUser", () => {
    const setUser = vi.fn();
    const sync = createArmsUserIdentitySync({
      deviceMid: DEVICE_MID,
      setUser,
    });
    sync.refresh();
    sync.refresh();
    sync.refresh();
    expect(setUser).toHaveBeenCalledTimes(1);
  });
});
