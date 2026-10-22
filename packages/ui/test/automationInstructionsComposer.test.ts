// @vitest-environment jsdom
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AutomationInstructionsTextarea } from "@/settings/AutomationInstructionsComposer.js";

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
        Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
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
        Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", originalScrollHeight);
      } else {
        delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      }
    }
  });
});
