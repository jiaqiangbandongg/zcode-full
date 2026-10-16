// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";

const resizeObserverState = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
}));
const cancelAnimation = vi.fn();
const animateTrack = vi.fn(() => ({ cancel: cancelAnimation }) as unknown as Animation);
const originalAnimateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverState.callback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

function setTitleWidths({
  clientWidth,
  contentWidth,
}: {
  clientWidth: number;
  contentWidth: number;
}) {
  const title = screen.getByTestId("task-title-overflow-text");
  const original = title.querySelector('[data-task-title-copy="original"]');
  Object.defineProperty(title, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
  Object.defineProperty(original, "scrollWidth", {
    configurable: true,
    value: contentWidth,
  });
}

function notifyResize() {
  act(() => {
    resizeObserverState.callback?.([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  resizeObserverState.callback = null;
  animateTrack.mockClear();
  cancelAnimation.mockClear();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animateTrack,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalAnimateDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimateDescriptor);
  } else {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
});

describe("TaskTitleOverflowText", () => {
  it("does not render a native title tooltip", () => {
    render(
      createElement(
        TaskTitleOverflowText,
        { "data-testid": "task-title-overflow-text", title: "完整任务名称" },
        "很长的任务标题",
      ),
    );

    expect(screen.getByTestId("task-title-overflow-text").getAttribute("title")).toBeNull();
  });

  it("holds the aligned duplicate for two seconds before the seamless reset", () => {
    vi.useFakeTimers();
    render(
      createElement(
        "div",
        { "data-task-item-key": "task-1", "data-testid": "task-item" },
        createElement(
          TaskTitleOverflowText,
          { "data-testid": "task-title-overflow-text" },
          "很长的任务标题",
        ),
      ),
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const taskItem = screen.getByTestId("task-item");
    fireEvent.mouseEnter(taskItem);

    expect(animateTrack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(999));
    expect(animateTrack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));

    expect(animateTrack).toHaveBeenCalledTimes(2);
    expect(animateTrack.mock.calls[0]?.[0]).toEqual([
      { offset: 0, transform: "translate3d(0, 0, 0)" },
      {
        offset: 6.6 / 8.6,
        transform: "translate3d(-264px, 0, 0)",
      },
      { offset: 1, transform: "translate3d(-264px, 0, 0)" },
    ]);
    expect(animateTrack.mock.calls[0]?.[1]).toEqual({
      duration: 8_600,
      easing: "linear",
      iterations: Infinity,
    });
    expect(animateTrack.mock.calls[1]?.[0]).toEqual([
      {
        maskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
        offset: 0,
        webkitMaskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
      },
      {
        maskImage:
          "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)",
        offset: 0.15 / 8.6,
        webkitMaskImage:
          "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)",
      },
      {
        maskImage:
          "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)",
        offset: (6.6 * (240 / 264)) / 8.6,
        webkitMaskImage:
          "linear-gradient(to right, transparent 0, black 1.5rem, black calc(100% - 1.5rem), transparent 100%)",
      },
      {
        maskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
        offset: (6.6 * (240 / 264)) / 8.6,
        webkitMaskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
      },
      {
        maskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
        offset: 1,
        webkitMaskImage:
          "linear-gradient(to right, black 0, black calc(100% - 1.5rem), transparent 100%)",
      },
    ]);
    expect(animateTrack.mock.calls[1]?.[1]).toEqual({
      duration: 8_600,
      easing: "linear",
      iterations: Infinity,
    });

    fireEvent.mouseLeave(taskItem);
    expect(cancelAnimation).toHaveBeenCalledTimes(2);
  });

  it("cancels the delayed start when hover ends before one second", () => {
    vi.useFakeTimers();
    render(
      createElement(
        "div",
        { "data-task-item-key": "task-1", "data-testid": "task-item" },
        createElement(
          TaskTitleOverflowText,
          { "data-testid": "task-title-overflow-text" },
          "很长的任务标题",
        ),
      ),
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const taskItem = screen.getByTestId("task-item");
    fireEvent.mouseEnter(taskItem);
    act(() => vi.advanceTimersByTime(300));
    fireEvent.mouseLeave(taskItem);
    act(() => vi.advanceTimersByTime(1_000));

    expect(animateTrack).not.toHaveBeenCalled();
  });

  it("does not animate when reduced motion is requested", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        addEventListener: vi.fn(),
        matches: true,
        removeEventListener: vi.fn(),
      })),
    );
    render(
      createElement(
        TaskTitleOverflowText,
        { "data-testid": "task-title-overflow-text" },
        "很长的任务标题",
      ),
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    fireEvent.mouseEnter(screen.getByTestId("task-title-overflow-text"));

    expect(animateTrack).not.toHaveBeenCalled();
  });

  it("does not apply a fade mask while the title fits", () => {
    render(
      createElement(TaskTitleOverflowText, { "data-testid": "task-title-overflow-text" }, "短标题"),
    );
    setTitleWidths({ clientWidth: 160, contentWidth: 120 });
    notifyResize();

    const title = screen.getByTestId("task-title-overflow-text");
    expect(title.className).not.toContain("mask-image");
    expect(title.querySelectorAll("[data-task-title-copy]")).toHaveLength(1);
  });

  it("renders an original title and an aria-hidden copy only while overflowing", () => {
    render(
      createElement(
        TaskTitleOverflowText,
        { "data-testid": "task-title-overflow-text" },
        "很长的任务标题",
      ),
    );
    setTitleWidths({ clientWidth: 120, contentWidth: 240 });
    notifyResize();

    const title = screen.getByTestId("task-title-overflow-text");
    const copies = title.querySelectorAll("[data-task-title-copy]");
    const duplicate = title.querySelector('[data-task-title-copy="duplicate"]');
    const track = title.querySelector<HTMLElement>("[data-task-title-marquee-track]");
    expect(title.className).toContain("mask-image:linear-gradient");
    expect(copies).toHaveLength(2);
    expect(copies[0]?.textContent).toBe("很长的任务标题");
    expect(copies[1]?.textContent).toBe("很长的任务标题");
    expect(duplicate?.getAttribute("aria-hidden")).toBe("true");
    expect(track).not.toBeNull();

    setTitleWidths({ clientWidth: 240, contentWidth: 240 });
    notifyResize();

    expect(title.className).not.toContain("mask-image");
    expect(title.querySelectorAll("[data-task-title-copy]")).toHaveLength(1);
  });

  it("supports the span element used by grouped task rows", () => {
    render(
      createElement(
        TaskTitleOverflowText,
        { as: "span", "data-testid": "task-title-overflow-text" },
        "Grouped task title",
      ),
    );

    expect(screen.getByTestId("task-title-overflow-text").tagName).toBe("SPAN");
  });
});
