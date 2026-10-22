import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

describe("ControlHintTooltip", () => {
  it("renders an icon button trigger without falling back to a nested Radix button", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          ControlHintTooltip,
          { title: "Send", shortcut: "Enter" },
          createElement(
            Button,
            { type: "submit", size: "icon-lg", "aria-label": "Send" },
            createElement("span", { "aria-hidden": true }, "↑"),
            createElement("span", { className: "sr-only" }, "Send"),
          ),
        ),
      ),
    );

    expect(html).toMatch(/^<button[^>]*data-slot="tooltip-trigger"/);
    expect(html).not.toContain('<span data-slot="tooltip-trigger"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('type="submit"');
  });
});
