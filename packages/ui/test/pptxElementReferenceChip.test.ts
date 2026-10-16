// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import { PptxElementReferenceChip } from "@/v4/composer/PptxElementReferenceChip.js";

function makeReference(): PptxElementReference {
  return {
    bounds: { x: 10, y: 20, width: 300, height: 80 },
    capturedAt: 1,
    id: "reference-1",
    nodeId: "7",
    nodeName: "Title",
    nodeType: "shape",
    slideIndex: 2,
    slidePart: "ppt/slides/slide3.xml",
    sourceFingerprint: `sha256:${"a".repeat(64)}`,
    sourcePath: "/workspace/deck.pptx",
    sourceTitle: "deck.pptx",
    text: "Quarterly plan",
    selectedText: "Quarterly",
    comment: "Make the title more concise",
    workspacePath: "/workspace",
    zIndex: 1,
  };
}

afterEach(() => document.body.replaceChildren());

describe("PptxElementReferenceChip", () => {
  it("opens a concrete reference while keeping delete as an isolated sibling action", async () => {
    const reference = makeReference();
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PptxElementReferenceChip, {
          references: [reference],
          onOpen,
          onRemove,
        }),
      ),
    );

    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "1 slide element" }),
    );
    const referenceLabel = await screen.findByText("Quarterly");
    expect(screen.getByText("Make the title more concise")).toBeTruthy();
    const referenceButton = referenceLabel.closest("button");
    expect(referenceButton).not.toBeNull();

    fireEvent.click(referenceButton as HTMLButtonElement);
    expect(onOpen).toHaveBeenCalledWith(reference);

    fireEvent.click(screen.getByRole("button", { name: "Remove slide element" }));
    expect(onRemove).toHaveBeenCalledWith(reference.id);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
