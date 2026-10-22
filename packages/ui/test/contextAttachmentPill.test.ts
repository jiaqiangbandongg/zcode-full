// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { FileIcon } from "lucide-react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

afterEach(() => document.body.replaceChildren());

describe("ContextAttachmentPill", () => {
  it("opens context details and removes through one pill trigger", async () => {
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

    fireEvent.pointerEnter(trigger);
    await screen.findByText("Context details");

    const removeButton = screen.getByRole("button", { name: "Remove context" });

    fireEvent.click(removeButton);
    expect(onRemoveAll).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[aria-label="1 context"]')).toHaveLength(1);
  });
});
