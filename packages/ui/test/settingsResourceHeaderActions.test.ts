// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

afterEach(cleanup);

describe("SettingsResourceHeaderActions", () => {
  it("hides unsupported actions", () => {
    const onRefresh = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(SettingsResourceHeaderActions, { onRefresh }),
        ),
      ),
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Refresh");
    fireEvent.click(buttons[0]!);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New" })).toBeNull();
  });

  it("shows only implemented overflow actions in overflow, Refresh, New order", () => {
    const onImport = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(SettingsResourceHeaderActions, {
            onImport,
            onRefresh: vi.fn(),
            onNew: vi.fn(),
          }),
        ),
      ),
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["", "", "New"]);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("More actions");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Refresh");

    fireEvent.pointerDown(buttons[0]!, { button: 0, ctrlKey: false });
    const menuItems = screen.getAllByRole("menuitem");
    expect(menuItems.map((item) => item.textContent)).toEqual(["Import"]);
    expect(menuItems[0]?.querySelector(".lucide-square-arrow-right-enter")).not.toBeNull();
    fireEvent.click(menuItems[0]!);
    expect(onImport).toHaveBeenCalledOnce();
  });

  it("allows a resource-specific visible create label", () => {
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(SettingsResourceHeaderActions, {
            onRefresh: vi.fn(),
            onNew: vi.fn(),
            newLabel: "Add provider",
          }),
        ),
      ),
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["", "Add provider"]);
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Add provider");
  });
});
