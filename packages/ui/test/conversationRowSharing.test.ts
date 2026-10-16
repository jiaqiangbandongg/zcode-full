// Conversation row 结构共享单测（docs/performance/conversation-row-structural-sharing.md）。
import { describe, expect, it } from "vitest";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationRowPool, shareStructure } from "@/v4/conversationRowSharing.js";

/** 模拟一次反序列化：内容相同、引用全新（包括字符串）。 */
function fresh<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function bigToolRow(rowId: number, status: ToolCallRow["status"] = "running"): ToolCallRow {
  const content = `内容-${rowId}-`.repeat(2000);
  return {
    rowId,
    turnId: "t1",
    createdAt: 1,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName: "Write",
    status,
    input: { file_path: "/a.txt", content },
    inputText: JSON.stringify({ file_path: "/a.txt", content }),
  };
}

describe("shareStructure", () => {
  it("深相等时返回 prev 本身", () => {
    const prev = { a: 1, b: { c: ["x", { d: null }] } };
    expect(shareStructure(prev, fresh(prev))).toBe(prev);
  });

  it("部分变化时新建外壳，复用未变化的子值", () => {
    const prev = { keep: { deep: [1, 2] }, change: { v: 1 }, text: "长文本" };
    const next = { keep: { deep: [1, 2] }, change: { v: 2 }, text: "长文本" };
    const shared = shareStructure(prev, next);
    expect(shared).not.toBe(prev);
    expect(shared).toEqual(next);
    expect(shared.keep).toBe(prev.keep);
    expect(shared.change).toBe(next.change);
  });

  it("不修改 next，保留 next 的键顺序", () => {
    const prev = { a: { x: 1 }, b: 1 };
    const next = { b: 2, a: { x: 1 } };
    const snapshot = JSON.stringify(next);
    const nextA = next.a;
    const shared = shareStructure(prev, next);
    expect(JSON.stringify(next)).toBe(snapshot);
    expect(next.a).toBe(nextA);
    expect(Object.keys(shared)).toEqual(["b", "a"]);
  });

  it("键集合不同或类型不同时不复用 prev", () => {
    expect(shareStructure({ a: 1 }, { a: 1, b: undefined })).toEqual({ a: 1, b: undefined });
    expect(shareStructure({ a: 1, b: 2 }, { a: 1 })).toEqual({ a: 1 });
    expect(shareStructure([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
    const arr = [1];
    expect(shareStructure({ 0: 1 }, arr)).toBe(arr);
    expect(shareStructure(1, 2)).toBe(2);
  });

  it("数组元素逐个共享", () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [{ id: 1 }, { id: 3 }];
    const shared = shareStructure(prev, next);
    expect(shared[0]).toBe(prev[0]);
    expect(shared[1]).toBe(next[1]);
  });
});

describe("ConversationRowPool", () => {
  it("同 topic 同 rowId 的内容相同行复用旧对象", () => {
    const pool = new ConversationRowPool();
    const first = pool.shareRow("conversation/s1", bigToolRow(1));
    const again = pool.shareRow("conversation/s1", fresh(bigToolRow(1)));
    expect(again).toBe(first);
  });

  it("行状态变化时复用未变的大输入", () => {
    const pool = new ConversationRowPool();
    const first = pool.shareRow("conversation/s1", bigToolRow(1)) as ToolCallRow;
    const done = pool.shareRow("conversation/s1", fresh(bigToolRow(1, "success"))) as ToolCallRow;
    expect(done).not.toBe(first);
    expect(done.status).toBe("success");
    expect(done.input).toBe(first.input);
    // 字符串无法用 toBe 区分引用，这里至少确保值正确；引用复用由 heap snapshot 验证。
    expect(done.inputText).toBe(first.inputText);
  });

  it("不同 topic 不共享", () => {
    const pool = new ConversationRowPool();
    const a = pool.shareRow("conversation/s1", bigToolRow(1));
    const b = pool.shareRow("conversation/s2", fresh(bigToolRow(1)));
    expect(b).not.toBe(a);
  });

  it("remember 登记的行供后续共享", () => {
    const pool = new ConversationRowPool();
    const streamed = bigToolRow(1);
    pool.remember("conversation/s1", streamed);
    expect(pool.shareRow("conversation/s1", fresh(streamed))).toBe(streamed);
  });

  it("shareWindow 在所有行都未变化时复用 prev 数组", () => {
    const pool = new ConversationRowPool();
    const rows: ConversationRow[] = [bigToolRow(1), bigToolRow(2)];
    const window = pool.shareWindow("conversation/s1", rows);
    expect(window).toBe(rows);
    const again = pool.shareWindow("conversation/s1", fresh(rows), window);
    expect(again).toBe(window);
    const grown = pool.shareWindow("conversation/s1", fresh([...rows, bigToolRow(3)]), window);
    expect(grown).not.toBe(window);
    expect(grown[0]).toBe(window[0]);
    expect(grown[1]).toBe(window[1]);
  });
});
