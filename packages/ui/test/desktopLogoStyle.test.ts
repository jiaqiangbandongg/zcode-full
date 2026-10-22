// @vitest-environment jsdom
import { createElement, type ComponentProps, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopTopOverlay } from "@/DesktopTopOverlay.js";

vi.mock("@/ControlHintTooltip.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ControlHintTooltip.js")>()),
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/UpdateStatusButton.js", () => ({ UpdateStatusButton: () => null }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
afterEach(cleanup);

it.each([
  { name: "Windows", isDesktop: true, isWindowsDesktop: true, isMacDesktop: false },
  { name: "Linux", isDesktop: true, isWindowsDesktop: false, isMacDesktop: false },
  { name: "macOS", isDesktop: true, isWindowsDesktop: false, isMacDesktop: true },
  { name: "Web", isDesktop: false, isWindowsDesktop: false, isMacDesktop: false },
])("$name Logo 保持平台边界与侧栏点击回调", ({ isDesktop, isWindowsDesktop, isMacDesktop }) => {
  const onToggleSidebar = vi.fn();
  render(
    createElement(DesktopTopOverlay, {
      workspaceAbsPath: "/repo",
      isDesktop,
      isWindowsDesktop,
      isMacDesktop,
      isSidebarVisible: true,
      updateReadyVersion: null,
      updateState: null,
      toggleSidebarShortcutLabel: "Ctrl+B",
      newTaskShortcutLabel: "Ctrl+N",
      goBackShortcutLabel: "Alt+Left",
      goForwardShortcutLabel: "Alt+Right",
      canTaskNavBack: false,
      canTaskNavForward: false,
      canGoBack: false,
      canGoForward: false,
      appLogoUrl: "/logo.svg",
      platform: {} as ComponentProps<typeof DesktopTopOverlay>["platform"],
      onToggleSidebar,
      onCreateTask: vi.fn(),
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
    }),
  );
  if (!isDesktop || isMacDesktop) {
    expect(screen.queryByTestId("desktop-top-logo-sidebar-toggle")).toBeNull();
    return;
  }
  const logo = screen.getByTestId("desktop-top-logo-sidebar-toggle");
  fireEvent.click(logo);
  expect(onToggleSidebar).toHaveBeenCalledExactlyOnceWith();
});
