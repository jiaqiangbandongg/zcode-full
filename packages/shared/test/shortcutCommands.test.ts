import { describe, expect, it } from "vitest";
import {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  isValidShortcutBinding,
  parseShortcutBinding,
  serializeShortcutBinding,
} from "../src/shortcutCommands.js";

describe("shortcutCommands 序列化格式", () => {
  it("解析并往返规范形式的绑定", () => {
    expect(serializeShortcutBinding(parseShortcutBinding("CmdOrCtrl+Shift+p")!)).toBe(
      "CmdOrCtrl+Shift+p",
    );
    expect(serializeShortcutBinding(parseShortcutBinding("CmdOrCtrl+Alt+b")!)).toBe(
      "CmdOrCtrl+Alt+b",
    );
    expect(serializeShortcutBinding(parseShortcutBinding("CmdOrCtrl+-")!)).toBe("CmdOrCtrl+-");
  });

  it("修饰键顺序不敏感，序列化输出固定顺序", () => {
    const parsed = parseShortcutBinding("Shift+Alt+CmdOrCtrl+b");
    expect(parsed).not.toBeNull();
    expect(serializeShortcutBinding(parsed!)).toBe("CmdOrCtrl+Alt+Shift+b");
  });

  it("Plus/Equal/Minus 别名归一为字符键", () => {
    expect(parseShortcutBinding("CmdOrCtrl+Plus")?.key).toBe("=");
    expect(parseShortcutBinding("CmdOrCtrl+Equal")?.key).toBe("=");
    expect(parseShortcutBinding("CmdOrCtrl+Minus")?.key).toBe("-");
    expect(serializeShortcutBinding(parseShortcutBinding("CmdOrCtrl+Plus")!)).toBe("CmdOrCtrl+=");
  });

  it("接受符号键与数字键（zoom 命令的现实需要）", () => {
    expect(isValidShortcutBinding("CmdOrCtrl+=")).toBe(true);
    expect(isValidShortcutBinding("CmdOrCtrl+-")).toBe(true);
    expect(isValidShortcutBinding("CmdOrCtrl+0")).toBe(true);
    expect(isValidShortcutBinding("CmdOrCtrl+Shift+]")).toBe(true);
  });

  it("拒绝大写字母键（规范形式统一小写）", () => {
    expect(parseShortcutBinding("CmdOrCtrl+P")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl+Shift+P")).toBeNull();
  });

  it("拒绝非法输入：空串、裸加号、缺键、未知键、重复/未知修饰键、单键裸修饰", () => {
    expect(parseShortcutBinding("")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl++")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl+")).toBeNull();
    expect(parseShortcutBinding("+")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl+ß")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl+CmdOrCtrl+k")).toBeNull();
    // Electron 的其他修饰名（Meta/Command/Super）不在本格式内
    expect(parseShortcutBinding("Meta+k")).toBeNull();
    expect(parseShortcutBinding("Command+k")).toBeNull();
  });

  it("无修饰键单键格式上合法（spec §3：格式合法、匹配支持）", () => {
    expect(serializeShortcutBinding(parseShortcutBinding("F5")!)).toBe("F5");
    expect(serializeShortcutBinding(parseShortcutBinding("]")!)).toBe("]");
  });

  it("命名键白名单大小写敏感", () => {
    expect(parseShortcutBinding("CmdOrCtrl+ArrowUp")?.key).toBe("ArrowUp");
    expect(parseShortcutBinding("CmdOrCtrl+arrowup")).toBeNull();
    expect(parseShortcutBinding("CmdOrCtrl+F13")).toBeNull();
  });

  it("Enter 族键可表示（composer 作用域命令的现实需要，spec §12.2）", () => {
    expect(serializeShortcutBinding(parseShortcutBinding("Enter")!)).toBe("Enter");
    expect(serializeShortcutBinding(parseShortcutBinding("Shift+Enter")!)).toBe("Shift+Enter");
    expect(serializeShortcutBinding(parseShortcutBinding("CmdOrCtrl+Enter")!)).toBe(
      "CmdOrCtrl+Enter",
    );
    // 大小写敏感不变
    expect(parseShortcutBinding("enter")).toBeNull();
  });
});

describe("shortcutCommands 命令表", () => {
  it("命令 ID 不重复，且默认绑定全部为合法规范形式", () => {
    const ids = new Set<string>();
    for (const entry of SHORTCUT_COMMANDS) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.defaultBindings.length).toBeGreaterThan(0);
      for (const binding of entry.defaultBindings) {
        expect(isValidShortcutBinding(binding)).toBe(true);
      }
    }
  });

  it("未知命令返回空数组", () => {
    expect(getDefaultShortcutBindings("doesNotExist")).toEqual([]);
  });
});

describe("Side Pane 完整视图快捷键", () => {
  it("默认绑定 ⇧⌘F / Ctrl+Shift+F，走 renderer window 通道", () => {
    const entry = SHORTCUT_COMMANDS.find((candidate) => candidate.id === "toggleSidePaneFullView");
    expect(entry?.channel).toBe("window");
    expect(getDefaultShortcutBindings("toggleSidePaneFullView")).toEqual(["CmdOrCtrl+Shift+f"]);
  });
});
