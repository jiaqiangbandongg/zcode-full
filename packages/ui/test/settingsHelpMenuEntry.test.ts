import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("settings help menu entry", () => {
  it("renders the shared workspace help menu on every platform", () => {
    const settingsPageSource = readSource("packages/ui/src/SettingsPage.tsx");

    expect(settingsPageSource).toContain("import { WorkspaceHelpMenuButton }");
    expect(settingsPageSource).not.toContain("usesCaptionHelpMenu");
    expect(settingsPageSource).toContain(
      "<WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />",
    );
    expect(settingsPageSource).toContain("relative flex flex-col");
    expect(settingsPageSource).toContain("absolute right-2.5 top-2.5");
    expect(settingsPageSource).toContain("在内容面板内定位");
    expect(settingsPageSource).not.toContain("mr-[165px]");
    expect(settingsPageSource).not.toContain('isWindowsDesktop && "h-12"');
  });

  it("uses the macOS question-mark help entry before inline desktop controls", () => {
    const settingsPageSource = readSource("packages/ui/src/SettingsPage.tsx");

    expect(settingsPageSource).not.toContain("import { WindowsCaptionMenuButton }");
    expect(settingsPageSource).not.toContain("<WindowsCaptionMenuButton");
    const helpIndex = settingsPageSource.indexOf(
      "<WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} />",
    );
    const controlsIndex = settingsPageSource.indexOf("<DesktopWindowControls />");
    expect(helpIndex).toBeGreaterThan(-1);
    expect(controlsIndex).toBeGreaterThan(helpIndex);
    expect(settingsPageSource).toContain("<DesktopWindowControls />");
    expect(settingsPageSource).toContain('usesInlineWindowControls ? "mr-[134px]" : "mr-12"');
  });

  it("passes desktop mode into the shared profile menu footer", () => {
    const settingsPageSource = readSource("packages/ui/src/SettingsPage.tsx");
    const footerIndex = settingsPageSource.indexOf("<WorkspaceSidebarFooter");
    const footerCloseIndex = settingsPageSource.indexOf("/>", footerIndex);
    const footerUsage = settingsPageSource.slice(footerIndex, footerCloseIndex);

    expect(footerIndex).toBeGreaterThan(-1);
    expect(footerUsage).toContain("isDesktop={isDesktop}");
    expect(footerUsage).toContain("头像菜单是 WorkspaceSidebarFooter 的共享菜单");
  });
});
