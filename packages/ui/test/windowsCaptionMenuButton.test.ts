import { createElement } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "zh-CN",
  }),
}));

const capturedDropdownContentProps = vi.hoisted(() => ({
  calls: [] as Array<{ align?: string; alignOffset?: number }>,
}));

const capturedWindowsCaptionMenu = vi.hoisted(() => {
  const screenshot = {
    dataBase64: "base64-image",
    filename: "zcode-error-2026-06-17.png",
    contentType: "image/png",
    size: 12,
  };

  return {
    screenshot,
    menuItems: [] as Array<{
      label: string;
      onSelect: (() => void | Promise<void>) | undefined;
    }>,
    openSubmit: vi.fn(),
    openFeatureRequest: vi.fn(),
    openExternal: vi.fn(),
    exportLogs: vi.fn(async () => ({ success: true })),
    captureWindowScreenshot: vi.fn(async () => screenshot),
    executeDesktopCommand: vi.fn(async () => undefined),
  };
});

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuCheckboxItem: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuContent: ({
    children,
    align,
    alignOffset,
  }: {
    children: ReactNode;
    align?: string;
    alignOffset?: number;
  }) => {
    capturedDropdownContentProps.calls.push({ align, alignOffset });
    return createElement("div", null, children);
  },
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
  }) => {
    const label = Array.isArray(children)
      ? children.filter((child) => typeof child === "string").join("")
      : typeof children === "string"
        ? children
        : "";
    capturedWindowsCaptionMenu.menuItems.push({ label, onSelect });
    return createElement("div", null, children);
  },
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/components/ui/toast.js", () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(() => 1),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) =>
    selector({
      openSubmit: capturedWindowsCaptionMenu.openSubmit,
      openFeatureRequest: capturedWindowsCaptionMenu.openFeatureRequest,
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    canOpenCommunity: vi.fn(async () => false),
    captureWindowScreenshot: capturedWindowsCaptionMenu.captureWindowScreenshot,
    executeDesktopCommand: capturedWindowsCaptionMenu.executeDesktopCommand,
    exportLogs: capturedWindowsCaptionMenu.exportLogs,
    openExternal: capturedWindowsCaptionMenu.openExternal,
    openInFileManager: vi.fn(async () => ({ success: true })),
  }),
}));

describe("WindowsCaptionMenuButton", () => {
  async function renderButton(
    triggerPresentation?: "header" | "header-borderless",
    useWindowsCaptionSpacing = false,
  ) {
    capturedDropdownContentProps.calls = [];
    capturedWindowsCaptionMenu.menuItems = [];
    const { WindowsCaptionMenuButton } = await import("@/WindowsCaptionMenuButton.js");
    // 快捷键特性后组件经 useShortcutCommandLabel 读设置，裸渲染需提供最小 ServiceProvider
    const { ServiceProvider } = await import("@/hooks/useServices.js");
    const { createSettingsTestServices } = await import("./lib/settingsTestServices.js");
    return renderToStaticMarkup(
      createElement(
        ServiceProvider,
        { services: createSettingsTestServices() },
        createElement(WindowsCaptionMenuButton, {
          workspaceAbsPath: "/workspace",
          onCreateTask: vi.fn(),
          onOpenWorkspace: vi.fn(),
          onToggleBrowser: vi.fn(),
          onToggleTerminal: vi.fn(),
          triggerPresentation,
          useWindowsCaptionSpacing,
        }),
      ),
    );
  }

  it("keeps the normal header trigger flush with the caption edge", async () => {
    const html = await renderButton("header");

    expect(html).toContain("border-l");
    expect(html).not.toContain("bg-surface");
  });

  it("uses the header trigger shape without a border for Windows new task drafts", async () => {
    const html = await renderButton("header-borderless", true);

    // Bugfix: Windows 新任务草稿态要和 session task 的标题栏入口一致，但不能再带左侧分隔线。
    expect(html).toContain(
      "h-full w-[var(--windows-caption-control-width,46px)] rounded-none border-0 hover:bg-hover",
    );
    expect(html).not.toContain("border-l");
    expect(html).not.toContain("bg-surface");
  });

  it("keeps the legacy caption trigger width unless Windows spacing is requested", async () => {
    const html = await renderButton("header-borderless");

    expect(html).toContain("h-full w-[45px] rounded-none border-0 hover:bg-hover");
    expect(html).not.toContain("--windows-caption-control-width");
  });

  it("does not render the retired bulk session stress menu entry", async () => {
    const html = await renderButton("header");

    // Bugfix: Windows 标题栏使用自绘合并菜单，原生菜单删掉后这里也不能残留旧压测入口。
    expect(html).not.toContain("titleBar.menu.help.toggleBulkSessionStressTest");
  });

  it("Preview 隐藏更新入口，生产版继续保留", async () => {
    const { shouldShowDesktopUpdateEntry } = await import("@/WindowsCaptionMenuButton.js");

    // 更新入口跟随产品身份：生产后端的 Preview 同样隐藏。
    expect(shouldShowDesktopUpdateEntry("preview")).toBe(false);
    expect(shouldShowDesktopUpdateEntry("production")).toBe(true);

    const html = await renderButton("header");
    expect(html).not.toContain("titleBar.menu.help.checkForUpdates");
  });

  it("includes help actions migrated from the shared question-mark menu", async () => {
    capturedWindowsCaptionMenu.openSubmit.mockClear();
    capturedWindowsCaptionMenu.openFeatureRequest.mockClear();
    capturedWindowsCaptionMenu.openExternal.mockClear();
    capturedWindowsCaptionMenu.exportLogs.mockClear();
    capturedWindowsCaptionMenu.captureWindowScreenshot.mockClear();

    const html = await renderButton("header");

    expect(html).toContain("titleBar.menu.help.feedback");
    expect(html).toContain("workspaceHeader.help.productRequest");
    expect(html).toContain("workspaceHeader.help.docs");
    expect(html).toContain("titleBar.menu.help.exportLogs");

    await capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.feedback")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.productRequest")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "workspaceHeader.help.docs")
      ?.onSelect?.();
    capturedWindowsCaptionMenu.menuItems
      .find((item) => item.label === "titleBar.menu.help.exportLogs")
      ?.onSelect?.();

    expect(capturedWindowsCaptionMenu.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(capturedWindowsCaptionMenu.openSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bug",
        includeLogs: true,
        screenshots: [],
      }),
    );
    expect(capturedWindowsCaptionMenu.openFeatureRequest).toHaveBeenCalledTimes(1);
    expect(capturedWindowsCaptionMenu.openExternal).toHaveBeenCalledWith("https://zcode.z.ai/docs");
    expect(capturedWindowsCaptionMenu.exportLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps the menu surface clear of the native Windows caption buttons", async () => {
    await renderButton("header");

    // Bugfix: Windows 原生 titleBarOverlay 宽度存在 DPI/取整差异，右对齐菜单需要轻微左移避开最小化按钮。
    expect(capturedDropdownContentProps.calls[0]).toMatchObject({
      align: "end",
      alignOffset: -12,
    });
  });
});
