import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OffPeakTemplateIcon,
  type OffPeakTemplateIconName,
} from "@/settings/OffPeakTemplateIcon.js";

describe("OffPeakTemplateIcon", () => {
  it.each([
    ["standupGitSummary", "lucide-list"],
    ["ciFlakyReport", "lucide-activity"],
    ["customize", "lucide-sliders-horizontal"],
    ["standupGitSummarySecondary", "lucide-list"],
    ["followUpMonitor", "lucide-list-checks"],
  ] as const)("maps %s to %s", (name, lucideClass) => {
    const html = renderToStaticMarkup(
      createElement(OffPeakTemplateIcon, {
        name: name as OffPeakTemplateIconName,
      }),
    );

    expect(html).toContain(lucideClass);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain(`data-off-peak-template-icon="${name}"`);
    expect(html).not.toContain("lucide-moon");
  });
});
