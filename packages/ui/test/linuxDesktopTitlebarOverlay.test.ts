import { readFileSync } from "node:fs";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("radix-ui", async () => {
  const actual = await vi.importActual<typeof import("radix-ui")>("radix-ui");
  return {
    ...actual,
    Dialog: {
      Root: ({ children }: { children: ReactNode }) => createElement("div", null, children),
      Trigger: ({ children, ...props }: { children: ReactNode }) =>
        createElement("button", props, children),
      Portal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
      Overlay: ({ children, ...props }: { children?: ReactNode }) =>
        createElement("div", props, children),
      Content: ({ children, ...props }: { children: ReactNode }) =>
        createElement("section", props, children),
      Title: ({ children, ...props }: { children: ReactNode }) =>
        createElement("h2", props, children),
      Description: ({ children, ...props }: { children: ReactNode }) =>
        createElement("p", props, children),
      Close: ({ children }: { children: ReactNode }) => createElement("span", null, children),
    },
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/hooks/useGlobalTaskList.js", () => ({
  useGlobalTaskList: () => ({
    items: [],
    loading: false,
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    fileService: {
      listWorkspaceFiles: vi.fn(async () => []),
    },
  }),
}));

function renderTaskFindDialog(options: {
  isLinuxDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}) {
  return import("@/quickpick/TaskFindDialog.js").then(({ TaskFindDialog }) =>
    renderWithTooltipProvider(
      createElement(TaskFindDialog, {
        open: true,
        focusRequestId: 0,
        conversationMatchCount: 0,
        conversationMatchIndex: -1,
        fileChangeMatchCount: 0,
        fileChangeMatchIndex: -1,
        onConversationFindChange: vi.fn(),
        onConversationFindNavigate: vi.fn(),
        onFileChangeFindChange: vi.fn(),
        onFileChangeFindNavigate: vi.fn(),
        onOpenChange: vi.fn(),
        onOpenFileChanges: vi.fn(),
        ...options,
      }),
    ),
  );
}

function renderCommandCenterDialog() {
  return import("@/command-center/CommandCenterDialog.js").then(({ CommandCenterDialog }) =>
    renderWithTooltipProvider(
      createElement(CommandCenterDialog, {
        open: true,
        commands: [],
        workspaceAbsPath: "/workspace",
        workspaceTabs: [],
        onOpenChange: vi.fn(),
        onSelectTask: vi.fn(),
        onOpenCodeViewer: vi.fn(),
      }),
    ),
  );
}

function renderWithTooltipProvider(element: ReactElement) {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element));
}

describe("Desktop titlebar overlay guards", () => {
  it("registers the Linux desktop Tailwind variant used by shared overlays", () => {
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");

    expect(styles).toContain("@custom-variant platform-linux-desktop");
    expect(styles).toContain(".platform-linux-desktop");
  });

  it("registers the Windows desktop variant and renderer root marker for caption-safe overlays", () => {
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");
    const desktopRendererSource = readFileSync(
      "packages/desktop/src/renderer/src/main.tsx",
      "utf8",
    );

    expect(styles).toContain("@custom-variant platform-windows-desktop");
    expect(styles).toContain(".platform-windows-desktop");
    expect(desktopRendererSource).toContain(
      'document.documentElement.classList.toggle("platform-windows-desktop", isWindowsDesktop)',
    );
  });

  it("registers the macOS desktop variant and renderer root marker for native-titlebar-safe overlays", () => {
    const styles = readFileSync("packages/ui/src/styles.css", "utf8");
    const desktopRendererSource = readFileSync(
      "packages/desktop/src/renderer/src/main.tsx",
      "utf8",
    );

    expect(styles).toContain("@custom-variant platform-mac-desktop");
    expect(styles).toContain(".platform-mac-desktop");
    expect(desktopRendererSource).toContain(
      'document.documentElement.classList.toggle("platform-mac-desktop", isMacDesktop)',
    );
  });

  it("keeps Linux modal overlays full-window and vertically centered", () => {
    const dialogSource = readFileSync("packages/ui/src/components/ui/dialog.tsx", "utf8");
    const alertDialogSource = readFileSync(
      "packages/ui/src/components/ui/alert-dialog.tsx",
      "utf8",
    );

    expect(dialogSource).not.toContain("platform-linux-desktop:top-12");
    expect(dialogSource).not.toContain("platform-linux-desktop:top-[calc(50%+1.5rem)]");
    expect(alertDialogSource).not.toContain("platform-linux-desktop:top-12");
    expect(alertDialogSource).not.toContain("platform-linux-desktop:top-[calc(50%+1.5rem)]");
  });

  it("keeps image preview actions inset below desktop window controls", () => {
    const imagePreviewSource = readFileSync(
      "packages/ui/src/components/ai-elements/image-preview-dialog.tsx",
      "utf8",
    );

    // Bugfix: Windows caption controls占据右上角；Linux 预览内容虽已整体避开自绘标题栏，
    // action row 仍需显式保留平台 inset，避免后续全屏布局重构把按钮重新推回窗控区。
    expect(imagePreviewSource).toContain("platform-linux-desktop:right-6");
    expect(imagePreviewSource).toContain("platform-linux-desktop:top-4");
    expect(imagePreviewSource).toContain("platform-mac-desktop:top-12");
    expect(imagePreviewSource).toContain("platform-windows-desktop:right-6");
    expect(imagePreviewSource).toContain(
      "platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]",
    );
  });

  it("keeps the command center top-positioned after CommandDialog class merging", async () => {
    const html = await renderCommandCenterDialog();

    // Bugfix: Command Center 不是居中弹窗，不能继承 DialogContent 的 Linux 居中补偿。
    expect(html).toContain("top-16");
    expect(html).toContain("sm:top-20");
    expect(html).toContain("platform-linux-desktop:top-16");
    expect(html).toContain("sm:platform-linux-desktop:top-20");
    expect(html).not.toContain("platform-linux-desktop:top-[calc(50%+1.5rem)]");
  });

  it("moves the task find popup out of the Linux titlebar and window controls", async () => {
    const linuxHtml = await renderTaskFindDialog({ isLinuxDesktop: true });
    const webHtml = await renderTaskFindDialog({});

    // Bugfix: Linux 的查找浮层不能贴住 top-3，否则会挡住 renderer 自绘标题栏点击区。
    expect(linuxHtml).toContain("top-12 right-[120px]");
    expect(webHtml).toContain("top-3 right-3");
    expect(webHtml).not.toContain("right-[120px]");
  });
});
