import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("MermaidBlock config", () => {
  it("does not override DOMPurify options that affect Mermaid styling", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/components/ai-elements/mermaid-block.tsx"),
      "utf8",
    );

    expect(source).not.toContain("dompurifyConfig");
  });
});
