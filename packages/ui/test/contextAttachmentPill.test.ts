// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

afterEach(() => document.body.replaceChildren());

describe("ContextAttachmentPill", () => {
  it("uses symmetric horizontal padding when the conversation pill has no remove action", () => {
    render(
      createElement(
        ContextAttachmentPill,
        {
          icon: createElement(FileIcon),
          label: "Conversation context",
          removeLabel: "Remove context",
        },
        createElement("div", null, "Context details"),
      ),
    );

    const trigger = screen.getByRole("button", { name: "Conversation context" });
    expect(trigger.className).toContain("px-3");
    expect(trigger.className).not.toContain("pr-1.5");
  });

  it("keeps one pill trigger while rendering details in the hover-card portal", async () => {
    const onRemoveAll = vi.fn();
    const { container } = render(
      createElement(
        "div",
        { "data-testid": "attachment-area" },
        createElement(
          ContextAttachmentPill,
          {
            icon: createElement(FileIcon),
            label: "1 context",
            removeLabel: "Remove context",
            onRemoveAll,
          },
          createElement("div", null, "Context details"),
        ),
      ),
    );

    const area = screen.getByTestId("attachment-area");
    const trigger = screen.getByRole("button", { name: "1 context" });
    expect(trigger.parentElement).toBe(area);
    expect(trigger.className).toContain("rounded-full");
    expect(trigger.className).toContain("bg-surface");
    expect(trigger.className).toContain("pl-3");
    expect(trigger.className).toContain("pr-1.5");
    const content = trigger.querySelector(":scope > span");
    expect(content?.className).toBe("flex min-w-0 items-center gap-1.5");

    fireEvent.pointerEnter(trigger);
    const details = await screen.findByText("Context details");
    const hoverContent = details.closest('[data-slot="hover-card-content"]');
    expect(hoverContent?.className).toContain("bg-tooltip");
    expect(hoverContent?.className).toContain("border-border");
    expect(hoverContent?.className).not.toContain("bg-menu");

    const removeButton = screen.getByRole("button", { name: "Remove context" });
    expect(removeButton.className).toContain("size-5");
    expect(removeButton.className).toContain("rounded-full");
    expect(removeButton.className).toContain("text-foreground-subtle");
    expect(removeButton.className).toContain("opacity-0");
    expect(removeButton.className).toContain("group-hover:opacity-100");
    expect(removeButton.querySelector("svg")?.getAttribute("class")).toContain("size-3.5");
    fireEvent.click(removeButton);
    expect(onRemoveAll).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[aria-label="1 context"]')).toHaveLength(1);
  });
});
