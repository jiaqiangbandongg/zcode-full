// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnchoredToastStack,
  type ToastItem,
} from "@/components/ui/toast.js";

function createItem(id: number, message: string): ToastItem {
  return {
    id,
    message,
    durationMs: 0,
    position: "top-center",
    anchorId: "automations-main-toast-anchor",
  };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  document.body.replaceChildren();
});

describe("AnchoredToastStack", () => {
  it("falls back to viewport center when the anchor is missing", () => {
    const { container } = render(
      createElement(AnchoredToastStack, {
        anchorId: "automations-main-toast-anchor",
        items: [createItem(1, "fallback toast")],
        onDone: vi.fn(),
      }),
    );

    expect(screen.getByText("fallback toast")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("left-1/2");
  });

  it("still expires when the anchor is missing", () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const item = { ...createItem(3, "expiring toast"), durationMs: 10 };

    render(
      createElement(AnchoredToastStack, {
        anchorId: "automations-main-toast-anchor",
        items: [item],
        onDone,
      }),
    );

    act(() => vi.advanceTimersByTime(210));

    expect(onDone).toHaveBeenCalledWith(3);
  });

  it("falls back to viewport center when the anchor unmounts", async () => {
    const anchor = document.createElement("main");
    anchor.id = "automations-main-toast-anchor";
    anchor.getBoundingClientRect = () =>
      ({ left: 240, width: 960 }) as DOMRect;
    document.body.appendChild(anchor);

    const { container } = render(
      createElement(AnchoredToastStack, {
        anchorId: "automations-main-toast-anchor",
        items: [createItem(2, "moving toast")],
        onDone: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect((container.firstElementChild as HTMLElement).style.left).toBe("720px");
    });

    anchor.remove();

    await waitFor(() => {
      expect(container.firstElementChild?.className).toContain("left-1/2");
    });
    expect(screen.getByText("moving toast")).toBeTruthy();
  });
});
