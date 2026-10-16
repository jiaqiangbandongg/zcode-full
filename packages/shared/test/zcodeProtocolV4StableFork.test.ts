import { describe, expect, it } from "vitest";
import { stableForkTargetSchema } from "../src/zcode-protocol-v4/index.js";

describe("ZCode Protocol v4 stable fork target", () => {
  it("固定 product/transcript turn 与有序 logical message boundary", () => {
    expect(
      stableForkTargetSchema.parse({
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: ["user-1", "assistant-tool", "tool-1", "assistant-final"],
        boundaryMessageId: "assistant-final",
      }),
    ).toEqual({
      productTurnId: "product-1",
      transcriptTurnId: "runtime-1",
      orderedMessageIds: ["user-1", "assistant-tool", "tool-1", "assistant-final"],
      boundaryMessageId: "assistant-final",
    });
    expect(() =>
      stableForkTargetSchema.parse({
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: [],
        boundaryMessageId: "assistant-final",
      }),
    ).toThrow();
    expect(() =>
      stableForkTargetSchema.parse({
        productTurnId: "product-1",
        transcriptTurnId: "runtime-1",
        orderedMessageIds: ["user-1", "assistant-other"],
        boundaryMessageId: "assistant-final",
      }),
    ).toThrow("boundaryMessageId");
  });
});
