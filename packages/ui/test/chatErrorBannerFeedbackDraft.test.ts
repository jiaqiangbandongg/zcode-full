import type { IPlatformService } from "@zcode/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const buttonMock = vi.hoisted(() => ({
  props: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", async () => {
  const React = await import("react");
  return {
    Button: (props: Record<string, unknown>) => {
      buttonMock.props.push(props);
      const { children, size, variant, ...domProps } = props;
      void size;
      void variant;
      return React.createElement("button", domProps, children);
    },
  };
});

vi.mock("@/components/ui/toast.js", () => ({
  toast: vi.fn(),
}));

const mockPlatform = {
  captureWindowScreenshot: vi.fn(async () => null),
} as unknown as IPlatformService;

function resetFeedbackStore() {
  useFeedbackStore.setState({
    open: false,
    featureRequestOpen: false,
    tab: "submit",
    submitDraft: null,
    selectedTicketId: null,
  });
}

function renderErrorBanner() {
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: mockPlatform },
        createElement(ChatErrorBanner, {
          error: {
            code: "PROVIDER_AUTH_FAILED",
            message: "Provider authentication failed.",
            traceId: "trace-auth-failed",
          },
          onDismiss: vi.fn(),
        }),
      ),
    ),
  );
}

async function openFeedbackFromBanner() {
  const feedbackButton = buttonMock.props.find((props) => props["aria-label"] === "反馈问题");
  expect(feedbackButton).toBeDefined();
  if (!feedbackButton) {
    throw new Error("Feedback issue button was not rendered");
  }

  (feedbackButton.onClick as () => void)();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ChatErrorBanner feedback draft", () => {
  beforeEach(() => {
    buttonMock.props = [];
    vi.clearAllMocks();
    resetFeedbackStore();
  });

  it("uses a compact one-line error summary without the generic investigation heading", async () => {
    renderErrorBanner();

    await openFeedbackFromBanner();

    expect(mockPlatform.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(useFeedbackStore.getState().submitDraft?.includeLogs).toBe(true);
    const description = useFeedbackStore.getState().submitDraft?.description;
    expect(description).toContain("报错摘要：Provider authentication failed.");
    expect(description).toContain("TraceID: trace-auth-failed");
    expect(description).not.toContain("我在使用过程中遇到了报错，请帮忙排查。");
    expect(description).not.toContain("报错摘要\nProvider authentication failed.");
  });

  it("没有升级处理器时不展示不可用的升级动作", () => {
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(ChatErrorBanner, {
            error: {
              code: "model_config_missing",
              message: "Model config is missing.",
            },
            onOpenModelSettings: vi.fn(),
          }),
        ),
      ),
    );

    expect(buttonMock.props.some((props) => props["aria-label"] === "升级")).toBe(false);
    expect(buttonMock.props.some((props) => props["aria-label"] === "配置")).toBe(true);
  });

  it("远程 workspace 缺模型时只切换措辞，动作仍是本机配置与升级", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(ChatErrorBanner, {
            error: {
              code: "model_config_missing",
              message: "Model config is missing.",
            },
            modelConfigTarget: "remote",
            onOpenModelSettings: vi.fn(),
            onOpenUpgrade: vi.fn(),
          }),
        ),
      ),
    );

    expect(html).toContain(zhCN["chat.error.remoteNoAvailableModel"]);
    expect(html).not.toContain(zhCN["chat.error.noAvailableModel"]);
    expect(buttonMock.props.some((props) => props["aria-label"] === "配置")).toBe(true);
    expect(buttonMock.props.some((props) => props["aria-label"] === "升级")).toBe(true);
    expect(buttonMock.props.some((props) => props["aria-label"] === "去同步")).toBe(false);
  });
});

it("远程发送竞态提供重连，反馈归属连接失败而非模型调用", async () => {
  const reconnect = vi.fn();
  renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: mockPlatform },
        createElement(ChatErrorBanner, {
          error: {
            code: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
            message: "ZCODE_REMOTE_WORKSPACE_DISCONNECTED",
          },
          remoteKind: "ssh",
          onReconnect: reconnect,
        }),
      ),
    ),
  );
  const button = buttonMock.props.find((props) => props.children === "重新连接");
  expect(button).toBeDefined();
  (button!.onClick as () => void)();
  expect(reconnect).toHaveBeenCalledOnce();
  await openFeedbackFromBanner();
  expect(useFeedbackStore.getState().submitDraft?.module).toBe("SSH连接失败");
});
