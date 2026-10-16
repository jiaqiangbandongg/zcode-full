import { describe, expect, it } from "vitest";
import { resolveChannelMentionNames } from "../src/bots/channelMentionResolver.js";
import { channelReplyResultSchema } from "@zcode/shared";

const resolve = (names: string[], members: Record<string, string> | undefined) =>
  resolveChannelMentionNames(
    names.map((name) => ({ type: "mentionName", name })),
    [],
    members,
    "scope",
    "feishu",
  );

describe("channel recipient name matching", () => {
  it("sends two unique partial Chinese names as their full identities", () => {
    expect(resolve(["小明", "小红"], { ou_a: "王小明", ou_b: "李小红" })).toMatchObject({
      parts: [
        { name: "王小明", targetId: "ou_a" },
        { name: "李小红", targetId: "ou_b" },
      ],
    });
  });
  it("prefers the unique exact name among containing names", () => {
    expect(resolve([" Alex "], { ou_a: "Alex", ou_b: "Alex Smith" })).toMatchObject({
      parts: [{ targetId: "ou_a" }],
    });
  });
  it("preserves a multiword name and normalizes Unicode and case", () => {
    expect(
      resolve([" ＡＬＥＸ Smith "], { ou_a: "Alex Smith", ou_b: "Alex", ou_c: "Smith" }),
    ).toMatchObject({ parts: [{ targetId: "ou_a" }] });
  });
  it("reports every unresolved recipient after the first failure without returning partial delivery", () => {
    const result = resolve(["Missing", "Alex", "Nobody", "Unique"], {
      ou_a: "Alex Smith",
      ou_b: "Alex Jones",
      ou_c: "Unique",
    });
    expect(result).toMatchObject({
      status: "needs_clarification",
      unresolved: [
        { name: "Missing", reason: "not_found" },
        {
          name: "Alex",
          reason: "ambiguous",
          candidates: [{ name: "Alex Smith" }, { name: "Alex Jones" }],
        },
        { name: "Nobody", reason: "not_found" },
      ],
    });
    expect(result).not.toHaveProperty("parts");
    expect(channelReplyResultSchema.safeParse(result).success).toBe(true);
  });
  it("does not choose between duplicate exact names", () => {
    expect(resolve(["Alex"], { ou_a: "Alex", ou_b: "Alex", ou_c: "Alex Smith" })).toMatchObject({
      status: "needs_clarification",
    });
  });
  it("reports lookup failure for all requested names", () => {
    expect(resolve(["Alex", "Robin"], undefined)).toMatchObject({
      unresolved: [
        { name: "Alex", reason: "unavailable" },
        { name: "Robin", reason: "unavailable" },
      ],
    });
  });
});
