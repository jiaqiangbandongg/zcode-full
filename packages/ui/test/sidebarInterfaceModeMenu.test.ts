import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CR-01 回归：侧边栏"界面模式"菜单的办公模式项 value 必须是 "office"。
 * 改名 office 时该菜单项漏改（value 残留旧名 "general"），normalizeInterfaceMode
 * 只认 "office"，点办公模式实际切成 coding，且 RadioGroup value 永不匹配旧名，
 * 选中态永远不亮。以源码断言方式守住（该菜单无组件渲染测试基建）。
 */
describe("侧边栏界面模式菜单", () => {
  it("办公模式 RadioItem 的 value 为 office 且与 RadioGroup 取值域一致", async () => {
    const source = await readFile(resolve(__dirname, "../src/WorkspaceSidebarFooter.tsx"), "utf-8");
    const groupMatch = source.match(
      /<DropdownMenuRadioGroup[^>]*value=\{interfaceMode\}[\s\S]*?<\/DropdownMenuRadioGroup>/,
    );
    expect(groupMatch).not.toBeNull();
    const group = groupMatch![0];
    const values = [...group.matchAll(/<DropdownMenuRadioItem value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(["coding", "office"]);
    // InterfaceMode 类型只有 office|coding，菜单项 value 不允许再出现旧名。
    expect(values).not.toContain("general");
  });
});
