import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readRenderer(name: string): string {
  return readFileSync(
    `packages/ui/src/ToolCallBlocks/renderers/${name}.tsx`,
    "utf8",
  );
}

describe("tool command typography", () => {
  it("uses the UI sans font for Execute command text while preserving mono output", () => {
    const source = readRenderer("execute");

    expect(source).toContain(
      '<code className="truncate font-sans">{secondaryText}</code>',
    );
    expect(source).toContain(
      'className="flex items-start gap-2 font-sans text-ui-base text-foreground"',
    );
    // 输出已抽到独立组件，字体断言跟随组件归属，不再绑定旧容器高度。
    expect(readRenderer("ExecuteOutput")).toContain("font-mono text-ui-base");
  });

  it("uses the UI sans font for readonly Shell commands in Explore summaries", () => {
    const source = readRenderer("explore");

    expect(source).toContain(
      '<code className="min-w-0 truncate font-sans">{secondaryText}</code>',
    );
  });
});
