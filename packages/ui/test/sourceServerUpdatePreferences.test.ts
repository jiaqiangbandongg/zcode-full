import { describe, expect, it } from "vitest";
import {
  createSourceServerUpdatePreferences,
  sourceServerUpdateKey,
} from "@/lib/sourceServerUpdatePreferences.js";

describe("设备更新本地偏好", () => {
  it("重启保留设备版本去重但清除稍后，新版本和其他设备不受影响", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const key = sourceServerUpdateKey("device-a", "4.0");
    const first = createSourceServerUpdatePreferences(storage);
    first.markSeen(key);
    first.defer(key);
    expect(first.isDeferred(key)).toBe(true);
    const restarted = createSourceServerUpdatePreferences(storage);
    expect(restarted.hasSeen(key)).toBe(true);
    expect(restarted.isDeferred(key)).toBe(false);
    expect(restarted.hasSeen(sourceServerUpdateKey("device-a", "4.1"))).toBe(false);
    expect(restarted.hasSeen(sourceServerUpdateKey("device-b", "4.0"))).toBe(false);
  });
});
