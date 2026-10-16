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

  it("deviceMid 变更时重新写入", () => {
    const setUser = vi.fn();
    const sync1 = createArmsUserIdentitySync({
      deviceMid: "mid-001",
      setUser,
    });
    sync1.refresh();
    expect(setUser).toHaveBeenCalledTimes(1);

    const sync2 = createArmsUserIdentitySync({
      deviceMid: "mid-002",
      setUser,
    });
    sync2.refresh();
    expect(setUser).toHaveBeenCalledTimes(2);
    expect(setUser).toHaveBeenLastCalledWith({ name: "mid-002" });
  });
});
