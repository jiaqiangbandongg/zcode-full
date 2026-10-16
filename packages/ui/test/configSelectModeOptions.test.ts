import { createElement, forwardRef, type ForwardedRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSelectContentProps: Array<{
  onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
}> = [];

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) =>
    createElement("div", { "data-testid": "control-hint-tooltip" }, children),
}));

vi.mock("@/components/ai-elements/context.js", () => ({
  Context: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContentBody: ({ children }: { children: unknown }) => createElement("div", null, children),
  ContextContentHeader: () => createElement("div"),
  ContextTrigger: () => createElement("button"),
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: ({ children }: { children: unknown }) => createElement("div", { "data-testid": "select-root" }, children),
  SelectContent: ({
    children,
    onCloseAutoFocus,
  }: {
    children: unknown;
    onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
  }) => {
    mockSelectContentProps.push({ onCloseAutoFocus });
    return createElement("div", { "data-testid": "select-content" }, children);
  },
  SelectItem: forwardRef(function MockSelectItem(
    {
      children,
      value,
      className,
    }: {
      children: unknown;
      value: string;
      className?: string;
    },
    ref: ForwardedRef<HTMLDivElement>,
  ) {
    return createElement(
      "div",
      {
        ref,
        "data-slot": "select-item",
        "data-value": value,
        className,
      },
      children,
    );
  }),
  SelectTrigger: ({
    children,
    className,
    indicator,
  }: {
    children: unknown;
    className?: string;
    indicator?: unknown;
  }) =>
    createElement(
      "button",
      {
        "data-testid": "select-trigger",
        className,
      },
      children,
      indicator,
    ),
  SelectValue: () => createElement("span", null, "value"),
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  TooltipProvider: ({ children }: { children: unknown }) => createElement("div", { "data-testid": "tooltip-provider" }, children),
  Tooltip: ({ children }: { children: unknown }) => createElement("div", { "data-testid": "tooltip-root" }, children),
  TooltipTrigger: ({ children }: { children: unknown }) => children,
  TooltipContent: ({
    children,
    side,
  }: {
    children: unknown;
    side?: string;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "tooltip-content",
        "data-side": side,
      },
      children,
    ),
}));

import {
  ConfigSelect,
  isHighPermissionModeValue,
  resolveModeOptionIcon,
} from "@/chat-input-toolbar/display.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

beforeEach(() => {
  mockSelectContentProps.length = 0;
});

function renderConfigSelect(
  locale: "zh-CN" | "en-US",
  props: Parameters<typeof ConfigSelect>[0],
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(ConfigSelect, props),
    ),
  );
}

describe("ConfigSelect mode options", () => {
  it.each([
    ["zh-CN", "自主模式", "在有风险时询问"],
    ["en-US", "Autonomous mode", "Ask when there’s risk"],
  ] as const)(
    "Guarded 在 %s 下使用浅蓝色和 Edit 图标，不复用 YOLO 警示样式",
    (locale, label, description) => {
      const html = renderConfigSelect(locale, {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "guarded",
          options: [{ value: "guarded", name: "Guarded" }],
        },
        onValueChange: vi.fn(),
        tooltipTitle: "Mode",
      });
      expect(isHighPermissionModeValue("guarded")).toBe(false);
      expect(html).toContain(label);
      expect(html).toContain(description);
      expect(html).toContain('data-value="guarded"');
      expect(resolveModeOptionIcon("guarded")).toBe(resolveModeOptionIcon("edit"));
      expect(html.match(/lucide-shield-check/g)).toHaveLength(2);
      expect(html).toContain("text-icon-blue hover:text-icon-blue aria-expanded:text-icon-blue");
      expect(html).not.toContain("text-warning");
      expect(html).not.toContain("lucide-shield-alert");
    },
  );

  it.each([ ["zh-CN", "自动编辑"], ["en-US", "Edit automatically"] ] as const)(
    "历史 edit 在 %s 下保留本地化回显，但不重新加入候选", (locale, label) => {
      const onValueChange = vi.fn();
      const html = renderConfigSelect(locale, {
        provider: "glm",
        option: {
          id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "edit",
          options: [{ value: "guarded", name: "Guarded" }, { value: "yolo", name: "YOLO" }],
        },
        onValueChange,
        tooltipTitle: "Mode",
      });
      expect(html).toContain(label);
      expect(html).not.toContain('data-value="edit"');
      expect(onValueChange).not.toHaveBeenCalled();
    },
  );

  it("允许 composer 在窄宽度隐藏 mode 下拉箭头", () => {
    const html = renderConfigSelect("zh-CN", {
      provider: "codex",
      option: {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "read-only",
        options: [{ value: "read-only", name: "read-only" }],
      },
      onValueChange: () => {},
      tooltipTitle: "Mode",
      indicatorClassName: "hidden @xl/composer:block",
    });

    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain("hidden @xl/composer:block");
  });

  it("触控设备关闭 mode 菜单后不会重新聚焦聊天输入框", () => {
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        matchMedia: vi.fn(() => ({ matches: true })),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: vi.fn(() => ({ focus })),
      },
    });

    try {
      renderConfigSelect("zh-CN", {
        provider: "codex",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "read-only",
          options: [
            {
              value: "read-only",
              name: "read-only",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

      mockSelectContentProps[0]?.onCloseAutoFocus?.({ preventDefault });

      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(document.querySelector).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("中文环境下显示中文标签，并在菜单项中显示 description", () => {
    const html = renderConfigSelect("zh-CN", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            {
              value: "build",
              name: "Build",
              description: "Require confirmation before edits.",
            },
            {
              value: "edit",
              name: "Edit",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

    expect(html).toContain("变更前确认");
    expect(html).toContain("自动编辑");
    expect(html).not.toContain("变更前确认 / Build");
    expect(html).toContain("改文件前先问我。");
    expect(html).toContain("pr-8");
  });

  it("mode trigger 使用当前文案而不是 SelectValue 自动回填", () => {
    const html = renderConfigSelect("zh-CN", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            {
              value: "build",
              name: "Build",
            },
            {
              value: "edit",
              name: "Edit",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

    expect(html).toContain("变更前确认");
    expect(html).not.toContain(">value<");
  });

  it("英文环境下显示英文多语言标签", () => {
    const html = renderConfigSelect("en-US", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            {
              value: "build",
              name: "Build",
            },
            {
              value: "edit",
              name: "Edit",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

    expect(html).toContain("Ask before changes");
    expect(html).toContain("Edit automatically");
    expect(html).not.toContain("默认模式");
  });

  it("GLM 模式列表只渲染 agent 返回的可用模式", () => {
    const html = renderConfigSelect("zh-CN", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "yolo",
          options: [
            { value: "build", name: "Build" },
            { value: "edit", name: "Edit" },
            { value: "plan", name: "Plan" },
            { value: "yolo", name: "Yolo" },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
      });

    expect(html).toContain("变更前确认");
    expect(html).toContain("自动编辑");
    expect(html).toContain("计划模式");
    expect(html).toContain("完全访问");
    expect(html).toContain("自动编辑文件。");
    expect(html).not.toContain("Auto");
  });

  it("选中 edit 模式时不会显示高权限 warning 色", () => {
    const html = renderConfigSelect("zh-CN", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "edit",
          options: [
            {
              value: "edit",
              name: "Edit",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
        triggerClassName: "rounded-full text-ui-base/relaxed pl-3 pr-2",
      });

    expect(html).toContain('data-testid="select-trigger"');
    expect(html).not.toContain("text-warning");
  });

  it.each([
    ["claude", "bypassPermissions"],
    ["codex", "full-access"],
    ["codex", "agent-full-access"],
    ["gemini", "yolo"],
    ["glm", "yolo"],
  ] as const)(
    "选中高权限模式 %s/%s 时，trigger 文本会显示 warning 色",
    (provider, currentValue) => {
      const html = renderConfigSelect("zh-CN", {
          provider,
          option: {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue,
            options: [
              {
                value: currentValue,
                name: currentValue,
              },
            ],
          },
          onValueChange: () => {},
          tooltipTitle: "Mode",
          triggerClassName: "rounded-full text-ui-base/relaxed pl-3 pr-2",
        });

      expect(html).toContain('data-testid="select-trigger"');
      expect(html).toContain("text-warning");
    },
  );

  it("restoreFocusSelector 为 null 时保留 Radix 默认回焦（不 preventDefault）", () => {
    // Bugfix 回归：Automations 权限选择器没有聊天输入框可恢复；之前 onCloseAutoFocus
    // 无条件 preventDefault，null 时把 Radix 默认“回焦到 trigger”一并吃掉，焦点掉 body。
    const focus = vi.fn();
    const preventDefault = vi.fn();
    const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "document",
    );

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        // 桌面指针环境（非触屏）：非 null selector 本应恢复输入框焦点的场景。
        matchMedia: vi.fn(() => ({ matches: false })),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: vi.fn(() => ({ focus })),
      },
    });

    try {
      renderConfigSelect("zh-CN", {
        provider: "glm",
        option: {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [
            {
              value: "build",
              name: "build",
            },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Mode",
        restoreFocusSelector: null,
      });

      mockSelectContentProps[0]?.onCloseAutoFocus?.({ preventDefault });

      expect(preventDefault).not.toHaveBeenCalled();
      expect(document.querySelector).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    } finally {
      if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, "window", originalWindowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalDocumentDescriptor) {
        Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("不传 provider 时 label/description 回退到预本地化 entry", () => {
    // ConfigSelect 仍支持没有 provider 词表的调用方直接提供本地化名称与说明。
    const html = renderConfigSelect("zh-CN", {
        option: {
          id: "mode",
          name: "Permission",
          category: "mode",
          type: "select",
          currentValue: "yolo",
          options: [
            { value: "build", name: "自定义确认", description: "自定义确认说明。" },
            { value: "yolo", name: "完全访问", description: "更少确认地执行。" },
          ],
        },
        onValueChange: () => {},
        tooltipTitle: "Permission",
      });

    expect(html).toContain("自定义确认");
    expect(html).toContain("完全访问");
    expect(html).toContain("自定义确认说明。");
    expect(html).toContain("更少确认地执行。");
    expect(html).not.toContain("变更前确认");
    // 高权限 warning 语义只依赖 entry.value，不依赖 provider。
    expect(html).toContain("text-warning");
  });
});
