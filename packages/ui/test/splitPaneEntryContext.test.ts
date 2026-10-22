import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useV4SplitPaneEntry, V4SplitPaneEntryProvider } from "@/v4/splitPaneEntryContext.js";

function readEntry(enabled: boolean): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  function Probe() {
    captured = { ...useV4SplitPaneEntry() };
    return null;
  }
  renderToStaticMarkup(createElement(V4SplitPaneEntryProvider, { enabled }, createElement(Probe)));
  return captured;
}

describe("V4SplitPaneEntryProvider", () => {
  // 「在分屏打开」已下线，context 只保留任务行拖拽（移动到项目）的可用性开关。
  it("only exposes whether session rows may start a drag", () => {
    expect(readEntry(true)).toEqual({ enabled: true });
    expect(readEntry(false)).toEqual({ enabled: false });
  });
});
