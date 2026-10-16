import { describe, expect, it } from "vitest";
import { buildToolDisplayModel } from "../src/lib/toolDisplay.js";

describe("toolDisplay helpers", () => {
  it("renders read tools as inline text previews", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-read",
        kind: "read",
        title: "读取 src/app.ts",
        input: {
          path: "src/app.ts",
        },
        output: {
          content: "export const value = 1;\n",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("text");
    expect(displayModel.showSummaryFileLink).toBe(false);
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(false);
  });

  it("renders replace-like tools as inline patches", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-replace",
        kind: "replace",
        title: "替换 src/app.ts",
        input: {
          path: "src/app.ts",
          old_string: "const a = 1;",
          new_string: "const a = 2;",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("patch");
    expect(displayModel.viewerLabelId).toBe("codeViewer.viewDiff");
    expect(displayModel.showSummaryFileLink).toBe(true);
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
  });

  it("hides successful write tool outputs while showing inline code", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-write",
        kind: "write",
        title: "写入 src/app.ts",
        input: {
          path: "src/app.ts",
          content: "export const value = 1;\n",
        },
        output: {
          result: "文件已成功写入",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("text");
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(false);
  });

  it("renders image tools as inline image previews", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-image",
        kind: "read",
        title: "查看 logo.png",
        input: {
          path: "assets/logo.png",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("image");
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.viewerSource?.type).toBe("image");
  });

  it("renders execute tools showing only output, hiding input and kind", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-exec",
        kind: "execute",
        title: "运行 npm test",
        input: {
          command: "npm test",
        },
        output: "All tests passed.\n",
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("none");
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(true);
    expect(displayModel.showKind).toBe(false);
  });

  it("renders execute tools with no output as collapsed", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-exec-2",
        kind: "execute",
        title: "运行 ls",
        input: {
          command: "ls",
        },
        status: "in_progress",
      },
      "/workspace",
    );

    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(false);
  });

  it("leaves node repl input and output to the dedicated renderer", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-node-repl-display",
        toolName: "js",
        kind: "js",
        title: "js",
        input: {
          code: "return 1;",
          title: "读取当前状态",
        },
        output: {
          type: "text",
          value: "1",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("none");
    expect(displayModel.showSummaryFileLink).toBe(false);
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(false);
  });

  it("renders search tools showing only result payload", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-search",
        kind: "search",
        title: "搜索 src 下的 TODO",
        input: {
          query: "TODO",
          path: "src",
        },
        output: {
          matches: [
            {
              path: "src/app.ts",
              line: 12,
            },
          ],
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("none");
    expect(displayModel.showSummaryFileLink).toBe(false);
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(true);
    expect(displayModel.showKind).toBe(false);
  });

  it("keeps search tools collapsed while running", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-search-running",
        kind: "grep",
        title: "grep TODO",
        input: {
          pattern: "TODO",
          path: "src",
        },
        status: "in_progress",
      },
      "/workspace",
    );

    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(false);
  });

  it("keeps search tool errors visible without showing parameters", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-search-error",
        kind: "fetch",
        title: "Fetch docs",
        input: {
          url: "https://example.com",
        },
        error: "request failed",
        status: "failed",
      },
      "/workspace",
    );

    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(true);
    expect(displayModel.showKind).toBe(false);
  });

  it("renders goal tools showing only result payloads", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-goal-update",
        toolName: "GoalUpdate",
        kind: "GoalUpdate",
        title: "GoalUpdate",
        input: {
          completionEvidence: "测试已通过，文档已更新。",
          status: "complete",
        },
        output: {
          goal: {
            status: "complete",
          },
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("none");
    expect(displayModel.showSummaryFileLink).toBe(false);
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(true);
    expect(displayModel.showKind).toBe(false);
  });

  it("hides failed edit parameters and surfaces nested error payloads", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-edit-error",
        kind: "edit",
        title: "edit src/App.tsx",
        input: {
          filePath: "/workspace/src/App.tsx",
          oldString: "const a = 1;\n",
          newString: "const a = 1;\n",
        },
        output: {
          error: "No changes to apply: oldString and newString are identical.",
        },
        status: "failed",
      },
      "/workspace",
    );

    expect(displayModel.inlinePreview.type).toBe("none");
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(true);
    expect(displayModel.showKind).toBe(false);
  });


  it("renders plan results from tool output and hides generic payload blocks", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-plan-output",
        kind: "switch_mode",
        title: "Exited Plan Mode",
        input: {
          plan: "# 输入里的旧计划",
        },
        output: {
          allowedPrompts: [
            {
              prompt: "run python3 snake.py to test the game",
              tool: "Bash",
            },
          ],
          plan: "# 输出计划\n\n- 渲染 markdown",
          planFilePath: "plans/snake.md",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.planResult).toEqual({
      plan: "# 输出计划\n\n- 渲染 markdown",
      planFilePath: "/workspace/plans/snake.md",
    });
    expect(displayModel.showInput).toBe(false);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(true);
  });

  it("does not treat plan-like input as tool result", () => {
    const displayModel = buildToolDisplayModel(
      {
        toolId: "tool-plan-input-only",
        kind: "switch_mode",
        title: "EnterPlanMode",
        input: {
          plan: "# 只存在于输入中的计划",
        },
        status: "completed",
      },
      "/workspace",
    );

    expect(displayModel.planResult).toBeNull();
    expect(displayModel.showInput).toBe(true);
    expect(displayModel.showOutput).toBe(false);
    expect(displayModel.showKind).toBe(true);
  });
});
