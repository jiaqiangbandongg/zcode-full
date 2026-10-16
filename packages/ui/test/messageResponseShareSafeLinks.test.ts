import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

describe("MessageResponse share-safe links", () => {
  it("renders an external link without requiring a Desktop platform provider", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(
            MessageResponse,
            { onOpenExternalUrl: vi.fn() },
            "[公开链接](https://example.com/share)",
          ),
        ),
      ),
    );

    expect(html).toContain("公开链接");
    expect(html).toContain("cursor-pointer");
  });
});
