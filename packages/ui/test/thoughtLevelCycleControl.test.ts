import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { getNextThoughtLevelValue } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ZCodeConfigOption } from "@zcode/shared";

const zhIntl = {
  formatMessage({ id }: { id: string }) {
    return (
      {
        "chat.toolbar.thoughtLevel.tooltip": "思考级别",
        "chat.toolbar.thoughtLevel.placeholder": "选择思考档位",
        "chat.toolbar.thoughtLevel.value.max": "最高",
      }[id] ?? id
    );
  },
};

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

describe("ThoughtLevelCycleControl", () => {
  it.each([
    ["high", "100%"],
    ["off", "0%"],
    ["ultra", "50%"],
    ["missing", "0%"],
  ])("关闭项在中间时 %s 的阶梯进度为 %s", (currentValue, progress) => {
    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option: {
          id: "thought_level",
          category: "thought_level",
          type: "select",
          currentValue,
          options: [
            { value: "ultra", name: "Ultra" },
            { value: "off", name: "Off" },
            { value: "high", name: "High" },
          ],
        },
        intl: zhIntl,
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );
    expect(html).toContain(`height:${progress}`);
  });
  it.each([false, true])(
    "空值显示待选择而非第一档，保留非法值模式=%s",
    (showInvalidCurrentValue) => {
      const html = renderWithTooltipProvider(
        createElement(ThoughtLevelCycleControl, {
          option: {
            id: "thought_level",
            type: "select",
            currentValue: "",
            options: [{ value: "max", name: "Max" }],
          },
          intl: zhIntl,
          labelVisibilityClassName: "",
          showInvalidCurrentValue,
          triggerRef: { current: null },
          onValueChange: vi.fn(),
        }),
      );
      expect(html).toContain('aria-label="选择思考档位"');
      expect(html).toContain('role="combobox"');
      expect(html).not.toContain('data-thought-level-fixed="true"');
      expect(html).toContain("height:0%");
    },
  );

  it("单档位只读展示，不渲染可展开的选择器", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [{ value: "max", name: "Max" }],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        labelVisibilityClassName: "",
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain('data-thought-level-fixed="true"');
    expect(html).toContain("最高");
    expect(html).not.toContain('role="combobox"');
  });

  it("非法历史值遇到单档模型时仍渲染选择器以便修正", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [{ value: "max", name: "Max" }],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        labelVisibilityClassName: "",
        showInvalidCurrentValue: true,
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).not.toContain('data-thought-level-fixed="true"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain("medium");
    expect(html).toContain("height:0%");
  });

  it("显示当前思考阶梯文案", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "off", name: "Off" },
        { value: "max", name: "Max" },
      ],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        labelVisibilityClassName: "",
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain("最高");
  });

  it("进度条仅在 sm 到 xl 的中间宽度显示", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "off", name: "Off" },
        { value: "max", name: "Max" },
      ],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain("hidden @sm/composer:inline-flex @xl/composer:hidden");
    expect(html).not.toContain("@lg/composer:hidden");
  });

  it("允许 composer 先隐藏箭头并在超窄宽度收成正方形", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "off", name: "Off" },
        { value: "max", name: "Max" },
      ],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        indicatorClassName: "hidden @xl/composer:block",
        triggerClassName:
          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:p-0",
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain("hidden @xl/composer:block");
    expect(html).toContain("gap-1 rounded-lg px-1.5 py-1.5");
    expect(html).toContain("@max-sm/composer:size-7");
    expect(html).toContain("@max-sm/composer:justify-center");
    expect(html).toContain("@max-sm/composer:p-0");
  });

  it("文字收起时仍保留当前阶梯文案用于 tooltip 和可访问信息", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "off", name: "Off" },
        { value: "max", name: "Max" },
      ],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        labelVisibilityClassName: "hidden",
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="最高"');
    expect(html).toContain('title="最高"');
    expect(html).toContain("最高");
  });

  it("保留 cycle 模式用于恢复旧版点击循环交互", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "max",
      options: [
        { value: "off", name: "Off" },
        { value: "max", name: "Max" },
      ],
    };

    const html = renderWithTooltipProvider(
      createElement(ThoughtLevelCycleControl, {
        option,
        intl: zhIntl,
        interactionMode: "cycle",
        labelVisibilityClassName: "",
        triggerRef: { current: null },
        onValueChange: vi.fn(),
      }),
    );

    expect(html).toContain('type="button"');
    expect(html).toContain("最高");
  });

  it("Ctrl+T 快速切换按展示顺序选择下一个思考档位", () => {
    const option: ZCodeConfigOption = {
      id: "thought_level",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "high", name: "High" },
        { value: "off", name: "Off" },
        { value: "low", name: "Low" },
      ],
    };

    expect(getNextThoughtLevelValue(option)).toBe("high");
  });

  it("Ctrl+T 不循环唯一思考档位", () => {
    expect(
      getNextThoughtLevelValue({
        type: "select",
        currentValue: "max",
        options: [{ value: "max", name: "Max" }],
      }),
    ).toBeNull();
  });
});
