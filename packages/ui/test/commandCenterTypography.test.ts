// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandCenterSearchHistoryEntry } from "@/command-center/commandCenterSearchHistory.js";
import {
  CommandCenterConversationTimestamp,
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
  it("使用 text-ui-base 而非过小的 text-ui-xs", () => {
    render(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "全部", onClick: vi.fn() },
        createElement("span", { "data-testid": "icon" }),
      ),
    );

    const tab = screen.getByRole("tab", { name: "全部" });
    expect(tab.className).toContain("text-ui-base");
    expect(tab.className).not.toContain("text-ui-xs");
  });

  it("点击时触发 onClick", () => {
    const onClick = vi.fn();
    render(
      createElement(
        CommandCenterScopeButton,
        { active: false, label: "命令", onClick },
        null,
      ),
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

describe("CommandCenterConversationTimestamp", () => {
  it("使用 text-ui-sm 而非 text-ui-xs", () => {
    render(
      createElement(
        CommandCenterConversationTimestamp,
        null,
        "2小时前",
      ),
    );

    const span = screen.getByText("2小时前");
    expect(span.className).toContain("text-ui-sm");
    expect(span.className).not.toContain("text-ui-xs");
  });
});

function makeEntry(overrides: Partial<CommandCenterSearchHistoryEntry> = {}): CommandCenterSearchHistoryEntry {
  return {
    query: "登录",
    scope: "all",
    updatedAt: 1700000000000,
    ...overrides,
  };
}

describe("CommandCenterSearchHistory", () => {
  function renderHistory(
    overrides: Record<string, unknown> = {},
  ) {
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

  it("分区标题使用 text-ui-sm", () => {
    renderHistory();
    const heading = screen.getByText("历史搜索");
    expect(heading.className).not.toContain("text-ui");
    // 标题在 div 容器上，向上取父元素校验
    const container = heading.parentElement;
    expect(container?.className ?? "").toContain("text-ui-sm");
  });

  it("历史 chip 搜索词使用 text-ui-base，scope 前缀保持 text-ui-xs", () => {
    renderHistory({
      entries: [makeEntry({ query: "登录", scope: "commands" })],
    });

    // chip 是 button；点击它再检查 className
    const chip = screen.getByText("登录").closest("button");
    expect(chip).not.toBeNull();
    expect(chip!.className).toContain("text-ui-base");
    expect(chip!.className).not.toContain("text-ui-xs");

    // commands scope 的前缀是 ">"，作为 badge 保持 text-ui-xs
    const prefix = screen.getByText(">");
    expect(prefix.className).toContain("text-ui-xs");
  });

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

  // CR-01: text-ui-base 会随 --ui-font-size（12–20px）缩放，但固定高度 h-5(20px
  // border-box) 不会变化。字号调到 20px 时，扣除 2px 边框后内容区仅剩 18px，
  // 无法容纳 20px 字体的行盒，配合外层 overflow-hidden 会导致文字上下裁切。
  // 可缩放 UI 文本禁止绑定固定高度，与 uiFontTokenMigration 的约束同源。
  it("历史 chip 不用固定高度 h-5 限制可缩放的 text-ui-base", () => {
    renderHistory({
      entries: [makeEntry({ query: "登录" })],
    });

    const chip = screen.getByText("登录").closest("button");
    expect(chip).not.toBeNull();
    // 可缩放文本应使用 min-h + 行高，而非固定高度 h-5（min-h-5 是允许的）
    expect(chip!.className).not.toMatch(/(^| )h-5( |$)/);
    // 必须用 min-h-5 让高度随字号增长
    expect(chip!.className).toContain("min-h-5");
    expect(chip!.className).toContain("leading-none");
  });
});
