import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BotConfig, BotRuntimeInfo } from "@zcode/shared";
import { ALL_BOT_WORKSPACES } from "@zcode/shared";
import { BotSummaryCard } from "@/BotsDialog/BotSummaryCard.js";
import { ProviderSettingsCard } from "@/BotsDialog/ProviderSettingsCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const bot: BotConfig = {
  id: "feishu-bot",
  name: "咪处长",
  provider: "feishu",
  enabled: true,
  credentialRef: "credential-ref",
  feishuAppId: "cli_test",
  allowedWorkspaces: [ALL_BOT_WORKSPACES],
  allowedCommands: {},
  currentOptions: {},
  replyMode: "streaming_card",
};

const runtime: BotRuntimeInfo = {
  botId: bot.id,
  provider: bot.provider,
  status: "error",
  message: "Feishu WebSocket failed: code: 1000040351, system busy",
};

function renderZh(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, element),
  );
}

describe("BotsDialog runtime error", () => {
  it("shows a runtime failure instead of the unbound summary", () => {
    const markup = renderZh(
      createElement(BotSummaryCard, {
        bot,
        runtime,
        selectedBotDisplayName: bot.name,
        selectedBotName: bot.name,
        fallbackBotName: "飞书机器人",
        renaming: false,
        onStartRename: vi.fn(),
        onCommitNameDraft: vi.fn(),
        onNameDraftChange: vi.fn(),
        onNameInputKeyDown: vi.fn(),
        onPatchBot: vi.fn(),
      }),
    );

    expect(markup).toContain("飞书连接失败");
    expect(markup).not.toContain("未绑定");
  });

  it("shows delivery errors independently of an active connection", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot,
        runtime: {
          ...runtime,
          status: "connected",
          deliveryError: "HTTP 200, code=230101, log_id=delivery-log",
        },
        credentialValue: "",
        bindCode: {
          botId: bot.id,
          code: "BB2549",
          createdAt: 1,
          expiresAt: 60_001,
          ttlMs: 60_000,
        },
        bindExpired: false,
        bindRemainingMs: 26_000,
        bindCountdownProgress: 43,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain("机器人回复发送失败");
    expect(markup).toContain("230101");
    expect(markup).toContain("delivery-log");
    expect(markup).not.toContain("无法连接飞书");
  });

  it("replaces an active bind command with the persistent connection error", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot,
        runtime,
        credentialValue: "",
        bindCode: {
          botId: bot.id,
          code: "BB2549",
          createdAt: 1,
          expiresAt: 60_001,
          ttlMs: 60_000,
        },
        bindExpired: false,
        bindRemainingMs: 26_000,
        bindCountdownProgress: 43,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain("无法连接飞书");
    expect(markup).toContain("1000040351");
    expect(markup).toContain("system busy");
    expect(markup).not.toContain("/bind BB2549");
    expect(markup).not.toContain("刷新绑定码");
  });

  it("keeps an existing binding while showing that its connection is interrupted", () => {
    const markup = renderZh(
      createElement(ProviderSettingsCard, {
        bot: { ...bot, providerUserId: "ou_bound_user" },
        runtime,
        credentialValue: "",
        bindCode: null,
        bindExpired: false,
        bindRemainingMs: 0,
        bindCountdownProgress: 0,
        feishuRegistration: null,
        feishuRegistrationLoading: false,
        weixinRegistration: null,
        weixinRegistrationLoading: false,
        weixinActivated: false,
        secretSaving: false,
        onCredentialValueChange: vi.fn(),
        onSaveSecret: vi.fn(),
        onRemoveSecret: vi.fn(),
        onOpenTelegramBotFather: vi.fn(),
        onStartWeixinRegistration: vi.fn(),
        onStartFeishuRegistration: vi.fn(),
        onCreateBindCode: vi.fn(),
        onUnbind: vi.fn(),
        onCopyBindCommand: vi.fn(),
      }),
    );

    expect(markup).toContain("连接中断");
    expect(markup).toContain("长连接数可能已达上限或飞书服务繁忙");
    expect(markup).toContain("若持续失败，可绑定新的机器人");
    expect(markup).toContain("解绑");
    expect(markup).not.toContain(">已连通<");
    expect(markup).not.toContain("暂时不能完成绑定");
  });
});
