import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("SelectTrigger styles", () => {
  it("does not clip its background to the padding box", () => {
    const source = readFileSync("packages/ui/src/components/ui/select.tsx", "utf8");

    expect(source).not.toContain("bg-clip-padding");
  });
});
