import { describe, expect, it } from "vitest";

import { sharedContextImportStateSchema } from "../src/zcode-protocol-v4/snapshot.js";

describe("shared context import state", () => {
  it("accepts the persisted handover lifecycle", () => {
    expect(
      sharedContextImportStateSchema.parse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status: "reserved",
      }),
    ).toEqual({
      contextId: "context-1",
      title: "分享标题",
      shareUrl: "https://zcode.z.ai/cn/share/code-1",
      status: "reserved",
    });
  });

  it.each(["pending", "attached", "discarded"] as const)("accepts %s status", (status) => {
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status,
      }).success,
    ).toBe(true);
  });

  it("rejects non-canonical or unknown fields", () => {
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://share.example.com/share/code-1",
        status: "pending",
      }).success,
    ).toBe(false);
    expect(
      sharedContextImportStateSchema.safeParse({
        contextId: "context-1",
        title: "分享标题",
        shareUrl: "https://zcode.z.ai/cn/share/code-1",
        status: "pending",
        markdown: "must-not-cross-projection",
      }).success,
    ).toBe(false);
  });
});
