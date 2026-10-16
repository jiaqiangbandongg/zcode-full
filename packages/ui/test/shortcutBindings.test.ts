import { describe, expect, it } from "vitest";
import { SHORTCUT_COMMANDS, isValidShortcutBinding } from "@zcode/shared";
import {
  buildShortcutOverridesAfterAppend,
  buildShortcutOverridesAfterSteal,
  buildShortcutOverridesWithoutBindingAt,
  buildShortcutOverridesWithBindingAt,
  checkShortcutBindingConflict,
  isSamePhysicalBinding,
  RESERVED_BINDINGS,
} from "../src/shortcuts/conflicts.js";
import {
  formatShortcutBindingLabel,
  formatShortcutBindingLabelParts,
} from "../src/shortcuts/label.js";
import {
  isEditableShortcutEventTarget,
  isShiftOnlyPrintableBinding,
  isShortcutEventNoise,
  isShortcutRecordingActive,
  matchesShortcutBinding,
  recordShortcutBinding,
  resolveEffectiveShortcutBindings,
  setShortcutRecordingActive,
  type ShortcutBindingEvent,
} from "../src/shortcuts/bindings.js";

const MAC = { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" };
const WIN = { platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" };
const LINUX = { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" };

/** 构造键盘事件（只填快捷键关心的字段）。 */
function keyEvent(patch: Partial<ShortcutBindingEvent> & { key: string }): ShortcutBindingEvent {
  return {
    code: undefined,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    isComposing: false,
    ...patch,
  };
}

describe("快捷键噪声过滤（IME / 长按）", () => {
  it("IME 组合中（isComposing / Process / Dead / keyCode 229）与 repeat 均视为噪声", () => {
    expect(isShortcutEventNoise(keyEvent({ key: "k", isComposing: true }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "Process" }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "Dead" }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k", keyCode: 229 }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k", repeat: true }))).toBe(true);
    expect(isShortcutEventNoise(keyEvent({ key: "k" }))).toBe(false);
  });

  it("噪声事件不命中任何绑定", () => {
    const macCmdK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", MAC)).toBe(true);
    expect(matchesShortcutBinding({ ...macCmdK, isComposing: true }, "CmdOrCtrl+k", MAC)).toBe(
      false,
    );
    expect(matchesShortcutBinding({ ...macCmdK, repeat: true }, "CmdOrCtrl+k", MAC)).toBe(false);
  });
});

describe("快捷键通用匹配器：平台隔离与修饰键精确匹配", () => {
  it("CmdOrCtrl 在 mac 匹配 Cmd、在 win/linux 匹配 Ctrl，且平台隔离", () => {
    const macCmdK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    const winCtrlK = keyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", MAC)).toBe(true);
    expect(matchesShortcutBinding(macCmdK, "CmdOrCtrl+k", WIN)).toBe(false);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", WIN)).toBe(true);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", MAC)).toBe(false);
    expect(matchesShortcutBinding(winCtrlK, "CmdOrCtrl+k", LINUX)).toBe(true);
  });

  it("多余修饰键不算命中（精确匹配）", () => {
    const cmdCtrlK = keyEvent({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
    expect(matchesShortcutBinding(cmdCtrlK, "CmdOrCtrl+k", MAC)).toBe(false);
    const ctrlShiftJ = keyEvent({ key: "j", code: "KeyJ", ctrlKey: true, shiftKey: true });
    expect(matchesShortcutBinding(ctrlShiftJ, "CmdOrCtrl+j", WIN)).toBe(false);
    expect(matchesShortcutBinding(ctrlShiftJ, "CmdOrCtrl+Shift+j", WIN)).toBe(true);
    // 缺修饰键同样不命中
    const plainJ = keyEvent({ key: "j", code: "KeyJ" });
    expect(matchesShortcutBinding(plainJ, "CmdOrCtrl+j", WIN)).toBe(false);
  });

  it("三修饰键组合（CmdOrCtrl+Alt+Shift）精确匹配", () => {
    const event = keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true, shiftKey: true });
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Alt+Shift+b", WIN)).toBe(true);
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Alt+b", WIN)).toBe(false);
    expect(matchesShortcutBinding(event, "CmdOrCtrl+Shift+b", WIN)).toBe(false);
  });

  it("macOS 显式 Ctrl 修饰独立于 CmdOrCtrl", () => {
    const macCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(matchesShortcutBinding(macCtrlP, "Ctrl+p", MAC)).toBe(true);
    expect(matchesShortcutBinding(macCtrlP, "CmdOrCtrl+p", MAC)).toBe(false);
    // Windows/Linux 上 Ctrl 与 CmdOrCtrl 同义（录制在这些平台只产出 CmdOrCtrl）
    expect(matchesShortcutBinding(macCtrlP, "CmdOrCtrl+p", WIN)).toBe(true);
  });

  it("Shift+字母：event.key 为大写时命中小写基键绑定", () => {
    const shiftP = keyEvent({ key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(matchesShortcutBinding(shiftP, "CmdOrCtrl+Shift+p", MAC)).toBe(true);
    const winShiftBracket = keyEvent({
      key: "{",
      code: "BracketLeft",
      ctrlKey: true,
      shiftKey: true,
    });
    // Shift+[ 的 event.key 在 US 布局是 "{"，靠 code 兜底命中
    expect(matchesShortcutBinding(winShiftBracket, "CmdOrCtrl+Shift+[", WIN)).toBe(true);
  });

  it("macOS Option 参与时 key 被布局改写，event.code 兜底命中", () => {
    const optionCmdB = keyEvent({ key: "ß", code: "KeyB", metaKey: true, altKey: true });
    expect(matchesShortcutBinding(optionCmdB, "CmdOrCtrl+Alt+b", MAC)).toBe(true);
  });

  it("符号键匹配：= - 0 与方括号（zoom 与会话导航命令）", () => {
    const ctrlEqual = keyEvent({ key: "=", code: "Equal", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlEqual, "CmdOrCtrl+=", WIN)).toBe(true);
    const ctrlMinus = keyEvent({ key: "-", code: "Minus", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlMinus, "CmdOrCtrl+-", WIN)).toBe(true);
    const ctrlBracket = keyEvent({ key: "[", code: "BracketLeft", metaKey: true });
    expect(matchesShortcutBinding(ctrlBracket, "CmdOrCtrl+[", MAC)).toBe(true);
  });

  it("AltGr 与 Ctrl+Alt 是同一物理组合，两种写法都命中", () => {
    const altGrQ = keyEvent({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
    expect(matchesShortcutBinding(altGrQ, "AltGr+q", WIN)).toBe(true);
    expect(matchesShortcutBinding(altGrQ, "CmdOrCtrl+Alt+q", WIN)).toBe(true);
    // Windows 现有绑定 Ctrl+Alt+B（toggleSidePane 默认）按物理事实就是 ctrl+alt 同按，必须命中
    const ctrlAltB = keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
    expect(matchesShortcutBinding(ctrlAltB, "CmdOrCtrl+Alt+b", WIN)).toBe(true);
  });

  it("非法绑定串永不命中", () => {
    const ctrlK = keyEvent({ key: "k", code: "KeyK", ctrlKey: true });
    expect(matchesShortcutBinding(ctrlK, "not-a-binding", WIN)).toBe(false);
    expect(matchesShortcutBinding(ctrlK, "CmdOrCtrl+", WIN)).toBe(false);
  });
});

describe("快捷键录制器", () => {
  it("mac 的 Cmd → CmdOrCtrl；win/linux 的 Ctrl → CmdOrCtrl（跨平台配置可移植）", () => {
    const macCmdP = keyEvent({ key: "p", code: "KeyP", metaKey: true });
    expect(recordShortcutBinding(macCmdP, MAC)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+p",
    });
    const winCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(recordShortcutBinding(winCtrlP, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+p",
    });
    const linuxCtrlShiftP = keyEvent({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true });
    expect(recordShortcutBinding(linuxCtrlShiftP, LINUX)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+Shift+p",
    });
  });

  it("mac 显式 Ctrl 录为 Ctrl+p", () => {
    const macCtrlP = keyEvent({ key: "p", code: "KeyP", ctrlKey: true });
    expect(recordShortcutBinding(macCtrlP, MAC)).toEqual({ kind: "binding", binding: "Ctrl+p" });
  });

  it("Shift+符号用 event.code 反查物理基键（Shift+7 → 7 而非 &）", () => {
    const shift7 = keyEvent({ key: "&", code: "Digit7", ctrlKey: true, shiftKey: true });
    expect(recordShortcutBinding(shift7, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+Shift+7",
    });
  });

  it("纯 Shift 组合（无其他修饰键）可正常录制", () => {
    const shiftF = keyEvent({ key: "F", code: "KeyF", shiftKey: true });
    expect(recordShortcutBinding(shiftF, WIN)).toEqual({ kind: "binding", binding: "Shift+f" });
    const shift7 = keyEvent({ key: "&", code: "Digit7", shiftKey: true });
    expect(recordShortcutBinding(shift7, WIN)).toEqual({ kind: "binding", binding: "Shift+7" });
    const macShiftF = keyEvent({ key: "F", code: "KeyF", shiftKey: true });
    expect(recordShortcutBinding(macShiftF, MAC)).toEqual({ kind: "binding", binding: "Shift+f" });
    // 匹配侧同样命中（用户场景：录制后主界面按 Shift+F 触发命令）
    expect(matchesShortcutBinding(shiftF, "Shift+f", WIN)).toBe(true);
  });

  it("IME 组合事件在录制态用 event.code 反查物理键（中文输入法下 Shift+字母 可录）", () => {
    // 焦点落在可编辑元素时，中文 IME 会把 Shift+字母 吞成组合输入，
    // 事件只剩 isComposing/Process/229 标记 —— 录制是显式意图，仍按 code 录制
    const imeShiftF = keyEvent({ key: "Process", code: "KeyF", shiftKey: true, keyCode: 229 });
    expect(recordShortcutBinding(imeShiftF, WIN)).toEqual({ kind: "binding", binding: "Shift+f" });
    const composingCtrlJ = keyEvent({ key: "j", code: "KeyJ", ctrlKey: true, isComposing: true });
    expect(recordShortcutBinding(composingCtrlJ, WIN)).toEqual({
      kind: "binding",
      binding: "CmdOrCtrl+j",
    });
    // 无可反查 code 的 IME 事件保持 pending（继续等待完整组合）
    expect(recordShortcutBinding(keyEvent({ key: "Process" }), WIN)).toEqual({ kind: "pending" });
    // repeat 长按即便有 code 也不录制
    const repeated = keyEvent({
      key: "Process",
      code: "KeyF",
      shiftKey: true,
      repeat: true,
    });
    expect(recordShortcutBinding(repeated, WIN)).toEqual({ kind: "pending" });
    // 匹配侧对 IME 事件照旧过滤（录制宽松、匹配严格）
    expect(matchesShortcutBinding(imeShiftF, "Shift+f", WIN)).toBe(false);
  });

  it("纯修饰键按下与 IME 噪声保持 pending（继续等待完整组合）", () => {
    expect(recordShortcutBinding(keyEvent({ key: "Shift", shiftKey: true }), WIN)).toEqual({
      kind: "pending",
    });
    expect(recordShortcutBinding(keyEvent({ key: "Meta", metaKey: true }), MAC)).toEqual({
      kind: "pending",
    });
    expect(recordShortcutBinding(keyEvent({ key: "Process" }), WIN)).toEqual({ kind: "pending" });
  });

  it("平台归一会丢主修饰键的组合拒绝录制（CR-01：不得产出裸单键）", () => {
    // mac 的 Cmd+Ctrl+K：cmdOrCtrl 与 ctrl 归一后双双为 false，旧实现会录出裸 "k"
    const macCmdCtrlK = keyEvent({ key: "k", code: "KeyK", metaKey: true, ctrlKey: true });
    expect(recordShortcutBinding(macCmdCtrlK, MAC)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // win/linux 的纯 Meta（Win 键）+K：同为归一丢失
    const winMetaK = keyEvent({ key: "k", code: "KeyK", metaKey: true });
    expect(recordShortcutBinding(winMetaK, WIN)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // meta+ctrl+shift 叠加同样不得滑过守卫
    const macCmdCtrlShiftK = keyEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
      ctrlKey: true,
      shiftKey: true,
    });
    expect(recordShortcutBinding(macCmdCtrlShiftK, MAC)).toEqual({
      kind: "invalid",
      reason: "unsupported-key",
    });
    // mac 纯 Cmd / 纯 Ctrl 与 win AltGr（Ctrl+Alt）不受影响
    expect(recordShortcutBinding(keyEvent({ key: "k", code: "KeyK", metaKey: true }), MAC)).toEqual(
      { kind: "binding", binding: "CmdOrCtrl+k" },
    );
    expect(recordShortcutBinding(keyEvent({ key: "k", code: "KeyK", ctrlKey: true }), MAC)).toEqual(
      { kind: "binding", binding: "Ctrl+k" },
    );
    expect(
      recordShortcutBinding(keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }), WIN),
    ).toEqual({ kind: "binding", binding: "CmdOrCtrl+Alt+b" });
  });

  it("纯 Shift+可打印键绑定可判定（CR-02：可编辑目标内需豁免）", () => {
    expect(isShiftOnlyPrintableBinding("Shift+f")).toBe(true);
    expect(isShiftOnlyPrintableBinding("Shift+7")).toBe(true);
    expect(isShiftOnlyPrintableBinding("CmdOrCtrl+Shift+f")).toBe(false);
    expect(isShiftOnlyPrintableBinding("Shift+F1")).toBe(false);
    expect(isShiftOnlyPrintableBinding("CmdOrCtrl+f")).toBe(false);
    // 无 DOM 环境（node 单测）下可编辑目标判定恒为 false
    expect(isEditableShortcutEventTarget(null)).toBe(false);
  });

  it("无修饰键的普通键拒绝（no-modifier）；F 键与方向键单键允许录出", () => {
    expect(recordShortcutBinding(keyEvent({ key: "p", code: "KeyP" }), WIN)).toEqual({
      kind: "invalid",
      reason: "no-modifier",
    });
    expect(recordShortcutBinding(keyEvent({ key: "F5", code: "F5" }), WIN)).toEqual({
      kind: "binding",
      binding: "F5",
    });
    expect(recordShortcutBinding(keyEvent({ key: "ArrowUp", code: "ArrowUp" }), WIN)).toEqual({
      kind: "binding",
      binding: "ArrowUp",
    });
  });

  it("录制产物必然是合法规范形式（可直接入 setting.json 与菜单 accelerator）", () => {
    const cases = [
      // 注：win 平台 meta+alt 组合已被 CR-01 守卫拒绝（平台归一会丢主修饰键），
      // 这里用 cmdOrCtrl+alt 的规范组合替代
      keyEvent({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }),
      keyEvent({ key: "[", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      keyEvent({ key: "=", code: "Equal", ctrlKey: true }),
    ];
    for (const event of cases) {
      const result = recordShortcutBinding(event, WIN);
      expect(result.kind).toBe("binding");
      if (result.kind === "binding") {
        expect(isValidShortcutBinding(result.binding)).toBe(true);
      }
    }
  });
});

describe("快捷键生效表 resolve", () => {
  it("无覆盖时返回命令表默认绑定", () => {
    const effective = resolveEffectiveShortcutBindings();
    expect(effective.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
    expect(effective.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+Shift+p"]);
  });

  it("覆盖为整组替换（双默认绑定同时失效）", () => {
    const effective = resolveEffectiveShortcutBindings({ openCommandCenter: ["CmdOrCtrl+e"] });
    expect(effective.openCommandCenter).toEqual(["CmdOrCtrl+e"]);
  });

  it("非法覆盖条目忽略；全非法时回退默认；未知命令 ID 忽略", () => {
    const effective = resolveEffectiveShortcutBindings({
      toggleSidebar: ["CmdOrCtrl+g", "not-legal!!"],
      newTask: ["garbage"],
      unknownCommand: ["CmdOrCtrl+q"],
    });
    expect(effective.toggleSidebar).toEqual(["CmdOrCtrl+g"]);
    expect(effective.newTask).toEqual(["CmdOrCtrl+n"]);
    expect("unknownCommand" in effective).toBe(false);
  });

  it("显式空数组 = 未设置（不回退默认）——抢绑会把被抢命令清到这个状态", () => {
    const effective = resolveEffectiveShortcutBindings({ toggleSidebar: [] });
    expect(effective.toggleSidebar).toEqual([]);
  });
});

describe("快捷键冲突检测（拒绝 + 标红）", () => {
  it("保留键（编辑类 / 刷新 / F 键 / 方向键）拒绝为 reserved", () => {
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+c")).toEqual({
      kind: "reserved",
      binding: "CmdOrCtrl+c",
    });
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+r")).toMatchObject({
      kind: "reserved",
    });
    expect(checkShortcutBindingConflict("toggleSidebar", "F5")).toMatchObject({ kind: "reserved" });
    expect(checkShortcutBindingConflict("toggleSidebar", "ArrowUp")).toMatchObject({
      kind: "reserved",
    });
  });

  it("工具条三键已转正为可配置命令（spec §12.6），不再占用保留黑名单", () => {
    // CR-06 的最终解法从「拉黑」升级为「转正入表」：openModelMenu / cycleSessionMode /
    // cycleThoughtLevel 是 window 通道命令，用户可改绑/清除，冲突体系自然接管。
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+m")).toBe(false);
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+Shift+m")).toBe(false);
    expect(RESERVED_BINDINGS.has("CmdOrCtrl+t")).toBe(false);
    // 但默认绑定（显式 Ctrl）仍应被冲突检测视为占用——防止其它命令绑到同键
    expect(checkShortcutBindingConflict("toggleSidebar", "Ctrl+m")).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "Ctrl+m",
    });
  });

  it("冲突检测物理等价归一（新 CR-01）：录制产物与显式 Ctrl 默认绑定互检", () => {
    // 场景 A（win/linux 静默遮蔽路径）：录制器在 win 上把 ⌃M 平台归一为 "CmdOrCtrl+m"，
    // 字符串不等但物理等价于 openModelMenu 默认的 "Ctrl+m" —— 必须报占用而非静默保存
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+m", undefined, {
        platformInfo: WIN,
      }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "CmdOrCtrl+m",
    });
    // 反向：显式 Ctrl 串也检出（与 openModelMenu 默认绑定字符串一致，两种平台语义下都命中）
    expect(checkShortcutBindingConflict("toggleSidebar", "Ctrl+m")).toEqual({
      kind: "occupied",
      ownerCommandId: "openModelMenu",
      binding: "Ctrl+m",
    });
    // AltGr ≡ Ctrl+Alt（win）：toggleSidePane 默认 CmdOrCtrl+Alt+b，等价变体同样占用
    expect(
      checkShortcutBindingConflict("findInTask", "Ctrl+Alt+b", undefined, { platformInfo: WIN }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "toggleSidePane",
      binding: "Ctrl+Alt+b",
    });
  });

  it("macOS ⌘M 为系统菜单 minimize 固定 accelerator，不可被任何命令占用（新 CR-01 场景 B）", () => {
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+m", undefined, {
        platformInfo: MAC,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+m" });
    // minimize 是系统级行为：composer 作用域命令绑 ⌘M 同样死绑定，一并拦截
    expect(
      checkShortcutBindingConflict("composerSend", "CmdOrCtrl+m", undefined, {
        platformInfo: MAC,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+m" });
    // mac 显式 Ctrl+m 是不同物理键，不受 minimize 防线影响（openModelMenu 自身默认可保持）
    expect(
      checkShortcutBindingConflict("openModelMenu", "Ctrl+m", undefined, { platformInfo: MAC }),
    ).toBeNull();
  });

  it("抢绑清除物理等价条目（新 CR-01）：CmdOrCtrl+m 抢绑后 openModelMenu 默认 Ctrl+m 一并清空", () => {
    // 物理等价（CmdOrCtrl ≡ 显式 Ctrl）只在 win/linux 成立，必须显式钉平台：
    // node ≥21.2 的 navigator.platform 在 macOS 上是 "MacIntel"，缺省 platformInfo 会让本用例
    // 在 mac 开发机上按 apple 语义跑（⌘M ≠ ⌃M → 不清除）而失败，在 Linux CI 上却通过。
    // mac 侧 ⌘M 由上一条 reserved 防线覆盖，本用例只负责 win/linux 抢绑清理。
    const next = buildShortcutOverridesAfterSteal(undefined, "toggleSidebar", "CmdOrCtrl+m", {
      platformInfo: WIN,
    });
    expect(next.toggleSidebar).toEqual(["CmdOrCtrl+m"]);
    // openModelMenu 默认 "Ctrl+m" 与 CmdOrCtrl+m 在 win/linux 物理等价，被抢后清为未设置
    expect(next.openModelMenu).toEqual([]);
  });

  it("Web 端 menu 通道命令默认键按保留处理，不提供抢绑（CR-04）", () => {
    // 桌面端：menu 命令占用为 occupied，可走二次确认抢绑
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n")).toEqual({
      kind: "occupied",
      ownerCommandId: "newTask",
      binding: "CmdOrCtrl+n",
    });
    // Web 端：menu 通道命令的默认键被根级回退监听固定消费，按保留键拒绝（无抢绑入口）
    expect(
      checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n", undefined, {
        menuChannelReserved: true,
      }),
    ).toEqual({ kind: "reserved", binding: "CmdOrCtrl+n" });
    // window 通道命令占用在 Web 端仍是 occupied（可抢绑）
    expect(
      checkShortcutBindingConflict("findInTask", "CmdOrCtrl+b", undefined, {
        menuChannelReserved: true,
      }),
    ).toEqual({
      kind: "occupied",
      ownerCommandId: "toggleSidebar",
      binding: "CmdOrCtrl+b",
    });
  });

  it("已被其他命令占用（含默认绑定）拒绝为 occupied 并给出占用者", () => {
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+n")).toEqual({
      kind: "occupied",
      ownerCommandId: "newTask",
      binding: "CmdOrCtrl+n",
    });
    // 占用者含双默认绑定时任一绑定都算占用
    expect(checkShortcutBindingConflict("toggleSidebar", "CmdOrCtrl+Shift+p")).toEqual({
      kind: "occupied",
      ownerCommandId: "openCommandCenter",
      binding: "CmdOrCtrl+Shift+p",
    });
  });

  it("命令自身当前绑定不构成冲突（整组替换语义）", () => {
    expect(checkShortcutBindingConflict("newTask", "CmdOrCtrl+n")).toBeNull();
    expect(checkShortcutBindingConflict("openCommandCenter", "CmdOrCtrl+k")).toBeNull();
  });

  it("命令表默认绑定不得与保留键清单相交（仅 global 作用域，spec §12.2）", () => {
    for (const entry of SHORTCUT_COMMANDS) {
      if (entry.scope === "composer") {
        continue;
      }
      for (const binding of entry.defaultBindings) {
        expect(RESERVED_BINDINGS.has(binding)).toBe(false);
      }
    }
  });

  it("Enter 入全局黑名单但 composer 作用域不受限（spec §12.2）", () => {
    expect(RESERVED_BINDINGS.has("Enter")).toBe(true);
    // global 命令重绑 Enter → reserved；composer 命令重绑 Enter → 不受限
    expect(checkShortcutBindingConflict("toggleSidebar", "Enter")).toMatchObject({
      kind: "reserved",
    });
    expect(checkShortcutBindingConflict("composerSend", "Enter")).toBeNull();
    expect(checkShortcutBindingConflict("composerSend", "CmdOrCtrl+Enter")).toBeNull();
  });

  it("冲突检测作用域隔离：composer 与 global 同键互不冲突（spec §12.2）", () => {
    // CmdOrCtrl+k 是 openCommandCenter（global）默认绑定；composer 命令绑它不算冲突
    expect(checkShortcutBindingConflict("composerSend", "CmdOrCtrl+k")).toBeNull();
    // 反向同样隔离：global 命令绑 composerSend 的默认键 Enter 不算 occupied，而是 reserved
    expect(checkShortcutBindingConflict("toggleSidebar", "Shift+Enter")).toBeNull();
    // composer 作用域内部仍互相检测：composerInsertNewline 绑 composerSend 的默认键 → occupied
    expect(checkShortcutBindingConflict("composerInsertNewline", "Enter")).toEqual({
      kind: "occupied",
      ownerCommandId: "composerSend",
      binding: "Enter",
    });
  });
});

describe("按键搜索的物理等价比较 isSamePhysicalBinding", () => {
  it("win/linux：CmdOrCtrl ≡ 显式 Ctrl，AltGr 叠加 Alt 位（与冲突检测同口径）", () => {
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: WIN })).toBe(true);
    expect(isSamePhysicalBinding("Ctrl+Alt+b", "AltGr+b", { platformInfo: WIN })).toBe(true);
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "CmdOrCtrl+Shift+m", { platformInfo: WIN })).toBe(
      false,
    );
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+t", { platformInfo: LINUX })).toBe(false);
  });

  it("apple：主修饰（⌘）与 Ctrl 是独立物理键，等价关系随平台翻转", () => {
    // 同一对串在 win 上等价、在 mac 上不等价（⌘M ≠ ⌃M）—— 搜索口径与冲突口径一致
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: MAC })).toBe(false);
    expect(isSamePhysicalBinding("CmdOrCtrl+m", "Ctrl+m", { platformInfo: WIN })).toBe(true);
  });

  it("裸命名键（composer 作用域默认）与解析失败串", () => {
    expect(isSamePhysicalBinding("Enter", "Enter")).toBe(true);
    expect(isSamePhysicalBinding("Enter", "Shift+Enter")).toBe(false);
    // 非法串解析失败 → 恒不等（null 短路语义，与冲突检测一致）
    expect(isSamePhysicalBinding("not-a-binding", "Enter")).toBe(false);
  });
});

describe("拆行多绑定构建器（spec §8：一个命令多组键，行级操作）", () => {
  // openCommandCenter 默认双键：CmdOrCtrl+k / CmdOrCtrl+Shift+p
  it("追加：默认键 + 已有覆盖全部保留，新键排尾", () => {
    const next = buildShortcutOverridesAfterAppend(undefined, "openCommandCenter", "CmdOrCtrl+g");
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+Shift+p", "CmdOrCtrl+g"]);
    // 覆盖后的命令追加基于生效列表（覆盖整组替换语义）
    const replaced = buildShortcutOverridesAfterAppend(
      { openCommandCenter: ["Ctrl+y"] },
      "openCommandCenter",
      "CmdOrCtrl+g",
    );
    expect(replaced.openCommandCenter).toEqual(["Ctrl+y", "CmdOrCtrl+g"]);
    // 未分配（显式 []）追加 = 第一条
    const fromEmpty = buildShortcutOverridesAfterAppend(
      { toggleSidebar: [] },
      "toggleSidebar",
      "CmdOrCtrl+b",
    );
    expect(fromEmpty.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
  });

  it("删除：移除指定条，删空落显式 []（未分配），不影响其他命令", () => {
    const next = buildShortcutOverridesWithoutBindingAt(undefined, "openCommandCenter", 0);
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    const last = buildShortcutOverridesWithoutBindingAt(
      { openCommandCenter: ["CmdOrCtrl+k"], toggleSidebar: ["CmdOrCtrl+b"] },
      "openCommandCenter",
      0,
    );
    // 删到空 = 未分配（不回退默认），其他命令条目原样保留
    expect(last.openCommandCenter).toEqual([]);
    expect(last.toggleSidebar).toEqual(["CmdOrCtrl+b"]);
  });

  it("替换：指定位置换新键，其余条目（含默认键）保留", () => {
    const next = buildShortcutOverridesWithBindingAt(
      undefined,
      "openCommandCenter",
      1,
      "CmdOrCtrl+g",
    );
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+k", "CmdOrCtrl+g"]);
    // 无覆盖时替换第 0 条同样保留其余默认键
    const first = buildShortcutOverridesWithBindingAt(undefined, "openCommandCenter", 0, "Ctrl+y");
    expect(first.openCommandCenter).toEqual(["Ctrl+y", "CmdOrCtrl+Shift+p"]);
  });
});

describe("快捷键二次确认抢绑", () => {
  it("抢绑后目标命令绑新键，被抢命令默认绑定被清空为「未设置」", () => {
    // findInTask 抢 toggleSidebar 的默认 CmdOrCtrl+b
    const next = buildShortcutOverridesAfterSteal(undefined, "findInTask", "CmdOrCtrl+b");
    expect(next.findInTask).toEqual(["CmdOrCtrl+b"]);
    expect(next.toggleSidebar).toEqual([]);
    const effective = resolveEffectiveShortcutBindings(next);
    expect(effective.findInTask).toEqual(["CmdOrCtrl+b"]);
    expect(effective.toggleSidebar).toEqual([]);
  });

  it("被抢命令是多默认绑定时只移除被抢的那条，其余保留", () => {
    // 抢 openCommandCenter 的第一默认 CmdOrCtrl+k
    const next = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k");
    expect(next.toggleTerminal).toEqual(["CmdOrCtrl+k"]);
    expect(next.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });

  it("抢绑在既有覆盖之上叠加，不丢失无关命令的覆盖", () => {
    const next = buildShortcutOverridesAfterSteal(
      { toggleSidebar: ["CmdOrCtrl+g"] },
      "findInTask",
      "CmdOrCtrl+j", // toggleTerminal 默认
    );
    expect(next.toggleSidebar).toEqual(["CmdOrCtrl+g"]); // 无关覆盖保留
    expect(next.findInTask).toEqual(["CmdOrCtrl+j"]);
    expect(next.toggleTerminal).toEqual([]); // 被抢清空
  });

  it("多绑定命令行级抢绑：replace 只换目标条，其余绑定保留（CR-01）", () => {
    // replace 第 0 条：CmdOrCtrl+Shift+p 必须保留，不得被整组替换吞掉
    const replaceFirst = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: 0 },
    );
    expect(replaceFirst.toggleTerminal).toEqual(["CmdOrCtrl+k"]);
    expect(replaceFirst.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // replace 第 1 条：openCommandCenter 原有的 CmdOrCtrl+k 作为冲突键被移除，剩第 2 条
    const replaceSecond = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: 1 },
    );
    expect(replaceSecond.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });

  it("多绑定命令行级抢绑：未分配录第一条（append）与缺省旧行为", () => {
    // bindingIndex null（未分配占位录制）→ 追加语义；toggleTerminal 默认 CmdOrCtrl+j 保留
    const appendSteal = buildShortcutOverridesAfterSteal(
      undefined,
      "toggleTerminal",
      "CmdOrCtrl+k",
      { mode: "replace", bindingIndex: null },
    );
    expect(appendSteal.toggleTerminal).toEqual(["CmdOrCtrl+j", "CmdOrCtrl+k"]);
    expect(appendSteal.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // add 模式 → 追加到现有列表尾部
    const addSteal = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k", {
      mode: "add",
      bindingIndex: null,
    });
    expect(addSteal.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
    // 缺省（未传 mode）保持旧整组替换行为，既有调用方不受影响
    const legacy = buildShortcutOverridesAfterSteal(undefined, "toggleTerminal", "CmdOrCtrl+k");
    expect(legacy.openCommandCenter).toEqual(["CmdOrCtrl+Shift+p"]);
  });
});

describe("快捷键录制态抑制", () => {
  it("setShortcutRecordingActive 开关可读", () => {
    expect(isShortcutRecordingActive()).toBe(false);
    setShortcutRecordingActive(true);
    expect(isShortcutRecordingActive()).toBe(true);
    setShortcutRecordingActive(false);
    expect(isShortcutRecordingActive()).toBe(false);
  });
});

describe("快捷键展示 label", () => {
  it("macOS 符号风格，修饰键按 ⌃⌥⇧⌘ 顺序", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+k", MAC)).toBe("⌘ K");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Shift+p", MAC)).toBe("⇧ ⌘ P");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Alt+b", MAC)).toBe("⌥ ⌘ B");
    expect(formatShortcutBindingLabel("Ctrl+p", MAC)).toBe("⌃ P");
  });

  it("Windows/Linux 文字风格", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+k", WIN)).toBe("Ctrl+K");
    expect(formatShortcutBindingLabel("CmdOrCtrl+Alt+Shift+b", LINUX)).toBe("Ctrl+Alt+Shift+B");
    expect(formatShortcutBindingLabel("Ctrl+p", WIN)).toBe("Ctrl+P");
  });

  it("zoom 语义：= 显示为 +，- 保持", () => {
    expect(formatShortcutBindingLabel("CmdOrCtrl+=", WIN)).toBe("Ctrl++");
    expect(formatShortcutBindingLabel("CmdOrCtrl+-", WIN)).toBe("Ctrl+-");
  });

  it("逐键 token：与 label 同序同义，键帽逐个渲染（spec §8）", () => {
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Shift+p", MAC)).toEqual(["⇧", "⌘", "P"]);
    expect(formatShortcutBindingLabelParts("Ctrl+Alt+Shift+b", LINUX)).toEqual([
      "Ctrl",
      "Alt",
      "Shift",
      "B",
    ]);
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+Enter", MAC)).toEqual(["⌘", "Enter"]);
    // token 重拼与 label 串一致：两条展示路径单一事实来源
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+k", MAC).join(" ")).toBe(
      formatShortcutBindingLabel("CmdOrCtrl+k", MAC),
    );
    expect(formatShortcutBindingLabelParts("CmdOrCtrl+k", WIN).join("+")).toBe(
      formatShortcutBindingLabel("CmdOrCtrl+k", WIN),
    );
    // 非法串原样单 token 返回
    expect(formatShortcutBindingLabelParts("not-a-binding", WIN)).toEqual(["not-a-binding"]);
  });
});
