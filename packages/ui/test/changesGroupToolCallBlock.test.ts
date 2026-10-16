import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ChangesGroupToolCallBlock,
  resolveFileChipAvailableWidth,
  resolveResponsiveFileChipCount,
} from "@/ToolCallBlocks/renderers/changes-group.js";

function renderChangesGroup(options: {
  running: boolean;
  forceOpen?: boolean;
  overflow?: boolean;
  multiFile?: boolean;
  singleFile?: boolean;
  unresolvedCount?: number;
}) {
  const children = options.unresolvedCount
    ? Array.from({ length: options.unresolvedCount }, (_, index) => ({
        toolId: `write-unresolved-${index}`,
        toolName: "Write",
        kind: "Write",
        title: "Write",
        input: { content: `content-${index}` },
        status: "pending",
        raw: { v4Status: "inputStreaming", inputPreviewComplete: false },
      }))
    : [
    {
      toolId: "write-1",
      toolName: "Write",
      kind: "Write",
      title: "Write",
      input: { file_path: "/workspace/src/a.ts", content: "a" },
      status: "completed",
    },
    ...(!options.singleFile ? [{
      toolId: "edit-2",
      toolName: "Edit",
      kind: "Edit",
      title: "Edit",
      input: {
        file_path: "/workspace/src/b.css",
        old_string: "b",
        new_string: "c",
      },
      status: options.running ? "in_progress" : "completed",
    }] : []),
    {
      toolId: "edit-3",
      toolName: "Edit",
      kind: "Edit",
      title: "Edit",
      input: {
        file_path: "src/a.ts",
        old_string: "a",
        new_string: "aa",
      },
      raw: {
        display: {
          kind: "file_diff",
          filePath: "/workspace/src/a.ts",
          additions: 2,
          deletions: 1,
        },
      },
      status: "completed",
    },
    ...(options.multiFile
      ? [
          {
            toolId: "edit-multi",
            toolName: "Edit",
            kind: "Edit",
            title: "Edit",
            input: {},
            raw: {
              changes: {
                "/workspace/src/a.ts": { type: "update" },
                "/workspace/src/e.tsx": { type: "update" },
              },
            },
            status: "completed",
          },
        ]
      : []),
  ];
  if (options.overflow) {
    children.push(
      {
        toolId: "write-4",
        toolName: "Write",
        kind: "Write",
        title: "Write",
        input: { file_path: "/workspace/src/c.json", content: "c" },
        status: "completed",
      },
      {
        toolId: "write-5",
        toolName: "Write",
        kind: "Write",
        title: "Write",
        input: { file_path: "/workspace/src/d.md", content: "d" },
        status: "completed",
      },
    );
  }
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(ChangesGroupToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "changes:1",
            toolName: "ChangesGroup",
            kind: "changesGroup",
            title: "Changes",
            input: {},
            status: options.running ? "in_progress" : "completed",
          },
          childToolCalls: children.map((toolCall) => ({
            toolCall,
            childToolCalls: [],
          })),
        },
        workspacePath: "/workspace",
        displayModel: {
          inlinePreview: { type: "none" },
          planResult: null,
          viewerSource: null,
          viewerLabelId: "codeViewer.viewCode",
          showSummaryFileLink: true,
          showInput: false,
          showOutput: true,
          showKind: false,
        },
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: options.running,
        statusLabel: options.running ? "Running" : "Completed",
        childToolList: null,
        forceOpen: options.forceOpen ?? false,
        canToggle: true,
        showIcon: true,
        onOpenCodeViewer: () => undefined,
      }),
    ),
  );
}

function parentSummary(html: string) {
  return html.slice(0, html.indexOf('data-slot="collapsible-content"'));
}

describe("ChangesGroupToolCallBlock", () => {
  it("uses a pencil icon for the Changes group", () => {
    const html = renderChangesGroup({ running: false });
    expect(html).toContain("lucide-pencil");
    expect(html).not.toContain("lucide-files");
  });

  it("rolls the latest editing file while running and collapsed", () => {
    const summary = parentSummary(renderChangesGroup({ running: true }));
    expect(summary).toContain("Editing");
    expect(summary).toContain("a.ts");
    expect(summary).toContain(">src</span>");
    expect(summary).toContain("2 files");
    expect(summary).toContain('aria-label="+2"');
    expect(summary).toContain('aria-label="-1"');
    expect(summary).toContain('data-animate-initial="true"');
    expect(summary.indexOf("2 files")).toBeLessThan(summary.indexOf("Editing"));
    expect(summary).toContain(
      "relative inline-flex min-w-0 items-center gap-2 overflow-hidden",
    );
  });

  it("keeps initial diff animation enabled for expanded child edits", () => {
    const html = renderChangesGroup({ running: true, forceOpen: true });
    const content = html.slice(html.indexOf('data-slot="collapsible-content"'));

    expect(content).toContain('aria-label="+2"');
    expect(content).toContain('data-animate-initial="true"');
  });

  it("uses the latest child operation when rolling a Write", () => {
    const summary = parentSummary(
      renderChangesGroup({ running: true, overflow: true }),
    );
    expect(summary).toContain("Writing");
    expect(summary).toContain("d.md");
    expect(summary).not.toContain("Editing");
  });

  it("shows the tool count before paths arrive", () => {
    const summary = parentSummary(
      renderChangesGroup({ running: true, unresolvedCount: 3 }),
    );

    expect(summary).toContain("3 tools");
    expect(summary).not.toContain("0 files");
    expect(summary).not.toContain("Writing");
  });

  it("keeps unresolved child actions visible while expanded", () => {
    const html = renderChangesGroup({
      running: true,
      forceOpen: true,
      unresolvedCount: 3,
    });
    const content = html.slice(html.indexOf('data-slot="collapsible-content"'));

    expect(content.match(/Writing/gu)).toHaveLength(3);
  });

  it.each([true, false])(
    "shows only the unique file count while expanded (running=%s)",
    (running) => {
      const summary = parentSummary(
        renderChangesGroup({ running, forceOpen: true }),
      );
      expect(summary).toContain("2 files");
      expect(summary).not.toContain("Editing");
      expect(summary).not.toContain("a.ts");
    },
  );

  it("shows count and deduplicated file chips when completed and collapsed", () => {
    const summary = parentSummary(renderChangesGroup({ running: false }));
    expect(summary).toContain("2 files");
    expect(summary.match(/>a\.ts<\/span>/gu)).toHaveLength(1);
    expect(summary.match(/>b\.css<\/span>/gu)).toHaveLength(1);
    expect(summary).toContain("<button");
  });

  it("shows the file directly without a one-file count when completed and collapsed", () => {
    const summary = parentSummary(
      renderChangesGroup({ running: false, singleFile: true }),
    );
    expect(summary).toContain(">a.ts</span>");
    expect(summary).not.toContain("1 file");
  });

  it("renders every completed file before client width measurement", () => {
    const summary = parentSummary(
      renderChangesGroup({ running: false, overflow: true }),
    );
    expect(summary).toContain("4 files");
    expect(summary).not.toContain("+1");
    expect(summary).toContain(">d.md</span>");
  });

  it("flattens a multi-file Edit before deduplicating across children", () => {
    const summary = parentSummary(
      renderChangesGroup({ running: false, multiFile: true }),
    );
    expect(summary).toContain("3 files");
    expect(summary.match(/>a\.ts<\/span>/gu)).toHaveLength(1);
    expect(summary.match(/>e\.tsx<\/span>/gu)).toHaveLength(1);
  });
});

describe("resolveFileChipAvailableWidth", () => {
  it("uses the ToolCall boundary instead of the shrink-to-content list width", () => {
    expect(
      resolveFileChipAvailableWidth({
        boundaryRight: 800,
        listLeft: 300,
        trailingWidth: 24,
      }),
    ).toBe(476);
  });

  it("never returns a negative width", () => {
    expect(
      resolveFileChipAvailableWidth({
        boundaryRight: 300,
        listLeft: 300,
        trailingWidth: 24,
      }),
    ).toBe(0);
  });
});

describe("resolveResponsiveFileChipCount", () => {
  it("shows no file chips when the composed available width is zero", () => {
    const availableWidth = resolveFileChipAvailableWidth({
      boundaryRight: 324,
      listLeft: 300,
      trailingWidth: 24,
    });

    expect(availableWidth).toBe(0);
    expect(
      resolveResponsiveFileChipCount({
        availableWidth,
        chipWidths: [50, 50],
        overflowWidth: 24,
        gap: 8,
      }),
    ).toBe(0);
  });

  it("keeps every chip when the available width is sufficient", () => {
    expect(
      resolveResponsiveFileChipCount({
        availableWidth: 500,
        chipWidths: [50, 50, 50, 50],
        overflowWidth: 24,
        gap: 8,
      }),
    ).toBe(4);
  });

  it("reserves room for +N and keeps as many leading chips as fit", () => {
    expect(
      resolveResponsiveFileChipCount({
        availableWidth: 150,
        chipWidths: [50, 50, 50, 50],
        overflowWidth: 24,
        gap: 8,
      }),
    ).toBe(2);
  });

  it("shows only +N when no file chip fits", () => {
    expect(
      resolveResponsiveFileChipCount({
        availableWidth: 20,
        chipWidths: [50, 50],
        overflowWidth: 24,
        gap: 8,
      }),
    ).toBe(0);
  });
});
