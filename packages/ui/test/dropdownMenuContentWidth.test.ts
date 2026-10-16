import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dropdownMenuSource = readFileSync(
  new URL("../src/components/ui/dropdown-menu.tsx", import.meta.url),
  "utf8",
);

describe("shared dropdown menu content width", () => {
  // Bug：DropdownMenuContent 曾把宽度绑到 --radix-dropdown-menu-trigger-width。
  // 图标按钮触发器只有 ~28px，实际宽度被 min-w-32(128px) 卡死，
  // 「恢复 User 默认」「Restore User default」等菜单项被迫折成两行。
  it("菜单按内容撑开，不再绑定触发器宽度", () => {
    expect(dropdownMenuSource).not.toContain("w-(--radix-dropdown-menu-trigger-width)");
    expect(dropdownMenuSource).toContain("min-w-32");
  });

  it("菜单宽度受 Radix 可用宽度约束，窄屏 Web 端不会撑出视口", () => {
    expect(dropdownMenuSource).toContain("max-w-(--radix-dropdown-menu-content-available-width)");
  });
});
