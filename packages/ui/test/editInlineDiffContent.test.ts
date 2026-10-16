import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  buildInlineDiffHighlightCode,
  EditInlineDiffContent,
  getInlineDiffHighlightLine,
} from "@/ToolCallBlocks/renderers/EditInlineDiffContent.js";
import type { PatchCodeViewerSource } from "@/lib/codeViewer.js";

// M5②.5 store 耦合剥离：EditInlineDiffContent 不再自取 store，
// theme / codePreviewSettings 改为 props 传入（见下方 render 调用），无需再 mock StoreProvider。
const TEST_CODE_PREVIEW_SETTINGS = {
  darkTheme: "github-dark",
  fontSizePx: 12,
  lightTheme: "github-light",
  showLineNumbers: true,
  wrapLongLines: false,
} as const;

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string>,
      ) =>
        id === "diff.preview.truncatedLines"
          ? `omitted ${values?.count ?? ""}`
          : id,
    },
  }),
}));

describe("EditInlineDiffContent", () => {
  it("builds async syntax highlight input without diff markers", () => {
    expect(getInlineDiffHighlightLine("+  const next = 1;")).toEqual({
      code: "  const next = 1;",
      marker: "+",
    });
    expect(getInlineDiffHighlightLine("-  const prev = 0;")).toEqual({
      code: "  const prev = 0;",
      marker: "-",
    });
    expect(getInlineDiffHighlightLine("  return next;")).toEqual({
      code: " return next;",
      marker: " ",
    });
    expect(
      buildInlineDiffHighlightCode([
        "+  const next = 1;",
        "-  const prev = 0;",
      ]),
    ).toBe("  const next = 1;\n  const prev = 0;");
  });

  it("renders lightweight hunk code without diff protocol markers", () => {
    const preview: PatchCodeViewerSource = {
      path: "/workspace/demo.ts",
      patch: [
        "--- a/demo.ts",
        "+++ b/demo.ts",
        "@@ -1,2 +1,2 @@",
        " const a = 1;",
        "-old",
        "+new",
      ].join("\n"),
      title: "demo.ts",
      type: "patch",
    };

    const html = renderToStaticMarkup(
      createElement(EditInlineDiffContent, {
        preview,
        theme: "zai-dark",
        codePreviewSettings: TEST_CODE_PREVIEW_SETTINGS,
      }),
    );

    expect(html).toContain("data-inline-diff-preview");
    expect(html).toContain("data-lightweight-diff-preview");
    expect(html).toContain('data-inline-diff-highlight-language="typescript"');
    expect(html).toContain('data-inline-diff-highlight-theme="github-dark"');
    expect(html).toContain('data-lightweight-diff-highlighted="false"');
    expect(html).not.toContain("diffs-container");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("old");
    expect(html).toContain("new");
    expect(html).not.toContain("-old");
    expect(html).not.toContain("+new");
    expect(html).not.toContain("--- a/demo.ts");
    expect(html).not.toContain("@@ -1");
  });
});
