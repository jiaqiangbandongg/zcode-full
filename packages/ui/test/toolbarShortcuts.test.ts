import { describe, expect, it } from "vitest";
import { resolveEffectiveShortcutBindings } from "../src/shortcuts/bindings.js";
import { resolveToolbarShortcutAction } from "../src/v4/composer/toolbarShortcuts.js";
import type { ZCodeConfigOption } from "@zcode/shared";

/** 构造工具条关心的键盘事件字段子集。 */
function toolbarEvent(patch: Partial<Parameters<typeof resolveToolbarShortcutAction>[0]> = {}) {
  return {
    key: "m",
    code: "KeyM",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    ...patch,
  };
}

/** model 类选项（category=model → 归 Ctrl+M 动作）。 */
const modelOption = { type: "select", category: "model", currentValue: "m1", options: [] } as unknown as ZCodeConfigOption;
const modeOption = { type: "select", category: "mode", currentValue: "a", options: [] } as unknown as ZCodeConfigOption;
const thoughtOption = { type: "select", category: "thought_level", currentValue: "low", options: [] } as unknown as ZCodeConfigOption;

const enabledState = {
  hasAnyOption: true,
  toolbarDisabled: false,
  modelMenuDisabled: false,
  modelOption,
  modeOption,
  thoughtOption,
};

describe("composer 工具条热键按生效表解析（spec §12.6）", () => {
  it("默认表：Ctrl+M / Ctrl+Shift+M / Ctrl+T 分别命中三个动作", () => {
    const effective = resolveEffectiveShortcutBindings(undefined);
    expect(resolveToolbarShortcutAction(toolbarEvent({ ctrlKey: true }), effective, enabledState)).toBe(
      "openModelMenu",
    );
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ key: "m", code: "KeyM", ctrlKey: true, shiftKey: true }), effective, enabledState),
    ).toBe("cycleSessionMode");
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ key: "t", code: "KeyT", ctrlKey: true }), effective, enabledState),
    ).toBe("cycleThoughtLevel");
  });

  it("修饰精确匹配：Ctrl+Shift+M 不误命中 Ctrl+M（与旧 matchesCtrlShortcut 语义一致）", () => {
    const effective = resolveEffectiveShortcutBindings(undefined);
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ ctrlKey: true, shiftKey: true }), effective, enabledState),
    ).toBe("cycleSessionMode");
  });

  it("改绑后按新键位命中：openModelMenu 改绑 Ctrl+Y", () => {
    const effective = resolveEffectiveShortcutBindings({ openModelMenu: ["Ctrl+y"] });
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ ctrlKey: true }), effective, enabledState),
    ).toBeNull();
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ key: "y", code: "KeyY", ctrlKey: true }), effective, enabledState),
    ).toBe("openModelMenu");
  });

  it("门控保留：disabled / 无选项 / defaultPrevented / repeat 不触发动作", () => {
    const effective = resolveEffectiveShortcutBindings(undefined);
    const ctrlM = toolbarEvent({ ctrlKey: true });
    expect(
      resolveToolbarShortcutAction(ctrlM, effective, { ...enabledState, toolbarDisabled: true }),
    ).toBeNull();
    expect(
      resolveToolbarShortcutAction(ctrlM, effective, {
        ...enabledState,
        modelMenuDisabled: true,
      }),
    ).toBeNull();
    expect(
      resolveToolbarShortcutAction(ctrlM, effective, { ...enabledState, modelOption: undefined }),
    ).toBeNull();
    expect(
      resolveToolbarShortcutAction({ ...ctrlM, defaultPrevented: true }, effective, enabledState),
    ).toBeNull();
    expect(resolveToolbarShortcutAction({ ...ctrlM, repeat: true }, effective, enabledState)).toBeNull();
  });

  it("mac 语义：显式 Ctrl 命中，Cmd+M 不命中（与旧固定热键一致）", () => {
    const effective = resolveEffectiveShortcutBindings(undefined);
    const macState = { ...enabledState };
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ key: "m", code: "KeyM", ctrlKey: true, metaKey: false }), effective, macState),
    ).toBe("openModelMenu");
    expect(
      resolveToolbarShortcutAction(toolbarEvent({ metaKey: true }), effective, macState),
    ).toBeNull();
  });
});
