import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadFileChip, type ReadSummary } from "@/ToolCallBlocks/renderers/read.js";

const summary: ReadSummary = {
  path: "/workspace/src/App.tsx",
  fileName: "App.tsx",
  filePath: "/workspace/src/",
  fileIconSrc: "/material-icons/typescript.svg",
  entryType: "file",
};

describe("ReadFileChip", () => {
  it.each([false, true])("uses the subtle filename color (clickable=%s)", (clickable) => {
    const html = renderToStaticMarkup(
      createElement(ReadFileChip, {
        summary,
        clickable,
        onClick: clickable ? () => undefined : undefined,
      }),
    );

    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toMatch(/(?:^|\s)text-foreground(?:\s|$)/u);
  });
});
