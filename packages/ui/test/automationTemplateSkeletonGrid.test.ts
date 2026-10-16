// @vitest-environment jsdom
import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationTemplateSkeletonGrid } from "@/settings/AutomationTemplateSkeletonGrid.js";

describe("AutomationTemplateSkeletonGrid", () => {
  it("renders four template-card skeletons as two desktop rows by default", () => {
    const view = render(
      createElement(AutomationTemplateSkeletonGrid, {
        label: "Loading templates",
      }),
    );
    const grid = view.getByRole("status");
    const cards = grid.querySelectorAll<HTMLElement>("[data-automation-template-skeleton-card]");

    expect(grid.textContent).toContain("Loading templates");
    expect(grid.classList.contains("grid-cols-1")).toBe(true);
    expect(grid.classList.contains("sm:grid-cols-2")).toBe(true);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      expect(card.classList.contains("min-h-[114px]")).toBe(true);
      expect(card.classList.contains("motion-safe:animate-pulse")).toBe(true);
    }
  });
});
