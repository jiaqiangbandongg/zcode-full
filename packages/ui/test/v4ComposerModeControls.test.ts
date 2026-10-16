import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_COMPOSER_INPUT } from "@zcode/shared";

const captured = vi.hoisted(() => ({
  contentProps: null as Record<string, unknown> | null,
  permissionProps: null as Record<string, unknown> | null,
  planProps: null as Record<string, unknown> | null,
  tooltipProps: null as Record<string, unknown> | null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: (props: Record<string, unknown> & { children?: ReactNode }) => {
    captured.tooltipProps = props;
    return createElement("span", null, props.children);
  },
}));

// 菜单已从旧单选组件拆成权限单选与独立 Plan；测试实际边界，不继续捕获旧组件。
vi.mock("@/components/ui/dropdown-menu.js", () => {
  const children = (props: { children?: ReactNode }) => createElement("span", null, props.children);
  return {
    DropdownMenu: children,
    DropdownMenuTrigger: children,
    DropdownMenuSeparator: () => createElement("hr"),
    DropdownMenuRadioItem: children,
    DropdownMenuContent: (props: Record<string, unknown>) => {
      captured.contentProps = props;
      return children(props);
    },
    DropdownMenuRadioGroup: (props: Record<string, unknown>) => {
      captured.permissionProps = props;
      return children(props);
    },
    DropdownMenuCheckboxItem: (props: Record<string, unknown>) => {
      captured.planProps = props;
      return children(props);
    },
  };
});

vi.mock("@/lib/pickerFocus.js", () => ({ isCoarseTouchDevice: () => false }));

vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({ configOptions: [] }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  getNextConfigSelectValue: vi.fn(),
  useToolbarShortcutBindings: vi.fn(),
}));

vi.mock("@/shortcuts/useShortcutBindings.js", () => ({
  // 工具条热键转正后 modeShortcutLabel 读生效表（spec §12.6）；本组件测试只关心
  // 模式选项逻辑，label 固定桩即可
  useShortcutCommandLabel: () => "Ctrl+Shift+M",
}));

import { V4ComposerModeSwitch } from "@/v4/composer/V4ComposerModeControls.js";

describe("V4ComposerModeSwitch", () => {
  it("Guarded 在新的 Plan/权限菜单保持蓝色和独立 Plan 标记", () => {
    const html = renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "guarded", planEnabled: true },
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    );
    expect(captured.permissionProps?.value).toBe("guarded");
    expect(captured.planProps?.checked).toBe(true);
    expect(html).toContain("text-icon-blue");
    expect(html).not.toContain("text-warning");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("模式菜单关闭后把焦点恢复到 V4 输入框", () => {
    renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "build" },
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    );

    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    vi.stubGlobal("document", { querySelector });
    const preventDefault = vi.fn();
    const close = captured.contentProps!.onCloseAutoFocus as (event: {
      preventDefault: () => void;
    }) => void;
    close({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(querySelector).toHaveBeenCalledWith(`[data-testid="${TID_V4_COMPOSER_INPUT}"]`);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("草稿显示自己的模式，不被旧预热 snapshot mode 覆盖", () => {
    renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "yolo" },
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    );

    expect(captured.permissionProps).toMatchObject({
      value: "yolo",
    });
    expect(captured.tooltipProps).toMatchObject({ shortcut: "Ctrl+Shift+M" });
  });

  it("已有 session 修改模式后显示 Composer 值，不回读旧 snapshot", () => {
    renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "edit" },
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    );

    expect(captured.permissionProps).toMatchObject({
      value: "edit",
    });
  });

  it("已有 session 没有 snapshot config 时仍显示 Composer 模式", () => {
    renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "yolo" },
        activeConfigPicker: null,
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode: vi.fn(),
      }),
    );

    expect(captured.permissionProps).toMatchObject({
      value: "yolo",
    });
  });
  it("Plan 勾选独立于权限，菜单通过已有草稿回调切换", () => {
    const onSwitchMode = vi.fn();
    const html = renderToStaticMarkup(
      createElement(V4ComposerModeSwitch, {
        workspacePath: "/workspace",
        provider: "glm",
        draftConfig: { mode: "yolo", planEnabled: true },
        activeConfigPicker: "mode",
        onConfigPickerOpenChange: vi.fn(),
        onSwitchMode,
      }),
    );
    expect(captured.permissionProps?.value).toBe("yolo");
    expect(captured.planProps?.checked).toBe(true);
    expect(
      renderToStaticMarkup(createElement("div", null, captured.planProps?.children as ReactNode)),
    ).toContain("mode.description.glm.plan");
    expect(html).toContain('data-testid="v4-composer-plan-marker"');
    const onCheckedChange = captured.planProps!.onCheckedChange as (checked: boolean) => void;
    onCheckedChange(false);
    expect(onSwitchMode).toHaveBeenNthCalledWith(1, "plan-off");
    onCheckedChange(true);
    expect(onSwitchMode).toHaveBeenNthCalledWith(2, "plan");
    expect(onSwitchMode).toHaveBeenCalledTimes(2);
  });
});
