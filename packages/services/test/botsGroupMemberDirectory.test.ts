import { describe, expect, it, vi } from "vitest";
import { createGroupMemberDirectory } from "../src/bots/providers/groupMemberDirectory.js";

describe("group member directory", () => {
  it("follows pages, coalesces requests and isolates keys", async () => {
    const read = vi.fn(async (cursor?: string) =>
      cursor
        ? { items: [{ member_id: "ou_b", name: " Bob " }], has_more: false }
        : { items: [{ member_id: "ou_a", name: "Alice" }], has_more: true, page_token: "next" },
    );
    const directory = createGroupMemberDirectory();
    const [first, second] = await Promise.all([
      directory("bot:chat", read),
      directory("bot:chat", read),
    ]);
    expect(first).toEqual({ ou_a: "Alice", ou_b: "Bob" });
    expect(second).toEqual(first);
    expect(read).toHaveBeenCalledTimes(2);
    await directory("bot:chat", read);
    expect(read).toHaveBeenCalledTimes(2);
    await directory("bot:other", read);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("does not publish partial pages and backs off failures", async () => {
    let now = 0;
    const read = vi.fn(async (cursor?: string) => {
      if (cursor) throw new Error("denied");
      return { items: [{ member_id: "ou_a", name: "Alice" }], has_more: true, page_token: "next" };
    });
    const directory = createGroupMemberDirectory(() => now);
    await expect(directory("a", read)).rejects.toThrow("denied");
    await expect(directory("a", read)).rejects.toThrow("denied");
    expect(read).toHaveBeenCalledTimes(2);
    now = 30_001;
    await expect(directory("a", read)).rejects.toThrow("denied");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("rejects a broken pagination cycle", async () => {
    const directory = createGroupMemberDirectory();
    const read = async () => ({ items: [], has_more: true, page_token: "same" });
    await expect(directory("a", read)).rejects.toThrow("pagination");
  });
});
