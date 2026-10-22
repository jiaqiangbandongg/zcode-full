import { describe, expect, it } from "vitest";
import { GrepErrorCode } from "../src/tools/grep.js";

describe("Grep contracts", () => {
  it("declares the stable grep cancellation error code", () => {
    expect(GrepErrorCode.CANCELLED).toBe("grep_cancelled");
  });
});
