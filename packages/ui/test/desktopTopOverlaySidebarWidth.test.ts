import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("DesktopTopOverlay sidebar width sync", () => {
  it("keeps resize width sync local to the overlay instead of App state", () => {
    const appSource = readSource("packages/ui/src/App.tsx");
    const layoutSource = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const overlaySource = readSource("packages/ui/src/DesktopTopOverlay.tsx");
    const chromeStateSource = readSource("packages/ui/src/app-shell/useAppChromeState.ts");

    expect(appSource).not.toContain("sidebarWidthPx");
    expect(layoutSource).not.toContain("sidebarWidthPx");
    expect(chromeStateSource).not.toContain("setSidebarWidthPx");
    expect(overlaySource).toContain("--workspace-sidebar-panel-width");
    expect(overlaySource).not.toContain("ResizeObserver");
    expect(overlaySource).not.toContain("requestAnimationFrame");
    expect(overlaySource).not.toContain("getBoundingClientRect");
    expect(overlaySource).not.toContain("overlayElement.style.width");
    expect(overlaySource).not.toContain("sidebarContainerRef");
  });

  it("keeps macOS top overlay padding driven by window control metrics", () => {
    const overlaySource = readSource("packages/ui/src/DesktopTopOverlay.tsx");
    const chromeStateSource = readSource("packages/ui/src/app-shell/useAppChromeState.ts");

    expect(chromeStateSource).toContain("onWindowControlsOverlayChanged");
    expect(chromeStateSource).toContain("getWindowControlsOverlayMetrics");
    expect(chromeStateSource).toContain("setMacWindowControlsLeftPaddingPx");
    expect(chromeStateSource).toContain("setWindowsWindowControlsRightPaddingPx");
    expect(overlaySource).toContain("macTopOverlayPaddingStyle");
    expect(overlaySource).toContain("windowsTopOverlayPaddingStyle");
    expect(overlaySource).toContain("paddingLeft");
    expect(overlaySource).toContain("paddingRight");
    expect(overlaySource).not.toContain('"pl-24 pt-2"');
  });

  it("keeps native window control padding independent from sidebar geometry reads", () => {
    const overlaySource = readSource("packages/ui/src/DesktopTopOverlay.tsx");
    const actionButtonSource = readSource("packages/ui/src/DesktopTopOverlayActionButton.tsx");

    expect(overlaySource).toContain("macTopOverlayPaddingStyle");
    expect(overlaySource).toContain("windowsTopOverlayPaddingStyle");
    expect(overlaySource).not.toContain("useLayoutEffect");
    expect(actionButtonSource).toContain("transition-colors");
  });
});
