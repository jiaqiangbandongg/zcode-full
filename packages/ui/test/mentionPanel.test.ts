import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildVirtualRows,
  MentionPanel,
  type MentionPanelSection,
} from "../src/mentions/components/MentionPanel.js";
import { resolveVerticalScrollMaskState } from "../src/mentions/components/scrollMask.js";

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt-${i}`,
    label: `Option ${i}`,
    description: `Description ${i}`,
  }));
}

describe("buildVirtualRows", () => {
  it("keeps the project heading when # has only one matching group", () => {
    const rows = buildVirtualRows([
      {
        id: "project-p",
        title: "Project p",
        options: makeOptions(1),
        emptyText: "Empty",
        showHeader: true,
      },
    ]);
    expect(rows[0]).toEqual({ kind: "section_header", sectionId: "project-p", title: "Project p" });
  });
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
      {
        id: "files",
        title: "Files",
        options: [],
        emptyText: "No files",
        loading: true,
        loadingText: "Loading...",
      },
    ];
    const rows = buildVirtualRows(sections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "status", content: "loading", text: "Loading..." });
  });

  it("shows error status row when section has error", () => {
    const sections: MentionPanelSection[] = [
      {
        id: "files",
        title: "Files",
        options: [],
        emptyText: "No files",
        errorText: "Failed to load",
      },
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
    expect(html.indexOf('role="listbox"')).toBeLessThan(html.indexOf("Type to search"));
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
