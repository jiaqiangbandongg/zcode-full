// @vitest-environment jsdom
import { Fragment, createElement, type ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resizeObserverState = vi.hoisted(() => ({
  callback: null as ResizeObserverCallback | null,
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  Tooltip: ({ children }: { children: ReactNode }) => createElement(Fragment, null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  TooltipContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "automation-schedule-tooltip" }, children),
}));

import { AutomationScheduleBadge } from "@/settings/AutomationScheduleBadge.js";

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverState.callback = callback;
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

function renderBadge() {
  render(
    createElement(AutomationScheduleBadge, {
      text: "每小时的第 05 分 · 下次运行 55 分钟后",
      icon: createElement("svg", { "aria-hidden": "true" }),
    }),
  );
}

function setTextWidths({ clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number }) {
  const text = screen.getByTestId("automation-schedule-text");
  Object.defineProperties(text, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

function notifyResize() {
  act(() => {
    resizeObserverState.callback?.([], {} as ResizeObserver);
  });
}

beforeEach(() => {
  resizeObserverState.callback = null;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AutomationScheduleBadge", () => {
  it("does not render a tooltip when the schedule text fits", () => {
    renderBadge();
    setTextWidths({ clientWidth: 240, scrollWidth: 240 });
    notifyResize();

    expect(screen.queryByTestId("automation-schedule-tooltip")).toBeNull();
  });

  it("renders the tooltip only while the schedule text is truncated", () => {
    renderBadge();
    setTextWidths({ clientWidth: 160, scrollWidth: 240 });
    notifyResize();

    expect(screen.getByTestId("automation-schedule-tooltip").textContent).toBe(
      "每小时的第 05 分 · 下次运行 55 分钟后",
    );

    setTextWidths({ clientWidth: 240, scrollWidth: 240 });
    notifyResize();

    expect(screen.queryByTestId("automation-schedule-tooltip")).toBeNull();
  });
});
