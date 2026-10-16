import { describe, expect, it } from "vitest";
import { normalizeSingleFilePatch } from "@/ToolCallBlocks/fileSummaryTypes.js";

describe("normalizeSingleFilePatch", () => {
  it("adds file headers to hunk-only unified diff fragments", () => {
    expect(normalizeSingleFilePatch("@@ -1 +1 @@\n-old\n+new", "demo.ts")).toBe(
      "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-old\n+new",
    );
  });

  it("does not wrap apply_patch payloads as fake unified diffs", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: demo.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    expect(normalizeSingleFilePatch(patch, "demo.ts")).toBe(patch);
  });
});
