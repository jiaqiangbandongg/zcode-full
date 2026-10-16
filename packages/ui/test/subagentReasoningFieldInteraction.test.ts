// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  SubagentReasoningField,
  type SubagentReasoningFieldState,
} from "@/settings/SubagentReasoningField.js";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;

  constructor(
    type: string,
    init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
  ) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}

const intl = {
  formatMessage({ id }: { id: string }) {
    return id;
  },
};

const option: ZCodeConfigOption = {
  id: "thought_level",
  category: "thought_level",
  type: "select",
  currentValue: "high",
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
  ],
};

function renderField(state: SubagentReasoningFieldState, onValueCommit = vi.fn()) {
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(SubagentReasoningField, {
        disabled: false,
        intl,
        labelVisibilityClassName: "inline-flex",
        onValueCommit,
        state,
      }),
    ),
  );
}

describe("SubagentReasoningField interaction ownership", () => {
  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: TestPointerEvent,
    });
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: {
        configurable: true,
        value: () => false,
      },
      releasePointerCapture: {
        configurable: true,
        value: () => undefined,
      },
      scrollIntoView: {
        configurable: true,
        value: () => undefined,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("closes an open menu as soon as catalog capability becomes unavailable", async () => {
    const readyState: SubagentReasoningFieldState = {
      kind: "supported",
      option,
    };
    const unavailableState: SubagentReasoningFieldState = {
      kind: "unknown",
      status: "unavailable",
    };
    const view = renderField(readyState);

    const trigger = screen.getByTestId("chat-thought-level-select-trigger");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(SubagentReasoningField, {
          disabled: false,
          intl,
          labelVisibilityClassName: "inline-flex",
          onValueCommit: vi.fn(),
          state: unavailableState,
        }),
      ),
    );

    await act(async () => undefined);
    expect(trigger.isConnected).toBe(false);
    expect(screen.queryByRole("listbox")).toBeNull();

    view.rerender(
      createElement(
        TooltipProvider,
        null,
        createElement(SubagentReasoningField, {
          disabled: false,
          intl,
          labelVisibilityClassName: "inline-flex",
          onValueCommit: vi.fn(),
          state: readyState,
        }),
      ),
    );

    expect(
      screen.getByTestId("chat-thought-level-select-trigger").getAttribute("aria-expanded"),
    ).toBe("false");
  });
});
