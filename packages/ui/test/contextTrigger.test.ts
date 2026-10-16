import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Context,
  ContextTrigger,
} from "../src/components/ai-elements/context.js";

describe("ContextTrigger", () => {
  it("renders the default trigger as an icon-only button", () => {
    const html = renderToStaticMarkup(
      createElement(
        Context,
        { maxTokens: 200000, usedTokens: 1234 },
        createElement(ContextTrigger, {
          "aria-label": "上下文已用 1,234 / 总量 200,000",
        }),
      ),
    );

    expect(html).toContain("data-size=\"icon-md\"");
    expect(html).toContain("aria-label=\"上下文已用 1,234 / 总量 200,000\"");
    expect(html).toContain("aria-hidden=\"true\"");
    expect(html).toContain("class=\"size-3.5\"");
    expect(html).not.toContain("height=\"24\"");
    expect(html).not.toContain("width=\"24\"");
    expect(html).not.toContain("1.2K/200K");
  });
});
