// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPresentationElementSelectedText } from "@/presentation/presentationTextSelection.js";

function domRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function appendText(surface: HTMLElement, text: string, left: number) {
  const span = document.createElement("span");
  span.dataset.left = String(left);
  span.textContent = text;
  surface.append(span);
  return span.firstChild as Text;
}

function installRangeRects() {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value(this: Range) {
      const parent = this.startContainer.parentElement;
      return parent ? [domRect(Number(parent.dataset.left), 120, 160, 20)] : [];
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe("getPresentationElementSelectedText", () => {
  it("跨多个元素划选时只返回当前高亮元素内部的文本", () => {
    installRangeRects();
    const surface = document.createElement("div");
    document.body.append(surface);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 1_000, 500),
    );
    const before = appendText(surface, "Before element", 40);
    appendText(surface, "Current selected words", 340);
    appendText(surface, "Overlapping foreign text", 400);
    const after = appendText(surface, "After element", 760);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(before, 7);
    range.setEnd(after, 5);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      getPresentationElementSelectedText({
        selection: selection ?? null,
        renderSurface: surface,
        pageSize: { width: 1_000, height: 500 },
        elementBounds: { x: 300, y: 100, width: 300, height: 100 },
        elementText: "Current selected words",
      }),
    ).toBe("Current selected words");
  });

  it("从当前元素划选到其它元素时保留当前元素内的部分文本", () => {
    installRangeRects();
    const surface = document.createElement("div");
    document.body.append(surface);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 1_000, 500),
    );
    const current = appendText(surface, "Current selected words", 340);
    const after = appendText(surface, "After element", 760);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(current, 8);
    range.setEnd(after, 5);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      getPresentationElementSelectedText({
        selection: selection ?? null,
        renderSurface: surface,
        pageSize: { width: 1_000, height: 500 },
        elementBounds: { x: 300, y: 100, width: 300, height: 100 },
        elementText: "Current selected words",
      }),
    ).toBe("selected words");
  });

  it("选区折叠或完全位于其它元素时返回 null", () => {
    installRangeRects();
    const surface = document.createElement("div");
    document.body.append(surface);
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(
      domRect(0, 0, 1_000, 500),
    );
    const outside = appendText(surface, "Outside", 40);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(outside);
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(
      getPresentationElementSelectedText({
        selection: selection ?? null,
        renderSurface: surface,
        pageSize: { width: 1_000, height: 500 },
        elementBounds: { x: 300, y: 100, width: 300, height: 100 },
        elementText: "Current selected words",
      }),
    ).toBeNull();

    selection?.collapse(outside, 2);
    expect(
      getPresentationElementSelectedText({
        selection: selection ?? null,
        renderSurface: surface,
        pageSize: { width: 1_000, height: 500 },
        elementBounds: { x: 300, y: 100, width: 300, height: 100 },
        elementText: "Current selected words",
      }),
    ).toBeNull();
  });
});
