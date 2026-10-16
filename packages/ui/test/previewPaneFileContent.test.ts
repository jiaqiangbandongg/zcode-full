import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { PreviewPaneContent } from "@/previewPaneContent.js";

vi.mock("@pierre/diffs/react", () => ({
  File: ({
    className,
    file,
    lineAnnotations,
    renderAnnotation,
    selectedLines,
  }: {
    className?: string;
    file?: { contents?: string };
    lineAnnotations?: unknown[];
    renderAnnotation?: (annotation: unknown) => unknown;
    selectedLines?: { start: number; end: number } | null;
  }) =>
    createElement(
      "diffs-container",
      {
        class: className,
        "data-code": file?.contents,
        "data-selected-lines": selectedLines
          ? `${selectedLines.start}-${selectedLines.end}`
          : "",
      },
      lineAnnotations?.map((annotation, index) =>
        createElement("div", { key: index }, renderAnnotation?.(annotation)),
      ),
    ),
  MultiFileDiff: () => createElement("diffs-multi-file"),
  PatchDiff: () => createElement("diffs-patch"),
}));

function renderFileContent(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(PreviewPaneContent, {
        source: {
          type: "file",
          title: "response.json",
          path: "/workspace/response.json",
        },
        filePreview: {
          path: "/workspace/response.json",
          content: "line 75\n我是中文\nline 77",
          offset: 0,
          bytesRead: 28,
          totalBytes: 28,
          truncated: false,
          isBinary: false,
        },
        fileTooLarge: false,
        loadingInitial: false,
        loadingImagePreview: false,
        imagePreview: null,
        loadingPdfPreview: false,
        pdfViewerSource: null,
        pdfViewerLabels: {
          loading: "Loading",
          loadError: "Load error",
          noData: "No data",
          previousPage: "Previous",
          nextPage: "Next",
          pageInput: "Page",
          zoomIn: "Zoom in",
          zoomOut: "Zoom out",
        },
        loadingOfficePreview: false,
        officePreview: null,
        officePreviewKind: null,
        loadingPptxPreview: false,
        pptxPreviewData: null,
        pptxReferenceSource: null,
        pptxViewerLabels: {
          loading: "Loading",
          loadError: "Load error",
          noSlides: "No slides",
          previousPage: "Previous",
          nextPage: "Next",
          pageInput: "Page",
          zoomIn: "Zoom in",
          zoomOut: "Zoom out",
          thumbnails: "Thumbnails",
          thumbnail: (pageNumber) => `Slide ${pageNumber}`,
          selectElement: "Select element",
          exitElementSelection: "Exit selection",
          aiEdit: "AI Edit",
          commentPlaceholder: "Add a comment",
          cancelAiEdit: "Cancel",
          addToConversation: "Add to conversation",
        },
        error: null,
        codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
        codeTheme: "github-light",
        resolvedTheme: "light",
        theme: "light",
        workspacePath: "/workspace",
        markdownViewMode: "code",
        svgViewMode: "code",
        wrapLongLines: false,
        codeComments: [],
        codeCommentLabels: {
          addComment: "Add comment",
          addCommentTooltip: "Add comment",
          commentPlaceholder: "Comment",
          submitComment: "Submit",
          cancelComment: "Cancel",
          deleteComment: "Delete",
          commentLine: "Line {line}",
          commentRange: "Lines {startLine}-{endLine}",
        },
        ...overrides,
      }),
    ),
  );
}

describe("PreviewPaneContent text files", () => {
  it("renders UTF-8 text as one continuous document", () => {
    const html = renderFileContent();

    expect(html.match(/<diffs-container/g)).toHaveLength(1);
    expect(html).toContain("line 75");
    expect(html).toContain("我是中文");
    expect(html).toContain("line 77");
    expect(html).toContain("overflow-auto");
    expect(html).not.toContain("data-preview-file-scroll-container");
    expect(html).not.toContain("data-scroll-mode");
  });

  it("shows a localized limit message instead of truncated text", () => {
    const html = renderFileContent({
      filePreview: null,
      fileTooLarge: true,
    });

    expect(html).toContain(
      "This file exceeds the 256 KB preview limit. Open it in another editor to view the full contents.",
    );
    expect(html).toContain("text-foreground-subtle");
    expect(html).not.toContain("<diffs-container");
  });

  it("keeps PPTX preview available when element-reference identity is unavailable", () => {
    const html = renderFileContent({
      source: {
        type: "pptx",
        title: "deck.pptx",
        path: "/workspace/deck.pptx",
      },
      filePreview: null,
      pptxPreviewData: new ArrayBuffer(1),
      pptxReferenceSource: null,
    });

    expect(html).toContain("Loading");
  });

  it("renders a valid code-review range as a read-only inline comment and source code", () => {
    const html = renderFileContent({
      source: {
        type: "code-review",
        title: "README.md",
        path: "/workspace/README.md",
        review: {
          requestId: "review-1",
          title: "Heading problem",
          body: "Use a more specific heading.",
          priority: 1,
          startLine: 2,
          endLine: 3,
        },
      },
      filePreview: {
        path: "/workspace/README.md",
        content: "# Heading\ntext\nmore text",
        offset: 0,
        bytesRead: 24,
        totalBytes: 24,
        truncated: false,
        isBinary: false,
      },
      markdownViewMode: "preview",
    });

    expect(html).toContain("<diffs-container");
    expect(html).toContain("Use a more specific heading.");
    expect(html).toContain("Lines 2-3");
    expect(html).toContain('data-selected-lines="2-3"');
    expect(html).not.toContain("Delete");
  });

  it("renders a code review without line numbers at the top without fabricating a range", () => {
    const html = renderFileContent({
      source: {
        type: "code-review",
        title: "response.json",
        path: "/workspace/response.json",
        review: {
          requestId: "review-no-range",
          title: "File review",
          body: "Review the whole file.",
        },
      },
    });

    expect(html).toContain("Review the whole file.");
    expect(html).not.toContain("Line 1");
    expect(html).toContain('data-selected-lines=""');
  });

  it("keeps an out-of-range review visible at the top and reports the invalid target", () => {
    const html = renderFileContent({
      source: {
        type: "code-review",
        title: "response.json",
        path: "/workspace/response.json",
        review: {
          requestId: "review-out-of-range",
          title: "Missing line",
          body: "This target moved.",
          startLine: 99,
          endLine: 100,
        },
      },
    });

    expect(html).toContain("This target moved.");
    expect(html).toContain("The target line does not exist");
    expect(html).toContain('data-selected-lines=""');
  });
});
