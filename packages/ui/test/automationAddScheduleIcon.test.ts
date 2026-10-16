import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AutomationAddScheduleIcon } from "@/settings/AutomationDesignPrimitives.js";

describe("AutomationAddScheduleIcon", () => {
  it("uses the shared Lucide Plus geometry", () => {
    const html = renderToStaticMarkup(createElement(AutomationAddScheduleIcon));

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('class="lucide lucide-plus"');
    expect(html).toContain('stroke-width="2"');
    expect(html).not.toContain("mask-image");
  });
});
