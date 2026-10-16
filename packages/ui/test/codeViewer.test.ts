import { describe, expect, it } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import {
  buildUnifiedDiff,
  getToolCallCodeContentPreview,
  getToolCallCodePreview,
  inferCodeLanguage,
  inferImageMediaType,
  isPdfPreviewPath,
  isPptxPreviewPath,
} from "../src/lib/codeViewer.js";

describe("codeViewer helpers", () => {
  it("infers language from file extension", () => {
    expect(inferCodeLanguage("/tmp/example.tsx")).toBe("tsx");
    expect(inferCodeLanguage("/tmp/example.py")).toBe("python");
    expect(inferCodeLanguage("/tmp/README.md")).toBe("markdown");
  });

  it("infers image media types from file extensions", () => {
    expect(inferImageMediaType("/tmp/example.png")).toBe("image/png");
    expect(inferImageMediaType("/tmp/example.svg")).toBe("image/svg+xml");
    expect(inferImageMediaType("/tmp/example.txt")).toBeNull();
  });

  it("detects pdf preview paths case-insensitively", () => {
    expect(isPdfPreviewPath("/tmp/report.pdf")).toBe(true);
    expect(isPdfPreviewPath("/tmp/REPORT.PDF")).toBe(true);
    expect(isPdfPreviewPath("/tmp/archive.pdf.zip")).toBe(false);
    expect(isPdfPreviewPath("/tmp/example.txt")).toBe(false);
    expect(isPdfPreviewPath(undefined)).toBe(false);
  });

  it("detects pptx preview paths case-insensitively", () => {
    expect(isPptxPreviewPath("/tmp/slides.pptx")).toBe(true);
    expect(isPptxPreviewPath("/tmp/SLIDES.PPTX")).toBe(true);
    expect(isPptxPreviewPath("/tmp/archive.pptx.zip")).toBe(false);
    expect(isPptxPreviewPath("/tmp/legacy.ppt")).toBe(false);
    expect(isPptxPreviewPath(undefined)).toBe(false);
  });

  it("builds a unified diff for simple edits", () => {
    const diff = buildUnifiedDiff("const a = 1;\nreturn a;", "const a = 2;\nreturn a;", "demo.ts");

    expect(diff).toContain("--- a/demo.ts");
    expect(diff).toContain("+++ b/demo.ts");
    expect(diff).toContain("-const a = 1;");
    expect(diff).toContain("+const a = 2;");
  });

  it("keeps deleted SQL comments inside one generated file diff", () => {
    const diff = buildUnifiedDiff(
      "-- old table comment\nSELECT 1;",
      "-- new table comment\nSELECT 1;",
      "schema.sql",
    );

    expect(diff).toMatch(/^diff --git a\/schema\.sql b\/schema\.sql/);
    expect(() => getSingularPatch(diff ?? "")).not.toThrow();
  });

  it("marks newly created files with a /dev/null old path", () => {
    const diff = buildUnifiedDiff("", "export const value = 1;", "demo.ts");

    expect(diff).toContain("--- /dev/null");
    expect(diff).toContain("+++ b/demo.ts");
    expect(diff).toContain("@@ -0,0 +1,1 @@");
    expect(diff).not.toContain("--- a/demo.ts");
  });

  it("keeps diff preview available for large files with small edits", () => {
    const beforeLines = Array.from({ length: 280 }, (_, index) =>
      index === 140 ? "const snakeHeadColor = '#2ecc71';" : `line ${index};`,
    );
    const afterLines = [...beforeLines];
    afterLines[140] = "const snakeHeadColor = '#f39c12';";

    const diff = buildUnifiedDiff(beforeLines.join("\n"), afterLines.join("\n"), "snake.html");

    expect(diff).not.toBeNull();
    expect(diff).toContain("-const snakeHeadColor = '#2ecc71';");
    expect(diff).toContain("+const snakeHeadColor = '#f39c12';");
  });

  it("can trim unchanged context around edits", () => {
    const beforeLines = Array.from({ length: 20 }, (_, index) =>
      index === 10 ? "const snakeHeadColor = '#2ecc71';" : `line ${index};`,
    );
    const afterLines = [...beforeLines];
    afterLines[10] = "const snakeHeadColor = '#f39c12';";

    const diff = buildUnifiedDiff(beforeLines.join("\n"), afterLines.join("\n"), "snake.html", {
      contextLines: 3,
    });

    expect(diff).toContain("@@ -8,7 +8,7 @@");
    expect(diff).toContain(" line 7;");
    expect(diff).toContain(" line 13;");
    expect(diff).not.toContain(" line 1;");
    expect(diff).not.toContain(" line 18;");
    expect(diff).toContain("-const snakeHeadColor = '#2ecc71';");
    expect(diff).toContain("+const snakeHeadColor = '#f39c12';");
  });

  it("preserves distant small insertions as separate hunks instead of a giant replacement", () => {
    const beforeLines = [
      ...Array.from({ length: 33 }, (_, index) => `head ${index};`),
      "type ActiveSession = RuntimeSessionState",
      ...Array.from({ length: 301 }, (_, index) => `middle ${index};`),
      "let tools = runtime.tools",
      ...Array.from({ length: 115 }, (_, index) => `tail ${index};`),
    ];
    const afterLines = [
      ...beforeLines.slice(0, 33),
      "import { reportAppLaunch, reportDailyActive } from './telemetry/index.js'",
      ...beforeLines.slice(33, 335),
      "// Fire-and-forget telemetry for app launch and daily active",
      "reportAppLaunch().catch(() => {})",
      "reportDailyActive().catch(() => {})",
      "",
      ...beforeLines.slice(335),
    ];

    const diff = buildUnifiedDiff(beforeLines.join("\n"), afterLines.join("\n"), "src/cli.ts", {
      contextLines: 3,
    });

    expect(diff).toContain(
      "+import { reportAppLaunch, reportDailyActive } from './telemetry/index.js'",
    );
    expect(diff).toContain("+// Fire-and-forget telemetry for app launch and daily active");
    expect(diff).toContain("+reportAppLaunch().catch(() => {})");
    expect(diff).toContain("+reportDailyActive().catch(() => {})");
    expect(diff?.match(/^@@ /gm)).toHaveLength(2);
    expect(diff).not.toContain("-type ActiveSession = RuntimeSessionState");
    expect(diff).not.toContain("-middle 0;");
  });

  it("extracts inline code preview from write tools", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-1",
        kind: "write",
        title: "写入 src/app.ts",
        input: { path: "src/app.ts", content: "export const value = 1;\n" },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "text",
      title: "写入 src/app.ts",
      path: "/workspace/src/app.ts",
      content: "export const value = 1;\n",
      language: "typescript",
    });
  });

  it("decodes uri-encoded file paths before opening a file preview", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-uri-path",
        kind: "read",
        title: "读取 engine.ts",
        input: {
          file_path: "/Users/dev/ZCodeProject/323/Auto%20Snake/src/game/engine.ts",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "file",
      title: "读取 engine.ts",
      path: "/Users/dev/ZCodeProject/323/Auto Snake/src/game/engine.ts",
    });
  });

  it("decodes uri-encoded relative paths against the workspace root", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-relative-uri-path",
        kind: "read",
        title: "",
        input: { path: "src/Auto%20Snake/engine.ts" },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "file",
      title: "engine.ts",
      path: "/workspace/src/Auto Snake/engine.ts",
    });
  });

  it("extracts patch preview from edit tools", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-2",
        kind: "edit",
        title: "修改 src/app.ts",
        input: {
          path: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview?.type).toBe("patch");
    if (!preview || preview.type !== "patch") {
      throw new Error("Expected patch preview");
    }

    expect(preview.path).toBe("/workspace/src/app.ts");
    expect(preview.patch).toContain("-const a = 1;");
    expect(preview.patch).toContain("+const a = 2;");
  });

  it("extracts updated code content preview from edit tools", () => {
    const preview = getToolCallCodeContentPreview(
      {
        toolId: "tool-2-content",
        kind: "edit",
        title: "修改 src/app.ts",
        input: {
          path: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "text",
      title: "修改 src/app.ts",
      path: "/workspace/src/app.ts",
      content: "const a = 2;",
      language: "typescript",
    });
  });

  it("extracts patch preview from raw diff content blocks", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-raw-diff",
        kind: "edit",
        title: "/workspace/src/app.ts",
        input: {
          content: "const a = 2;\n",
          filePath: "/workspace/src/app.ts",
        },
        output: {
          output: "Wrote file successfully.",
        },
        raw: {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "Wrote file successfully.",
              },
            },
            {
              type: "diff",
              path: "/workspace/src/app.ts",
              oldText: "const a = 1;\n",
              newText: "const a = 2;\n",
            },
          ],
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview?.type).toBe("patch");
    if (!preview || preview.type !== "patch") {
      throw new Error("Expected patch preview");
    }

    expect(preview.path).toBe("/workspace/src/app.ts");
    expect(preview.patch).toContain("-const a = 1;");
    expect(preview.patch).toContain("+const a = 2;");
  });

  it("extracts updated code content from raw diff blocks", () => {
    const preview = getToolCallCodeContentPreview(
      {
        toolId: "tool-raw-diff-content",
        kind: "edit",
        title: "/workspace/src/app.ts",
        input: {
          content: "const a = 2;\n",
          filePath: "/workspace/src/app.ts",
        },
        output: {
          output: "Wrote file successfully.",
        },
        raw: {
          content: [
            {
              type: "diff",
              path: "/workspace/src/app.ts",
              oldText: "const a = 1;\n",
              newText: "const a = 2;\n",
            },
          ],
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "text",
      title: "/workspace/src/app.ts",
      path: "/workspace/src/app.ts",
      content: "const a = 2;\n",
      language: "typescript",
    });
  });

  it("extracts image previews from file-oriented tools", () => {
    const preview = getToolCallCodePreview(
      {
        toolId: "tool-image-read",
        kind: "read",
        title: "查看 logo.png",
        input: {
          path: "assets/logo.png",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(preview).toEqual({
      type: "image",
      title: "查看 logo.png",
      path: "/workspace/assets/logo.png",
      mediaType: "image/png",
    });
  });
});
