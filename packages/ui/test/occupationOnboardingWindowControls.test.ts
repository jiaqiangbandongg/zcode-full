import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Windows/Linux 桌面端引导全屏覆盖主界面（含自绘标题栏），期间必须补上
 * 最小化/最大化/关闭按钮，否则用户无法操作窗口。源码断言守住两点：
 * ① OccupationOnboarding 渲染 DesktopWindowControls 且受 showWindowControls 控制；
 * ② Root 按主界面同款条件（Windows/Linux 自绘、macOS 系统红绿灯）传入。
 */
describe("onboarding 窗口控制按钮", () => {
  it("OccupationOnboarding 顶栏渲染 DesktopWindowControls（受 prop 控制）", async () => {
    const source = await readFile(
      resolve(__dirname, "../src/onboarding/OccupationOnboarding.tsx"),
      "utf-8",
    );
    expect(source).toContain("showWindowControls?: boolean;");
    expect(source).toMatch(
      /\{showWindowControls \? \(\s*<div className="absolute right-1 top-1[^"]*">\s*<DesktopWindowControls \/>/,
    );
  });

  it("引导页与设置页使用相同的窗控定位和内边距", async () => {
    const sources = await Promise.all(
      ["onboarding/OccupationOnboarding.tsx", "SettingsPage.tsx"].map((file) =>
        readFile(resolve(__dirname, "../src", file), "utf-8"),
      ),
    );
    for (const source of sources) {
      expect(source).toMatch(
        /className="absolute right-1 top-1 z-30 mt-px mr-px flex h-12 items-center(?: gap-0\.5)? px-2/,
      );
    }
  });

  it("Root 按与主界面一致的条件传入 showWindowControls", async () => {
    const root = await readFile(resolve(__dirname, "../src/Root.tsx"), "utf-8");
    const header = await readFile(resolve(__dirname, "../src/WorkspaceHeader.tsx"), "utf-8");
    expect(root).toContain(
      "showWindowControls={Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))}",
    );
    // 与主界面 WorkspaceHeader 的内联窗控判定保持同一语义
    expect(header).toContain(
      "usesInlineWindowControls = Boolean(isWindowsDesktop || (isDesktop && !isMacDesktop))",
    );
  });
});
