/** @vitest-environment jsdom */
import { createElement } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserUseTabIcon } from "@/app-shell/BrowserUseTabIcon.js";
import { BROWSER_USE_OPERATION_INDICATOR_DURATION_MS } from "@/lib/workspaceSidePane.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BrowserUseTabIcon", () => {
  it("keeps the mouse indicator for five seconds and then restores the favicon", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00.000Z"));
    const operationUntil = Date.now() + BROWSER_USE_OPERATION_INDICATOR_DURATION_MS;
    const view = render(
      createElement(BrowserUseTabIcon, {
        tab: {
          id: "browser-use:tab-1",
          type: "browser-use",
          sessionId: "sess-1",
          tabId: "tab-1",
          faviconUrl: "https://example.com/favicon.ico",
          browserUseOperationUntil: operationUntil,
        },
      }),
    );

    const indicator = view.container.querySelector(
      '[data-browser-use-operation-indicator="active"]',
    );
    expect(indicator).not.toBeNull();
    expect(view.container.querySelector("img")).toBeNull();

    act(() => vi.advanceTimersByTime(BROWSER_USE_OPERATION_INDICATOR_DURATION_MS - 1));
    expect(
      view.container.querySelector('[data-browser-use-operation-indicator="active"]'),
    ).not.toBeNull();

    act(() => vi.advanceTimersByTime(1));
    expect(view.container.querySelector("[data-browser-use-operation-indicator]")).toBeNull();
    const favicon = view.container.querySelector("img");
    expect(favicon?.getAttribute("src")).toBe("https://example.com/favicon.ico");
    expect(favicon?.getAttribute("referrerpolicy")).toBe("no-referrer");

    fireEvent.error(favicon as HTMLImageElement);
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });
});
