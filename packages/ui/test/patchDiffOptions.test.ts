import { describe, expect, it } from "vitest";
import {
  getGitPaneDiffPreviewPlan,
  shouldRenderPlainTextDiffPreview,
} from "../src/GitPane/helpers.js";
import { createPatchDiffOptions } from "../src/lib/patchDiffOptions.js";

const SETTINGS = {
  lightTheme: "github-light",
  darkTheme: "github-dark",
  showLineNumbers: true,
  wrapLongLines: false,
} as const;

describe("createPatchDiffOptions", () => {
  it("keeps line-info separators by default", () => {
    const options = createPatchDiffOptions(SETTINGS, "light");

    expect(options.hunkSeparators).toBe("line-info");
  });

  it("supports simple separators for compact diff previews", () => {
    const options = createPatchDiffOptions(SETTINGS, "light", {
      separatorStyle: "simple",
    });

    expect(options.hunkSeparators).toBe("simple");
  });

  it("patch diff 与 worker 池使用同一个 WASM 高亮引擎", () => {
    const options = createPatchDiffOptions(SETTINGS, "dark");

    expect(options.preferredHighlighter).toBe("shiki-wasm");
  });
});

describe("shouldRenderPlainTextDiffPreview", () => {
  it("falls back for created plain text patches on review surfaces", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
    ].join("\n");

    expect(shouldRenderPlainTextDiffPreview(patch)).toEqual([
      "+hello",
      "+world",
    ]);
  });

  it("hides unified diff metadata and keeps no-newline markers", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1,1 @@",
      "+hello world",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    expect(shouldRenderPlainTextDiffPreview(patch)).toEqual([
      "+hello world",
      "\\ No newline at end of file",
    ]);
  });

  it("keeps structured file types on PatchDiff path", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/demo.json",
      "@@ -0,0 +1,1 @@",
      "+{}",
    ].join("\n");

    expect(shouldRenderPlainTextDiffPreview(patch)).toBeNull();
  });
});

describe("getGitPaneDiffPreviewPlan", () => {
  it("uses patch-only rendering when full before/after content is large", () => {
    const beforeContent = Array.from(
      { length: 1_300 },
      (_, index) => `line-${index + 1}`,
    ).join("\n");
    const afterContent = beforeContent.replace("line-10", "line-10 changed");

    expect(
      getGitPaneDiffPreviewPlan({
        path: "/workspace/demo.ts",
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
        summary: null,
      }),
    ).toEqual({ kind: "patch" });
  });

  it("uses plain text when a large created structured file would be expensive", () => {
    const afterLines = Array.from(
      { length: 1_300 },
      (_, index) => `+  "line-${index + 1}": true,`,
    );

    const plan = getGitPaneDiffPreviewPlan({
      path: "/workspace/demo.json",
      availability: "patch",
      patch: [
        "--- /dev/null",
        "+++ b/demo.json",
        "@@ -0,0 +1,1300 @@",
        ...afterLines,
      ].join("\n"),
      beforeContent: "",
      afterContent: afterLines.map((line) => line.slice(1)).join("\n"),
      summary: null,
    });

    expect(plan.kind).toBe("plain-text");
    expect(plan.kind === "plain-text" ? plan.lines.at(0) : null).toBe(
      '+  "line-1": true,',
    );
  });

  it("keeps unsafe patches on the lightweight fallback when full contents are unavailable", () => {
    const afterLines = Array.from(
      { length: 1_300 },
      (_, index) => `+  "line-${index + 1}": true,`,
    );

    const plan = getGitPaneDiffPreviewPlan({
      path: "/workspace/demo.json",
      availability: "patch",
      patch: [
        "--- /dev/null",
        "+++ b/demo.json",
        "@@ -0,0 +1,1300 @@",
        ...afterLines,
      ].join("\n"),
      beforeContent: null,
      afterContent: null,
      summary: null,
    });

    expect(plan.kind).toBe("plain-text");
    expect(plan.kind === "plain-text" ? plan.lines.at(0) : null).toBe(
      '+  "line-1": true,',
    );
  });
});
