// @vitest-environment jsdom
import { createElement, Fragment } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SettingsBreadcrumbProvider,
  SettingsBreadcrumbReporter,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";

afterEach(cleanup);

describe("SettingsHeaderBreadcrumb", () => {
  it("hides the breadcrumb when only the section level exists", () => {
    const { container } = render(
      createElement(SettingsHeaderBreadcrumb, {
        ariaLabel: "Settings path",
        items: [{ label: "Memory" }],
      }),
    );

    expect(container.childElementCount).toBe(0);
  });

  it("renders section and page levels with chevron separators", () => {
    const onOpenMemory = vi.fn();
    const onOpenProject = vi.fn();
    render(
      createElement(SettingsHeaderBreadcrumb, {
        ariaLabel: "Settings path",
        items: [
          { label: "Memory", onSelect: onOpenMemory },
          { label: "z-code", onSelect: onOpenProject },
          { label: "MEMORY.md" },
        ],
      }),
    );

    const navigation = screen.getByRole("navigation", {
      name: "Settings path",
    });
    expect(navigation.textContent).toBe("Memoryz-codeMEMORY.md");
    expect(navigation.className).toContain("px-2.5");
    expect(navigation.className).not.toContain("px-4");
    expect(navigation.querySelector("ol")?.className).toContain("gap-0");
    expect(navigation.querySelector("ol")?.className).not.toContain("gap-1");
    expect(screen.getAllByTestId("settings-breadcrumb-separator")).toHaveLength(
      2,
    );
    expect(
      screen
        .getAllByTestId("settings-breadcrumb-separator")[0]
        ?.getAttribute("class"),
    ).toContain("text-foreground-subtlest");
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByText("MEMORY.md").tagName).toBe("SPAN");
    expect(screen.getByText("MEMORY.md").className).toContain("px-2");
    expect(screen.getByText("MEMORY.md").closest("ol")?.className).toContain(
      "text-ui-base/relaxed",
    );
    expect(screen.getByRole("button", { name: "Memory" }).className).toContain(
      "[app-region:no-drag]",
    );
    expect(
      screen.getByRole("button", { name: "Memory" }).getAttribute("data-size"),
    ).toBe("default");
    expect(screen.getByRole("button", { name: "Memory" }).className).toContain(
      "text-foreground-subtle",
    );
    expect(screen.getByRole("button", { name: "Memory" }).className).toContain(
      "hover:text-foreground",
    );
    expect(
      screen.getByRole("button", { name: "Memory" }).getAttribute("data-testid"),
    ).toBe("settings-breadcrumb-section");
    expect(
      screen.getByRole("button", { name: "Memory" }).className,
    ).not.toContain("px-1");

    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    fireEvent.click(screen.getByRole("button", { name: "z-code" }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it("reports page levels through the shared provider", () => {
    const onItemsChange = vi.fn();
    const onOpenSection = vi.fn();
    const onOpenProject = vi.fn();
    render(
      createElement(
        SettingsBreadcrumbProvider,
        { onItemsChange, sectionLabel: "Memory" },
        createElement(SettingsBreadcrumbReporter, {
          items: [
            { label: "z-code", onSelect: onOpenProject },
            { label: "MEMORY.md" },
          ],
          onSectionSelect: onOpenSection,
        }),
      ),
    );

    const items = onItemsChange.mock.lastCall?.[0];
    expect(items?.map((item: { label: string }) => item.label)).toEqual([
      "Memory",
      "z-code",
      "MEMORY.md",
    ]);
    expect(items?.[0].onSelect).toEqual(expect.any(Function));
    items?.[0].onSelect?.();
    items?.[1].onSelect?.();
    expect(onOpenSection).toHaveBeenCalledOnce();
    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it("does not let a stale reporter cleanup clear a newer breadcrumb", () => {
    const onItemsChange = vi.fn();
    const renderTree = (showOld: boolean) =>
      createElement(
        SettingsBreadcrumbProvider,
        { onItemsChange, sectionLabel: "Plugin Marketplace" },
        createElement(
          Fragment,
          null,
          showOld
            ? createElement(SettingsBreadcrumbReporter, {
                key: "old",
                items: [{ label: "Plugins" }],
              })
            : null,
          createElement(SettingsBreadcrumbReporter, {
            key: "new",
            items: [{ label: "Plugins" }, { label: "New MCP server" }],
          }),
        ),
      );

    const view = render(renderTree(true));
    view.rerender(renderTree(false));

    expect(
      onItemsChange.mock.lastCall?.[0].map(
        (item: SettingsBreadcrumbItem) => item.label,
      ),
    ).toEqual(["Plugin Marketplace", "Plugins", "New MCP server"]);
  });
});
