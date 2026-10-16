import { describe, expect, it } from "vitest";
import {
  createActivePromptInputTokenSnapshot,
  getActivePromptInputTokenReplacementRange,
  reconcileActivePromptInputTokenSnapshot,
} from "../src/mentions/activePromptInputToken.js";

function selection(text: string, cursorOffset: number, nodeKey = "node-1") {
  return {
    cursorOffset,
    nodeKey,
    text,
    textBeforeCursor: text.slice(0, cursorOffset),
  };
}

describe("active prompt input token", () => {
  it("左右移动仍在同一 token 内时保持原始 query 和完整范围", () => {
    const text = "@skill-creator";
    const snapshot = createActivePromptInputTokenSnapshot(selection(text, text.length));

    expect(snapshot).toMatchObject({
      nodeKey: "node-1",
      query: "skill-creator",
      tokenEnd: text.length,
      tokenStart: 0,
      tokenText: text,
      trigger: "@",
    });

    const movedLeft = reconcileActivePromptInputTokenSnapshot(snapshot, selection(text, 7), true);
    expect(movedLeft).toBe(snapshot);
    expect(
      reconcileActivePromptInputTokenSnapshot(movedLeft, selection(text, text.length), true),
    ).toBe(snapshot);
    expect(getActivePromptInputTokenReplacementRange(snapshot, selection(text, 7))).toEqual({
      end: text.length,
      start: 0,
    });
  });

  it("光标离开 token、节点改变或 token 文本改变时不复用快照", () => {
    const text = "前缀 @plugin-name 后文";
    const tokenEnd = text.indexOf(" 后文");
    const snapshot = createActivePromptInputTokenSnapshot(selection(text, tokenEnd));
    expect(snapshot).not.toBeNull();

    expect(
      reconcileActivePromptInputTokenSnapshot(snapshot, selection(text, text.indexOf("@")), true),
    ).toBeNull();
    expect(
      reconcileActivePromptInputTokenSnapshot(snapshot, selection(text, tokenEnd, "node-2"), true),
    ).toBeNull();

    const edited = text.replace("plugin-name", "plugin-next");
    expect(
      reconcileActivePromptInputTokenSnapshot(snapshot, selection(edited, tokenEnd), true),
    ).toMatchObject({ query: "plugin-next", tokenText: "@plugin-next" });
  });

  it("内容更新重新解析 query，裸触发符不会把后续正文纳入 token", () => {
    const original = createActivePromptInputTokenSnapshot(selection("@plugin", 7));
    expect(
      reconcileActivePromptInputTokenSnapshot(original, selection("@plug-in", 8), false),
    ).toMatchObject({ query: "plug-in", tokenText: "@plug-in" });

    const bareTrigger = createActivePromptInputTokenSnapshot(selection("@已有正文", 1));
    expect(bareTrigger).toMatchObject({
      query: "",
      tokenEnd: 1,
      tokenStart: 0,
      tokenText: "@",
    });
    expect(
      getActivePromptInputTokenReplacementRange(bareTrigger, selection("@已有正文", 1)),
    ).toEqual({ end: 1, start: 0 });
  });

  it("Slash token 位于既有 CJK 正文前时只替换用户实际输入范围", () => {
    const text = "/goal修复这个问题";
    const snapshot = createActivePromptInputTokenSnapshot(selection(text, "/goal".length));

    expect(snapshot).toMatchObject({
      query: "goal",
      tokenStart: 0,
      tokenEnd: "/goal".length,
      tokenText: "/goal",
      trigger: "/",
    });
    expect(
      getActivePromptInputTokenReplacementRange(
        snapshot,
        selection(text, "/goal".length - 1),
      ),
    ).toEqual({ start: 0, end: "/goal".length });
  });
});
