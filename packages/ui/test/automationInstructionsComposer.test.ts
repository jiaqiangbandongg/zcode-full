// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
} from "@/settings/AutomationInstructionsComposer.js";

afterEach(() => {
  cleanup();
});

function ControlledInstructions() {
  const [value, setValue] = useState("");
  return createElement(AutomationInstructionsTextarea, {
    "aria-label": "Instructions",
    value,
    onChange: (event) => setValue(event.target.value),
  });
}

describe("AutomationInstructionsTextarea", () => {
  it("moves the shared Input border states from the surface parent to the textarea", () => {
    const { container } = render(
      createElement(
        AutomationInstructionsComposer,
        null,
        createElement(ControlledInstructions),
      ),
    );
    const composer = container.firstElementChild;
    const textarea = screen.getByRole("textbox", { name: "Instructions" });

    expect(composer?.classList.contains("border-input-border")).toBe(false);
    expect(composer?.classList.contains("border-0")).toBe(true);
    expect(composer?.classList.contains("bg-surface")).toBe(true);
    expect(textarea.classList).toContain("border-input-border");
    expect(textarea.classList).toContain("hover:border-input-border-hover");
    expect(textarea.classList).toContain("focus:border-input-border-focused");
  });

  it("uses secondary color for idle controls until hover or menu expansion", () => {
    const classes =
      AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME.split(" ");

    expect(classes).toContain("text-foreground-subtle");
    expect(classes).not.toContain("text-foreground");
    expect(classes).toContain("hover:text-foreground");
    expect(classes).toContain("aria-expanded:text-foreground");
  });

  it("disables manual resize on desktop and mobile", () => {
    render(createElement(ControlledInstructions));
    const textarea = screen.getByRole("textbox", {
      name: "Instructions",
    });

    expect(textarea.classList).toContain("resize-none");
    expect(textarea.classList).not.toContain("sm:resize-y");
    expect(textarea.classList).toContain("max-h-39");
    expect(textarea.classList).not.toContain("sm:max-h-none");
  });

  it("grows through seven lines, then scrolls, and shrinks after content is deleted", () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        const lineCount = Math.max(1, this.value.split("\n").length);
        return lineCount * 20 + 16;
      },
    });

    try {
      render(createElement(ControlledInstructions));
      const textarea = screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement;

      expect(textarea.style.height).toBe("116px");
      expect(textarea.style.overflowY).toBe("hidden");

      fireEvent.input(textarea, {
        target: { value: Array.from({ length: 6 }, () => "line").join("\n") },
      });
      expect(textarea.style.height).toBe("136px");
      expect(textarea.style.overflowY).toBe("hidden");

      fireEvent.input(textarea, {
        target: { value: Array.from({ length: 8 }, () => "line").join("\n") },
      });
      expect(textarea.style.height).toBe("156px");
      expect(textarea.style.overflowY).toBe("auto");

      fireEvent.input(textarea, { target: { value: "line" } });
      expect(textarea.style.height).toBe("116px");
      expect(textarea.style.overflowY).toBe("hidden");
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "scrollHeight",
          originalScrollHeight,
        );
      } else {
        delete (
          HTMLTextAreaElement.prototype as unknown as Record<string, unknown>
        ).scrollHeight;
      }
    }
  });

  it("preserves a desktop manual height while long content keeps internal scrolling", () => {
    const originalScrollHeight = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        const lineCount = Math.max(1, this.value.split("\n").length);
        return lineCount * 20 + 16;
      },
    });

    try {
      render(createElement(ControlledInstructions));
      const textarea = screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement;

      textarea.style.height = "220px";
      fireEvent.input(textarea, {
        target: {
          value: Array.from({ length: 12 }, () => "line").join("\n"),
        },
      });
      expect(textarea.style.height).toBe("220px");
      expect(textarea.style.overflowY).toBe("auto");

      fireEvent.input(textarea, { target: { value: "line" } });
      expect(textarea.style.height).toBe("220px");
      expect(textarea.style.overflowY).toBe("hidden");
    } finally {
      if (originalScrollHeight) {
        Object.defineProperty(
          HTMLTextAreaElement.prototype,
          "scrollHeight",
          originalScrollHeight,
        );
      } else {
        delete (
          HTMLTextAreaElement.prototype as unknown as Record<string, unknown>
        ).scrollHeight;
      }
    }
  });
});
