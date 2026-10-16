import { describe, expect, it } from "vitest";
import type { ShortcutBindingEvent } from "../src/shortcuts/bindings.js";
import {
  resolveComposerKeyAction,
  shouldBareEnterFallThroughToNewline,
  type ComposerEffectiveBindings,
} from "../src/shortcuts/composerShortcuts.js";
import { getDefaultShortcutBindings } from "@zcode/shared";

/** 构造 Enter 族键盘事件（composer 插件收到的就是真实 KeyboardEvent 的字段子集）。 */
function enterEvent(patch: Partial<ShortcutBindingEvent> = {}): ShortcutBindingEvent {
  return {
    key: "Enter",
    code: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...patch,
  };
}

/** 默认生效表（无用户覆盖）：composerSend=Enter、composerInsertNewline=Shift+Enter。 */
function defaultEffective(): ComposerEffectiveBindings {
  return {
    composerSend: getDefaultShortcutBindings("composerSend"),
    composerInsertNewline: getDefaultShortcutBindings("composerInsertNewline"),
  };
}

/** Ctrl+Enter 党：把发送改绑为 CmdOrCtrl+Enter（整组替换，裸 Enter 移除）。 */
function ctrlEnterEffective(): ComposerEffectiveBindings {
  return { ...defaultEffective(), composerSend: ["CmdOrCtrl+Enter"] };
}

/**
 * 三平台 platformInfo。凡是断言跨 CmdOrCtrl ↔ 显式 Ctrl/meta 等价边界的用例都必须显式传入：
 * 缺省时 isAppleKeyboardPlatform() 读运行时 navigator，而 node ≥21.2 在 macOS 上给出
 * navigator.platform = "MacIntel"，用例会在 mac 开发机按 apple 语义跑、在 Linux CI 按
 * win 语义跑，结论随宿主机翻转。
 */
const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" };
const WIN = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" };
const LINUX = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };

describe("composer 作用域键位解析（spec §12.3）", () => {
  it("默认表：裸 Enter 发送、Shift+Enter 换行", () => {
    expect(resolveComposerKeyAction(enterEvent(), defaultEffective())).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), defaultEffective())).toBe(
      "newline",
    );
  });

  it("改绑后：CmdOrCtrl+Enter 发送、裸 Enter 未命中交主链回退换行（Ctrl+Enter 党场景）", () => {
    const effective = ctrlEnterEffective();
    // CmdOrCtrl 归一依赖平台，显式钉 win（mac 的 ⌘/⌃ 分支见下方三平台矩阵）
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, WIN)).toBe("send");
    // 裸 Enter 不再命中发送 → 解析器返回 null 交主链；主链裸 Enter 发送分支
    // 用 shouldBareEnterFallThroughToNewline 前置检查落到换行（spec §12.3）
    expect(resolveComposerKeyAction(enterEvent(), effective, WIN)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("Shift+Enter 党零改动：默认表下裸 Enter 仍发送", () => {
    expect(shouldBareEnterFallThroughToNewline(defaultEffective())).toBe(false);
  });

  it("非 Enter 事件默认表不命中（开放策略下改绑非 Enter 键才会命中，SG-09）", () => {
    // 默认绑定全是 Enter 族：非 Enter 键不命中 → 主链照常处理
    expect(resolveComposerKeyAction(enterEvent({ key: "k", code: "KeyK" }), defaultEffective())).toBe(
      null,
    );
    // 统一开放策略（SG-09）：composerSend 改绑为非 Enter 键（如 F9）后照常触发
    const f9Effective: ComposerEffectiveBindings = {
      ...defaultEffective(),
      composerSend: ["F9"],
    };
    expect(
      resolveComposerKeyAction(
        enterEvent({ key: "F9", code: "F9", ctrlKey: false }),
        f9Effective,
      ),
    ).toBe("send");
    // 未绑定的非 Enter 键仍不命中
    expect(resolveComposerKeyAction(enterEvent({ key: "F9", code: "F9" }), defaultEffective())).toBe(
      null,
    );
    // 换行同样开放：composerInsertNewline 改绑为 F2 后 F2 触发换行
    const f2Newline: ComposerEffectiveBindings = {
      ...defaultEffective(),
      composerInsertNewline: ["F2"],
    };
    expect(
      resolveComposerKeyAction(
        enterEvent({ key: "F2", code: "F2", shiftKey: false }),
        f2Newline,
      ),
    ).toBe("newline");
  });

  it("未绑定（显式空数组）时解析器全部未命中，主链前置检查落换行", () => {
    const effective: ComposerEffectiveBindings = {
      composerSend: [],
      composerInsertNewline: [],
    };
    expect(resolveComposerKeyAction(enterEvent(), effective)).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective)).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), effective)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("默认状态下未命中的修饰组合返回 null（主链反转投递/换行语义不受影响）", () => {
    // Ctrl+Enter 默认不在任何 composer 绑定里：无修饰组合命中时不得吞掉
    // onModifiedSubmit（反转投递）与 Lexical 默认换行
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), defaultEffective())).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective())).toBeNull();
  });

  // ============================================================================
  // 三平台语义矩阵（spec §12：平台差异全部收敛在内核 CmdOrCtrl 归一，作用域层平台无关）
  // ============================================================================

  it("mac：默认表裸 Enter 发送、Shift+Enter 换行；Cmd+Enter 不命中（主链反转投递语义保留）", () => {
    expect(resolveComposerKeyAction(enterEvent(), defaultEffective(), MAC)).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ shiftKey: true }), defaultEffective(), MAC)).toBe(
      "newline",
    );
    // mac 上 CmdOrCtrl 归一为 Cmd：Cmd+Enter 不在默认绑定（裸 Enter 不带修饰），
    // 必须落回主链给反转投递（onModifiedSubmit 接受 metaKey）
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective(), MAC)).toBeNull();
    // mac 的 Win 键等价物不存在；Option（alt）+Enter 同样不命中默认绑定
    expect(resolveComposerKeyAction(enterEvent({ altKey: true }), defaultEffective(), MAC)).toBeNull();
  });

  it("mac：改绑 CmdOrCtrl+Enter 后 Cmd+Enter 发送，显式 Ctrl+Enter 不命中（保留系统编辑区语义）", () => {
    const effective = ctrlEnterEffective();
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), effective, MAC)).toBe("send");
    // mac 显式 Ctrl 是独立的修饰（系统 Emacs 编辑保留区），用户没绑就是没绑 → 主链
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, MAC)).toBeNull();
    expect(shouldBareEnterFallThroughToNewline(effective)).toBe(true);
  });

  it("win/linux：Ctrl+Enter 命中 CmdOrCtrl 改绑；Win/Super+Enter 被裸键守卫挡住", () => {
    const effective = ctrlEnterEffective();
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, WIN)).toBe("send");
    expect(resolveComposerKeyAction(enterEvent({ ctrlKey: true }), effective, LINUX)).toBe("send");
    // 裸键绑定要求主修饰键抬起：meta（Win/Super）+Enter 不命中任何绑定
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), effective, WIN)).toBeNull();
    expect(resolveComposerKeyAction(enterEvent({ metaKey: true }), defaultEffective(), LINUX)).toBeNull();
  });
});
