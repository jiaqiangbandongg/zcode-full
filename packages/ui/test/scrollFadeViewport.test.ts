// @vitest-environment jsdom
import { createElement, createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ScrollFadeViewport", () => {
  it("forwards the actual viewport ref and preserves scrolling while updating both masks", () => {
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(300);
    const ref = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    const screen = render(createElement(ScrollFadeViewport, { ref, onScroll }, "output"));
    const viewport = ref.current!;
    expect(viewport).not.toBeNull();
    expect(viewport.dataset.scrollMask).toBe("bottom");
    viewport.scrollTop = 50;
    fireEvent.scroll(viewport);
    expect(viewport.dataset.scrollMask).toBe("both");
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    expect(viewport.dataset.scrollMask).toBe("top");
    expect(onScroll).toHaveBeenCalledTimes(2);
    expect(viewport.scrollTop).toBe(200);
    screen.unmount();
    expect(ref.current).toBeNull();
  });

  it("removes fading after content or viewport resizing without changing the scroll position", () => {
    vi.useFakeTimers();
    let height = 300;
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => height);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const ref = createRef<HTMLDivElement>();
    const screen = render(createElement(ScrollFadeViewport, { ref }, "output"));
    expect(ref.current!.dataset.scrollMask).toBe("bottom");
    height = 100;
    act(() => {
      resize();
      vi.advanceTimersByTime(20);
    });
    expect(ref.current!.dataset.scrollMask).toBe("none");
    expect(ref.current!.scrollTop).toBe(0);
    screen.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
