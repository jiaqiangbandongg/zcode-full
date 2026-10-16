import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  buildVirtualRows,
  MentionPanel,
  SECTION_HEADER_CLASS_NAME,
  SECTION_HEADER_ROW_HEIGHT,
  type MentionPanelSection,
} from "../src/mentions/components/MentionPanel.js";
import { resolveVerticalScrollMaskState } from "../src/mentions/components/scrollMask.js";

describe("mention search hint copy", () => {
  it("只提示插件、文件和对话，不再提及画板", () => {
    expect(zhCN["chat.mention.searchHint"]).toBe(
      "输入内容以搜索插件、文件或对话",
    );
    expect(enUS["chat.mention.searchHint"]).toBe(
      "Type to search plugins, files, or conversations",
    );
  });
});

describe("mention section header typography", () => {
  it("uses the base UI font size", () => {
    expect(SECTION_HEADER_CLASS_NAME).toContain("text-ui-base");
    expect(SECTION_HEADER_CLASS_NAME).not.toContain("text-ui-xs");
  });

  it("uses the secondary foreground color", () => {
    expect(SECTION_HEADER_CLASS_NAME).toContain("text-foreground-subtle");
    expect(SECTION_HEADER_CLASS_NAME).not.toContain("text-foreground-subtlest");
  });

  it("matches the command option row height without overflowing padding", () => {
    expect(SECTION_HEADER_ROW_HEIGHT).toBe(34);
    expect(SECTION_HEADER_CLASS_NAME).toContain("h-8");
    expect(SECTION_HEADER_CLASS_NAME).toContain("items-center");
    expect(SECTION_HEADER_CLASS_NAME).not.toMatch(/\b(?:pt|pb)-/);
  });
});

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt-${i}`,
    label: `Option ${i}`,
    description: `Description ${i}`,
  }));
}

describe("buildVirtualRows", () => {
  it("returns empty array for empty sections", () => {
    expect(buildVirtualRows([])).toEqual([]);
  });

  it("produces one option row per option with correct flatOptionIndex", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(3), emptyText: "No files" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === "option")).toBe(true);

    const indices = rows
      .filter((r): r is Extract<typeof r, { kind: "option" }> => r.kind === "option")
      .map((r) => r.flatOptionIndex);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("shows loading status row when section is loading", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files", loading: true, loadingText: "Loading..." },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "loading", text: "Loading..." });
  });

  it("shows error status row when section has error", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files", errorText: "Failed to load" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "error", text: "Failed to load" });
  });

  it("shows empty status row when section has no options and is not loading", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: [], emptyText: "No files found" },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "empty", text: "No files found" });
  });

  it("assigns continuous flatOptionIndex across multiple sections", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(2), emptyText: "" },
      { id: "symbols", title: "Symbols", options: makeOptions(3), emptyText: "" },
    ];
    const rows = buildVirtualRows(sections);
    const optionRows = rows.filter(
      (r): r is Extract<typeof r, { kind: "option" }> => r.kind === "option",
    );
    expect(optionRows.map((r) => r.flatOptionIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("handles large option sets efficiently", () => {
    const sections: MentionPanelSection[] = [
      { id: "files", title: "Files", options: makeOptions(1000), emptyText: "" },
    ];
    const start = performance.now();
    const rows = buildVirtualRows(sections);
    const elapsed = performance.now() - start;

    expect(rows).toHaveLength(1000);
    expect(elapsed).toBeLessThan(50);
  });

  it("renders the optional description after the virtualized list", () => {
    const html = renderToStaticMarkup(
      createElement(MentionPanel, {
        title: "Mentions",
        description: "Type to search",
        trigger: "@",
        sections: [
          {
            id: "files",
            title: "Files",
            options: makeOptions(1),
            emptyText: "No files",
          },
        ],
        emptyText: "",
        selectedIndex: 0,
        hasActiveQuery: false,
        onSelect: () => undefined,
      }),
    );

    expect(html.indexOf('role="listbox"')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Type to search")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('role="listbox"')).toBeLessThan(
      html.indexOf("Type to search"),
    );
  });
});

describe("resolveVerticalScrollMaskState", () => {
  it("does not show masks when content does not overflow", () => {
    expect(
      resolveVerticalScrollMaskState({
        clientHeight: 100,
        scrollHeight: 100,
        scrollTop: 0,
      }),
    ).toEqual({ showBottom: false, showTop: false });
  });

  it("shows only the bottom mask at the top", () => {
    expect(
      resolveVerticalScrollMaskState({
        clientHeight: 100,
        scrollHeight: 240,
        scrollTop: 0,
      }),
    ).toEqual({ showBottom: true, showTop: false });
  });

  it("shows both masks in the middle", () => {
    expect(
      resolveVerticalScrollMaskState({
        clientHeight: 100,
        scrollHeight: 240,
        scrollTop: 64,
      }),
    ).toEqual({ showBottom: true, showTop: true });
  });

  it("shows only the top mask at the bottom", () => {
    expect(
      resolveVerticalScrollMaskState({
        clientHeight: 100,
        scrollHeight: 240,
        scrollTop: 140,
      }),
    ).toEqual({ showBottom: false, showTop: true });
  });
});
