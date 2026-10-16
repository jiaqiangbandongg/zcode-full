// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlDialog,
  isSameWebRemoteControlTarget,
  isReusableWebRemoteControlSession,
  getWebRemoteControlStatusTagLabel,
} from "@/WebRemoteControlDialog.js";

vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: ReactNode;
    [key: string]: unknown;
  }) => createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  DialogContent: ({
    children,
    className,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children?: ReactNode;
    className?: string;
    showCloseButton?: boolean;
    [key: string]: unknown;
  }) => createElement("section", { className, ...props }, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    createElement("p", null, children),
  DialogHeader: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => createElement("header", { className }, children),
  DialogTitle: ({ children }: { children?: ReactNode }) =>
    createElement("h2", null, children),
}));

const feedbackMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: feedbackMocks.toast }));

vi.mock("@/BotsDialog.js", () => ({
  BotsDialog: () => createElement("div", { "data-testid": "bots-dialog" }),
}));

const platformMock = vi.hoisted(() => ({
  getWebRemoteControlStatus: vi.fn(async () => ({ status: "idle" })),
  startWebRemoteControl: vi.fn(async () => ({ status: "running" })),
  refreshWebRemoteControlPairing: vi.fn(async () => ({ status: "running" })),
  stopWebRemoteControl: vi.fn(async () => {}),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platformMock,
}));

const confirmDialogMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => confirmDialogMock,
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { theme: string }) => unknown) =>
    selector({ theme: "zai-dark" }),
}));

const intlMock = vi.hoisted(() => ({
  intl: {
    formatMessage: ({ id }: { id: string }) => id,
  },
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => intlMock,
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: feedbackMocks.error,
    info: feedbackMocks.info,
  },
}));

function readWebRemoteControlDialogSource() {
  // Bugfix: WebRemoteControlDialog 经过 React.memo 包装后，组件 toString() 只会返回 [object Object]。
  // 源码结构守卫需要读取真实文件，才能继续校验复用顺序和确认弹窗保护没有被性能优化绕开。
  return readFileSync("packages/ui/src/WebRemoteControlDialog.tsx", "utf8");
}

describe("WebRemoteControlDialog layout", () => {
  afterEach(() => {
    cleanup();
    platformMock.getWebRemoteControlStatus.mockClear();
    platformMock.startWebRemoteControl.mockClear();
    platformMock.refreshWebRemoteControlPairing.mockClear();
    platformMock.stopWebRemoteControl.mockClear();
    feedbackMocks.error.mockClear();
    feedbackMocks.info.mockClear();
    feedbackMocks.toast.mockClear();
    confirmDialogMock.mockClear();
  });

  it("treats native start cancellation as idle without failure UI", async () => {
    platformMock.startWebRemoteControl.mockResolvedValueOnce({ status: "cancelled" });

    const view = render(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    await waitFor(() => expect(platformMock.startWebRemoteControl).toHaveBeenCalledOnce());
    expect(view.container.textContent).toContain("webRemoteControl.statusDetail.idle");
    expect(feedbackMocks.toast).not.toHaveBeenCalled();
    expect(feedbackMocks.error).not.toHaveBeenCalled();
  });

  it("keeps the running status and shows no feedback when native refresh is cancelled", async () => {
    platformMock.getWebRemoteControlStatus.mockResolvedValueOnce({
      status: "running",
      sessionId: "sid-1",
      mobileConnected: true,
      workspacePath: "/tmp/project",
    });
    platformMock.refreshWebRemoteControlPairing.mockResolvedValueOnce({ status: "cancelled" });

    const view = render(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );
    const refreshButton = await view.findByRole("button", {
      name: "webRemoteControl.refreshQr",
    });

    fireEvent.click(refreshButton);

    await waitFor(() => expect(platformMock.refreshWebRemoteControlPairing).toHaveBeenCalledOnce());
    expect(view.container.textContent).toContain("webRemoteControl.statusDetail.running");
    expect(feedbackMocks.toast).not.toHaveBeenCalled();
    expect(feedbackMocks.error).not.toHaveBeenCalled();
  });

  it("仅在 workspace 与 remoteSessionId 都匹配时复用远控状态", () => {
    expect(
      isSameWebRemoteControlTarget(
        {
          status: "running",
          sessionId: "sid-1",
          workspacePath: "/tmp/workspace-a",
        },
        "/tmp/workspace-b",
      ),
    ).toBe(false);

    expect(
      isSameWebRemoteControlTarget(
        {
          status: "running",
          sessionId: "sid-1",
          workspacePath: "/tmp/workspace-a",
          remoteSessionId: "remote-a",
        },
        "/tmp/workspace-a",
        undefined,
        "remote-b",
      ),
    ).toBe(false);

    expect(
      isSameWebRemoteControlTarget(
        {
          status: "running",
          sessionId: "sid-1",
          workspacePath: "/tmp/workspace-a",
          workspaceIdentity: "ssh://host/repo",
          remoteSessionId: "remote-a",
        },
        "/tmp/any-local-path",
        "ssh://host/repo",
        "remote-a",
      ),
    ).toBe(true);
  });

  it("复用已有 window 级远控会话时不要求 workspace 匹配", () => {
    expect(
      isReusableWebRemoteControlSession({
        status: "active",
        sessionId: "sid-1",
        mobileConnected: true,
        workspacePath: "/tmp/workspace-a",
      }),
    ).toBe(true);

    expect(
      isReusableWebRemoteControlSession({
        status: "idle",
      }),
    ).toBe(false);

    expect(
      isReusableWebRemoteControlSession({
        status: "error",
        sessionId: "sid-1",
        mobileConnected: true,
        workspacePath: "/tmp/workspace-a",
      }),
    ).toBe(false);

    expect(
      isReusableWebRemoteControlSession({
        status: "running",
        sessionId: "sid-1",
        mobileConnected: false,
        workspacePath: "/tmp/workspace-a",
      }),
    ).toBe(false);
  });

  it("打开弹层时先复用已连接手机的 window 会话再考虑重新 start", () => {
    const source = readWebRemoteControlDialogSource();
    const reuseIndex = source.indexOf(
      "isReusableWebRemoteControlSession(currentStatus)",
    );
    const startIndex = source.indexOf("platform.startWebRemoteControl");
    const pollReuseIndex = source.indexOf(
      "isReusableWebRemoteControlSession(nextStatus)",
    );

    expect(reuseIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(-1);
    expect(reuseIndex).toBeLessThan(startIndex);
    expect(pollReuseIndex).toBeGreaterThan(-1);
  });

  it("uses Remote Connect width without forcing the lighter dialog to full height", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    expect(html).toContain("max-h-[calc(100vh-6rem)]");
    expect(html).toContain("max-w-4xl");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain('data-testid="web-remote-control-dialog-scroll"');
    expect(html).not.toContain('class="h-[calc(100vh-6rem)]');
    expect(html).toContain("overflow-y-auto");
  });

  it("renders phone QR and bot channel entry cards in the remote control dialog", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    expect(html).toContain('data-testid="web-remote-control-main-grid"');
    expect(html).toContain("webRemoteControl.mobileQr.title");
    expect(html).toContain("webRemoteControl.botChannel.title");
    expect(html).toContain("webRemoteControl.botChannel.weixin.title");
    expect(html).toContain("webRemoteControl.botChannel.feishu.title");
    expect(html).toContain("webRemoteControl.botChannel.lark.title");
    expect(html).toContain("webRemoteControl.botChannel.telegram.title");
    expect(html).toContain("login.oauth.regionTag.bigmodel");
    expect(html).toContain("login.oauth.regionTag.zai");
    expect(html).not.toContain("web-remote-control-bot-channel-logo-");
    expect(html).toContain("size-12");
    expect(html).toContain("border-transparent");
    expect(html).toContain('data-testid="web-remote-control-open-bots"');
    expect(html).toContain("webRemoteControl.botChannel.manageBots");

    const larkIndex = html.indexOf("webRemoteControl.botChannel.lark.title");
    const larkTagIndex = html.indexOf("login.oauth.regionTag.zai");
    const telegramIndex = html.indexOf("webRemoteControl.botChannel.telegram.title");
    const openBotsIndex = html.indexOf('data-testid="web-remote-control-open-bots"');
    expect(larkTagIndex).toBeGreaterThan(larkIndex);
    expect(larkTagIndex).toBeLessThan(telegramIndex);
    expect(telegramIndex).toBeGreaterThan(larkIndex);
    expect(openBotsIndex).toBeGreaterThan(telegramIndex);
  });

  it("merges status and copy link inside the Scan from phone card", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    const scanCardIndex = html.indexOf('data-testid="web-remote-control-scan-card"');
    const connectionCardIndex = html.indexOf(
      'data-testid="web-remote-control-connection-card"',
    );
    const copyLinkIndex = html.indexOf('data-testid="web-remote-control-copy-link-row"');
    const botChannelIndex = html.indexOf("webRemoteControl.botChannel.title");

    expect(scanCardIndex).toBeGreaterThan(-1);
    expect(connectionCardIndex).toBeGreaterThan(scanCardIndex);
    expect(copyLinkIndex).toBeGreaterThan(connectionCardIndex);
    expect(copyLinkIndex).toBeLessThan(botChannelIndex);
    expect(html).toContain('data-testid="web-remote-control-connection-card"');
    expect(html).toContain('data-testid="web-remote-control-copy-link-row"');
    expect(html).toContain("items-center");
    expect(html).toContain("webRemoteControl.statusDetail.idle");
    expect(html).toContain("webRemoteControl.copyLink.description");
    expect(html).not.toContain('data-testid="web-remote-control-copy-link-card"');
    expect(html).not.toContain("mt-5 flex min-h-11");
  });

  it("renders a refresh QR action near the copied mobile link", () => {
    const html = renderToStaticMarkup(
      createElement(WebRemoteControlDialog, {
        open: true,
        onOpenChange: vi.fn(),
        workspacePath: "/tmp/project",
      }),
    );

    const refreshIndex = html.indexOf("webRemoteControl.refreshQr");
    const copyIndex = html.indexOf("webRemoteControl.copyLink</button>");

    expect(refreshIndex).toBeGreaterThan(-1);
    expect(copyIndex).toBeGreaterThan(-1);
    expect(refreshIndex).toBeLessThan(copyIndex);
  });

  it("asks for confirmation before refreshing pairing material", () => {
    const source = readWebRemoteControlDialogSource();
    const confirmIndex = source.indexOf("confirmDialog({");
    const refreshIndex = source.indexOf("platform.refreshWebRemoteControlPairing");

    expect(source).toContain("webRemoteControl.refreshQr.confirmTitle");
    expect(source).toContain("webRemoteControl.refreshQr.confirmDescription");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeLessThan(refreshIndex);
  });

  it("uses the paired mobile device name for the status tag instead of session id", () => {
    expect(
      getWebRemoteControlStatusTagLabel(
        {
          status: "active",
          sessionId: "sid-12345678",
          mobileConnected: true,
          mobileDeviceInfo: {
            platform: "web",
            version: "1.7.0",
            name: "mobile-browser",
            browserPlatform: "iPhone",
            updatedAt: 1,
          },
        },
        ({ id }: { id: string }) => id,
      ),
    ).toBe("iPhone");
  });

  it("does not let dialog-local state decide the global remote-control session state", () => {
    const source = readWebRemoteControlDialogSource();

    expect(source).not.toContain("setWebRemoteControlSessionActive");
    expect(source).not.toContain("useWebRemoteControlRuntimeStore");
  });

  it("does not pass theme into start payload when syncing Web remote control status", () => {
    const source = readWebRemoteControlDialogSource();
    // Bugfix: 手机远控已改为默认 dark + 本地偏好，桌面端不应再把 theme 注入 start 参数，
    // 否则会重新把两端主题耦合到同一链路，和当前设计目标冲突。
    expect(source).not.toContain("theme,");
  });
});
