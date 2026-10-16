import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../src/components/ui/collapsible.js";

describe("Collapsible", () => {
  it("keeps the closed animation end frame while content is still mounted", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: false },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, { forceMount: true }, "Details"),
      ),
    );

    expect(html).toContain("data-[state=closed]:[animation-fill-mode:forwards]");
    expect(html).toContain(
      "group-data-[state=closed]/collapsible-content:[animation-fill-mode:forwards]",
    );
    expect(html).toContain('data-slot="collapsible-content"');
    expect(html).toContain('data-state="closed"');
    const contentTag = html.match(
      /<div[^>]*data-slot="collapsible-content"[^>]*>/,
    )?.[0];
    expect(contentTag).toBeDefined();
    expect(contentTag).not.toMatch(/\shidden(?:=|\s|>)/u);
  });

  it("does not expose collapsible animation layers to default CSS transitions", () => {
    const html = renderToStaticMarkup(
      createElement(
        Collapsible,
        { defaultOpen: true },
        createElement(CollapsibleTrigger, null, "Toggle"),
        createElement(CollapsibleContent, null, "Details"),
      ),
    );

    expect(html).toContain("transition-none");
    expect(html).toContain(
      "transition-none duration-300 ease-in-out group-data-[state=open]/collapsible-content:animate-in",
    );
  });
});
