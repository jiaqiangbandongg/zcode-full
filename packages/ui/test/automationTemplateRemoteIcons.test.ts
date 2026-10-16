// @vitest-environment jsdom

import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";
import { OffPeakTemplateIcon } from "@/settings/OffPeakTemplateIcon.js";

describe("automation template Client Scenes icons", () => {
  it("renders a scheduled img value as a Lucide icon name and inherits color", async () => {
    const view = render(
      createElement(
        "span",
        { className: "text-foreground" },
        createElement(AutomationScheduledTemplateIcon, {
          iconName: "calendar-clock",
          name: "target",
        }),
      ),
    );

    await waitFor(() => {
      expect(
        view.container.querySelector('[data-client-scene-lucide-icon="calendar-clock"]'),
      ).not.toBeNull();
    });
    const icon = view.container.querySelector("svg");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    expect(icon?.className.baseVal).not.toContain("text-foreground");
    expect(icon?.parentElement?.classList.contains("text-foreground")).toBe(true);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg.lucide-target")).toBeNull();
  });

  it("renders an idle img value by name and falls back for an unknown name", async () => {
    const view = render(
      createElement(OffPeakTemplateIcon, {
        iconName: "file-text",
        name: "ciFlakyReport",
      }),
    );

    await waitFor(() => {
      expect(
        view.container.querySelector('[data-client-scene-lucide-icon="file-text"]'),
      ).not.toBeNull();
    });
    expect(view.container.querySelector("img")).toBeNull();

    view.rerender(
      createElement(OffPeakTemplateIcon, {
        iconName: "https://cdn.example.com/off-peak-template.svg",
        name: "ciFlakyReport",
      }),
    );

    expect(view.container.querySelector("[data-client-scene-lucide-icon]")).toBeNull();
    expect(view.container.querySelector("svg.lucide-activity")).not.toBeNull();
  });
});
