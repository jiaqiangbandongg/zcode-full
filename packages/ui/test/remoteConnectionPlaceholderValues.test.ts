import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import zhCN from "@/i18n/locales/zh-CN.js";

/**
 * §9 门禁 1（弹窗部分）：connectedBanner 与识别卡的占位符必须渲染为实值。
 * mock 复刻 IntlProvider 真实语义（真实 zh-CN 消息 + replaceAll 插值）。
 */
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) => {
        let message = (zhCN as Record<string, string>)[id] ?? id;
        if (values) {
          for (const [key, value] of Object.entries(values)) {
            message = message.replaceAll(`{${key}}`, String(value));
          }
        }
        return message;
      },
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: () => createElement("div", { "data-testid": "directory-browser" }),
}));

vi.mock("@/RemoteConnectionFields.js", () => ({
  RemoteConnectionFields: () => createElement("div", { "data-testid": "remote-connection-fields" }),
}));

vi.mock("@/settings/RemoteSyncActions.js", () => ({
  RemoteSyncDialogs: () => createElement("div", { "data-testid": "remote-sync-dialogs" }),
  RemoteSyncDropdownButton: () => createElement("button", { type: "button" }, "sync"),
  shouldShowRemoteSyncActions: () => false,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (selector: (state: unknown) => unknown) => selector({ openSubmit: vi.fn() }),
}));

import { RemoteConnectionDirectoryStep } from "@/RemoteConnectionDialogContent.js";
import { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";

describe("remote connection dialog placeholder values", () => {
  it("shows connection and version in the banner without repeating the device", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        remoteTarget: { kind: "ssh", host: "example.com", username: "dev" },
        deviceName: "dev",
        profileName: "home-lab",
        deviceVersion: "3.8.1",
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("已连接");
    expect(html).toContain("home-lab");
    expect(html).toContain("v3.8.1");
    expect(html).not.toContain("已连接 dev");
    expect(html).not.toMatch(/\{(?:device|profile|version)\}/u);
  });

  it("interpolates the recognized device card title and profile body", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionConnectingStep, {
        kind: "ssh",
        logs: [],
        errorMessage: "",
        loading: false,
        recognizedDeviceName: "dev",
        profileName: "home-lab",
        onBack: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(html).toContain("已连接设备 dev");
    expect(html).not.toContain("remote.recognizedDeviceBody");
    expect(html).not.toMatch(/\{(?:device|profile)\}/u);
  });

  it("版本不兼容时将无效重试替换为就地更新", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionConnectingStep, {
        kind: "ssh",
        logs: [],
        errorMessage: "远程设备版本不兼容",
        loading: false,
        upgradeRequired: true,
        onUpgrade: vi.fn(),
        onBack: vi.fn(),
        onRetry: vi.fn(),
      }),
    );

    expect(html).toContain("更新远端");
    expect(html).not.toMatch(/>重试<\/button>/u);
  });
});
