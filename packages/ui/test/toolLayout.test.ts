import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../src/ToolCallBlocks/ToolLayout.js";
import { handleToolSummaryActionKeyDown } from "../src/ToolCallBlocks/ToolSummaryRow.js";

describe("ToolLayout", () => {
  it("keeps collapsible detail spacing inside the animated content body", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-spacing",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          forceOpen: true,
          kindLabel: "已探索",
          primaryText: "1 个搜索",
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).toContain('class="w-full flex flex-col"');
    expect(html).not.toContain('class="w-full flex flex-col gap-2"');
    expect(html).toMatch(
      /data-testid="tool-summary-trigger-tool-layout-spacing"[^>]*class="[^"]*\binline-flex\b[^"]*\bmax-w-full\b/,
    );
    expect(html).not.toMatch(
      /data-testid="tool-summary-trigger-tool-layout-spacing"[^>]*class="[^"]*(?:^|\s)w-full(?:\s|")/,
    );
    expect(html).not.toMatch(/data-slot="collapsible-content"[^>]*class="[^"]*\bpt-2\b[^"]*"/);
    expect(html).toMatch(
      /data-slot="collapsible-content"[^>]*>[\s\S]*?<div class="pt-2"><div class="tool-detail">detail<\/div><\/div>/,
    );
  });

  it("preserves detail spacing for force-open non-toggle content", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-force-open-spacing",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          forceOpen: true,
          kindLabel: "已探索",
          primaryText: "1 个搜索",
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).not.toContain('data-slot="collapsible-content"');
    expect(html).toMatch(
      /class="[^"]*\btext-popover-foreground\b[^"]*\bpt-2\b[^"]*"><div class="tool-detail">detail<\/div>/,
    );
  });

  it("keeps running tool icons static while animating kind labels", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-running-label",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          isRunning: true,
          kindLabel: "读取",
          primaryText: "mod.rs",
        }),
      ),
    );

    expect(html).toContain("icon");
    expect(html).not.toContain("lucide-loader");
    expect(html).not.toContain("animate-spin");
    expect(html).toContain("读取");
    expect(html).toContain("animated-gradient-text");
  });

  it("does not reserve a summary content gap when an expanded tool has no summary", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-empty-expanded-summary",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          forceOpen: true,
          kindLabel: "终端",
          primaryText: null,
          renderContent: () => createElement("div", null, "detail"),
        }),
      ),
    );

    expect(html).not.toContain("tool-summary-content");
    expect(html).toMatch(
      /tool-summary-kind-label[\s\S]*?终端<\/span><svg[^>]*lucide-chevron-right/,
    );
  });

  it("prioritizes edit file content when the conversation container narrows", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-edit-file-priority",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          canToggle: false,
          kindLabel: "已编辑",
          primaryText: "long-file-name.tsx",
          prioritizePrimaryText: true,
        }),
      ),
    );

    expect(html).toMatch(
      /class="[^"]*tool-summary-kind-label[^"]*@max-\[360px\]\/conversation:hidden/,
    );
    expect(html).toMatch(/class="[^"]*tool-summary-content[^"]*flex-1[^"]*overflow-hidden/);
  });

  it("renders a summary action without collapsible semantics or inline detail", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ToolLayout, {
          toolId: "tool-layout-summary-action",
          icon: createElement("span", { "aria-hidden": true }, "icon"),
          kindLabel: "子智能体",
          primaryText: "Explore workspace",
          summaryAction: {
            ariaLabel: "在右侧打开",
            onActivate: vi.fn(),
            testId: "subagent-summary-action",
          },
          renderContent: () => createElement("div", { className: "tool-detail" }, "detail"),
        }),
      ),
    );

    expect(html).toContain('data-testid="subagent-summary-action"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-label="在右侧打开"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("tool-detail");
  });

  it("activates summary actions from Enter and Space only", () => {
    const onActivate = vi.fn();
    const preventDefault = vi.fn();

    expect(handleToolSummaryActionKeyDown({ key: "Enter", preventDefault }, onActivate)).toBe(true);
    expect(handleToolSummaryActionKeyDown({ key: " ", preventDefault }, onActivate)).toBe(true);
    expect(handleToolSummaryActionKeyDown({ key: "Escape", preventDefault }, onActivate)).toBe(
      false,
    );
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(preventDefault).toHaveBeenCalledTimes(2);
  });
});
