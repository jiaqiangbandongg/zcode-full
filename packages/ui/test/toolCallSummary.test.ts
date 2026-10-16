import {
  getCompactToolCallSummary,
  isCompactToolCallFinishedState,
  isCompactToolCallRunningState,
} from "../src/lib/toolCallSummary.js";
import { describe, expect, it } from "vitest";

describe("toolCallSummary helpers", () => {
  it("prefers string input before structured fields", () => {
    const summary = getCompactToolCallSummary({
      title: "运行命令",
      kind: "bash",
      input: "pnpm typecheck\n--pretty false",
    });

    expect(summary.primaryText).toBe("运行命令");
    expect(summary.secondaryText).toBe("pnpm typecheck --pretty false");
  });

  it("uses command, path, then prompt as structured summary priority", () => {
    expect(
      getCompactToolCallSummary({
        title: "执行命令",
        kind: "bash",
        input: {
          command: "git status",
          path: "/workspace",
          prompt: "inspect repo",
        },
      }).secondaryText,
    ).toBe("git status");

    expect(
      getCompactToolCallSummary({
        title: "读取文件",
        kind: "read",
        input: {
          path: "/workspace/src/app.ts",
          prompt: "inspect file",
        },
      }).secondaryText,
    ).toBe("/workspace/src/app.ts");

    expect(
      getCompactToolCallSummary({
        title: "询问用户",
        kind: "prompt",
        input: {
          prompt: "Please confirm the migration.",
        },
      }).secondaryText,
    ).toBe("Please confirm the migration.");
  });

  it("returns changeStat for edit tool with old_string/new_string", () => {
    const summary = getCompactToolCallSummary({
      title: "Edit",
      kind: "edit",
      input: {
        file_path: "/workspace/src/app.ts",
        old_string: "line1\nline2\nline3",
        new_string: "line1\nlineA\nlineB\nline3",
      },
    });

    expect(summary.changeStat).toEqual({ added: 4, removed: 3 });
  });

  it("returns no changeStat for non-edit tools", () => {
    const summary = getCompactToolCallSummary({
      title: "Read",
      kind: "read",
      input: { file_path: "/workspace/src/app.ts" },
    });

    expect(summary.changeStat).toBeUndefined();
  });

  it("returns no changeStat when old_string and new_string are both empty", () => {
    const summary = getCompactToolCallSummary({
      title: "Edit",
      kind: "edit",
      input: { file_path: "/a.ts", old_string: "", new_string: "" },
    });

    expect(summary.changeStat).toBeUndefined();
  });

  it("distinguishes running and finished tool states", () => {
    expect(isCompactToolCallRunningState("input-streaming")).toBe(true);
    expect(isCompactToolCallRunningState("input-available")).toBe(true);
    expect(isCompactToolCallRunningState("output-available")).toBe(false);

    expect(isCompactToolCallFinishedState("output-available")).toBe(true);
    expect(isCompactToolCallFinishedState("output-error")).toBe(true);
    expect(isCompactToolCallFinishedState("output-denied")).toBe(true);
    expect(isCompactToolCallFinishedState("input-streaming")).toBe(false);
  });
});
