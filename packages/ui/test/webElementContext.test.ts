import { describe, expect, it } from "vitest";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "@/lib/webElementContext.js";

describe("webElementContext", () => {
  const baseContext: WebElementContextComposerAttachment = {
    id: "web-element-1",
    workspacePath: "/workspace",
    pageUrl: "https://example.com/checkout",
    pageTitle: "Checkout",
    tagName: "button",
    role: "button",
    accessibleName: "Submit order",
    selector: 'main form button[type="submit"]',
    xpath: "/html/body/main/form/button[1]",
    text: "Submit order",
    nearbyText: "Checkout Total: $42.00 Submit order",
    htmlExcerpt: '<button type="submit">Submit order</button>',
    attributes: {
      type: "submit",
      "aria-label": "Submit order",
    },
    rect: {
      x: 10,
      y: 20,
      width: 120,
      height: 32,
    },
    style: {
      backgroundColor: "#FFFFFF",
      color: "#18202F",
      display: "inline-flex",
      fontFamily: "Inter, ui-sans-serif",
      fontSize: "16px",
      fontWeight: "600",
    },
    capturedAt: 1_716_000_000_000,
  };

  it("appends selected web element context as markdown", () => {
    const prompt = buildPromptWithWebElementContexts("What is this button?", [baseContext]);

    expect(prompt).toContain("What is this button?");
    expect(prompt).toContain("# Web page elements:");
    expect(prompt).toContain("URL: https://example.com/checkout");
    expect(prompt).toContain("Accessible name: Submit order");
    expect(prompt).toContain("Color: #18202F");
    expect(prompt).toContain("Font: 16px Inter, ui-sans-serif");
    expect(prompt).toContain("HTML excerpt:");
    expect(prompt).toContain("<button");
  });

  it("parses web element blocks back into visible content and chips", () => {
    const prompt = buildPromptWithWebElementContexts("Explain this", [
      baseContext,
      {
        ...baseContext,
        id: "web-element-2",
        tagName: "input",
        role: "textbox",
        accessibleName: "Email",
        text: "Email",
      },
    ]);

    const parsed = parsePromptWebElementContexts(prompt, {
      workspacePath: "/workspace",
    });

    expect(parsed.visibleContent).toBe("Explain this");
    expect(parsed.webElementContexts).toHaveLength(2);
    expect(parsed.webElementContexts[0]).toMatchObject({
      pageUrl: "https://example.com/checkout",
      pageTitle: "Checkout",
      tagName: "button",
      accessibleName: "Submit order",
      style: {
        backgroundColor: "#FFFFFF",
        color: "#18202F",
        display: "inline-flex",
        fontFamily: "Inter, ui-sans-serif",
        fontSize: "16px",
        fontWeight: "600",
      },
      text: "Submit order",
    });
    expect(parsed.webElementContexts[1]).toMatchObject({
      tagName: "input",
      role: "textbox",
      accessibleName: "Email",
    });
  });
});
