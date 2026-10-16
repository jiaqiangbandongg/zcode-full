import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ExecuteToolCallBlock typography", () => {
  it("uses sans typography for the collapsed command summary only", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/ToolCallBlocks/renderers/execute.tsx"),
      "utf8",
    );

    expect(source).toContain('<code className="truncate font-sans">');
    expect(source).not.toContain('<code className="truncate font-mono">');
    expect(source).toContain(
      '<div className="flex items-start gap-2 font-sans text-ui-base text-foreground">',
    );
  });
});
