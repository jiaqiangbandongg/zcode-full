import { describe, expect, it } from "vitest";
import { resolveTopOverlayLeadingPaddingClass } from "@/WorkspaceHeader.js";

// WorkspaceHeader 与 Side Pane 完整视图 tab 栏共用：侧栏收起时给左上角浮层按钮组让位。
describe("resolveTopOverlayLeadingPaddingClass", () => {
  it("does not reserve space while the sidebar is visible", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: true, isMacDesktop: true }),
    ).toBe(false);
  });

  it("reserves the macOS traffic lights plus overlay buttons", () => {
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, isMacDesktop: true }),
    ).toBe("pl-58");
    expect(
      resolveTopOverlayLeadingPaddingClass({
        isSidebarVisible: false,
        isMacDesktop: true,
        isMacFullscreen: true,
        hasUpdateReady: true,
      }),
    ).toBe("pl-48");
  });

  it("reserves only the overlay buttons on Windows and Linux", () => {
    expect(resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false })).toBe("pl-38");
    expect(
      resolveTopOverlayLeadingPaddingClass({ isSidebarVisible: false, hasUpdateReady: true }),
    ).toBe("pl-44");
  });
});
