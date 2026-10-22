// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCenterSearchHistoryEntry } from "@/command-center/commandCenterSearchHistory.js";
import {
  CommandCenterScopeButton,
  CommandCenterSearchHistory,
} from "@/command-center/CommandCenterDialog.js";

// Cmd+K 命令中心内字号语义（DESIGN.md）的固化为单测目标：
// - scope tabs / 历史 chip 搜索词：可交互/可读内容 → text-ui-base
// - 历史分区标题 / 时间戳：次要文案、helper text → text-ui-sm
// - chip scope 前缀：badge 标记 → text-ui-xs

afterEach(() => {
  cleanup();
});

describe("CommandCenterScopeButton", () => {
  it("点击时触发 onClick", () => {
    const onClick = vi.fn();
    render(
      createElement(CommandCenterScopeButton, { active: false, label: "命令", onClick }, null),
    );

    fireEvent.click(screen.getByRole("tab", { name: "命令" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("active 状态反映在 aria-selected", () => {
    const { rerender } = render(
      createElement(
        CommandCenterScopeButton,
        { active: true, label: "对话", onClick: vi.fn() },
        null,
      ),
    );

    const tab = screen.getByRole("tab", { name: "对话" });
    expect(tab.getAttribute("aria-selected")).toBe("true");

    rerender(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "对话", onClick: vi.fn() },
        null,
      ),
    );
    expect(tab.getAttribute("aria-selected")).toBe("false");
  });
});

function makeEntry(
  overrides: Partial<CommandCenterSearchHistoryEntry> = {},
): CommandCenterSearchHistoryEntry {
  return {
    query: "登录",
    scope: "all",
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe("CommandCenterSearchHistory", () => {
  function renderHistory(overrides: Record<string, unknown> = {}) {
    const props = {
      entries: [makeEntry()],
      expanded: false,
      onToggleExpanded: vi.fn(),
      onPickEntry: vi.fn(),
      onClear: vi.fn(),
      historyLabel: "历史搜索",
      clearLabel: "清除历史",
      expandLabel: "展开",
      collapseLabel: "收起",
      ...overrides,
    };
    render(createElement(CommandCenterSearchHistory, props));
    return props;
  }

  it("点击历史 chip 触发 onPickEntry", () => {
    const onPickEntry = vi.fn();
    renderHistory({ onPickEntry });

    fireEvent.click(screen.getByText("登录"));
    expect(onPickEntry).toHaveBeenCalledOnce();
    const entry = onPickEntry.mock.calls[0]![0] as CommandCenterSearchHistoryEntry;
    expect(entry.query).toBe("登录");
  });

  it("清除按钮触发 onClear", () => {
    const onClear = vi.fn();
    renderHistory({ onClear });

    fireEvent.click(screen.getByLabelText("清除历史"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("条目超过 6 条时显示展开按钮，并触发 onToggleExpanded", () => {
    const onToggleExpanded = vi.fn();
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ query: `查询${i}`, updatedAt: 1700000000000 + i }),
    );
    renderHistory({ entries, onToggleExpanded });

    const expandBtn = screen.getByLabelText("展开");
    fireEvent.click(expandBtn);
    expect(onToggleExpanded).toHaveBeenCalledOnce();
  });

  it("条目不超过 6 条时不显示展开按钮", () => {
    renderHistory();
    expect(screen.queryByLabelText("展开")).toBeNull();
    expect(screen.queryByLabelText("收起")).toBeNull();
  });
});
