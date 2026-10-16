import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";
import { PatchFallbackContent } from "@/previewPanePatchFallbackContent.js";

vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: ({
    className,
    disableWorkerPool,
  }: {
    className?: string;
    disableWorkerPool?: boolean;
  }) =>
    createElement("div", {
      className,
      "data-disable-worker-pool": String(Boolean(disableWorkerPool)),
      "data-testid": "multi-file-diff",
    }),
  PatchDiff: ({
    className,
    disableWorkerPool,
  }: {
    className?: string;
    disableWorkerPool?: boolean;
  }) =>
    createElement("div", {
      className,
      "data-disable-worker-pool": String(Boolean(disableWorkerPool)),
      "data-testid": "patch-diff",
    }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

const codePreviewSettings = {
  diffSeparatorStyle: "compact",
  darkTheme: "github-dark",
  fontSizePx: 12,
  lightTheme: "github-light",
  showLineNumbers: true,
  wrapLongLines: false,
} as const;

function createGitChangeCardElement(diffState: Record<string, unknown>) {
  // Bugfix: GitPaneChangeCard 现在由 GitPane 注入右键菜单文案和文件动作；
  // 裸渲染单测也必须补齐这些依赖，否则会在 diff 内容断言前崩溃。
  return createElement(GitPaneChangeCard, {
    change: {
      added: 1,
      deleted: false,
      modified: true,
      removed: 1,
      status: "modified",
      path: "/workspace/demo.ts",
      workspaceRelativePath: "demo.ts",
    },
    contextMenuLabels: {
      copyPath: "Copy path",
      revealInFileManager: "Open in file manager",
      revealInFileTree: "Reveal in file tree",
    },
    diffState,
    isDiffLoading: false,
    isExpanded: true,
    canRevealInFileManager: true,
    codePreviewSettings,
    resolvedTheme: "light",
    onCopyPath: vi.fn(),
    onOpenChange: vi.fn(),
    onRevealInFileManager: vi.fn(),
    onRevealInFileTree: vi.fn(),
  });
}

describe("content horizontal scrolling", () => {
  it("keeps patch preview pane content scrollable in both axes", () => {
    const html = renderToStaticMarkup(
      createElement(PatchFallbackContent, {
        patch: "diff --git a/demo.ts b/demo.ts\n@@ -1 +1 @@\n-foo\n+bar",
        codePreviewSettings,
        resolvedTheme: "light",
      }),
    );

    expect(html).toContain("data-diff-viewer");
    expect(html).toContain("overflow-auto");
    expect(html).not.toContain("overflow-hidden");
  });

  it("does not opt patch preview pane rendering out of the diff worker pool", () => {
    const html = renderToStaticMarkup(
      createElement(PatchFallbackContent, {
        patch: "diff --git a/demo.ts b/demo.ts\n@@ -1 +1 @@\n-foo\n+bar",
        codePreviewSettings,
        resolvedTheme: "light",
      }),
    );

    expect(html).toContain('data-disable-worker-pool="false"');
  });

  it("falls back to plain text when previewing a multi-file patch", () => {
    const html = renderToStaticMarkup(
      createElement(PatchFallbackContent, {
        patch: [
          "diff --git a/demo.ts b/demo.ts",
          "--- a/demo.ts",
          "+++ b/demo.ts",
          "@@ -1 +1 @@",
          "-foo",
          "+bar",
          "diff --git a/other.ts b/other.ts",
          "--- a/other.ts",
          "+++ b/other.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
        codePreviewSettings,
        resolvedTheme: "light",
      }),
    );

    expect(html).toContain("data-patch-plain-text-preview");
    expect(html).toContain("data-lightweight-diff-preview");
    expect(html).toContain("overflow-auto");
    expect(html).toContain("bar");
    expect(html).toContain("new");
    expect(html).not.toContain("+bar");
    expect(html).not.toContain("+new");
    expect(html).not.toContain('data-testid="patch-diff"');
  });

  it("keeps syntax metadata on created-file patch fallbacks", () => {
    const html = renderToStaticMarkup(
      createElement(PatchFallbackContent, {
        patch: [
          "--- /dev/null",
          "+++ b/pomodoro.html",
          "@@ -0,0 +1,3 @@",
          "+<!DOCTYPE html>",
          "+<html>",
          "+</html>",
        ].join("\n"),
        codePreviewSettings,
        resolvedTheme: "light",
        sourcePath: "/workspace/pomodoro.html",
      }),
    );

    expect(html).toContain("data-patch-plain-text-preview");
    expect(html).toContain('data-lightweight-diff-highlight-language="html"');
    expect(html).toContain('data-lightweight-diff-highlight-theme="github-light"');
    expect(html).toContain('data-lightweight-diff-highlighted="false"');
    expect(html).toContain("&lt;!DOCTYPE html&gt;");
    expect(html).not.toContain("+&lt;!DOCTYPE html&gt;");
  });

  it("allows expanded Git change card diffs to scroll horizontally", () => {
    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: null,
        beforeContent: "foo\n",
        afterContent: "bar\n",
        path: "/workspace/demo.ts",
        summary: null,
      }),
    );

    expect(html).toContain("overflow-x-auto overflow-y-hidden");
  });

  it("keeps small Git change card diffs on the rich before/after renderer", () => {
    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1 @@\n-foo\n+bar",
        beforeContent: "foo\n",
        afterContent: "bar\n",
        path: "/workspace/demo.ts",
        summary: null,
      }),
    );

    expect(html).toContain('data-testid="multi-file-diff"');
    expect(html).not.toContain('data-testid="patch-diff"');
    expect(html).not.toContain("data-git-plain-text-diff-preview");
  });

  it("renders the Git patch when a complete before/after pair is unavailable", () => {
    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: "--- a/demo.ts\n+++ b/demo.ts\n@@ -1 +1,2 @@\n foo\n+bar",
        beforeContent: null,
        afterContent: null,
        path: "/workspace/demo.ts",
        summary: null,
      }),
    );

    expect(html).toContain('data-testid="patch-diff"');
    expect(html).not.toContain('data-testid="multi-file-diff"');
    expect(html).not.toContain("git.diff.unavailableTitle");
  });

  it("keeps last-turn new-file snapshots on the rich renderer when no patch exists", () => {
    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: null,
        beforeContent: null,
        afterContent: "export const created = true;\n",
        path: "/workspace/demo.ts",
        summary: null,
      }),
    );

    expect(html).toContain('data-testid="multi-file-diff"');
    expect(html).not.toContain('data-testid="patch-diff"');
  });

  it("renders large Git change card diffs from patch input", () => {
    const beforeContent = Array.from(
      { length: 1_300 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    const afterContent = beforeContent.replace("line-10", "line-10 changed");

    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: [
          "--- a/demo.ts",
          "+++ b/demo.ts",
          "@@ -8,5 +8,5 @@",
          " line-8",
          " line-9",
          "-line-10",
          "+line-10 changed",
          " line-11",
        ].join("\n"),
        beforeContent,
        afterContent,
        path: "/workspace/demo.ts",
        summary: null,
      }),
    );

    expect(html).toContain('data-testid="patch-diff"');
    expect(html).not.toContain('data-testid="multi-file-diff"');
  });

  it("renders expensive Git patch fallbacks as lightweight text", () => {
    const afterLines = Array.from(
      { length: 1_300 },
      (_, index) => `+  "line-${index + 1}": true,`,
    );

    const html = renderToStaticMarkup(
      createGitChangeCardElement({
        availability: "patch",
        patch: [
          "--- /dev/null",
          "+++ b/demo.json",
          "@@ -0,0 +1,1300 @@",
          ...afterLines,
        ].join("\n"),
        beforeContent: "",
        afterContent: afterLines.map((line) => line.slice(1)).join("\n"),
        path: "/workspace/demo.json",
        summary: null,
      }),
    );

    expect(html).toContain("data-git-plain-text-diff-preview");
    expect(html).toContain("data-lightweight-diff-preview");
    expect(html).toContain("&quot;line-1&quot;: true,");
    expect(html).not.toContain("+  &quot;line-1&quot;: true,");
    expect(html).not.toContain('data-testid="patch-diff"');
    expect(html).not.toContain('data-testid="multi-file-diff"');
  });

  it("keeps lightweight diff row backgrounds on one shared scroll width", () => {
    const html = renderToStaticMarkup(
      createElement(LightweightDiffPreview, {
        codePreviewSettings,
        lines: [
          "-short",
          "+a very long changed line that should define the shared scroll width",
          "+short",
        ],
      }),
    );

    expect(html).toContain("data-lightweight-diff-scroll-content");
    expect(html).toContain(
      "min-w-full font-mono leading-relaxed text-foreground w-max",
    );
    expect(html).toContain("flex min-w-full w-full");
    expect(html).not.toContain("flex min-w-full w-max");
  });
});
