// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelTrajectorySearchBar } from "@/ModelTrajectorySearchBar.js";

const labels: Record<string, string> = {
  "modelTrajectory.search": "搜索调用轨迹",
  "modelTrajectory.searchPlaceholder": "搜索调用轨迹内容…",
  "modelTrajectory.searchPrevious": "上一个匹配项",
  "modelTrajectory.searchNext": "下一个匹配项",
  "modelTrajectory.searchClose": "关闭搜索",
};

afterEach(() => vi.restoreAllMocks());

describe("ModelTrajectorySearchBar", () => {
  it("supports keyboard navigation, result count, and close", () => {
    const onMove = vi.fn();
    const onClose = vi.fn();
    const onQueryChange = vi.fn();
    render(
      createElement(ModelTrajectorySearchBar, {
        query: "needle",
        activeIndex: 1,
        matchCount: 3,
        onQueryChange,
        onMove,
        onClose,
        intl: {
          formatMessage: ({ id }: { id: string }) => labels[id] ?? id,
        } as never,
      }),
    );

    const input = screen.getByRole("searchbox", { name: "搜索调用轨迹" });
    expect(document.activeElement).toBe(input);
    expect(screen.getByText("2/3")).toBeTruthy();
    fireEvent.change(input, { target: { value: "next" } });
    expect(onQueryChange).toHaveBeenCalledWith("next");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onMove).toHaveBeenNthCalledWith(1, "next");
    expect(onMove).toHaveBeenNthCalledWith(2, "previous");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
