// @vitest-environment jsdom
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

afterEach(cleanup);

describe("SettingsSearchInput", () => {
  it("uses the shared settings search geometry", () => {
    const { container } = render(
      createElement(SettingsSearchInput, { placeholder: "Search" }),
    );

    const input = screen.getByRole("searchbox");
    expect(input.className).toContain("h-9");
    expect(input.className).toContain("rounded-xl");
    expect(input.className).toContain("pl-9");
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "size-4",
    );
  });

  it("uses an X icon button to clear a controlled search", () => {
    const onClear = vi.fn();
    render(
      createElement(SettingsSearchInput, {
        clearLabel: "Clear search",
        clearTestId: "settings-search-clear-test",
        onChange: vi.fn(),
        onClear,
        value: "plugin",
      }),
    );

    const clearButton = screen.getByRole("button", { name: "Clear search" });
    expect(clearButton.getAttribute("data-testid")).toBe("settings-search-clear-test");
    expect(clearButton.getAttribute("data-size")).toBe("icon-sm");
    expect(clearButton.className).toContain("rounded-full");
    expect(clearButton.querySelector("svg")?.getAttribute("class")).toContain(
      "size-3.5",
    );
    fireEvent.click(clearButton);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it.each([
    "HooksSection",
    "SubagentsSection",
    "PluginStoreListView",
  ])("is reused by %s", (name) => {
    const source = readFileSync(`packages/ui/src/settings/${name}.tsx`, "utf8");
    expect(source).toContain("<SettingsSearchInput");
  });

  it("aligns Skills filter rounding with the search input", () => {
    const skillsFilter = readFileSync(
      "packages/ui/src/settings/EnabledStatusFilterSelect.tsx",
      "utf8",
    );
    expect(skillsFilter).toContain("h-9 w-full justify-between rounded-xl");
  });
});
