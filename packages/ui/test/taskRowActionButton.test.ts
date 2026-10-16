import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({
    children,
    title,
    side,
    sideOffset,
  }: {
    children: ReactNode;
    title: ReactNode;
    side?: string;
    sideOffset?: number;
  }) =>
    createElement(
      "span",
      {
        "data-control-hint-tooltip": "true",
        "data-side": side,
        "data-side-offset": sideOffset,
        "data-title": title,
      },
      children,
    ),
}));

import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";

describe("TaskRowActionButton", () => {
  it("renders the shared portal tooltip above the button", () => {
    const html = renderToStaticMarkup(
      createElement(
        TaskRowActionButton,
        {
          label: "Move to top",
          onClick: () => {},
          showTooltip: true,
        },
        "↑",
      ),
    );

    expect(html).toContain('data-control-hint-tooltip="true"');
    expect(html).toContain('data-side="top"');
    expect(html).toContain('data-side-offset="2"');
    expect(html).toContain('data-title="Move to top"');
  });

  it("uses the disabled reason as the tooltip title", () => {
    const html = renderToStaticMarkup(
      createElement(
        TaskRowActionButton,
        {
          label: "Move to top",
          disabledReason: "Already at the top",
          onClick: () => {},
          showTooltip: true,
        },
        "↑",
      ),
    );

    expect(html).toContain('data-title="Already at the top"');
    expect(html).not.toContain('data-title="Move to top"');
  });

  it("keeps draft actions tooltip-free by default", () => {
    const html = renderToStaticMarkup(
      createElement(TaskRowActionButton, { label: "Close", onClick: () => {} }, "×"),
    );

    expect(html).not.toContain("data-control-hint-tooltip");
  });

  it("forwards an optional semantic color class to the button", () => {
    const html = renderToStaticMarkup(
      createElement(
        TaskRowActionButton,
        {
          className: "text-foreground-subtle hover:text-foreground",
          label: "Show file tree",
          onClick: () => {},
        },
        "tree",
      ),
    );

    expect(html).toContain("text-foreground-subtle");
    expect(html).toContain("hover:text-foreground");
  });
});
