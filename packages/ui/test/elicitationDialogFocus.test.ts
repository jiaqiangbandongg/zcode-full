// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeElicitationRequest } from "@zcode/shared";
import { ElicitationDialog } from "@/ElicitationDialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ElicitationDialog custom answer focus", () => {
  it.each(["single", "multi", "plan"])(
    "%s: 上下键可进入及离开自定义输入框，保留草稿且不隐式提交",
    async (kind) => {
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        window.setTimeout(() => callback(performance.now()), 0),
      );
      vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
      const request: ZCodeElicitationRequest = {
        type: "elicitation_request",
        taskId: "task-focus",
        traceId: "trace-focus",
        requestId: "ask-focus",
        message: "请选择方案",
        options: [],
        questions: [
          {
            question: "请选择方案",
            multiSelect: kind === "multi",
            options: [
              { value: "approve", label: "方案一" },
              { value: "second", label: "方案二" },
            ],
          },
        ],
        ...(kind === "plan"
          ? { schema: { interaction: "plan_approval", toolName: "ExitPlanMode" } }
          : {}),
      };
      const onRespond = vi.fn();
      const { container } = render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ElicitationDialog, { request, onRespond }),
        ),
      );
      const options = container.querySelectorAll<HTMLButtonElement>(
        'button[role="option"],button[role="checkbox"]',
      );
      const input = container.querySelector<HTMLTextAreaElement>("textarea")!;
      const card = container.querySelector<HTMLElement>('[data-elicitation-dialog-card="true"]')!;
      await waitFor(() => expect(document.activeElement).toBe(kind === "plan" ? options[0] : card));

      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.change(input, { target: { value: "保留我的自定义答案\n第二行" } });

      // 输入法上下选词不能误切到选项；同时覆盖 native 和 composition ref 两种保护。
      fireEvent.keyDown(input, { key: "ArrowUp", isComposing: true });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(input);
      fireEvent.compositionStart(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.activeElement).toBe(input);
      fireEvent.compositionEnd(input);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(options[1]));
      fireEvent.keyDown(options[1]!, { key: "ArrowDown" });
      await waitFor(() => expect(document.activeElement).toBe(input));
      fireEvent.keyDown(input, { key: "ArrowDown" });
      await waitFor(() => expect(document.activeElement).toBe(options[0]));
      fireEvent.keyDown(options[0]!, { key: "ArrowUp" });
      await waitFor(() => expect(document.activeElement).toBe(input));

      expect(input.value).toBe("保留我的自定义答案\n第二行");
      expect(onRespond).not.toHaveBeenCalled();
      expect(options[0]!.getAttribute(kind === "multi" ? "aria-checked" : "aria-selected")).toBe(
        "false",
      );
      if (kind !== "multi") {
        expect(input.previousElementSibling?.textContent).toBe("3.");
        expect(input.previousElementSibling?.classList.contains("self-start")).toBe(true);
        expect(input.previousElementSibling?.classList.contains("mt-px")).toBe(true);
        expect(input.previousElementSibling?.classList.contains("leading-normal")).toBe(true);
        expect(input.previousElementSibling?.classList.contains("md:leading-relaxed")).toBe(true);
      }
    },
  );
});
