// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen } from "@testing-library/react";
import type { Locale } from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MODEL_INPUT_CAPABILITY_BADGE_CLASS_NAME } from "@/components/ModelInputCapabilityBadge.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  MODEL_CONFIG_SELECT_BADGE_CLASS_NAME,
  getModelTriggerLabelClassName,
  isModelSelectGroupSelected,
  ModelConfigSelect,
  shouldRenderModelGroupSeparator,
  shouldShowModelProviderLevel,
  type ModelSelectGroup,
} from "@/ModelConfigSelect.js";
import { shouldRestoreChatInputFocusAfterPickerClose } from "@/lib/pickerFocus.js";

function createGroup(key: string): ModelSelectGroup {
  return {
    key,
    label: key,
    items: [
      {
        key: `${key}:model`,
        value: `${key}/model`,
        name: "Model",
      },
    ],
  };
}

function renderWithTooltipProvider(element: ReactElement, locale: Locale = "zh-CN") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(TooltipProvider, null, element),
    ),
  );
}

function renderInteractive(element: ReactElement, locale: Locale) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(TooltipProvider, null, element),
    ),
  );
}

afterEach(() => cleanup());

describe("ModelConfigSelect menu hierarchy", () => {
  it("多个 provider 时展示 provider 一级菜单", () => {
    expect(
      shouldShowModelProviderLevel([createGroup("Provider A"), createGroup("Provider B")]),
    ).toBe(true);
  });

  it("单个 provider 时也展示 provider 分组层级", () => {
    expect(shouldShowModelProviderLevel([createGroup("Provider A")])).toBe(true);
    expect(shouldShowModelProviderLevel([])).toBe(false);
  });

  it("单个 provider family 有连接方式时仍展示 provider 一级菜单", () => {
    expect(
      shouldShowModelProviderLevel([
        {
          ...createGroup("BigModel"),
          connectionOptions: [
            {
              key: "coding-plan:account:bigmodel-individual-coding-plan",
              label: "Coding plan",
              value: "custom:account:bigmodel-individual-coding-plan:GLM-5.2",
              providerId: "account:bigmodel-individual-coding-plan",
              familyId: "bigmodel",
              mode: "oauth",
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("provider 一级菜单能识别当前选中的 model 所在分组", () => {
    const providerA = createGroup("Provider A");
    const providerB = createGroup("Provider B");

    expect(isModelSelectGroupSelected(providerA, "Provider B/model")).toBe(false);
    expect(isModelSelectGroupSelected(providerB, "Provider B/model")).toBe(true);
  });

  it("family 模型块和普通 provider 区之间展示分割线，普通 provider 之间不展示", () => {
    const bigModelFamily: ModelSelectGroup = {
      ...createGroup("BigModel"),
      key: "family:bigmodel",
      labelBadge: "Individual Plan",
    };
    const openRouter = createGroup("OpenRouter");
    const deepSeek = createGroup("DeepSeek");

    expect(shouldRenderModelGroupSeparator(undefined, bigModelFamily)).toBe(false);
    expect(shouldRenderModelGroupSeparator(bigModelFamily, openRouter)).toBe(true);
    expect(shouldRenderModelGroupSeparator(openRouter, deepSeek)).toBe(false);
  });
});

describe("ModelConfigSelect badge style", () => {
  it("个人和团队连接标签使用无边框的弱表面 pill", () => {
    const classTokens = MODEL_CONFIG_SELECT_BADGE_CLASS_NAME.split(/\s+/);

    expect(classTokens).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "bg-surface",
        "px-1",
        "py-px",
        "text-ui-xs",
        "font-medium",
        "text-foreground-subtle",
      ]),
    );
    expect(classTokens).not.toContain("border");
    expect(classTokens).not.toContain("border-border");
    expect(classTokens).not.toContain("bg-secondary");
    expect(classTokens).not.toContain("text-ui-base");
  });

  it("视觉标签与连接方式标签使用一致的轻量圆形 pill", () => {
    const classTokens = MODEL_INPUT_CAPABILITY_BADGE_CLASS_NAME.split(/\s+/);

    expect(classTokens).toEqual(
      expect.arrayContaining([
        "rounded-full",
        "border",
        "border-border",
        "bg-surface",
        "px-1",
        "py-px",
        "text-ui-xs",
        "font-medium",
        "text-foreground-subtle",
      ]),
    );
    expect(classTokens).not.toContain("rounded-md");
    expect(classTokens).not.toContain("text-ui-sm");
    expect(classTokens).not.toContain("font-mono");
  });

  it.each([
    ["zh-CN", "视觉"],
    ["en-US", "Vision"],
  ] as const)("模型项在模型名后展示 %s 视觉标签并保留行尾选中区", (locale, label) => {
    renderInteractive(
      createElement(ModelConfigSelect, {
        modelGroups: [
          {
            ...createGroup("Provider A"),
            items: [
              {
                key: "vision-model",
                value: "Provider A/openrouter/nvidia/ox-alpha",
                name: "openrouter/nvidia/ox-alpha",
                supportsVisionInput: true,
              },
            ],
          },
        ],
        normalizedValue: "Provider A/openrouter/nvidia/ox-alpha",
        triggerLabel: "openrouter/nvidia/ox-alpha",
        showManageModelsAction: false,
        lockReasonMessage: "Locked",
        isItemLocked: () => false,
        onValueChange: () => {},
        open: true,
        showProviderLevel: false,
      }),
      locale,
    );

    const badge = screen.getByLabelText(label);
    const modelItem = badge.closest('[role="menuitemradio"]');
    const modelName = modelItem?.querySelector('[title="openrouter/nvidia/ox-alpha"]');

    expect(badge.getAttribute("data-model-input-capability")).toBe("vision");
    expect(modelName).not.toBeNull();
    expect(modelName?.compareDocumentPosition(badge)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(modelItem?.className.split(/\s+/)).toContain("pr-8");
  });
});

describe("ModelConfigSelect trigger label", () => {
  it("composer 仅在小于 sm 的超窄宽度隐藏模型名称", () => {
    const className = getModelTriggerLabelClassName({
      labelVisibilityClassName: "hidden @sm/composer:inline-flex",
    });

    expect(className.split(/\s+/)).toContain("hidden");
    expect(className).toContain("@sm/composer:inline-flex");
    expect(className).toContain("min-w-0");
    expect(className).toContain("text-left");
  });

  it("显式标签样式仍可让非 composer 场景始终展示模型名称", () => {
    const className = getModelTriggerLabelClassName({
      labelVisibilityClassName: "hidden @xl/composer:inline-flex",
      triggerLabelClassName: "inline-flex min-w-0",
    });

    const classTokens = className.split(/\s+/);
    expect(classTokens).not.toContain("hidden");
    expect(className).toContain("inline-flex");
    expect(className).toContain("min-w-0");
  });

  it("composer 宽屏显示模型名称，超窄屏只保留正方形 package 图标按钮", () => {
    const html = renderWithTooltipProvider(
      createElement(ModelConfigSelect, {
        modelGroups: [createGroup("Provider A")],
        normalizedValue: "Provider A/model",
        triggerLabel: "GLM-5",
        showManageModelsAction: false,
        lockReasonMessage: "Locked",
        isItemLocked: () => false,
        onValueChange: () => {},
        tooltipTitle: "Choose model",
        labelVisibilityClassName: "hidden @sm/composer:inline-flex",
        triggerIconClassName: "inline-flex @sm/composer:hidden",
        indicatorClassName: "hidden @sm/composer:block",
        triggerClassName:
          "@max-sm/composer:size-7 @max-sm/composer:justify-center @max-sm/composer:gap-0 @max-sm/composer:p-0",
      }),
    );

    expect(html).toContain("lucide-package");
    expect(html).toContain("inline-flex @sm/composer:hidden");
    expect(html).toContain("GLM-5");
    expect(html).toContain("lucide-chevron-down");
    expect(html).toContain("hidden @sm/composer:block");
    expect(html).toContain("@max-sm/composer:size-7");
    expect(html).toContain("@max-sm/composer:p-0");
    expect(html).toContain("hidden @sm/composer:inline-flex");
  });

  it("允许调用方省略通用 tooltip 并保留模型名可访问文案", () => {
    const html = renderWithTooltipProvider(
      createElement(ModelConfigSelect, {
        modelGroups: [createGroup("Provider A")],
        normalizedValue: "Provider A/model",
        triggerLabel: "GLM-5",
        showManageModelsAction: false,
        lockReasonMessage: "",
        isItemLocked: () => false,
        onValueChange: () => {},
      }),
    );

    expect(html).toContain('aria-label="GLM-5"');
    expect(html).toContain('title="GLM-5"');
  });

  it("pending 状态下 loading 显示在模型文字后面", () => {
    const html = renderWithTooltipProvider(
      createElement(ModelConfigSelect, {
        modelGroups: [createGroup("Provider A")],
        normalizedValue: "Provider A/model",
        triggerLabel: "Model",
        showManageModelsAction: false,
        lockReasonMessage: "Locked",
        isItemLocked: () => false,
        onValueChange: () => {},
        tooltipTitle: "Choose model",
        pending: true,
        pendingLabel: "Switching model",
      }),
    );

    expect(html.indexOf("Switching model")).toBeGreaterThanOrEqual(0);
    expect(html.indexOf("Switching model")).toBeLessThan(html.indexOf("lucide-loader"));
  });
});

describe("picker focus restoration", () => {
  it("does not restore chat input focus after closing a picker on coarse touch devices", () => {
    expect(
      shouldRestoreChatInputFocusAfterPickerClose({
        isCoarseTouchDevice: true,
      }),
    ).toBe(false);
  });
});
