import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AutomationChevronDownIcon,
  AutomationClockIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationRefreshIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

describe("AutomationDesignPrimitives icons", () => {
  it("uses the Lucide moon on a native 24px viewBox", () => {
    const html = renderToStaticMarkup(createElement(AutomationIdleTimeIcon));

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="2"');
  });

  it("keeps the shared Lucide family displayed at 16px", () => {
    const icons = [
      AutomationInfoIcon,
      AutomationClockIcon,
      AutomationMoreHorizontalIcon,
      AutomationExternalLinkIcon,
      AutomationRefreshIcon,
    ];

    for (const Icon of icons) {
      const html = renderToStaticMarkup(createElement(Icon));
      expect(html).toContain('width="16"');
      expect(html).toContain('height="16"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke-width="2"');
      expect(html).toContain("currentColor");
    }
  });

  it("keeps Lucide chevrons in 20px and 18px containers", () => {
    const chevronHtml = renderToStaticMarkup(
      createElement(AutomationChevronDownIcon, { size: 14 }),
    );
    const compactChevronHtml = renderToStaticMarkup(
      createElement(AutomationChevronDownIcon, {
        size: 14,
        containerSize: 18,
      }),
    );
    const trashHtml = renderToStaticMarkup(createElement(AutomationTrashIcon));

    expect(chevronHtml).toContain("size-5");
    expect(chevronHtml).toContain('viewBox="0 0 24 24"');
    expect(chevronHtml).toContain('stroke-width="2"');
    expect(compactChevronHtml).toContain("size-4.5");
    expect(compactChevronHtml).not.toContain("size-5");
    expect(trashHtml).toContain("size-5");
    expect(trashHtml).toContain('viewBox="0 0 24 24"');
  });
});
