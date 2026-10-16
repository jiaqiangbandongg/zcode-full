import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", { role: "tooltip" }, children),
  TooltipProvider: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => createElement("div", { "data-message-class": className }, children),
}));

import { UpdateReleaseNotesTooltip } from "@/UpdateReleaseNotesTooltip.js";

describe("UpdateReleaseNotesTooltip", () => {
  it("preserves the Markdown hierarchy inside rich tooltip content", () => {
    const html = renderToStaticMarkup(
      createElement(
        UpdateReleaseNotesTooltip,
        {
          locale: "en-US",
          onOpenExternalUrl: () => {},
          releaseDateLabel: "August 7, 2026",
          releaseNotesMarkdown:
            "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6\n[Release link](https://example.com)",
          releaseNotesTitle: "What's new",
        },
        createElement("button", null, "Open"),
      ),
    );

    expect(html).toContain('role="tooltip"');
    expect(html).toContain("prose-h1:text-ui-lg");
    expect(html).toContain("prose-h2:text-ui-base");
    expect(html).toContain("prose-h3:text-ui-base");
    expect(html).not.toContain("prose-h4:text-ui-sm");
    expect(html).not.toContain("prose-h5:text-ui-sm");
    expect(html).not.toContain("prose-h6:text-ui-sm");
    expect(html).not.toContain("prose-a:text-ui-sm");
  });
});
