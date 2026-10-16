// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTrajectorySearchHighlights,
  clearTrajectorySearchHighlights,
  isTrajectorySearchTargetMounted,
  scrollTrajectorySearchRangeIntoView,
} from "@/ModelTrajectorySearchHighlight.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("model trajectory search highlights", () => {
  it("detects whether the active target is already mounted", () => {
    document.body.innerHTML = `
      <div id="root">
        <div data-trajectory-search-target-key="call-1:input:0"></div>
      </div>`;
    const root = document.querySelector("#root") as HTMLElement;

    expect(isTrajectorySearchTargetMounted(root, "call-1:input:0")).toBe(true);
    expect(isTrajectorySearchTargetMounted(root, "call-2:input:0")).toBe(false);
  });

  it("only scrolls when the active range is outside the scroll viewport", () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.scrollTop = 100;
    scrollContainer.getBoundingClientRect = () =>
      ({ top: 100, bottom: 300, height: 200 }) as DOMRect;
    const visibleRange = {
      getBoundingClientRect: () => ({ top: 140, bottom: 160, height: 20 }) as DOMRect,
    } as Range;
    const hiddenRange = {
      getBoundingClientRect: () => ({ top: 360, bottom: 380, height: 20 }) as DOMRect,
    } as Range;

    expect(scrollTrajectorySearchRangeIntoView(visibleRange, scrollContainer)).toBe(false);
    expect(scrollContainer.scrollTop).toBe(100);
    expect(scrollTrajectorySearchRangeIntoView(hiddenRange, scrollContainer)).toBe(true);
    expect(scrollContainer.scrollTop).toBe(270);
  });

  it("registers normal and active ranges for mounted search fields", () => {
    const layers = new Map<string, unknown>();
    class TestHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    Object.defineProperty(window, "Highlight", { configurable: true, value: TestHighlight });
    vi.stubGlobal("CSS", {
      highlights: {
        set: (name: string, value: unknown) => layers.set(name, value),
        delete: (name: string) => layers.delete(name),
      },
    });
    document.body.innerHTML = `
      <div id="root">
        <div data-state="open" data-trajectory-search-target-key="row-1">
          <div data-trajectory-message-expanded>
            <pre data-trajectory-search-field="content">Alpha\n beta alpha</pre>
          </div>
        </div>
      </div>`;
    const match = {
      key: "row-1:content:1:12",
      callKey: "call-1",
      callIndex: 0,
      expansionKey: "row-1",
      field: "content" as const,
      fieldMatchIndex: 1,
      sourceStart: 12,
      sourceEnd: 17,
      sourceText: "Alpha\n beta alpha",
    };

    const activeRange = applyTrajectorySearchHighlights({
      root: document.querySelector("#root") as HTMLElement,
      query: "alpha",
      matches: [match],
      activeMatch: match,
    });

    expect(activeRange?.toString()).toBe("alpha");
    expect(layers.has("zcode-model-trajectory-find")).toBe(true);
    expect(layers.has("zcode-model-trajectory-find-active")).toBe(true);
    clearTrajectorySearchHighlights();
    expect(layers.size).toBe(0);
  });
});
