import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { readV4UserMessagesInBrowser } from "./e2e/helpers/mobile-message-evidence.js";

function readRows(rows: Array<{ id: string; role: string; text: string; visible?: boolean }>) {
  const nodes = rows.map((row) => ({
    innerText: row.text,
    classList: { contains: (value: string) => value === `group/${row.role}-row` },
    getAttribute: () => row.id,
    getClientRects: () => (row.visible === false ? [] : [1]),
  }));
  return runInNewContext(`(${readV4UserMessagesInBrowser.toString()})("pane")`, {
    __name: (value: unknown) => value,
    document: {
      body: { innerText: "MOBILE MOBILE DESKTOP sidebar title" },
      querySelector: () => ({ querySelectorAll: () => nodes }),
    },
  });
}

describe("手机 transcript 的输入归属证据", () => {
  it("忽略页面标题、助手引用和隐藏旧行，只保留用户行顺序", () => {
    expect(
      readRows([
        { id: "old", role: "user", text: "MOBILE", visible: false },
        { id: "a", role: "user", text: "MOBILE" },
        { id: "reply", role: "assistant", text: "MOBILE DESKTOP" },
        { id: "b", role: "user", text: "DESKTOP" },
      ]),
    ).toEqual([
      { id: "a", text: "MOBILE" },
      { id: "b", text: "DESKTOP" },
    ]);
  });
  it("同一输入出现两行必须保留重复，不能按正文或 ID 去重掩盖回放错误", () => {
    expect(
      readRows([
        { id: "same", role: "user", text: "MOBILE" },
        { id: "same", role: "user", text: "MOBILE" },
      ]),
    ).toHaveLength(2);
  });
});
