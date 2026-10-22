// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";

afterEach(cleanup);

describe("SettingsSearchInput", () => {
  it("clears a controlled search through the labelled button", () => {
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
    fireEvent.click(clearButton);
    expect(onClear).toHaveBeenCalledOnce();
  });
});
