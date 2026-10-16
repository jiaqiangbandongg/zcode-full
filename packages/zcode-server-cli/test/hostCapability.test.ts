import { describe, expect, it } from "vitest";
import { createHostCapabilityStore } from "../src/server-core/hostCapability.js";

describe("host capability store", () => {
  it("allows a single consumption within the TTL and rejects replay", () => {
    let now = 1_000;
    const store = createHostCapabilityStore({ ttlMs: 100, now: () => now });
    const issued = store.issue();
    expect(issued.expiresAt).toBe(1_100);
    expect(store.consume(issued.capability)).toBe(true);
    // 一次性 ticket：重放必须失败。
    expect(store.consume(issued.capability)).toBe(false);
    now += 1;
    expect(store.consume(issued.capability)).toBe(false);
  });

  it("rejects expired capabilities and purges them", () => {
    let now = 0;
    const store = createHostCapabilityStore({ ttlMs: 100, now: () => now });
    const issued = store.issue();
    now = 101;
    expect(store.consume(issued.capability)).toBe(false);
    expect(store.consume(undefined)).toBe(false);
  });
});
