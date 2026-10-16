// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ZCodeConfigOption } from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

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

function renderControl(params?: {
  disabled?: boolean;
  onCurrentValueCommit?: (value: string) => void;
  onValueChange?: (value: string) => void;
}) {
  return render(
    createElement(
      TooltipProvider,
      null,
      createElement(ThoughtLevelCycleControl, {
        disabled: params?.disabled,
        intl,
        onCurrentValueCommit: params?.onCurrentValueCommit,
        onValueChange: params?.onValueChange ?? vi.fn(),
        option,
        restoreFocusSelector: null,
        triggerRef: { current: null },
      }),
    ),
  );
}

function openSelect() {
  const trigger = screen.getByRole("combobox");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return trigger;
}

function getOption(value: string) {
  return screen.getByTestId(`chat-thought-level-select-item-${value}`);
}

describe("ThoughtLevelCycleControl selection commit", () => {
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

  it("keeps the effective default selected and commits a mouse confirmation", async () => {
    const onValueChange = vi.fn();
    const onCurrentValueCommit = vi.fn();
    renderControl({ onCurrentValueCommit, onValueChange });

    const trigger = openSelect();
    const currentOption = getOption("high");
    expect(currentOption.getAttribute("data-state")).toBe("checked");

    fireEvent.pointerDown(currentOption, {
      button: 0,
      pointerId: 2,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(currentOption, {
      button: 0,
      pointerId: 2,
      pointerType: "mouse",
    });

    await act(async () => undefined);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onCurrentValueCommit).toHaveBeenCalledOnce();
    expect(onCurrentValueCommit).toHaveBeenCalledWith("high");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it.each(["Enter", " "])(
    "commits a keyboard confirmation with %s",
    async (key) => {
      const onCurrentValueCommit = vi.fn();
      renderControl({ onCurrentValueCommit });

      openSelect();
      fireEvent.keyDown(getOption("high"), { key });

      await act(async () => undefined);
      expect(onCurrentValueCommit).toHaveBeenCalledOnce();
      expect(onCurrentValueCommit).toHaveBeenCalledWith("high");
    },
  );

  it("commits a touch tap on the current value", async () => {
    const onCurrentValueCommit = vi.fn();
    renderControl({ onCurrentValueCommit });

    openSelect();
    const currentOption = getOption("high");
    fireEvent.pointerDown(currentOption, {
      button: 0,
      pointerId: 3,
      pointerType: "touch",
    });
    fireEvent.pointerUp(currentOption, {
      button: 0,
      pointerId: 3,
      pointerType: "touch",
    });
    fireEvent.click(currentOption);

    await act(async () => undefined);
    expect(onCurrentValueCommit).toHaveBeenCalledOnce();
    expect(onCurrentValueCommit).toHaveBeenCalledWith("high");
  });

  it("does not commit a touch scroll that ends over the current item", async () => {
    const onCurrentValueCommit = vi.fn();
    renderControl({ onCurrentValueCommit });

    openSelect();
    const currentOption = getOption("high");
    fireEvent.pointerDown(currentOption, {
      button: 0,
      clientY: 10,
      pointerId: 4,
      pointerType: "touch",
    });
    fireEvent.pointerMove(currentOption, {
      button: 0,
      clientY: 80,
      pointerId: 4,
      pointerType: "touch",
    });
    fireEvent.pointerUp(currentOption, {
      button: 0,
      clientY: 80,
      pointerId: 4,
      pointerType: "touch",
    });

    await act(async () => undefined);
    expect(onCurrentValueCommit).not.toHaveBeenCalled();
  });

  it("does not treat typeahead Space as a selection commit", async () => {
    const onCurrentValueCommit = vi.fn();
    renderControl({ onCurrentValueCommit });

    openSelect();
    const currentOption = getOption("high");
    fireEvent.keyDown(currentOption, { key: "h" });
    fireEvent.keyDown(currentOption, { key: " " });

    await act(async () => undefined);
    expect(onCurrentValueCommit).not.toHaveBeenCalled();
  });
});
