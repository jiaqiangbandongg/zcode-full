// @vitest-environment jsdom

import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderModelReasoningLevelEditor } from "@/settings/model-provider-section/ProviderModelReasoningLevelEditor.js";

afterEach(cleanup);

describe("ProviderModelReasoningLevelEditor", () => {
  it("只聚焦档位再离开不创建个人覆盖", () => {
    const onChange = vi.fn();
    render(
      createElement(ProviderModelReasoningLevelEditor, {
        values: ["low", "high"],
        overridden: false,
        addLabel: "添加档位",
        deleteLabel: "删除档位",
        onChange,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "low" }));
    fireEvent.blur(screen.getByDisplayValue("low"));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("用紧凑标签完成键盘排序、编辑、添加和删除", () => {
    function Harness() {
      const [values, setValues] = useState<readonly string[]>(["low", "high"]);
      return createElement(ProviderModelReasoningLevelEditor, {
        values,
        overridden: true,
        addLabel: "添加档位",
        deleteLabel: "删除档位",
        onChange: setValues,
      });
    }

    const { container } = render(createElement(Harness));
    const firstChip = container.querySelector<HTMLElement>(
      '[data-model-reasoning-level-editor="true"] > div',
    );
    expect(firstChip?.className).toContain("box-border");
    expect(firstChip?.className).toContain("h-8");
    expect(firstChip?.className).not.toContain("min-h-8");
    expect(screen.getByRole("button", { name: "low" }).className).not.toContain("font-mono");
    expect(screen.getByRole("button", { name: "low" }).dataset.variant).toBe("outline");
    expect(screen.getByRole("button", { name: "low" }).dataset.size).toBe("lg");
    const addButton = screen.getByRole("button", { name: "添加档位" });
    expect(addButton.dataset.variant).toBe("outline");
    expect(addButton.dataset.size).toBe("icon-lg");
    expect(screen.getByRole("button", { name: "删除档位: low" }).className).toContain("opacity-0");

    const readValues = () =>
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-model-reasoning-level-editor="true"] > div > button:first-of-type',
        ),
      ).map((button) => button.textContent);

    fireEvent.keyDown(screen.getByRole("button", { name: "low" }), {
      altKey: true,
      key: "ArrowRight",
    });
    expect(readValues()).toEqual(["high", "low"]);

    const chips = container.querySelectorAll<HTMLElement>(
      '[data-model-reasoning-level-editor="true"] > div',
    );
    fireEvent.dragStart(chips[0]!, {
      dataTransfer: { effectAllowed: "none" },
    });
    fireEvent.drop(chips[1]!);
    expect(readValues()).toEqual(["low", "high"]);

    fireEvent.click(screen.getByRole("button", { name: "high" }));
    expect(screen.getByDisplayValue("high").className).toContain("field-sizing-content");
    expect(screen.getByDisplayValue("high").className).toContain("text-ui-base");
    expect(screen.getByDisplayValue("high").className).not.toContain("font-mono");
    fireEvent.change(screen.getByDisplayValue("high"), { target: { value: "medium" } });
    fireEvent.keyDown(screen.getByDisplayValue("medium"), { key: "Enter" });
    expect(readValues()).toEqual(["low", "medium"]);

    fireEvent.click(screen.getByRole("button", { name: "添加档位" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "max" } });
    fireEvent.keyDown(screen.getByDisplayValue("max"), { key: "Enter" });
    expect(readValues()).toEqual(["low", "medium", "max"]);

    fireEvent.click(screen.getByRole("button", { name: "删除档位: low" }));
    expect(readValues()).toEqual(["medium", "max"]);
    expect(container.querySelector('[data-personal-override="true"]')).toBeTruthy();
  });
});
