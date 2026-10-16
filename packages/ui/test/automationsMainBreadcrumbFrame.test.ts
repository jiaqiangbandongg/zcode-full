// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationsMainBreadcrumbFrame } from "@/settings/AutomationsMainBreadcrumbFrame.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";

afterEach(cleanup);

describe("AutomationsMainBreadcrumbFrame", () => {
  it("projects automation edit navigation into the workspace drag header", async () => {
    const onBack = vi.fn();
    render(
      createElement(
        AutomationsMainBreadcrumbFrame,
        {
          isDesktop: true,
          sectionLabel: "Automations",
          ariaLabel: "Automation path",
        },
        createElement(SettingsBreadcrumbReporter, {
          items: [{ label: "Daily summary" }],
          onSectionSelect: onBack,
        }),
      ),
    );

    expect(
      (await screen.findByRole("navigation", { name: "Automation path" }))
        .textContent,
    ).toBe("AutomationsDaily summary");
    screen.getByRole("button", { name: "Automations" }).click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("keeps the desktop drag header blank for the list level", () => {
    render(
      createElement(AutomationsMainBreadcrumbFrame, {
        isDesktop: true,
        sectionLabel: "Automations",
        ariaLabel: "Automation path",
        children: createElement("div", null, "List"),
      }),
    );

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByTestId("automations-main-drag-region")).not.toBeNull();
  });
});
