import { describe, expect, it } from "vitest";
import { withPluginStorageLock } from "../src/lib/plugin-storage-lock.js";

describe("withPluginStorageLock", () => {
  it("serializes operations on the same storage root", async () => {
    const order: string[] = [];
    const slow = withPluginStorageLock("/root-a", async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    const fast = withPluginStorageLock("/root-a", async () => {
      order.push("b-start");
      order.push("b-end");
      return "b";
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("runs different roots concurrently", async () => {
    const order: string[] = [];
    await Promise.all([
      withPluginStorageLock("/root-a", async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 30));
        order.push("a-end");
      }),
      withPluginStorageLock("/root-b", async () => {
        order.push("b");
      }),
    ]);
    expect(order[0]).toBe("a-start");
    expect(order).toContain("b");
    // b should not wait for a-end
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a-end"));
  });

  it("releases the lock even if the operation throws", async () => {
    await expect(
      withPluginStorageLock("/root-c", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // next op still runs
    await expect(
      withPluginStorageLock("/root-c", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
