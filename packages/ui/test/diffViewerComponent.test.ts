import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DiffViewer } from "../src/components/ui/diff-viewer.js";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    className,
    options,
    selectedLines,
  }: {
    className?: string;
    options?: Record<string, unknown>;
    selectedLines?: { start: number; end: number; side?: string } | null;
  }) =>
    createElement("diffs-container", {
      class: className,
      "data-diff-indicators": String(options?.diffIndicators),
      "data-disable-file-header": String(Boolean(options?.disableFileHeader)),
      "data-hunk-separators": String(options?.hunkSeparators),
      "data-line-diff-type": String(options?.lineDiffType),
      "data-unsafe-css": String(options?.unsafeCSS ?? ""),
      "data-selected-lines": selectedLines
        ? `${selectedLines.side}:${selectedLines.start}-${selectedLines.end}`
        : "",
      "data-testid": "multi-file-diff",
    }),
  PatchDiff: ({
    className,
    disableWorkerPool,
    options,
    selectedLines,
  }: {
    className?: string;
    disableWorkerPool?: boolean;
    options?: Record<string, unknown>;
    selectedLines?: { start: number; end: number; side?: string } | null;
  }) =>
    createElement("diffs-container", {
      class: className,
      "data-diff-indicators": String(options?.diffIndicators),
      "data-disable-file-header": String(Boolean(options?.disableFileHeader)),
      "data-disable-worker-pool": String(Boolean(disableWorkerPool)),
      "data-hunk-separators": String(options?.hunkSeparators),
      "data-line-diff-type": String(options?.lineDiffType),
      "data-unsafe-css": String(options?.unsafeCSS ?? ""),
      "data-selected-lines": selectedLines
        ? `${selectedLines.side}:${selectedLines.start}-${selectedLines.end}`
        : "",
      "data-testid": "patch-diff",
    }),
}));

describe("DiffViewer", () => {
  it("renders the @pierre/diffs patch container without legacy fallback markup", () => {
    const html = renderToStaticMarkup(
      createElement(DiffViewer, {
        patch: "diff --git a/demo.ts b/demo.ts\n@@ -1 +1 @@\n-foo\n+bar",
      }),
    );

    expect(html).toContain("<diffs-container");
    expect(html).toContain("data-diff-viewer");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("min-h-full");
    expect(html).toContain("--diffs-bg:var(--color-background)");
    expect(html).toContain('data-diff-indicators="bars"');
    expect(html).toContain('data-disable-file-header="true"');
    expect(html).toContain('data-hunk-separators="simple"');
    expect(html).toContain('data-line-diff-type="word-alt"');
    expect(html).toContain('data-unsafe-css=""');
    expect(html).not.toContain("whitespace-pre");
  });

  it("keeps worker pool rendering enabled by default", () => {
    const html = renderToStaticMarkup(
      createElement(DiffViewer, {
        patch: "diff --git a/demo.ts b/demo.ts\n@@ -1 +1 @@\n-foo\n+bar",
      }),
    );

    expect(html).not.toContain('data-disable-worker-pool="true"');
  });

  it("renders old and new files through MultiFileDiff", () => {
    const html = renderToStaticMarkup(
      createElement(DiffViewer, {
        oldFile: {
          name: "demo.ts",
          contents: "const value = 1;\n",
        },
        newFile: {
          name: "demo.ts",
          contents: "const value = 2;\n",
        },
      }),
    );

    expect(html).toContain("<diffs-container");
    expect(html).toContain("data-diff-viewer");
    expect(html).toContain('data-testid="multi-file-diff"');
    expect(html).toContain('data-diff-indicators="bars"');
    expect(html).toContain('data-disable-file-header="true"');
    expect(html).toContain('data-hunk-separators="line-info"');
    expect(html).toContain('data-line-diff-type="word-alt"');
    expect(html).toContain('data-unsafe-css=""');
    expect(html).toContain("min-h-full");
  });

  it("forwards the requested current-side line range to both diff renderers", () => {
    const selectedLines = { side: "additions" as const, start: 8, end: 10 };
    const patchHtml = renderToStaticMarkup(
      createElement(DiffViewer, {
        patch: "diff --git a/demo.ts b/demo.ts\n@@ -1 +1 @@\n-old\n+new",
        selectedLines,
      }),
    );
    const filesHtml = renderToStaticMarkup(
      createElement(DiffViewer, {
        oldFile: { name: "demo.ts", contents: "old\n" },
        newFile: { name: "demo.ts", contents: "new\n" },
        selectedLines,
      }),
    );

    expect(patchHtml).toContain('data-selected-lines="additions:8-10"');
    expect(filesHtml).toContain('data-selected-lines="additions:8-10"');
  });
});
