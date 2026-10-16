import { describe, expect, it } from "vitest";
import {
  appendPromptHistoryEntry,
  MAX_PROMPT_HISTORY,
  navigatePromptHistory,
} from "../src/lib/promptHistory.js";

describe("appendPromptHistoryEntry", () => {
  it("会忽略空白内容", () => {
    expect(appendPromptHistoryEntry(["first"], "   ")).toEqual(["first"]);
  });

  it("只过滤 trim 后与上一条相同的连续重复", () => {
    expect(appendPromptHistoryEntry(["first"], "  first  ")).toEqual(["first"]);
    expect(appendPromptHistoryEntry(["first", "second"], " first ")).toEqual([
      "first",
      "second",
      "first",
    ]);
  });

  it("保留内部空白、换行和大小写不同的历史", () => {
    expect(appendPromptHistoryEntry(["A B"], " A  B ")).toEqual(["A B", "A  B"]);
    expect(appendPromptHistoryEntry(["line\nvalue"], "line value")).toEqual([
      "line\nvalue",
      "line value",
    ]);
    expect(appendPromptHistoryEntry(["Prompt"], "prompt")).toEqual(["Prompt", "prompt"]);
  });

  it("会在尾部追加并裁剪到最近 30 条", () => {
    const history = Array.from(
      { length: MAX_PROMPT_HISTORY },
      (_, index) => `message-${index + 1}`,
    );
    const next = appendPromptHistoryEntry(history, "message-31");

    expect(next).toHaveLength(MAX_PROMPT_HISTORY);
    expect(next[0]).toBe("message-2");
    expect(next.at(-1)).toBe("message-31");
  });
});

describe("navigatePromptHistory", () => {
  const history = ["first", "second", "third"];

  it("向上导航时会先命中最新一条", () => {
    expect(navigatePromptHistory(history, null, "up")).toEqual({
      nextIndex: 2,
      nextValue: "third",
      shouldHandle: true,
    });
  });

  it("向上导航到顶部后会停在最旧一条", () => {
    expect(navigatePromptHistory(history, 0, "up")).toEqual({
      nextIndex: 0,
      nextValue: "first",
      shouldHandle: true,
    });
  });

  it("向下导航时会逐步回到较新的记录，再回到空输入", () => {
    expect(navigatePromptHistory(history, 0, "down")).toEqual({
      nextIndex: 1,
      nextValue: "second",
      shouldHandle: true,
    });
    expect(navigatePromptHistory(history, 2, "down")).toEqual({
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    });
  });

  it("空输入时向下也能先带出最新一条记录", () => {
    expect(navigatePromptHistory(history, null, "down")).toEqual({
      nextIndex: 2,
      nextValue: "third",
      shouldHandle: true,
    });
  });
});
