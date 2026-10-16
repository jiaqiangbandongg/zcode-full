// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import {
  CodeViewer,
  codeViewerMarkedLinesCss,
  findCodeViewerCommentElement,
  findCodeViewerLineElement,
  formatCodeCommentCancelShortcutLabel,
  formatCodeCommentSubmitShortcutLabel,
  isCodeCommentCancelShortcut,
  isCodeCommentSubmitShortcut,
  resolveCodeViewerColorScheme,
} from "../src/components/ui/code-viewer.js";

vi.mock("@pierre/diffs/react", () => ({
  File: ({
    className,
    file,
    lineAnnotations,
    options,
    renderAnnotation,
    selectedLines,
  }: {
    className?: string;
    file?: { cacheKey?: string };
    lineAnnotations?: unknown[];
    options?: Record<string, unknown>;
    renderAnnotation?: (annotation: unknown) => unknown;
    selectedLines?: { start: number; end: number } | null;
  }) =>
    createElement(
      "diffs-container",
      {
        class: className,
        "data-disable-line-numbers": String(
          Boolean(options?.disableLineNumbers),
        ),
        "data-enable-gutter-utility": String(
          Boolean(options?.enableGutterUtility),
        ),
        "data-enable-line-selection": String(
          Boolean(options?.enableLineSelection),
        ),
        "data-file-cache-key": String(file?.cacheKey ?? ""),
        "data-has-gutter-utility-click": String(
          typeof options?.onGutterUtilityClick === "function",
        ),
        "data-line-hover-highlight": String(options?.lineHoverHighlight),
        "data-selected-lines": selectedLines
          ? `${selectedLines.start}-${selectedLines.end}`
          : "",
        "data-overflow": String(options?.overflow),
        "data-theme": String(options?.theme ?? ""),
        "data-unsafe-css": String(options?.unsafeCSS ?? ""),
      },
      [
        selectedLines
          ? createElement("span", {
              key: "selected-line",
              "data-line": String(selectedLines.start),
            })
          : null,
        ...(lineAnnotations?.map((annotation, index) =>
          createElement("div", { key: index }, renderAnnotation?.(annotation)),
        ) ?? []),
      ],
    ),
}));

describe("CodeViewer", () => {
  it("formats the comment submit shortcut by platform", () => {
    expect(formatCodeCommentSubmitShortcutLabel({ platform: "MacIntel" })).toBe(
      "⌘ ↵",
    );
    expect(formatCodeCommentSubmitShortcutLabel({ platform: "Win32" })).toBe(
      "Ctrl+↵",
    );
    expect(formatCodeCommentCancelShortcutLabel()).toBe("Esc");
  });

  it("submits comment drafts with the platform primary modifier and Enter", () => {
    expect(
      isCodeCommentSubmitShortcut(
        {
          key: "Enter",
          metaKey: true,
          ctrlKey: false,
        },
        { platform: "MacIntel" },
      ),
    ).toBe(true);
    expect(
      isCodeCommentSubmitShortcut(
        {
          key: "Enter",
          metaKey: false,
          ctrlKey: true,
        },
        { platform: "MacIntel" },
      ),
    ).toBe(false);
    expect(
      isCodeCommentSubmitShortcut(
        {
          key: "Enter",
          metaKey: false,
          ctrlKey: true,
        },
        { platform: "Win32" },
      ),
    ).toBe(true);
    expect(
      isCodeCommentSubmitShortcut(
        {
          key: "Enter",
          metaKey: false,
          ctrlKey: false,
        },
        { platform: "Win32" },
      ),
    ).toBe(false);
    expect(
      isCodeCommentSubmitShortcut(
        {
          key: "a",
          metaKey: true,
          ctrlKey: false,
        },
        { platform: "MacIntel" },
      ),
    ).toBe(false);
  });

  it("cancels comment drafts with Escape", () => {
    expect(isCodeCommentCancelShortcut({ key: "Escape" })).toBe(true);
    expect(isCodeCommentCancelShortcut({ key: "Enter" })).toBe(false);
  });

  it("renders the @pierre/diffs file container", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;\nconsole.log(value);",
        language: "typescript",
        showLineNumbers: true,
        wrapLongLines: true,
      }),
    );

    expect(html).toContain("<diffs-container");
    expect(html).toContain('data-language="typescript"');
    expect(html).toContain("overflow-auto");
    expect(html).toContain("min-h-full");
    expect(html).toContain("--diffs-bg:var(--color-background)");
    expect(html).toContain("--diffs-light-bg:var(--color-background)");
    expect(html).toContain("--diffs-dark-bg:var(--color-background)");
    expect(html).toContain("--diffs-font-size:12px");
    expect(html).toContain("color-scheme:light");
    expect(html).not.toContain("data-code-viewer-row");
  });

  it("pins dark code preview themes to dark color-scheme", () => {
    expect(resolveCodeViewerColorScheme("github-dark")).toBe("dark");
    expect(resolveCodeViewerColorScheme("vitesse-dark")).toBe("dark");
    expect(resolveCodeViewerColorScheme("min-dark")).toBe("dark");
    expect(resolveCodeViewerColorScheme("github-dark-high-contrast")).toBe("dark");
    expect(resolveCodeViewerColorScheme("catppuccin-mocha")).toBe("dark");
    expect(resolveCodeViewerColorScheme("github-light")).toBe("light");
    expect(resolveCodeViewerColorScheme("vitesse-light")).toBe("light");
    expect(resolveCodeViewerColorScheme("min-light")).toBe("light");
    expect(resolveCodeViewerColorScheme("github-light-high-contrast")).toBe("light");
    expect(resolveCodeViewerColorScheme("catppuccin-latte")).toBe("light");

    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "AI 需要写文件 -> requestPermission",
        language: "text",
        theme: "github-dark",
      }),
    );

    expect(html).toContain("color-scheme:dark");
  });

  it("includes the highlight theme in the diff file cache key", () => {
    const lightHtml = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        theme: "github-light",
      }),
    );
    const darkHtml = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        theme: "github-dark",
      }),
    );

    expect(lightHtml).toContain('data-theme="github-light"');
    expect(lightHtml).toContain(
      'data-file-cache-key="github-light:preview.typescript:typescript:',
    );
    expect(darkHtml).toContain('data-theme="github-dark"');
    expect(darkHtml).toContain(
      'data-file-cache-key="github-dark:preview.typescript:typescript:',
    );
  });

  it("passes preview sizing through CSS variables", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "function demo() {\n  return true;\n}",
        language: "typescript",
        showLineNumbers: true,
        wrapLongLines: false,
        fontSizePx: 13,
      }),
    );

    expect(html).toContain("<diffs-container");
    expect(html).toContain("--diffs-font-size:13px");
    // @pierre/diffs 在客户端 Shadow DOM 内渲染真实 code 行；SSR 只输出宿主节点。
    expect(html).not.toContain("  return true;");
  });

  it("does not render the legacy line grid", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;\nconsole.log(value);\nexport {};",
        language: "typescript",
        showLineNumbers: true,
        wrapLongLines: true,
      }),
    );

    expect(html).toContain("<diffs-container");
    expect(html).not.toContain("data-code-viewer-line");
    expect(html).not.toContain("data-code-viewer-code");
  });

  it("renders controlled code comments", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;\nconsole.log(value);",
        language: "typescript",
        comments: [
          {
            id: "comment-1",
            sourceTitle: "app.ts",
            startLine: 2,
            endLine: 2,
            selectedText: "console.log(value);",
            comment: "Check this line.",
          },
        ],
        labels: {
          deleteComment: "Remove comment",
          commentLine: "Line {line}",
        },
        onDeleteCodeComment: () => undefined,
      }),
    );

    expect(html).toContain("Check this line.");
    expect(html).toContain("Line 2");
    expect(html).toContain("Remove comment");
  });

  it("renders a model review with the existing comment annotation but no mutation controls", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;\nconsole.log(value);\nexport {};",
        language: "typescript",
        comments: [
          {
            id: "model-review-1",
            sourceTitle: "app.ts",
            startLine: 2,
            endLine: 3,
            selectedText: "",
            comment: "Model-only review.",
          },
        ],
        focusedRange: { startLine: 2, endLine: 3 },
        labels: {
          deleteComment: "Remove comment",
          commentRange: "Lines {startLine}-{endLine}",
        },
      }),
    );

    expect(html).toContain("Model-only review.");
    expect(html).toContain("Lines 2-3");
    expect(html).toContain('data-selected-lines="2-3"');
    expect(html).not.toContain("Remove comment");
    expect(html).not.toContain("data-code-viewer-add-comment");
  });

  it("finds a target line inside nested code viewer Shadow DOM", () => {
    const root = document.createElement("div");
    const host = document.createElement("diffs-container");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const nestedHost = document.createElement("div");
    const nestedShadowRoot = nestedHost.attachShadow({ mode: "open" });
    const line = document.createElement("span");
    line.setAttribute("data-line", "42");
    nestedShadowRoot.append(line);
    shadowRoot.append(nestedHost);
    root.append(host);

    expect(findCodeViewerLineElement(root, 42)).toBe(line);
    expect(findCodeViewerLineElement(root, 43)).toBeNull();
  });

  it("finds a review comment inside nested code viewer Shadow DOM", () => {
    const root = document.createElement("div");
    const host = document.createElement("diffs-container");
    const shadowRoot = host.attachShadow({ mode: "open" });
    const comment = document.createElement("div");
    comment.dataset.codeCommentId = "review-42";
    shadowRoot.append(comment);
    root.append(host);

    expect(findCodeViewerCommentElement(root, "review-42")).toBe(comment);
    expect(findCodeViewerCommentElement(root, "review-43")).toBeNull();
  });

  it("positions the review comment below the target without changing horizontal scroll", async () => {
    const view = render(
      createElement(CodeViewer, {
        code: "line 1\nline 2\nline 3",
        language: "typescript",
        comments: [
          {
            id: "review-scroll-1",
            sourceTitle: "app.ts",
            startLine: 2,
            endLine: 2,
            selectedText: "",
            comment: "Review text.",
          },
        ],
        focusedRange: { startLine: 2, endLine: 2 },
        focusRequestId: "review-scroll-1",
      }),
    );
    const container = view.container.querySelector<HTMLDivElement>("[data-language]");
    if (!container) {
      throw new Error("Code viewer scroll container was not rendered");
    }
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollLeft: { configurable: true, writable: true, value: 45 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    const geometrySpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function () {
        if (this.dataset.codeCommentId === "review-scroll-1") {
          return {
            bottom: 560,
            height: 60,
            left: 20,
            right: 700,
            top: 500,
            width: 680,
            x: 20,
            y: 500,
            toJSON: () => ({}),
          };
        }
        return {
          bottom: 600,
          height: 600,
          left: 0,
          right: 700,
          top: 0,
          width: 700,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      });

    await waitFor(() => {
      expect(container.scrollTop).toBe(72);
    });
    expect(container.scrollLeft).toBe(45);
    geometrySpy.mockRestore();
    view.unmount();
  });

  it("tints only the gutter numbers of marked lines, through the shadow-root CSS", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "a\nb\nc",
        language: "typescript",
        markedLines: [3, 1, 3],
      }),
    );
    // 静态标记里属性值的引号被转义。
    expect(html).toContain(
      "[data-column-number=&quot;3&quot;],[data-column-number=&quot;1&quot;]{color:var(--color-warning);}",
    );

    const plain = renderToStaticMarkup(
      createElement(CodeViewer, { code: "a", language: "typescript" }),
    );
    expect(plain).not.toContain("data-column-number");
  });

  it("drops non-positive and non-integer marked lines", () => {
    expect(codeViewerMarkedLinesCss([0, -2, 1.5])).toBe("");
    expect(codeViewerMarkedLinesCss(undefined)).toBe("");
    expect(codeViewerMarkedLinesCss([7])).toBe(
      '[data-column-number="7"]{color:var(--color-warning);}',
    );
  });

  it("keeps code blocks read-only when comment controls are disabled", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        onSubmitCodeComment: () => undefined,
      }),
    );

    expect(html).not.toContain("Add comment");
    expect(html).not.toContain("data-code-viewer-add-comment");
  });

  it("enables @pierre/diffs gutter selection when gutter utility is explicitly enabled", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        enableLineSelection: true,
        enableGutterUtility: true,
        onSubmitCodeComment: () => undefined,
      }),
    );

    expect(html).toContain('data-enable-line-selection="true"');
    expect(html).toContain('data-enable-gutter-utility="true"');
    expect(html).toContain('data-has-gutter-utility-click="true"');
    expect(html).toContain(
      "--code-comment-add-tooltip:&quot;Click or drag to comment&quot;",
    );
    expect(html).toContain("[data-gutter-utility-slot]");
    expect(html).toContain("right:4px");
    expect(html).toContain("left:calc(100% + 6px)");
    expect(html).not.toContain("right:calc(100% + 6px)");
    expect(html).toContain("justify-content:flex-end");
    expect(html).toContain("align-items:center");
    expect(html).toContain("[data-utility-button]::after");
    expect(html).toContain("var(--color-tooltip)");
    expect(html).toContain("var(--color-tooltip-foreground)");
    expect(html).toContain(":focus-visible::after");
  });

  it("localizes the gutter comment tooltip label", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        enableLineSelection: true,
        enableGutterUtility: true,
        labels: {
          addCommentTooltip: "点击或拖拽添加评论",
        },
        onSubmitCodeComment: () => undefined,
      }),
    );

    expect(html).toContain(
      "--code-comment-add-tooltip:&quot;点击或拖拽添加评论&quot;",
    );
  });

  it("does not render comment creation UI without a submit handler", () => {
    const html = renderToStaticMarkup(
      createElement(CodeViewer, {
        code: "const value = 1;",
        language: "typescript",
        enableLineSelection: true,
        enableGutterUtility: true,
      }),
    );

    expect(html).toContain('data-enable-line-selection="false"');
    expect(html).toContain('data-enable-gutter-utility="false"');
    expect(html).toContain('data-has-gutter-utility-click="false"');
  });
});
