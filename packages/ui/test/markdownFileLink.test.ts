import { describe, expect, it } from "vitest";
import {
  parseMarkdownFileLinkTarget,
  resolveMarkdownFileLink,
} from "../src/lib/markdownFileLink.js";
import { stripBalancedAssistantPathQuotes } from "../src/lib/assistantPathQuotes.js";

describe("parseMarkdownFileLinkTarget", () => {
  it("去除 rehype 产生的相对路径智能引号保护层", () => {
    expect(stripBalancedAssistantPathQuotes("./‘docs/说明.md’")).toBe("./docs/说明.md");
    expect(stripBalancedAssistantPathQuotes("/‘docs/说明.md’")).toBe("/docs/说明.md");
    expect(stripBalancedAssistantPathQuotes("/“./docs/说明.md”")).toBe("./docs/说明.md");
    expect(stripBalancedAssistantPathQuotes("%E2%80%9C./docs/说明%2520文档.md%E2%80%9D")).toBe(
      "./docs/说明%2520文档.md",
    );
  });
  it("extracts trailing line and column from absolute file paths", () => {
    expect(
      parseMarkdownFileLinkTarget(
        "/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx:30:4",
      ),
    ).toEqual({
      path: "/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx",
      lineNumber: 30,
      columnNumber: 4,
    });
  });

  it("keeps plain file paths unchanged when no line suffix exists", () => {
    expect(parseMarkdownFileLinkTarget("./src/app.ts")).toEqual({
      path: "./src/app.ts",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("extracts GitHub-style hash line ranges used by Wiki Sources", () => {
    expect(parseMarkdownFileLinkTarget("src/main.ts#L12-L80")).toEqual({
      path: "src/main.ts",
      lineNumber: 12,
      columnNumber: null,
    });
  });

  it.each([
    ["中文双引号", "“./src/report.pdf:12:3”"],
    ["中文单引号", "‘./src/report.pdf#L12-L80’"],
    ["ASCII 单引号", "'./src/report.pdf'"],
  ])("支持 %s 包裹的本地链接目标", (_label, href) => {
    expect(parseMarkdownFileLinkTarget(href)).toMatchObject({
      path: "./src/report.pdf",
    });
  });

  it("decodes uri-encoded path text while preserving line suffixes", () => {
    expect(
      parseMarkdownFileLinkTarget(
        "/Users/dev/ZCodeProject/323/Auto%20Snake/src/game/engine.ts:42",
      ),
    ).toEqual({
      path: "/Users/dev/ZCodeProject/323/Auto Snake/src/game/engine.ts",
      lineNumber: 42,
      columnNumber: null,
    });
  });

  it("只解码一次字面 percent-escape 文件名", () => {
    expect(parseMarkdownFileLinkTarget("./report%2520final.md")).toEqual({
      path: "./report%20final.md",
      lineNumber: null,
      columnNumber: null,
    });
    expect(parseMarkdownFileLinkTarget("./report%2520final.md:12")).toEqual({
      path: "./report%20final.md",
      lineNumber: 12,
      columnNumber: null,
    });
    expect(parseMarkdownFileLinkTarget("%E2%80%9C./report%2520final.md%E2%80%9D")).toEqual({
      path: "./report%20final.md",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("converts file URL targets to local file paths", () => {
    expect(
      parseMarkdownFileLinkTarget(
        "file:///Users/dev/ZCodeProject/todolist/src/app/gomoku/components/GameControls.tsx:18",
      ),
    ).toEqual({
      path: "/Users/dev/ZCodeProject/todolist/src/app/gomoku/components/GameControls.tsx",
      lineNumber: 18,
      columnNumber: null,
    });
  });

  it("file URL 只解码一次字面 percent-escape 文件名", () => {
    expect(parseMarkdownFileLinkTarget("file:///workspace/report%2520final.md")).toEqual({
      path: "/workspace/report%20final.md",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("converts Windows file URL targets to drive-letter paths", () => {
    expect(parseMarkdownFileLinkTarget("file:///C:/Users/dev/project/src/app.ts:12:3")).toEqual({
      path: "C:/Users/dev/project/src/app.ts",
      lineNumber: 12,
      columnNumber: 3,
    });
  });
});

describe("resolveMarkdownFileLink", () => {
  it("resolves workspace-relative file links against the workspace root", () => {
    expect(resolveMarkdownFileLink("/workspace", "./src/app.ts:12")).toEqual({
      path: "/workspace/src/app.ts",
      lineNumber: 12,
      columnNumber: null,
    });
  });

  it("解析智能引号包裹的 Markdown 文件链接", () => {
    expect(resolveMarkdownFileLink("/workspace", "“docs/report.pdf”")).toEqual({
      path: "/workspace/docs/report.pdf",
      lineNumber: null,
      columnNumber: null,
    });
    expect(resolveMarkdownFileLink("/workspace", "./‘docs/report.pdf’")).toEqual({
      path: "/workspace/docs/report.pdf",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("resolves Home-relative links against the injected Host Home", () => {
    expect(
      resolveMarkdownFileLink("/workspace", "~/Desktop/report.pdf:12", {
        homePath: "/Users/demo",
      }),
    ).toEqual({
      path: "/Users/demo/Desktop/report.pdf",
      lineNumber: 12,
      columnNumber: null,
    });
    expect(
      resolveMarkdownFileLink("C:\\workspace", String.raw`~\Desktop\deck.pptx`, {
        homePath: String.raw`C:\Users\demo`,
      }),
    ).toEqual({
      path: String.raw`C:\Users\demo\Desktop\deck.pptx`,
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("fails closed for Home-relative links when Host Home is unavailable", () => {
    expect(resolveMarkdownFileLink("/workspace", "~/Desktop/report.pdf")).toBeNull();
    expect(
      resolveMarkdownFileLink("/workspace", "~other/Desktop/report.pdf", {
        homePath: "/Users/demo",
      }),
    ).toBeNull();
  });

  it("resolves bare workspace-relative file links against the workspace root", () => {
    expect(resolveMarkdownFileLink("/workspace", "src/app/page.tsx")).toEqual({
      path: "/workspace/src/app/page.tsx",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("rejects nested relative traversal that escapes the workspace root", () => {
    expect(resolveMarkdownFileLink("/workspace", "foo/../../private.pdf")).toBeNull();
    expect(resolveMarkdownFileLink("/workspace", "/foo/../../private.pdf")).toBeNull();
    expect(resolveMarkdownFileLink("/workspace", "foo/%2E%2E/%2E%2E/private.pdf")).toBeNull();
    expect(resolveMarkdownFileLink("C:\\workspace", "dir\\..\\..\\private.pdf")).toBeNull();
  });

  it("normalizes contained relative traversal before returning the file path", () => {
    expect(resolveMarkdownFileLink("/workspace", "./a/../report.pdf")).toEqual({
      path: "/workspace/report.pdf",
      lineNumber: null,
      columnNumber: null,
    });
    expect(resolveMarkdownFileLink("C:\\workspace", "dir\\draft\\..\\report.pdf")).toEqual({
      path: "C:\\workspace\\dir\\report.pdf",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("resolves Wiki Sources hash line ranges against the workspace root", () => {
    expect(resolveMarkdownFileLink("/workspace", "src/main.ts#L12-L80")).toEqual({
      path: "/workspace/src/main.ts",
      lineNumber: 12,
      columnNumber: null,
    });
  });

  it("keeps unix absolute file links absolute instead of prefixing the workspace path", () => {
    expect(
      resolveMarkdownFileLink(
        "/workspace",
        "/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx:30",
      ),
    ).toEqual({
      path: "/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx",
      lineNumber: 30,
      columnNumber: null,
    });
  });

  it("keeps absolute links inside a non-standard workspace root absolute", () => {
    expect(resolveMarkdownFileLink("/workspace", "/workspace/report.pdf")).toEqual({
      path: "/workspace/report.pdf",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("supports windows absolute paths with drive letters", () => {
    expect(
      resolveMarkdownFileLink(
        "/workspace",
        "C:/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx:30",
      ),
    ).toEqual({
      path: "C:/Users/dev/project/src/components/FeedbackSurvey/useFeedbackSurvey.tsx",
      lineNumber: 30,
      columnNumber: null,
    });
  });

  it("restores the harden-safe Windows drive path used by Markdown rendering", () => {
    expect(
      resolveMarkdownFileLink("C:\\workspace", "/C:/Users/demo/project/report.md:12:3"),
    ).toEqual({
      path: "C:/Users/demo/project/report.md",
      lineNumber: 12,
      columnNumber: 3,
    });
  });

  it("restores the harden-safe Windows drive path in a UNC workspace", () => {
    expect(
      resolveMarkdownFileLink("\\\\server\\share\\repo", "/C:/Users/demo/project/report.md"),
    ).toEqual({
      path: "C:/Users/demo/project/report.md",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("does not reinterpret a Unix /C:/ path as a Windows drive path", () => {
    expect(resolveMarkdownFileLink("/workspace", "/C:/Users/demo/project/report.md")).toBeNull();
  });

  it("resolves uri-encoded workspace-relative file links", () => {
    expect(resolveMarkdownFileLink("/workspace", "./src/Auto%20Snake/engine.ts:12")).toEqual({
      path: "/workspace/src/Auto Snake/engine.ts",
      lineNumber: 12,
      columnNumber: null,
    });
  });

  it("resolves file URL links as absolute local file links", () => {
    expect(
      resolveMarkdownFileLink(
        "/workspace",
        "file:///Users/dev/ZCodeProject/todolist/src/app/gomoku/components/GameControls.tsx",
      ),
    ).toEqual({
      path: "/Users/dev/ZCodeProject/todolist/src/app/gomoku/components/GameControls.tsx",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("resolves normalized root-relative markdown links against the workspace root", () => {
    expect(resolveMarkdownFileLink("/workspace", "/flappy.html")).toEqual({
      path: "/workspace/flappy.html",
      lineNumber: null,
      columnNumber: null,
    });
  });

  it("ignores non-file markdown links", () => {
    expect(resolveMarkdownFileLink("/workspace", "https://example.com/docs")).toBeNull();
  });
});
